import "server-only";

import {
  CONVERSATION_MEDIA_ANALYSIS_WORKFLOW_CONTRACT_VERSION,
  buildConversationMediaAnalysisWorkflowId,
  type ConversationMediaAnalysisType,
} from "@icecore/temporal";

import Message from "@/models/message";
import {
  isTemporalConfigured,
  signalConversationMediaAnalysisAiriTriggerWorkflow,
  startConversationMediaAnalysisWorkflow,
} from "@/lib/temporal/conversation-media-analysis";

const ACTIVE_MEDIA_ANALYSIS_STATUSES = new Set([
  "queued",
  "processing",
  "submitted",
]);
const TERMINAL_MEDIA_ANALYSIS_STATUSES = new Set(["completed", "skipped"]);

type MessageMediaAnalysisState = {
  status?: string | null;
  workflowId?: string | null;
};

type MessageMediaLookup = {
  _id?: unknown;
  mediaType?: string | null;
  mediaAnalysis?: MessageMediaAnalysisState | null;
} | null;

type EnqueueConversationMediaAnalysisInput = {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  mediaType?: string | null;
  sourceId?: string | null;
  triggerAiriAfterAnalysis?: boolean;
  messageState?: Exclude<MessageMediaLookup, null>;
};

type EnqueueConversationMediaAnalysisResult = {
  queued: boolean;
  reason:
    | "queued"
    | "unsupported_media"
    | "message_not_found"
    | "already_active"
    | "already_complete"
    | "not_configured"
    | "publish_failed";
  workflowId?: string;
  duplicate?: boolean;
  errorMessage?: string;
  timings: {
    totalMs: number;
    messageLookupMs?: number;
    workflowStartMs?: number;
    statusWriteMs?: number;
  };
};

type EnqueueConversationMediaAnalysisStageTimings = Omit<
  EnqueueConversationMediaAnalysisResult["timings"],
  "totalMs"
>;

function withEnqueueTimings(
  startedAt: number,
  stageTimings: EnqueueConversationMediaAnalysisStageTimings,
  result: Omit<EnqueueConversationMediaAnalysisResult, "timings">
): EnqueueConversationMediaAnalysisResult {
  return {
    ...result,
    timings: {
      totalMs: Math.max(0, Date.now() - startedAt),
      ...stageTimings,
    },
  };
}

function normalizeConversationMediaAnalysisType(
  value: string | null | undefined
): ConversationMediaAnalysisType | null {
  const normalized = (value || "").trim().toLowerCase();
  if (
    normalized === "audio" ||
    normalized === "voice" ||
    normalized === "video"
  ) {
    return normalized;
  }
  return null;
}

export function buildConversationMediaAnalysisJobKey(params: {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  mediaType: ConversationMediaAnalysisType;
}): string {
  return buildConversationMediaAnalysisWorkflowId(params);
}

function getStoredMediaAnalysisStatus(
  message: MessageMediaLookup
): string | null {
  const status = message?.mediaAnalysis?.status;
  return typeof status === "string" ? status : null;
}

function getStoredMediaAnalysisWorkflowId(
  message: MessageMediaLookup
): string | null {
  const workflowId = message?.mediaAnalysis?.workflowId;
  return typeof workflowId === "string" && workflowId.trim()
    ? workflowId.trim()
    : null;
}

export async function enqueueConversationMediaAnalysis(
  input: EnqueueConversationMediaAnalysisInput
): Promise<EnqueueConversationMediaAnalysisResult> {
  const startedAt = Date.now();
  const stageTimings: EnqueueConversationMediaAnalysisStageTimings = {};
  const finish = (
    result: Omit<EnqueueConversationMediaAnalysisResult, "timings">
  ) => withEnqueueTimings(startedAt, stageTimings, result);
  const requestedMediaType = normalizeConversationMediaAnalysisType(
    input.mediaType
  );
  if (!requestedMediaType) {
    return finish({ queued: false, reason: "unsupported_media" });
  }

  const workflowId = buildConversationMediaAnalysisJobKey({
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    mediaType: requestedMediaType,
  });

  let message: MessageMediaLookup = input.messageState || null;
  if (!message) {
    const messageLookupStartedAt = Date.now();
    try {
      message = (await Message.findOne({
        _id: input.messageId,
        workspaceId: input.workspaceId,
        conversation: input.conversationId,
      })
        .select("mediaType mediaAnalysis")
        .lean()) as MessageMediaLookup;
    } finally {
      stageTimings.messageLookupMs = Math.max(
        0,
        Date.now() - messageLookupStartedAt
      );
    }
  }

  if (!message) {
    return finish({
      queued: false,
      reason: "message_not_found",
      workflowId,
    });
  }

  const storedMediaType =
    normalizeConversationMediaAnalysisType(message.mediaType) ||
    requestedMediaType;
  if (storedMediaType !== requestedMediaType) {
    return finish({
      queued: false,
      reason: "unsupported_media",
      workflowId,
    });
  }

  const storedStatus = getStoredMediaAnalysisStatus(message);
  const storedWorkflowId = getStoredMediaAnalysisWorkflowId(message);
  if (storedStatus && ACTIVE_MEDIA_ANALYSIS_STATUSES.has(storedStatus)) {
    const activeWorkflowId = storedWorkflowId || workflowId;
    if (input.triggerAiriAfterAnalysis) {
      if (!isTemporalConfigured()) {
        return finish({
          queued: false,
          reason: "not_configured",
          workflowId: activeWorkflowId,
        });
      }
      const workflowSignalStartedAt = Date.now();
      try {
        await signalConversationMediaAnalysisAiriTriggerWorkflow({
          workflowId: activeWorkflowId,
        });
      } catch (error) {
        return finish({
          queued: false,
          reason: "publish_failed",
          workflowId: activeWorkflowId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      } finally {
        stageTimings.workflowStartMs = Math.max(
          0,
          Date.now() - workflowSignalStartedAt
        );
      }
    }
    return finish({
      queued: false,
      reason: "already_active",
      workflowId: activeWorkflowId,
    });
  }
  if (storedStatus && TERMINAL_MEDIA_ANALYSIS_STATUSES.has(storedStatus)) {
    return finish({
      queued: false,
      reason: "already_complete",
      workflowId: storedWorkflowId || workflowId,
    });
  }

  if (!isTemporalConfigured()) {
    return finish({ queued: false, reason: "not_configured", workflowId });
  }

  let acceptedStart: Awaited<
    ReturnType<typeof startConversationMediaAnalysisWorkflow>
  > | null = null;
  try {
    const workflowStartStartedAt = Date.now();
    let start: Awaited<
      ReturnType<typeof startConversationMediaAnalysisWorkflow>
    >;
    try {
      start = await startConversationMediaAnalysisWorkflow({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        mediaType: requestedMediaType,
        sourceId: input.sourceId || null,
        triggerAiriAfterAnalysis: Boolean(input.triggerAiriAfterAnalysis),
      });
      acceptedStart = start;
    } finally {
      stageTimings.workflowStartMs = Math.max(
        0,
        Date.now() - workflowStartStartedAt
      );
    }

    const requestedAt = new Date();
    const statusWriteStartedAt = Date.now();
    try {
      await Message.updateOne(
        {
          _id: input.messageId,
          workspaceId: input.workspaceId,
          conversation: input.conversationId,
          $or: [
            { "mediaAnalysis.status": { $exists: false } },
            { "mediaAnalysis.status": null },
            {
              "mediaAnalysis.status": {
                $nin: ["processing", "submitted", "completed", "skipped"],
              },
            },
          ],
        },
        {
          $set: {
            "mediaAnalysis.status": "queued",
            "mediaAnalysis.workflowId": start.workflowId,
            "mediaAnalysis.kind": requestedMediaType,
            "mediaAnalysis.sourceId": input.sourceId || null,
            "mediaAnalysis.requestedAt": requestedAt,
            "mediaAnalysis.contractVersion":
              CONVERSATION_MEDIA_ANALYSIS_WORKFLOW_CONTRACT_VERSION,
            "mediaAnalysis.lastError": null,
          },
        }
      );
    } finally {
      stageTimings.statusWriteMs = Math.max(
        0,
        Date.now() - statusWriteStartedAt
      );
    }

    return finish({
      queued: true,
      reason: "queued",
      workflowId: start.workflowId,
      duplicate: start.duplicate,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (acceptedStart) {
      return finish({
        queued: true,
        reason: "queued",
        workflowId: acceptedStart.workflowId,
        duplicate: acceptedStart.duplicate,
        errorMessage,
      });
    }
    const failureStatusWriteStartedAt = Date.now();
    try {
      await Message.updateOne(
        {
          _id: input.messageId,
          workspaceId: input.workspaceId,
          conversation: input.conversationId,
        },
        {
          $set: {
            "mediaAnalysis.status": "failed",
            "mediaAnalysis.workflowId": workflowId,
            "mediaAnalysis.kind": requestedMediaType,
            "mediaAnalysis.sourceId": input.sourceId || null,
            "mediaAnalysis.lastError": errorMessage,
            "mediaAnalysis.completedAt": new Date(),
            "mediaAnalysis.contractVersion":
              CONVERSATION_MEDIA_ANALYSIS_WORKFLOW_CONTRACT_VERSION,
          },
        }
      );
    } finally {
      stageTimings.statusWriteMs =
        (stageTimings.statusWriteMs || 0) +
        Math.max(0, Date.now() - failureStatusWriteStartedAt);
    }
    return finish({
      queued: false,
      reason: "publish_failed",
      workflowId,
      errorMessage,
    });
  }
}
