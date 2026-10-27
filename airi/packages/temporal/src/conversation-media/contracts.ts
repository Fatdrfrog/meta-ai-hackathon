export const CONVERSATION_MEDIA_ANALYSIS_WORKFLOW =
  "conversationMediaAnalysisWorkflow";

export const CONVERSATION_MEDIA_ANALYSIS_WORKFLOW_CONTRACT_VERSION = 1;
export const CONVERSATION_MEDIA_ANALYSIS_ACTIVITY_CONTRACT_VERSION = 1;

export const CONVERSATION_MEDIA_ANALYSIS_ACTIVITY =
  "conversation.mediaAnalysis.process";
export const CONVERSATION_MEDIA_ANALYSIS_COMPLETE_ACTIVITY =
  "conversation.mediaAnalysis.complete";
export const CONVERSATION_MEDIA_ANALYSIS_FAIL_ACTIVITY =
  "conversation.mediaAnalysis.fail";
export const CONVERSATION_MEDIA_ANALYSIS_TRIGGER_AIRI_ACTIVITY =
  "conversation.mediaAnalysis.triggerAiri";
export const CONVERSATION_MEDIA_TRANSCRIPTION_COMPLETED_SIGNAL =
  "conversationMediaTranscriptionCompleted";
export const CONVERSATION_MEDIA_ANALYSIS_TRIGGER_AIRI_SIGNAL =
  "conversationMediaAnalysisTriggerAiri";

export const CONVERSATION_MEDIA_ANALYSIS_TASK_QUEUE = "airi-media";
export const CONVERSATION_MEDIA_TRANSCRIPTION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export type ConversationMediaAnalysisType = "audio" | "voice" | "video";

export type ConversationMediaAnalysisWorkflowInput = {
  contractVersion: number;
  workspaceId: string;
  conversationId: string;
  messageId: string;
  mediaType: ConversationMediaAnalysisType;
  sourceId?: string | null;
  triggerAiriAfterAnalysis?: boolean;
};

export type ConversationMediaAnalysisActivityInput =
  ConversationMediaAnalysisWorkflowInput;

export type ConversationMediaAnalysisFailActivityInput =
  ConversationMediaAnalysisWorkflowInput & {
    workflowId: string;
    error: string;
  };

export type ConversationMediaAnalysisTriggerAiriActivityInput =
  ConversationMediaAnalysisWorkflowInput & {
    workflowId: string;
  };

export type ConversationMediaAnalysisTriggerAiriActivityResult = {
  queued: boolean;
  reason:
    | "queued"
    | "already_signaled"
    | "runtime_disabled"
    | "conversation_disabled"
    | "message_not_inbound";
  workflowId?: string | null;
};

export type ConversationMediaTranscriptionStatus = "completed" | "failed";

export type ConversationMediaTranscriptionCompletedSignalInput = {
  requestId: string;
  status: ConversationMediaTranscriptionStatus;
  text?: string | null;
  languageCode?: string | null;
  error?: string | null;
  payload?: Record<string, unknown> | null;
  receivedAt?: string | null;
};

export type ConversationMediaAnalysisCompleteActivityInput =
  ConversationMediaAnalysisWorkflowInput & {
    workflowId: string;
    transcription: ConversationMediaTranscriptionCompletedSignalInput;
  };

export type ConversationMediaAnalysisActivityResult = {
  messageId: string;
  status: "submitted" | "completed" | "skipped" | "failed";
  mediaType: ConversationMediaAnalysisType;
  transcriptStored: boolean;
  analysisStored: boolean;
  providerRequestId?: string | null;
  error?: string | null;
};

export type ConversationMediaAnalysisWorkflowResult =
  ConversationMediaAnalysisActivityResult;

export function sanitizeConversationMediaAnalysisWorkflowIdPart(
  value: string,
): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-");
}

export function buildConversationMediaAnalysisWorkflowId(params: {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  mediaType: ConversationMediaAnalysisType;
}): string {
  return [
    "conversation-media-analysis",
    sanitizeConversationMediaAnalysisWorkflowIdPart(
      params.workspaceId || "workspace",
    ),
    sanitizeConversationMediaAnalysisWorkflowIdPart(
      params.conversationId || "conversation",
    ),
    sanitizeConversationMediaAnalysisWorkflowIdPart(params.messageId || "msg"),
    sanitizeConversationMediaAnalysisWorkflowIdPart(
      params.mediaType || "media",
    ),
  ].join(":");
}
