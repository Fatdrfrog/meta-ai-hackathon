import mongoose, { type Model } from "mongoose";

export const WHATSAPP_CALL_TRANSCRIPT_STATUSES = [
  "not_requested",
  "pending",
  "processing",
  "completed",
  "failed",
] as const;

export type WhatsAppCallTranscriptStatus =
  (typeof WHATSAPP_CALL_TRANSCRIPT_STATUSES)[number];

export type WhatsAppCallRecordingDocument = mongoose.Document & {
  workspaceId: string;
  sourceId?: string | null;
  callSessionId: mongoose.Types.ObjectId | string;
  callId: string;
  recordingObjectPath?: string | null;
  transcriptStatus: WhatsAppCallTranscriptStatus;
  transcriptTextPath?: string | null;
  transcriptionRequestId?: string | null;
  transcriptionLastError?: string | null;
  transcriptCompletedAt?: Date | null;
  retentionExpiresAt?: Date | null;
  bigQueryExportRowId?: string | null;
  liveKitEgressId?: string | null;
  liveKitEgressStatus?: string | null;
  egressStartedAt?: Date | null;
  egressStoppedAt?: Date | null;
  egressLastError?: string | null;
};

const WhatsAppCallRecordingSchema = new mongoose.Schema<
  Record<string, unknown>
>(
  {
    workspaceId: { type: String, required: true, index: true },
    sourceId: { type: String, default: null, index: true },
    callSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WhatsAppCallSession",
      required: true,
      index: true,
    },
    callId: { type: String, required: true, index: true },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      default: null,
      index: true,
    },
    phoneNumberId: { type: String, default: null, index: true },
    direction: { type: String, default: null, index: true },
    state: { type: String, required: true, index: true },
    durationSeconds: { type: Number, default: null },
    answerLatencyMs: { type: Number, default: null },
    terminationReason: { type: String, default: null, index: true },
    errorCode: { type: Number, default: null, index: true },
    errorMessage: { type: String, default: null },
    recordingObjectPath: { type: String, default: null },
    transcriptStatus: {
      type: String,
      enum: WHATSAPP_CALL_TRANSCRIPT_STATUSES,
      default: "not_requested",
      required: true,
      index: true,
    },
    transcriptTextPath: { type: String, default: null },
    transcriptionRequestId: { type: String, default: null, index: true },
    transcriptionLastError: { type: String, default: null },
    transcriptCompletedAt: { type: Date, default: null, index: true },
    retentionExpiresAt: { type: Date, default: null, index: true },
    bigQueryExportRowId: { type: String, default: null, index: true },
    liveKitEgressId: { type: String, default: null, index: true },
    liveKitEgressStatus: { type: String, default: null, index: true },
    egressStartedAt: { type: Date, default: null, index: true },
    egressStoppedAt: { type: Date, default: null, index: true },
    egressLastError: { type: String, default: null },
    analyticsExportedAt: { type: Date, default: null, index: true },
    analyticsPubSubMessageId: { type: String, default: null },
    analyticsLastError: { type: String, default: null },
    finalizedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

WhatsAppCallRecordingSchema.index(
  { workspaceId: 1, callSessionId: 1 },
  { unique: true, name: "whatsapp_call_recording_session_identity" }
);
WhatsAppCallRecordingSchema.index({
  workspaceId: 1,
  callId: 1,
  updatedAt: -1,
});
WhatsAppCallRecordingSchema.index({
  workspaceId: 1,
  bigQueryExportRowId: 1,
});

const WhatsAppCallRecording =
  (mongoose.models.WhatsAppCallRecording as
    | Model<WhatsAppCallRecordingDocument>
    | undefined) ||
  mongoose.model<WhatsAppCallRecordingDocument>(
    "WhatsAppCallRecording",
    WhatsAppCallRecordingSchema
  );

export default WhatsAppCallRecording;
