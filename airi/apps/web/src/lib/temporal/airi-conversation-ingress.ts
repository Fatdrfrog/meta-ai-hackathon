import "server-only";

import connectDB from "@/lib/mongoose";
import { admitCompanyConversationIngress } from "@/lib/limits/company-runtime-capacity";
import { isCompanyRuntimeCapacityDeferredError } from "@icecore/shared/lib/company-runtime-capacity";
import { appendMessageToConversationById } from "@/lib/conversation-messages";
import { hasWhatsAppReferralContent } from "@icecore/airi-runtime/whatsapp-message-recovery";
import { enqueueConversationMediaAnalysis } from "@/lib/media/conversation-media-analysis-jobs";
import AiriTurnContext, {
  AIRI_CONVERSATION_INGRESS_QUEUE_INDEX,
  buildAiriIngressKeyFilter,
} from "@/models/airi-turn-context";
import Message, { MESSAGE_AIRI_INGRESS_PENDING_INDEX } from "@/models/message";
import {
  buildAiriConversationWorkflowId,
  resolveAiriConversationRouting,
} from "@icecore/temporal";
import {
  signalAiriConversationTurn,
  type AiriConversationSignalWithStartResult,
} from "./client";
import {
  buildAiriConversationIngressIntent,
  buildStoredAiriConversationTurnSignal,
  persistAiriConversationIngressIntent,
  type AiriTurnContextDocument,
  type AiriTurnContextInput,
} from "./airi-turn-context";
import {
  claimAiriIngress,
  finishAiriIngressClaim,
  getAiriIngressRetryDate,
} from "./airi-ingress-lease";

type QueuedContext = AiriTurnContextDocument & {
  ingressKey: string;
  ingressAttempts: number;
};
type IngressMessage = {
  _id: unknown;
  workspaceId?: unknown;
  conversation?: unknown;
  airiIngressIntent?: unknown;
};

/** Reconciles the two writes; the message remains the outbox until upsert succeeds. */
export async function materializeAiriMessageIngress(
  message: IngressMessage,
  fallbackPayload?: AiriTurnContextInput
): Promise<AiriTurnContextDocument | null> {
  await connectDB();
  const saved = message.airiIngressIntent
    ? message
    : await Message.findById(message._id)
        .select("workspaceId conversation +airiIngressIntent")
        .lean<IngressMessage | null>();
  const intent = saved?.airiIngressIntent as
    | AiriTurnContextDocument
    | undefined;
  if (!saved) throw new Error("Airi ingress message is missing");
  if (!intent && !fallbackPayload) return null;
  const candidate =
    intent || buildAiriConversationIngressIntent(fallbackPayload!);
  if (
    candidate.messageId !== String(message._id) ||
    candidate.workspaceId !== String(message.workspaceId) ||
    candidate.conversationId !== String(message.conversation)
  ) {
    throw new Error("Airi ingress intent does not belong to the saved message");
  }
  const stored = await persistAiriConversationIngressIntent(candidate);
  if (intent) {
    await Message.updateOne(
      { _id: message._id, "airiIngressIntent.ingressKey": intent.ingressKey },
      { $unset: { airiIngressIntent: "" } }
    );
  }
  return stored;
}

/** The same leased dispatch is used by foreground ingress and recovery. */
export async function dispatchPersistedAiriConversationIngress(
  context: AiriTurnContextDocument,
  options: { now?: Date } = {}
): Promise<AiriConversationSignalWithStartResult> {
  if (context.ingressStatus === "signaled") {
    return {
      workflowHandle: null,
      workflowId:
        context.ingressWorkflowId ||
        buildAiriConversationWorkflowId(context.conversationId),
      turnContextId: context.turnContextId,
      taskQueue: resolveAiriConversationRouting(context).taskQueue,
      alreadySignaled: true,
    };
  }
  if (!context.ingressKey) {
    throw new Error("Airi conversation ingress requires a durable intent");
  }
  const now = options.now || new Date();
  const claimed = await claimAiriIngress<QueuedContext>({
    filter: {
      ...buildAiriIngressKeyFilter(context.ingressKey),
      ingressKind: "conversation_turn",
      ingressStatus: "pending",
    },
    now,
  });
  if (!claimed) throw new Error("Airi ingress is pending another attempt");
  try {
    await admitCompanyConversationIngress(claimed.workspaceId);
    // Recovery also repairs a crash between message insertion and linking it.
    const message = await Message.findById(claimed.messageId)
      .select("workspaceId conversation date direction mediaType mediaAnalysis whatsappReferral")
      .lean<{
        workspaceId: string;
        conversation: unknown;
        date: Date;
        direction: "inbound" | "outbound";
        mediaType?: string;
        whatsappReferral?: unknown;
        mediaAnalysis?: { status?: string; workflowId?: string };
      } | null>();
    if (
      !message ||
      message.workspaceId !== claimed.workspaceId ||
      String(message.conversation) !== claimed.conversationId
    ) {
      throw new Error(
        "Airi ingress message is missing or has changed ownership"
      );
    }
    if (
      claimed.channel === "whatsapp" &&
      hasWhatsAppReferralContent(message.whatsappReferral)
    ) {
      const { enrichStoredWhatsAppReferral } = await import(
        "../whatsapp/referral-enrichment-store"
      );
      await enrichStoredWhatsAppReferral(
        {
          workspaceId: claimed.workspaceId,
          conversationId: claimed.conversationId,
          messageId: claimed.messageId,
        },
        { allowUnavailable: true }
      );
    }
    await appendMessageToConversationById(
      claimed.conversationId,
      claimed.messageId,
      {
        lastMessageAt: message.date,
        direction: message.direction,
      }
    );
    const media = await enqueueConversationMediaAnalysis({
      workspaceId: claimed.workspaceId,
      conversationId: claimed.conversationId,
      messageId: claimed.messageId,
      mediaType: message.mediaType,
      sourceId: claimed.sourceId,
      messageState: message,
      ...(claimed.channel === "whatsapp" ? { triggerAiriAfterAnalysis: true } : {}),
    });
    if (
      !media.queued &&
      !["unsupported_media", "already_active", "already_complete"].includes(
        media.reason
      )
    ) {
      throw new Error(
        `Airi ingress could not enqueue media analysis: ${media.reason}`
      );
    }
    if (
      claimed.channel === "whatsapp" &&
      (media.queued || media.reason === "already_active")
    ) {
      // The analysis workflow requests ingress again on completion. Keep this
      // intent pending so a crash or missed callback is also recovered by cron.
      throw new Error("Airi ingress awaits media analysis");
    }
    const result = await signalAiriConversationTurn(
      buildStoredAiriConversationTurnSignal(claimed)
    );
    const finished = await finishAiriIngressClaim({
      claimed,
      update: {
        $set: {
          ingressStatus: "signaled",
          ingressWorkflowId: result.workflowId,
          ingressSignaledAt: now,
          ingressLastError: null,
          // Execution owns retention now; accepting a signal is not completion.
        },
        $unset: {
          ingressLeaseToken: "",
          ingressLeaseExpiresAt: "",
          ingressNextRetryAt: "",
        },
      },
    });
    if (!finished) throw new Error("Airi ingress completion lost its lease");
    return result;
  } catch (error) {
    await finishAiriIngressClaim({
      claimed,
      update: {
        $set: {
          ingressStatus: "pending",
          ingressLastError:
            error instanceof Error ? error.message : String(error),
          ingressNextRetryAt: isCompanyRuntimeCapacityDeferredError(error)
            ? new Date(error.retryAt)
            : getAiriIngressRetryDate(now, claimed.ingressAttempts),
          expiresAt: null,
        },
        $unset: { ingressLeaseToken: "", ingressLeaseExpiresAt: "" },
      },
    });
    throw error;
  }
}

export async function processAiriConversationIngressQueue(
  options: { limit?: number; now?: Date } = {}
) {
  await connectDB();
  const now = options.now || new Date();
  const limit = Number.isFinite(options.limit)
    ? Math.max(1, Math.min(50, Math.trunc(options.limit!)))
    : 25;
  const messages = await Message.find({
    "airiIngressIntent.ingressKey": { $type: "string" },
    "airiIngressIntent.ingressNextRetryAt": { $lte: now },
  })
    .select("workspaceId conversation +airiIngressIntent")
    .sort({ "airiIngressIntent.ingressNextRetryAt": 1, _id: 1 })
    .limit(limit)
    .hint(MESSAGE_AIRI_INGRESS_PENDING_INDEX.options.name)
    .lean<IngressMessage[]>();
  const materialized = await Promise.allSettled(
    messages.map(message => materializeAiriMessageIngress(message))
  );
  for (let i = 0; i < materialized.length; i += 1) {
    if (materialized[i].status !== "rejected") continue;
    const message = messages[i];
    const intent = message.airiIngressIntent as AiriTurnContextDocument;
    await Message.updateOne(
      { _id: message._id, "airiIngressIntent.ingressKey": intent.ingressKey },
      {
        $set: {
          "airiIngressIntent.ingressNextRetryAt": getAiriIngressRetryDate(
            now,
            (intent.ingressAttempts || 0) + 1
          ),
        },
        $inc: { "airiIngressIntent.ingressAttempts": 1 },
      }
    );
  }
  const pending = await AiriTurnContext.find({
    ingressKind: "conversation_turn",
    ingressStatus: "pending",
    ingressNextRetryAt: { $lte: now },
    $or: [
      { ingressLeaseExpiresAt: null },
      { ingressLeaseExpiresAt: { $lte: now } },
    ],
  })
    .sort({ ingressNextRetryAt: 1, _id: 1 })
    .limit(limit)
    .hint(AIRI_CONVERSATION_INGRESS_QUEUE_INDEX.options.name)
    .lean<AiriTurnContextDocument[]>();
  const results = await Promise.allSettled(
    pending.map(context =>
      dispatchPersistedAiriConversationIngress(context, { now })
    )
  );
  return {
    materialized: materialized.filter(result => result.status === "fulfilled")
      .length,
    materializationFailed: materialized.filter(
      result => result.status === "rejected"
    ).length,
    signaled: results.filter(result => result.status === "fulfilled").length,
    retryScheduled: results.filter(result => result.status === "rejected")
      .length,
  };
}
