import { BULK_CAMPAIGN_DISPATCH_EXECUTION_SOURCES } from "@icecore/scenario-contracts";
import mongoose from "mongoose";

const CampaignDeliveryTaskSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    workspaceId: { type: String, required: true, index: true },
    scenarioId: { type: String, required: true, index: true },
    nodeId: { type: String, required: true, index: true },
    conversationId: { type: String, default: null, index: true },
    campaignId: { type: String, default: null, index: true },
    executionSource: {
      type: String,
      enum: [...BULK_CAMPAIGN_DISPATCH_EXECUTION_SOURCES],
      default: "scenario_schedule",
      index: true,
    },
    channel: {
      type: String,
      enum: ["whatsapp", "telegram", "email"],
      required: true,
      index: true,
    },
    provider: {
      type: String,
      enum: ["meta", "telegram", "postmark"],
      required: true,
      index: true,
    },
    deliveryMode: {
      type: String,
      enum: ["single", "batch"],
      default: "single",
      index: true,
    },
    audienceSource: {
      type: String,
      enum: ["explicit", "dynamic", "birthday"],
      required: true,
    },
    requiresRevalidation: { type: Boolean, default: false },
    sourceId: { type: String, default: null, index: true },
    recipientPhone: { type: String, default: null },
    recipientChatId: { type: String, default: null },
    recipientEmail: { type: String, default: null },
    recipientName: { type: String, default: null },
    recipientHash: { type: String, default: null, index: true },
    templateName: { type: String, default: null },
    templateLanguage: { type: String, default: null },
    templateCategory: {
      type: String,
      enum: ["MARKETING", "UTILITY", "AUTHENTICATION", null],
      default: null,
    },
    templateComponents: { type: mongoose.Schema.Types.Mixed, default: null },
    messageText: { type: String, default: null },
    emailTemplateKey: { type: String, default: null },
    emailTemplateModel: { type: mongoose.Schema.Types.Mixed, default: null },
    emailSubjectOverride: { type: String, default: null },
    emailMessageStream: { type: String, default: null },
    nextInternalLabel: { type: String, default: null },
    dispatchAt: { type: Date, required: true, index: true },
    dispatchExpiresAt: { type: Date, default: null },
    campaignStartedAt: { type: Date, default: null },
    scheduleId: { type: String, default: null, index: true },
    scheduledFor: { type: Date, default: null, index: true },
    runKey: { type: String, default: null, index: true },
    status: {
      type: String,
      enum: [
        "pending",
        "processing",
        "completed",
        "retry",
        "failed_terminal",
        "skipped",
      ],
      default: "pending",
      index: true,
    },
    attempts: { type: Number, default: 0 },
    processingStartedAt: { type: Date, default: null },
    processingLeaseId: { type: String, default: null, index: true },
    processingLeaseHeartbeatAt: { type: Date, default: null },
    providerAttemptStartedAt: { type: Date, default: null },
    providerAttemptSourceId: { type: String, default: null },
    providerAttemptPhoneNumberId: { type: String, default: null },
    providerAttemptRecipient: { type: String, default: null },
    completedAt: { type: Date, default: null },
    skipReason: { type: String, default: null },
    lastError: { type: String, default: null },
    idempotencyKey: { type: String, required: true, unique: true },
    scheduleVersion: { type: Number, default: 0 },
    wakeMethod: { type: String, default: null },
    wakeMessageId: { type: String, default: null, index: true },
    wakeScheduledFor: { type: Date, default: null },
    wakePublishedAt: { type: Date, default: null },
    wakeCancelledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

CampaignDeliveryTaskSchema.index({ status: 1, dispatchAt: 1 });
CampaignDeliveryTaskSchema.index({
  workspaceId: 1,
  status: 1,
  dispatchAt: 1,
});
CampaignDeliveryTaskSchema.index({
  campaignId: 1,
  status: 1,
  dispatchAt: 1,
});
CampaignDeliveryTaskSchema.index({
  scheduleId: 1,
  scheduledFor: 1,
  status: 1,
});

const CampaignDeliveryTask =
  mongoose.models.CampaignDeliveryTask ||
  mongoose.model("CampaignDeliveryTask", CampaignDeliveryTaskSchema);

export default CampaignDeliveryTask;
