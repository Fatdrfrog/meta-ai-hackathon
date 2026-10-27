import { retryConversationLifecycleWrite } from "@/lib/analytics/service-lifecycle";
import { hasHumanOutboundSince } from "@/lib/airi/reply/runtime/human-outbound";
import { Conversation } from "@/models/conversation";
import { readDate } from "@icecore/shared/lib/value-utils";

type HandoffSource = "scenario_contains" | "scenario_timeout" | "manual";

export type ConversationHandoffSnapshot = {
  airi_handoff_active?: boolean | null;
  airi_handoff_started_at?: Date | string | null;
  airi_handoff_source?: HandoffSource | null;
  airi_last_suppressed_reason?: string | null;
  airi_handoff_restore_bot_enabled?: boolean | null;
};

type ConversationSetter = {
  get(path: string): unknown;
  set(path: string, value: unknown): void;
};

function isScenarioHandoffSource(
  source: ConversationHandoffSnapshot["airi_handoff_source"]
): source is "scenario_contains" | "scenario_timeout" {
  return source === "scenario_contains" || source === "scenario_timeout";
}

function buildClearedHandoffStateUpdate(
  lastSuppressedReason?: string | null
): Record<string, unknown> {
  const update: Record<string, unknown> = {
    airi_handoff_active: false,
    airi_handoff_started_at: null,
    airi_handoff_source: null,
    airi_handoff_reason: null,
    airi_handoff_restore_bot_enabled: null,
    status: "open",
  };

  if (lastSuppressedReason === "scenario_handoff") {
    update.airi_last_suppressed_at = null;
    update.airi_last_suppressed_reason = null;
    update.airi_last_suppressed_manager_user_id = null;
    update.airi_last_suppressed_message_id = null;
  }

  return update;
}

function buildAutoResumeHandoffUpdate(
  snapshot?: ConversationHandoffSnapshot | null
): Record<string, unknown> {
  return {
    ...buildClearedHandoffStateUpdate(snapshot?.airi_last_suppressed_reason),
    airi_bot_enabled:
      typeof snapshot?.airi_handoff_restore_bot_enabled === "boolean"
        ? snapshot.airi_handoff_restore_bot_enabled
        : true,
  };
}

export function buildManualHandoffStateUpdate(params?: {
  handoffAt?: Date | string | null;
  handoffReason?: string | null;
}): Record<string, unknown> {
  const handoffAt = readDate(params?.handoffAt) || new Date();

  return {
    airi_bot_enabled: false,
    airi_handoff_active: true,
    airi_handoff_started_at: handoffAt,
    airi_handoff_source: "manual" as const,
    airi_handoff_reason: params?.handoffReason || "manager_reply",
    status: "in_progress",
  };
}

export function canAutoResumeScenarioHandoff(
  snapshot: ConversationHandoffSnapshot | null | undefined
): boolean {
  if (!snapshot?.airi_handoff_active) {
    return false;
  }

  if (!isScenarioHandoffSource(snapshot.airi_handoff_source)) {
    return false;
  }

  return Boolean(readDate(snapshot.airi_handoff_started_at));
}

export function applyClearedHandoffStateToConversation(
  conversation: ConversationSetter
): void {
  const update = buildClearedHandoffStateUpdate(
    typeof conversation.get("airi_last_suppressed_reason") === "string"
      ? String(conversation.get("airi_last_suppressed_reason"))
      : null
  );

  for (const [key, value] of Object.entries(update)) {
    conversation.set(key, value);
  }
}

/**
 * Writes conversation status/handoff fields. A concurrent lifecycle transition
 * makes the model's revision fence reject the write; it is retried so the
 * handoff is not lost, and each attempt re-reads the current state.
 */
export async function updateConversationHandoffState(
  filter: Record<string, unknown>,
  set: Record<string, unknown>
) {
  return retryConversationLifecycleWrite(() =>
    Conversation.updateOne(filter, { $set: set })
  );
}

export async function activateManualHandoff(params: {
  conversationId: string;
  handoffAt?: Date | string | null;
  handoffReason?: string | null;
}): Promise<void> {
  await updateConversationHandoffState(
    { _id: params.conversationId },
    buildManualHandoffStateUpdate({
      handoffAt: params.handoffAt,
      handoffReason: params.handoffReason,
    })
  );
}

export async function maybeAutoResumeScenarioHandoff(params: {
  conversationId: string;
  snapshot: ConversationHandoffSnapshot | null | undefined;
  inboundAt: Date;
  hasSubstantiveInbound: boolean;
}): Promise<{
  resumed: boolean;
  blockedByHumanReply: boolean;
}> {
  if (!params.hasSubstantiveInbound) {
    return { resumed: false, blockedByHumanReply: false };
  }

  if (!canAutoResumeScenarioHandoff(params.snapshot)) {
    return { resumed: false, blockedByHumanReply: false };
  }

  const handoffStartedAt = readDate(params.snapshot?.airi_handoff_started_at);
  if (!handoffStartedAt) {
    return { resumed: false, blockedByHumanReply: false };
  }

  const blockedByHumanReply = await hasHumanOutboundSince({
    conversationId: params.conversationId,
    since: handoffStartedAt,
    until: params.inboundAt,
  });

  if (blockedByHumanReply) {
    return { resumed: false, blockedByHumanReply: true };
  }

  // Resume only the scenario handoff that was checked; a retry after a
  // concurrent manual takeover must not clear the manager's handoff.
  const updated = await updateConversationHandoffState(
    {
      _id: params.conversationId,
      airi_handoff_active: true,
      airi_handoff_source: params.snapshot?.airi_handoff_source,
    },
    buildAutoResumeHandoffUpdate(params.snapshot || null)
  );
  if (updated.matchedCount === 0) {
    return { resumed: false, blockedByHumanReply: false };
  }

  return { resumed: true, blockedByHumanReply: false };
}
