import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import {
  isElevenLabsSttTransientError,
  type ElevenLabsTranscriptionSubmissionResult,
  type ElevenLabsTranscriptionWebhookMetadata,
  type SubmitTranscriptionOptions,
} from "@icecore/airi-runtime/elevenlabs-stt";
import {
  assertContractVersion,
  CONVERSATION_MEDIA_ANALYSIS_ACTIVITY_CONTRACT_VERSION,
  buildConversationMediaAnalysisWorkflowId,
  type ConversationMediaAnalysisCompleteActivityInput,
  type ConversationMediaAnalysisActivityInput,
  type ConversationMediaAnalysisActivityResult,
  type ConversationMediaAnalysisFailActivityInput,
  type ConversationMediaAnalysisTriggerAiriActivityInput,
  type ConversationMediaAnalysisTriggerAiriActivityResult,
} from "@icecore/temporal";
import { heartbeat } from "@temporalio/activity";
import { createConversationTranscriptionSubmitter } from "../media/conversation-transcription";

type MessageModel = {
  findOne: (query: Record<string, unknown>) => {
    select: (fields: string) => {
      lean: () => Promise<Record<string, unknown> | null>;
    };
  };
  findOneAndUpdate: (
    query: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => {
    select: (fields: string) => {
      lean: () => Promise<Record<string, unknown> | null>;
    };
  };
  updateOne: (
    query: Record<string, unknown>,
    update: Record<string, unknown>,
  ) => Promise<unknown>;
};

type ConversationAnalysisContextHelpers = {
  getBusinessContext: (input: {
    sourceId?: string | null;
    workspaceId?: string | null;
  }) => Promise<{
    airiLanguage: "en" | "ru" | "kz" | "uz";
    workspaceId: string;
  }>;
};

type ConversationMediaAnalysisHelpers = {
  conversationTranscriptionBilling: Pick<
    Parameters<typeof createConversationTranscriptionSubmitter>[0],
    "resolveAccess" | "reserve" | "settle" | "claimSubmission"
  >;
  processAudioMessageAnalysis: (params: {
    conversationId: string;
    language: "en" | "ru" | "kz" | "uz";
    message: Record<string, unknown>;
    context: { workspaceId: string; sourceId: string | null };
    workflowId?: string | null;
    transcriptionSubmitter: Pick<
      ConversationMediaTranscriptionSubmitter,
      "submitAudio"
    >;
  }) => Promise<{
    status: "submitted" | "completed" | "skipped" | "failed";
    transcriptStored: boolean;
    analysisStored: boolean;
    providerRequestId?: string | null;
    error?: string | null;
  }>;
  processVideoMessageAnalysis: (params: {
    conversationId: string;
    language: "en" | "ru" | "kz" | "uz";
    message: Record<string, unknown>;
    context: { workspaceId: string; sourceId: string | null };
    workflowId?: string | null;
    transcriptionSubmitter: Pick<
      ConversationMediaTranscriptionSubmitter,
      "submitVideo"
    >;
  }) => Promise<{
    status: "submitted" | "completed" | "skipped" | "failed";
    transcriptStored: boolean;
    analysisStored: boolean;
    providerRequestId?: string | null;
    error?: string | null;
  }>;
  completeConversationMediaMessageAnalysis: (params: {
    conversationId: string;
    language: "en" | "ru" | "kz" | "uz";
    message: Record<string, unknown>;
    context: { workspaceId: string; sourceId: string | null };
    workflowId?: string | null;
    transcription: ConversationMediaAnalysisCompleteActivityInput["transcription"];
  }) => Promise<{
    status: "submitted" | "completed" | "skipped" | "failed";
    transcriptStored: boolean;
    analysisStored: boolean;
    providerRequestId?: string | null;
    error?: string | null;
  }>;
  serializeLogError: (error: unknown) => { message: string; name?: string };
};

type ConversationMediaTranscriptionSubmitter = {
  submitAudio: (
    mediaUrl: string,
    mimeType: string | undefined,
    metadata: ElevenLabsTranscriptionWebhookMetadata,
    options?: SubmitTranscriptionOptions,
  ) => Promise<ElevenLabsTranscriptionSubmissionResult>;
  submitVideo: (
    mediaUrl: string,
    mimeType: string | undefined,
    metadata: ElevenLabsTranscriptionWebhookMetadata,
    options?: SubmitTranscriptionOptions,
  ) => Promise<ElevenLabsTranscriptionSubmissionResult>;
};

function validateContractVersion(value: number): void {
  assertContractVersion(
    value,
    { exact: CONVERSATION_MEDIA_ANALYSIS_ACTIVITY_CONTRACT_VERSION },
    "conversation media analysis activity",
  );
}

async function loadWebRuntimeDeps(): Promise<{
  connectDB: () => Promise<unknown>;
  Message: MessageModel;
  contextHelpers: ConversationAnalysisContextHelpers;
  mediaHelpers: ConversationMediaAnalysisHelpers;
}> {
  const [mongooseModule, messageModule, contextHelpers, mediaHelpers] =
    await Promise.all([
      import("@/lib/mongoose"),
      import("@/models/message"),
      import("@/lib/classifier/conversation-analysis-context"),
      import("@/lib/classifier/conversation-media-analysis"),
    ]);

  return {
    connectDB: mongooseModule.default as () => Promise<unknown>,
    Message: messageModule.default as MessageModel,
    contextHelpers:
      contextHelpers as unknown as ConversationAnalysisContextHelpers,
    mediaHelpers: mediaHelpers as unknown as ConversationMediaAnalysisHelpers,
  };
}

function mediaTypeQuery(
  mediaType: ConversationMediaAnalysisActivityInput["mediaType"],
) {
  return mediaType === "voice" ? { $in: ["voice", "audio"] } : mediaType;
}

function buildMediaAnalysisSet(params: {
  status: "processing" | "failed";
  mediaType: ConversationMediaAnalysisActivityInput["mediaType"];
  workflowId: string;
  sourceId?: string | null;
  error?: string | null;
}) {
  return {
    "mediaAnalysis.status": params.status,
    "mediaAnalysis.kind": params.mediaType,
    "mediaAnalysis.workflowId": params.workflowId,
    "mediaAnalysis.sourceId": params.sourceId || null,
    "mediaAnalysis.contractVersion":
      CONVERSATION_MEDIA_ANALYSIS_ACTIVITY_CONTRACT_VERSION,
    "mediaAnalysis.lastError": params.error || null,
    ...(params.status === "processing"
      ? { "mediaAnalysis.startedAt": new Date() }
      : { "mediaAnalysis.completedAt": new Date() }),
  };
}

async function markFailed(params: {
  Message: MessageModel;
  input: ConversationMediaAnalysisActivityInput;
  workflowId: string;
  error: string;
}) {
  await params.Message.updateOne(
    {
      _id: params.input.messageId,
      workspaceId: params.input.workspaceId,
      conversation: params.input.conversationId,
    },
    {
      $set: buildMediaAnalysisSet({
        status: "failed",
        mediaType: params.input.mediaType,
        workflowId: params.workflowId,
        sourceId: params.input.sourceId,
        error: params.error,
      }),
    },
  );
}

export async function conversationMediaAnalysisProcessActivity(
  input: ConversationMediaAnalysisActivityInput,
): Promise<ConversationMediaAnalysisActivityResult> {
  validateContractVersion(input.contractVersion);

  const workflowId = buildConversationMediaAnalysisWorkflowId(input);
  const { connectDB, Message, contextHelpers, mediaHelpers } =
    await loadWebRuntimeDeps();
  const transcriptionSubmitter = createConversationTranscriptionSubmitter(
    mediaHelpers.conversationTranscriptionBilling,
  );
  await connectDB();

  heartbeat({ status: "claiming", messageId: input.messageId, workflowId });

  const message = await Message.findOneAndUpdate(
    {
      _id: input.messageId,
      workspaceId: input.workspaceId,
      conversation: input.conversationId,
      mediaType: mediaTypeQuery(input.mediaType),
      $or: [
        { "mediaAnalysis.status": { $exists: false } },
        { "mediaAnalysis.status": null },
        { "mediaAnalysis.status": { $in: ["queued", "failed"] } },
        {
          "mediaAnalysis.status": "processing",
          "mediaAnalysis.workflowId": workflowId,
        },
      ],
    },
    {
      $set: buildMediaAnalysisSet({
        status: "processing",
        mediaType: input.mediaType,
        workflowId,
        sourceId: input.sourceId,
      }),
    },
    { new: true },
  )
    .select(
      "text imageUrl attachments audioAnalysis videoAnalysis mimeType mediaType mediaAnalysis",
    )
    .lean();

  if (!message) {
    const existing = await Message.findOne({
      _id: input.messageId,
      workspaceId: input.workspaceId,
      conversation: input.conversationId,
    })
      .select("mediaAnalysis mediaType")
      .lean();
    const status =
      typeof existing?.mediaAnalysis === "object" &&
      existing.mediaAnalysis &&
      "status" in existing.mediaAnalysis
        ? String((existing.mediaAnalysis as { status?: unknown }).status || "")
        : "";
    return {
      messageId: input.messageId,
      mediaType: input.mediaType,
      status: status === "completed" ? "skipped" : "skipped",
      transcriptStored: false,
      analysisStored: false,
      error: existing
        ? "Conversation media analysis was already claimed or completed."
        : "Message not found for conversation media analysis.",
    };
  }

  try {
    const { airiLanguage } = await contextHelpers.getBusinessContext({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
    });
    heartbeat({ status: "processing", messageId: input.messageId, workflowId });

    const result =
      input.mediaType === "video"
        ? await mediaHelpers.processVideoMessageAnalysis({
            conversationId: input.conversationId,
            language: airiLanguage,
            message,
            context: {
              workspaceId: input.workspaceId,
              sourceId: input.sourceId || null,
            },
            workflowId,
            transcriptionSubmitter,
          })
        : await mediaHelpers.processAudioMessageAnalysis({
            conversationId: input.conversationId,
            language: airiLanguage,
            message,
            context: {
              workspaceId: input.workspaceId,
              sourceId: input.sourceId || null,
            },
            workflowId,
            transcriptionSubmitter,
          });

    heartbeat({
      status: result.status,
      messageId: input.messageId,
      workflowId,
    });

    return {
      messageId: input.messageId,
      mediaType: input.mediaType,
      ...result,
    };
  } catch (error) {
    if (isElevenLabsSttTransientError(error)) {
      airiWorkerLogger.warn("conversation.media_analysis.retryable_failure", {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        mediaType: input.mediaType,
        workflowId,
        errorMessage: error.message,
        errorKind: error.info.kind,
        providerStatus: error.info.status || null,
      });
      throw error;
    }
    const serialized = mediaHelpers.serializeLogError(error);
    airiWorkerLogger.warn("conversation.media_analysis.failed", {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      mediaType: input.mediaType,
      workflowId,
      ...serialized,
    });
    await markFailed({
      Message,
      input,
      workflowId,
      error: serialized.message,
    });
    return {
      messageId: input.messageId,
      mediaType: input.mediaType,
      status: "failed",
      transcriptStored: false,
      analysisStored: false,
      error: serialized.message,
    };
  }
}

export async function conversationMediaAnalysisCompleteActivity(
  input: ConversationMediaAnalysisCompleteActivityInput,
): Promise<ConversationMediaAnalysisActivityResult> {
  validateContractVersion(input.contractVersion);

  const { connectDB, Message, contextHelpers, mediaHelpers } =
    await loadWebRuntimeDeps();
  await connectDB();

  heartbeat({
    status: "completing",
    messageId: input.messageId,
    workflowId: input.workflowId,
    requestId: input.transcription.requestId,
  });

  const message = await Message.findOne({
    _id: input.messageId,
    workspaceId: input.workspaceId,
    conversation: input.conversationId,
    mediaType: mediaTypeQuery(input.mediaType),
  })
    .select(
      "text imageUrl attachments audioAnalysis videoAnalysis mimeType mediaType mediaAnalysis",
    )
    .lean();

  if (!message) {
    return {
      messageId: input.messageId,
      mediaType: input.mediaType,
      status: "failed",
      transcriptStored: false,
      analysisStored: false,
      providerRequestId: input.transcription.requestId,
      error:
        "Message not found for conversation media transcription completion.",
    };
  }

  try {
    const { airiLanguage } = await contextHelpers.getBusinessContext({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
    });
    const result = await mediaHelpers.completeConversationMediaMessageAnalysis({
      conversationId: input.conversationId,
      language: airiLanguage,
      message,
      context: {
        workspaceId: input.workspaceId,
        sourceId: input.sourceId || null,
      },
      workflowId: input.workflowId,
      transcription: input.transcription,
    });

    heartbeat({
      status: result.status,
      messageId: input.messageId,
      workflowId: input.workflowId,
      requestId: input.transcription.requestId,
    });

    return {
      messageId: input.messageId,
      mediaType: input.mediaType,
      ...result,
    };
  } catch (error) {
    const serialized = mediaHelpers.serializeLogError(error);
    airiWorkerLogger.warn("conversation.media_analysis.complete_failed", {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      mediaType: input.mediaType,
      workflowId: input.workflowId,
      requestId: input.transcription.requestId,
      ...serialized,
    });
    await markFailed({
      Message,
      input,
      workflowId: input.workflowId,
      error: serialized.message,
    });
    return {
      messageId: input.messageId,
      mediaType: input.mediaType,
      status: "failed",
      transcriptStored: false,
      analysisStored: false,
      providerRequestId: input.transcription.requestId,
      error: serialized.message,
    };
  }
}

export async function conversationMediaAnalysisFailActivity(
  input: ConversationMediaAnalysisFailActivityInput,
): Promise<ConversationMediaAnalysisActivityResult> {
  validateContractVersion(input.contractVersion);

  const { connectDB, Message } = await loadWebRuntimeDeps();
  await connectDB();
  await markFailed({
    Message,
    input,
    workflowId: input.workflowId,
    error: input.error,
  });

  return {
    messageId: input.messageId,
    mediaType: input.mediaType,
    status: "failed",
    transcriptStored: false,
    analysisStored: false,
    error: input.error,
  };
}

export async function conversationMediaAnalysisTriggerAiriActivity(
  input: ConversationMediaAnalysisTriggerAiriActivityInput,
): Promise<ConversationMediaAnalysisTriggerAiriActivityResult> {
  const startedAt = Date.now();
  const { directIngressStoredAiriConversation } = await import(
    "@/lib/temporal/airi-direct-ingress"
  );
  const result = await directIngressStoredAiriConversation(
    {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      channel: "whatsapp",
      sourceId: input.sourceId || null,
      enqueuedAt: new Date().toISOString(),
    },
    { label: "conversation-media-analysis" },
  );

  airiWorkerLogger.info("conversation.media_analysis.airi_ingress", {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    mediaType: input.mediaType,
    mediaWorkflowId: input.workflowId,
    queued: result.queued,
    reason: result.reason,
    airiWorkflowId: result.workflowId || null,
    durationMs: Date.now() - startedAt,
  });
  return result;
}
