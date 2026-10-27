export const WHATSAPP_CALL_WORKFLOW = "whatsappCallWorkflow";
export const WHATSAPP_CALL_WORKFLOW_CONTRACT_VERSION = 1;

export const WHATSAPP_CALL_SESSION_EVENT_SIGNAL = "whatsapp.call.sessionEvent";
export const WHATSAPP_CALL_COMMAND_SIGNAL = "whatsapp.call.command";
export const WHATSAPP_CALL_STATE_QUERY = "whatsapp.call.state";

export const WHATSAPP_CALL_LOAD_SESSION_ACTIVITY = "whatsapp.call.loadSession";
export const WHATSAPP_CALL_PREPARE_MEDIA_ACTIVITY =
  "whatsapp.call.prepareMedia";
export const WHATSAPP_CALL_CREATE_COMMAND_ACTIVITY =
  "whatsapp.call.createCommand";
export const WHATSAPP_CALL_SEND_COMMAND_ACTIVITY = "whatsapp.call.sendCommand";
export const WHATSAPP_CALL_MARK_COMMAND_ACTIVITY = "whatsapp.call.markCommand";
export const WHATSAPP_CALL_EMIT_REALTIME_ACTIVITY =
  "whatsapp.call.emitRealtime";
export const WHATSAPP_CALL_START_RECORDING_ACTIVITY =
  "whatsapp.call.startRecording";
export const WHATSAPP_CALL_FINALIZE_RECORDING_ACTIVITY =
  "whatsapp.call.finalizeRecording";
export const WHATSAPP_CALL_POLL_TRANSCRIPTION_ACTIVITY =
  "whatsapp.call.pollTranscription";
export const WHATSAPP_CALL_TRANSCRIPTION_DRAIN_WORKFLOW =
  "whatsappCallTranscriptionDrainWorkflow";
export const WHATSAPP_CALL_TRANSCRIPTION_DRAIN_WORKFLOW_CONTRACT_VERSION = 1;
export const WHATSAPP_CALL_TRANSCRIPTION_DRAIN_ACTIVITY =
  "whatsapp.call.transcriptionDrain";
export const WHATSAPP_CALL_TRANSCRIPTION_DRAIN_SCHEDULE_ID =
  "whatsapp-call-transcriptions:drain";
export const WHATSAPP_CALL_TRANSCRIPTION_DRAIN_SCHEDULE_INTERVAL_MS = 60 * 1000;
export const WHATSAPP_CALL_TRANSCRIPTION_DRAIN_SCHEDULE_CATCHUP_WINDOW_MS =
  5 * 60 * 1000;
export const WHATSAPP_CALL_TRANSCRIPTION_DRAIN_DEFAULT_LIMIT = 50;
export const WHATSAPP_CALL_TRANSCRIPTION_DRAIN_MAX_LIMIT = 500;

export type WhatsAppCallLifecycleState =
  | "unknown"
  | "incoming"
  | "pre_accepted"
  | "accepted"
  | "ringing"
  | "active"
  | "terminated"
  | "missed"
  | "failed";

export type WhatsAppCallCommandAction =
  | "pre_accept"
  | "accept"
  | "reject"
  | "terminate";

export type WhatsAppCallSessionSignal = {
  contractVersion: number;
  workspaceId: string;
  sourceId?: string | null;
  callSessionId: string;
  callId: string;
  conversationId?: string | null;
  phoneNumberId?: string | null;
  state: WhatsAppCallLifecycleState;
  sessionSdp?: string | null;
  sessionSdpType?: string | null;
  receivedAt?: string | null;
};

export type WhatsAppCallCommandSignal = {
  contractVersion: number;
  commandId: string;
  workspaceId: string;
  callSessionId: string;
  callId: string;
  action: WhatsAppCallCommandAction;
  sdp?: string | null;
  requestedAt?: string | null;
};

export type WhatsAppCallStateQueryResult = {
  workflowId: string;
  workspaceId: string;
  sourceId: string | null;
  callSessionId: string;
  callId: string;
  conversationId: string | null;
  phoneNumberId: string | null;
  lastSessionState: WhatsAppCallLifecycleState;
  mediaPrepared: boolean;
  connectorAccepted: boolean;
  connectorSessionId: string | null;
  sdpAnswer: string | null;
  autoPreAcceptCommandId: string | null;
  autoPreAcceptStatus: "pending" | "sent" | "failed" | null;
  recordingStartAttempted: boolean;
  recordingStarted: boolean;
  recordingEgressId: string | null;
  recordingFinalized: boolean;
  transcriptionRequestId: string | null;
  transcriptionStatus: string | null;
  transcriptionPollAttempts: number;
  pendingSessionSignals: number;
  pendingCommands: number;
  processedCommandIds: string[];
  ended: boolean;
  updatedAt: string;
};

export type WhatsAppCallWorkflowInput = {
  contractVersion: number;
  workflowId: string;
  workspaceId: string;
  sourceId?: string | null;
  callSessionId: string;
  callId: string;
  conversationId?: string | null;
  phoneNumberId?: string | null;
  startedAt?: string | null;
  initialSession?: WhatsAppCallSessionSignal | null;
  carryover?: {
    state?: Partial<WhatsAppCallStateQueryResult> | null;
    pendingSessionSignals?: WhatsAppCallSessionSignal[] | null;
    pendingCommandSignals?: WhatsAppCallCommandSignal[] | null;
    processedCommandIds?: string[] | null;
    processedCount?: number | null;
  } | null;
};

export type WhatsAppCallLoadSessionActivityInput = {
  workspaceId: string;
  callSessionId: string;
  callId: string;
};

export type WhatsAppCallLoadSessionActivityResult = {
  exists: boolean;
  state: WhatsAppCallLifecycleState;
  conversationId?: string | null;
  phoneNumberId?: string | null;
  sessionSdp?: string | null;
  sessionSdpType?: string | null;
};

export type WhatsAppCallPrepareMediaActivityInput = {
  workspaceId: string;
  sourceId?: string | null;
  callSessionId: string;
  callId: string;
  sessionSdp: string;
};

export type WhatsAppCallPrepareMediaActivityResult = {
  mediaReady: boolean;
  roomName: string | null;
  connectorSessionId: string | null;
  sdpAnswer: string | null;
  providerAccepted?: boolean | null;
  reason?: string | null;
};

export type WhatsAppCallSendCommandActivityInput = WhatsAppCallCommandSignal;

export type WhatsAppCallCreateCommandActivityInput = {
  workspaceId: string;
  sourceId?: string | null;
  callSessionId: string;
  callId: string;
  action: WhatsAppCallCommandAction;
  requestedBy?: string | null;
  correlationId: string;
  request?: Record<string, unknown> | null;
};

export type WhatsAppCallCreateCommandActivityResult = {
  commandId: string;
  status: "pending" | "sent" | "failed";
  correlationId: string;
};

export type WhatsAppCallSendCommandActivityResult = {
  commandId: string;
  action: WhatsAppCallCommandAction;
  status: "sent" | "failed";
  providerResponse?: unknown;
  providerError?: unknown;
};

export type WhatsAppCallMarkCommandActivityInput =
  WhatsAppCallSendCommandActivityResult;

export type WhatsAppCallMarkCommandActivityResult = {
  commandId: string;
  status: "sent" | "failed";
};

export type WhatsAppCallEmitRealtimeActivityInput = {
  workspaceId: string;
  conversationId: string;
  callSessionId: string;
  state: WhatsAppCallLifecycleState;
  reason?: "session" | "command" | string | null;
  dedupeKeySuffix?: string | null;
};

export type WhatsAppCallEmitRealtimeActivityResult = {
  emitted: boolean;
};

export type WhatsAppCallAnalyticsExportEvent = {
  rowId: string;
  workspaceId: string;
  sourceId: string | null;
  callId: string;
  callSessionId: string;
  conversationId: string | null;
  phoneNumberId: string | null;
  direction: string | null;
  state: WhatsAppCallLifecycleState;
  durationSeconds: number | null;
  answerLatencyMs: number | null;
  terminationReason: string | null;
  errorCode: number | null;
  errorMessage: string | null;
  finalizedAt: string;
};

export type WhatsAppCallStartRecordingActivityInput = {
  workspaceId: string;
  callSessionId: string;
  callId: string;
  startedAt?: string | null;
};

export type WhatsAppCallStartRecordingActivityResult = {
  skipped: boolean;
  recordingId: string | null;
  recordingObjectPath: string | null;
  egressStarted: boolean;
  egressId: string | null;
  transcriptStatus: string;
  reason?: string | null;
};

export type WhatsAppCallPollTranscriptionActivityInput = {
  workspaceId: string;
  callSessionId: string;
  callId: string;
  operationName?: string | null;
};

export type WhatsAppCallPollTranscriptionActivityResult = {
  skipped: boolean;
  status: "not_requested" | "processing" | "completed" | "failed";
  transcriptionRequestId: string | null;
  transcriptTextPath: string | null;
  errorMessage?: string | null;
  progressPercent?: number | null;
  reason?: string | null;
};

export type WhatsAppCallTranscriptionDrainWorkflowInput = {
  contractVersion: number;
  limit?: number | null;
};

export type WhatsAppCallTranscriptionDrainActivityInput =
  WhatsAppCallTranscriptionDrainWorkflowInput;

export type WhatsAppCallTranscriptionDrainActivityResult = {
  scanned: number;
  processing: number;
  completed: number;
  failed: number;
  skipped: number;
};

export type WhatsAppCallTranscriptionDrainWorkflowResult =
  WhatsAppCallTranscriptionDrainActivityResult;

export type WhatsAppCallFinalizeRecordingActivityInput = {
  workspaceId: string;
  callSessionId: string;
  callId: string;
  finalizedAt?: string | null;
};

export type WhatsAppCallFinalizeRecordingActivityResult = {
  skipped: boolean;
  recordingId: string | null;
  recordingObjectPath: string | null;
  transcriptStatus: string;
  transcriptionRequestId: string | null;
  transcriptTextPath: string | null;
  retentionExpiresAt: string | null;
  bigQueryExportRowId: string | null;
  analyticsExported: boolean;
  reason?: string | null;
};

export function isTerminalWhatsAppCallState(
  state: WhatsAppCallLifecycleState,
): boolean {
  return state === "terminated" || state === "missed" || state === "failed";
}

export function sanitizeWhatsAppCallWorkflowIdPart(value: string): string {
  return String(value || "unknown")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 180);
}

export function buildWhatsAppCallWorkflowId(params: {
  workspaceId: string;
  phoneNumberId?: string | null;
  callId: string;
}): string {
  return [
    "whatsapp-call",
    sanitizeWhatsAppCallWorkflowIdPart(params.workspaceId),
    sanitizeWhatsAppCallWorkflowIdPart(params.phoneNumberId || "unknown-phone"),
    sanitizeWhatsAppCallWorkflowIdPart(params.callId),
  ].join(":");
}
