import {
  isTemporalConfigured,
  resolveAiriConversationWorkflowInactiveReason,
  signalWithStartAiriConversationExternalEvent,
} from "@/lib/temporal/client";
import User from "@/models/user";

import { airiOrchestrationLogger } from "@/lib/airi/reply/runtime/reply-logging";
import { isAutomatedOutboundOriginKind } from "@/lib/conversation-message-denorm";
import { normalizeString, readEntityId } from "@/lib/scenarios/task-utils";

type ScenarioTimeoutMessageEvent = {
  messageId: string;
  conversationId: string;
  workspaceId: string;
  channel: string;
  direction: "inbound" | "outbound";
  author?: unknown;
  originKind?: string | null;
  text?: string;
  date: Date;
};

function resolveAuthorId(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }
  if (typeof value === "object") {
    const raw = value as Record<string, unknown>;
    if (raw._id !== null && raw._id !== undefined) {
      return String(raw._id).trim();
    }
  }
  return "";
}

async function isBotAuthor(author: unknown): Promise<boolean> {
  const authorId = resolveAuthorId(author);
  if (!authorId) return false;
  if (authorId === "0") return true;

  const user = await User.findById(authorId)
    .select("isBot")
    .lean<{ isBot?: boolean } | null>();
  if (user) return Boolean(user.isBot);

  return false;
}

async function isHumanOutboundAuthor(author: unknown): Promise<boolean> {
  const authorId = resolveAuthorId(author);
  if (!authorId || authorId === "0") return false;
  const isBot = await isBotAuthor(author);
  return !isBot;
}

export async function handleScenarioTimeoutMessageSaved(
  event: ScenarioTimeoutMessageEvent
): Promise<void> {
  if (!event.conversationId || !event.workspaceId || !event.channel) return;

  if (event.direction === "inbound") {
    return;
  }

  if (isAutomatedOutboundOriginKind(event.originKind)) {
    return;
  }

  const isHuman = await isHumanOutboundAuthor(event.author);
  if (!isHuman) return;

  if (!isTemporalConfigured()) {
    airiOrchestrationLogger.info("airi.orchestration.timer_event", {
      workspaceId: event.workspaceId,
      conversationId: event.conversationId,
      messageId: event.messageId,
      note: "preserve_scenario_state_temporal_unavailable",
    });
    return;
  }

  try {
    await signalWithStartAiriConversationExternalEvent({
      kind: "human_outbound",
      workspaceId: event.workspaceId,
      conversationId: event.conversationId,
      messageId: event.messageId,
      channel: event.channel,
      messageDate: event.date.toISOString(),
      enqueuedAt: new Date().toISOString(),
    });
  } catch (error) {
    const inactiveReason = resolveAiriConversationWorkflowInactiveReason(error);
    const logPayload = {
      workspaceId: event.workspaceId,
      conversationId: event.conversationId,
      messageId: event.messageId,
      note:
        inactiveReason === "not_found"
          ? "signal_human_outbound_no_workflow"
          : inactiveReason === "completed"
            ? "signal_human_outbound_no_active_workflow"
            : "signal_human_outbound_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
    if (inactiveReason) {
      airiOrchestrationLogger.info(
        "airi.orchestration.timer_event",
        logPayload
      );
    } else {
      airiOrchestrationLogger.warn(
        "airi.orchestration.timer_event",
        logPayload
      );
    }
  }
}

export function toScenarioTimeoutMessageEvent(params: {
  _id: unknown;
  conversation?: unknown;
  workspaceId?: unknown;
  channel?: unknown;
  direction?: unknown;
  author?: unknown;
  origin?: { kind?: string | null } | null;
  text?: unknown;
  date?: unknown;
}): ScenarioTimeoutMessageEvent | null {
  const messageId = readEntityId(params._id);
  const conversationId = readEntityId(params.conversation);
  const workspaceId = normalizeString(params.workspaceId);
  const channel = normalizeString(params.channel);
  const direction =
    params.direction === "inbound" || params.direction === "outbound"
      ? params.direction
      : null;
  const date =
    params.date instanceof Date && !Number.isNaN(params.date.getTime())
      ? params.date
      : null;

  if (
    !messageId ||
    !conversationId ||
    !workspaceId ||
    !channel ||
    !direction ||
    !date
  ) {
    return null;
  }

  return {
    messageId,
    conversationId,
    workspaceId,
    channel,
    direction,
    author: params.author,
    originKind:
      params.origin && typeof params.origin.kind === "string"
        ? params.origin.kind
        : null,
    text: typeof params.text === "string" ? params.text : "",
    date,
  };
}
