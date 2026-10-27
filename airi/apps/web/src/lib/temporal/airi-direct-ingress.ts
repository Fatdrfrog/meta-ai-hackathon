import type { AiriAutoReplyParams } from "@icecore/airi-runtime/auto-reply";
import { createServerLogger } from "@/lib/observability/server-logs";
import {
  isTemporalConfigured,
  signalWithStartAiriConversation,
} from "@/lib/temporal/client";
import {
  buildAiriConversationIngressKey,
  createAiriConversationTurnContext,
  hydrateStoredAiriAutoReplyParamsFromTurn,
  type AiriTurnContextInput,
} from "@/lib/temporal/airi-turn-context";
import type { AiriConversationTurnSignal } from "@icecore/temporal";

const airiDirectIngressLogger = createServerLogger("airi.direct_ingress");

/** Message persistence is acceptance; a Temporal outage leaves recoverable work. */
export async function acceptAiriConversationIngress(
  message: {
    _id: unknown;
    workspaceId?: unknown;
    conversation?: unknown;
    airiIngressIntent?: unknown;
  },
  payload?: AiriTurnContextInput
): Promise<{
  accepted: true;
  status: "pending" | "signaled";
  workflowId?: string;
}> {
  const {
    materializeAiriMessageIngress,
    dispatchPersistedAiriConversationIngress,
  } = await import("./airi-conversation-ingress");
  const context = await materializeAiriMessageIngress(message, payload);
  if (!context)
    throw new Error("Airi acceptance requires a persisted ingress intent");
  try {
    const result = await dispatchPersistedAiriConversationIngress(context);
    return {
      accepted: true,
      status: "signaled",
      workflowId: result.workflowId,
    };
  } catch (error) {
    airiDirectIngressLogger.warn(
      "Airi accepted message awaits Temporal ingress",
      {
        workspaceId: context.workspaceId,
        conversationId: context.conversationId,
        messageId: context.messageId,
        ingressKey: context.ingressKey,
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return { accepted: true, status: "pending" };
  }
}

export type AiriDirectIngressResult = {
  workflowId: string;
  signaledRunId: string | null;
  alreadySignaled: boolean;
};

function buildIngressLogContext(
  payload: AiriAutoReplyParams,
  params?: {
    label?: string;
    workspaceId?: string;
    conversationId?: string;
    messageId?: string;
    channel?: string;
    idempotent?: boolean;
  }
) {
  return {
    label: params?.label || "airi-direct-ingress",
    workspaceId: params?.workspaceId || payload.workspaceId,
    conversationId:
      params?.conversationId || String(payload.conversation?._id || ""),
    messageId: params?.messageId || String(payload.newMessage?._id || ""),
    channel: params?.channel || payload.type,
  };
}

/** Persist admission before submitting optional dispatch to an owned executor.
 * The existing ingress recovery queue owns rejected submissions and crashes.
 */
export async function enqueueAiriConversationIngress(
  payload: AiriAutoReplyParams,
  schedule: (task: () => Promise<void>) => boolean,
): Promise<{ workflowId?: string }> {
  const ingressKey = buildAiriConversationIngressKey(payload);
  const context = await createAiriConversationTurnContext(payload, {
    ingressKey,
  });
  schedule(async () => {
    const { dispatchPersistedAiriConversationIngress } = await import(
      "./airi-conversation-ingress"
    );
    await dispatchPersistedAiriConversationIngress(context);
  });
  return {};
}

export async function directIngressAiriConversation(
  payload: AiriAutoReplyParams,
  params?: {
    label?: string;
    workspaceId?: string;
    conversationId?: string;
    messageId?: string;
    channel?: string;
    idempotent?: boolean;
  }
): Promise<AiriDirectIngressResult> {
  const startedAt = Date.now();
  const logContext = buildIngressLogContext(payload, params);
  const ingressKey =
    params?.idempotent === false
      ? null
      : buildAiriConversationIngressKey(payload);

  try {
    if (!isTemporalConfigured()) {
      if (ingressKey)
        await createAiriConversationTurnContext(payload, { ingressKey });
      throw new Error(
        "Temporal is required for Airi ingress, but it is not configured"
      );
    }
    const signalResult = ingressKey
      ? await signalWithStartAiriConversation(payload, { ingressKey })
      : await signalWithStartAiriConversation(payload);
    const { workflowHandle, workflowId, turnContextId, taskQueue } =
      signalResult;
    if (signalResult.alreadySignaled) {
      airiDirectIngressLogger.info("Airi direct ingress already signaled", {
        ...logContext,
        outcome: "already_signaled",
        durationMs: Date.now() - startedAt,
        workflowId,
        turnContextId,
        taskQueue,
      });
      return {
        workflowId,
        signaledRunId: null,
        alreadySignaled: true,
      };
    }
    if (!workflowHandle) {
      throw new Error(
        "Temporal accepted Airi ingress without a workflow handle"
      );
    }

    airiDirectIngressLogger.info("Airi direct ingress signaled", {
      ...logContext,
      outcome: "success",
      durationMs: Date.now() - startedAt,
      workflowId: workflowHandle.workflowId,
      runId: workflowHandle.signaledRunId || null,
      turnContextId,
      taskQueue,
    });

    return {
      workflowId: workflowHandle.workflowId,
      signaledRunId: workflowHandle.signaledRunId || null,
      alreadySignaled: false,
    };
  } catch (error) {
    airiDirectIngressLogger.error("Airi direct ingress failed", error, {
      ...logContext,
      outcome: "error",
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

export async function directIngressStoredAiriConversation(
  turn: AiriConversationTurnSignal,
  params?: { label?: string }
): Promise<{
  queued: boolean;
  reason:
    | "queued"
    | "already_signaled"
    | "runtime_disabled"
    | "conversation_disabled"
    | "message_not_inbound";
  workflowId?: string | null;
}> {
  if ((process.env.AIRI_AUTO_REPLY ?? "true").toLowerCase() !== "true") {
    return { queued: false, reason: "runtime_disabled" };
  }

  const payload = await hydrateStoredAiriAutoReplyParamsFromTurn(turn);
  const conversation =
    payload.conversation as AiriAutoReplyParams["conversation"] & {
      airi_bot_enabled?: boolean | null;
      airi_scenarios_enabled?: boolean | null;
      airi_enabled?: boolean | null;
    };
  const botEnabled =
    conversation.airi_bot_enabled ?? conversation.airi_enabled ?? false;
  const scenariosEnabled =
    conversation.airi_scenarios_enabled ?? conversation.airi_enabled ?? false;
  const automationEnabled = Boolean(botEnabled || scenariosEnabled);
  if (!automationEnabled) {
    return { queued: false, reason: "conversation_disabled" };
  }
  if (payload.newMessage.direction !== "inbound") {
    return { queued: false, reason: "message_not_inbound" };
  }

  const handle = await directIngressAiriConversation(payload, {
    label: params?.label || "conversation-media-analysis",
    workspaceId: turn.workspaceId,
    conversationId: turn.conversationId,
    messageId: turn.messageId,
    channel: turn.channel || "whatsapp",
    idempotent: true,
  });
  if (handle.alreadySignaled) {
    return {
      queued: false,
      reason: "already_signaled",
      workflowId: handle.workflowId,
    };
  }
  return {
    queued: true,
    reason: "queued",
    workflowId: handle.workflowId,
  };
}
