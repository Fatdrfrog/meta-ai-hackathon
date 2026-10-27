import {
  type AiriCoachJobInput,
  type AiriCoachJobResult,
} from "@icecore/temporal";
import {
  CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT,
  getCurrentConversationClassification,
} from "@icecore/shared/lib/conversation-classification-freshness";
import type { ConversationPreferredLanguage } from "@icecore/shared/types/conversation";

import { getHeavyTextModel } from "@/lib/ai";
import { isClaudeModel } from "@/lib/ai/text-models";
import { withWorkspaceTextAiAction } from "@/lib/ai/workspace-ai-policy";
import {
  buildCoachConversationWindow,
  buildCoachProfileContextBlock,
  COACH_CUSTOMER_SELECT,
  COACH_MESSAGE_SELECT,
  getCoachMessageContent,
  type CoachConversationProfile,
  type CoachConversationMessage,
  type CoachCustomerProfile,
} from "@/lib/airi/coach/conversation-window";
import { computeCoachTags } from "@/lib/airi/coach/coach-utils";
import { simpleCoachEngine } from "@/lib/airi/engine";
import { emitWorkspaceUsageDeltaBestEffort } from "@/lib/limits/company-usage-events";
import { ensureCompanyCoachCapacity } from "@/lib/limits/company-limits";
import connectDB from "@/lib/mongoose";
import { realtime } from "@/lib/realtime/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getWorkspaceCompanyInfo } from "@/lib/supabase/company-users";
import CoachingTip from "@/models/coaching-tip";
import { Conversation } from "@/models/conversation";
import Customer from "@/models/customer";
import Message from "@/models/message";
import { requireNonEmptyString as requireString } from "@icecore/shared/lib/value-utils";

export type RunAiriCoachJobInput = Omit<AiriCoachJobInput, "contractVersion">;

function computeDynamicTags(text: string): string[] {
  return computeCoachTags(text);
}

/**
 * `<provider>:<model>` of the call that produced the tips. The heuristic
 * fallback has no provider and keeps the legacy `vertex:` prefix that older
 * stored tips use.
 */
function buildCoachModelVersion(
  inference: { model?: string; provider?: string } | undefined
): string {
  const model = inference?.model || getHeavyTextModel();
  const provider =
    inference?.provider || (isClaudeModel(model) ? "anthropic" : "vertex");
  return `${provider}:${model}`;
}

async function recordAiriSession(params: {
  workspaceId: string;
  agentId?: string | null;
  conversationId: string;
  tipCount: number;
  latencyMs: number;
  skipped: boolean;
}): Promise<void> {
  try {
    const { data } = await supabaseAdmin
      .from("airi_sessions")
      .insert({
        workspace_id: params.workspaceId,
        agent_id: params.agentId || null,
        conversation_id: params.conversationId,
        tip_count: params.tipCount,
        latency_ms: params.latencyMs,
        skipped: params.skipped,
      })
      .select("id")
      .maybeSingle();

    if (!params.skipped) {
      emitWorkspaceUsageDeltaBestEffort(
        {
          workspaceId: params.workspaceId,
          metric: "coach_count",
          delta: 1,
          objectId:
            typeof data?.id === "string"
              ? data.id
              : `${params.conversationId}:${Date.now()}`,
          source: "airi_coach",
          metadata: {
            agentId: params.agentId || null,
          },
        },
        { logContext: "recordAiriSession" }
      );
    }
  } catch {
    // Analytics must not make the durable job fail.
  }
}

export async function runAiriCoachJob(
  input: RunAiriCoachJobInput
): Promise<AiriCoachJobResult> {
  return withWorkspaceTextAiAction(
    {
      workspaceId: requireString(input.workspaceId, "workspaceId"),
      actionId: `coach:${requireString(input.conversationId, "conversationId")}:${requireString(input.messageId, "messageId")}`,
    },
    () => runAiriCoachJobImpl(input)
  );
}

async function runAiriCoachJobImpl(
  input: RunAiriCoachJobInput
): Promise<AiriCoachJobResult> {
  const workspaceId = requireString(input.workspaceId, "workspaceId");
  const conversationId = requireString(input.conversationId, "conversationId");
  const messageId = requireString(input.messageId, "messageId");
  const agentId = input.agentId || null;

  await connectDB();
  const started = Date.now();

  const existingTip = await CoachingTip.findOne({
    workspaceId,
    conversationId,
    messageId,
  })
    .select("_id tips")
    .lean<{ _id: unknown; tips?: unknown[] } | null>();

  if (existingTip) {
    return {
      ok: true,
      skipped: true,
      reason: "tip_already_exists",
      tipCount: Array.isArray(existingTip.tips) ? existingTip.tips.length : 0,
      suggestionId: String(existingTip._id),
    };
  }

  const msg = (await Message.findById(messageId)
    .select(COACH_MESSAGE_SELECT)
    .lean()) as CoachConversationMessage | null;
  const sourceMessageContent = msg ? getCoachMessageContent(msg) : "";
  if (!sourceMessageContent) {
    return {
      ok: true,
      skipped: true,
      reason: "source_message_missing",
      tipCount: 0,
    };
  }

  const conv = (await Conversation.findOne({
    _id: conversationId,
    workspaceId,
  })
    .select(
      `preferred_language airi_coach_enabled airi_enabled workspaceId customerId channel status classification internal_labels quick_note ${CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT}`
    )
    .lean()) as {
    preferred_language?: ConversationPreferredLanguage;
    airi_coach_enabled?: boolean;
    airi_enabled?: boolean;
    workspaceId?: string;
    customerId?: unknown;
    channel?: string | null;
    status?: string | null;
    classification?: CoachConversationProfile["classification"];
    internal_labels?: string[] | null;
    quick_note?: string | null;
  } | null;

  const coachEnabled = conv?.airi_coach_enabled ?? conv?.airi_enabled ?? true;
  if (!coachEnabled) {
    await recordAiriSession({
      workspaceId,
      agentId,
      conversationId,
      tipCount: 0,
      latencyMs: Date.now() - started,
      skipped: true,
    });
    return {
      ok: true,
      skipped: true,
      reason: "coaching_disabled",
      tipCount: 0,
    };
  }

  const coachCapacity = await ensureCompanyCoachCapacity(
    supabaseAdmin,
    workspaceId
  );
  if (!coachCapacity.allowed) {
    await recordAiriSession({
      workspaceId,
      agentId,
      conversationId,
      tipCount: 0,
      latencyMs: Date.now() - started,
      skipped: true,
    });
    return {
      ok: true,
      skipped: true,
      reason: "coach_limit_exceeded",
      tipCount: 0,
    };
  }

  let workspaceLanguage: ConversationPreferredLanguage | undefined;
  if (conv?.workspaceId) {
    try {
      const workspaceCompany = await getWorkspaceCompanyInfo(
        supabaseAdmin,
        conv.workspaceId
      );

      if (workspaceCompany?.airi_language) {
        workspaceLanguage =
          workspaceCompany.airi_language as ConversationPreferredLanguage;
      }
    } catch {
      workspaceLanguage = undefined;
    }
  }

  const preferredLanguage =
    conv?.preferred_language || workspaceLanguage || "en";
  const lastMsgs = (await Message.find({ conversation: conversationId })
    .sort({ date: -1 })
    .limit(10)
    .select(COACH_MESSAGE_SELECT)
    .lean()) as CoachConversationMessage[];
  const ordered = [...lastMsgs].reverse();
  const inputMessageIds = ordered.map(message => String(message._id));
  const dynamicTags = computeDynamicTags(
    ordered.map(message => getCoachMessageContent(message)).join(" \n\n")
  );
  let customerContext: CoachCustomerProfile | null = null;
  const customerId = conv?.customerId ? String(conv.customerId) : "";
  if (customerId) {
    try {
      customerContext = await Customer.findOne({
        _id: customerId,
        workspaceId,
        status: "active",
      })
        .select(COACH_CUSTOMER_SELECT)
        .lean<CoachCustomerProfile | null>();
    } catch {
      customerContext = null;
    }
  }
  const currentClassification =
    getCurrentConversationClassification<
      NonNullable<CoachConversationProfile["classification"]>
    >(conv);
  const profileContextBlock = buildCoachProfileContextBlock({
    conversation: {
      channel: conv?.channel,
      status: conv?.status,
      preferred_language: conv?.preferred_language,
      classification: currentClassification,
      internal_labels: conv?.internal_labels,
      quick_note: conv?.quick_note,
    },
    customer: customerContext,
  });
  const conversationWindow = [
    profileContextBlock,
    buildCoachConversationWindow(ordered),
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await simpleCoachEngine.generate(sourceMessageContent, {
    workspaceId,
    conversationId,
    conversationWindow,
    preferredLanguage,
    workspaceLanguage: workspaceLanguage || undefined,
  });

  if (!result.tips || result.tips.length === 0) {
    await recordAiriSession({
      workspaceId,
      agentId,
      conversationId,
      tipCount: 0,
      latencyMs: Date.now() - started,
      skipped: true,
    });
    return {
      ok: true,
      skipped: true,
      reason: "no_tips_generated",
      tipCount: 0,
    };
  }

  const doc = await CoachingTip.create({
    workspaceId,
    conversationId,
    messageId,
    tips: result.tips,
    modelVersion: buildCoachModelVersion(result.inference),
    tagsApplied: dynamicTags,
    inputMessageIds,
    inference: result.inference,
    suggestedEdit: result.suggestedEdit || "",
  });

  await recordAiriSession({
    workspaceId,
    agentId,
    conversationId,
    tipCount: result.tips.length,
    latencyMs: Date.now() - started,
    skipped: false,
  });

  const eventPayload = {
    workspaceId,
    suggestionId: String(doc._id),
    messageId: String(messageId),
    tips: result.tips,
    suggestedEdit: doc.suggestedEdit,
    tagsApplied: dynamicTags,
    createdAt: doc.createdAt,
  };

  await realtime.trigger(
    `private-conversation-${conversationId}`,
    "airi.suggestion",
    eventPayload
  );

  return {
    ok: true,
    tipCount: result.tips.length,
    suggestionId: String(doc._id),
  };
}
