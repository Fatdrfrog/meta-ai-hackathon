import mongoose from "mongoose";

const AIRI_TURN_CONTEXT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const AIRI_CONVERSATION_INGRESS_QUEUE_INDEX = {
  keys: { ingressNextRetryAt: 1, _id: 1 },
  options: {
    name: "airi_conversation_ingress_queue",
    partialFilterExpression: {
      ingressKind: "conversation_turn",
      ingressStatus: "pending",
    },
  },
} as const;

export const AIRI_TIMER_REPLAN_INGRESS_UNIQUE_INDEX = {
  keys: { ingressKey: 1 },
  options: {
    name: "airi_timer_replan_ingress_unique",
    unique: true,
    partialFilterExpression: { ingressKey: { $type: "string" } },
  },
} as const;

export function buildAiriIngressKeyFilter(key: string | readonly string[]) {
  // MongoDB needs the partial index predicate explicitly in the query to use it.
  return {
    ingressKey: {
      ...(typeof key === "string" ? { $eq: key } : { $in: key }),
      $type: "string" as const,
    },
  };
}

export const AIRI_TIMER_REPLAN_INGRESS_QUEUE_INDEX = {
  keys: {
    ingressStatus: 1,
    ingressNextRetryAt: 1,
    ingressLeaseExpiresAt: 1,
    _id: 1,
  },
  options: {
    name: "airi_timer_replan_ingress_queue",
    partialFilterExpression: {
      triggerEventKind: "timer_replan",
      ingressStatus: "pending",
    },
  },
} as const;

export const AIRI_TIMER_REPLAN_INGRESS_SCENARIO_STATUS_INDEX = {
  keys: {
    workspaceId: 1,
    "timerReplanIngress.expectedScenarioId": 1,
    ingressStatus: 1,
    updatedAt: -1,
    _id: 1,
  },
  options: {
    name: "airi_timer_replan_ingress_scenario_status",
    partialFilterExpression: {
      triggerEventKind: "timer_replan",
      "timerReplanIngress.expectedScenarioId": { $type: "string" },
    },
  },
} as const;

const TimerReplanIngressSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    expectedScenarioId: { type: String, default: null },
    expectedConditionNodeId: { type: String, default: null },
    expectedSourceActionNodeId: { type: String, default: null },
    messageDate: { type: Date, default: null },
    enqueuedAt: { type: Date, default: null },
    completion: {
      type: String,
      enum: ["signaled", "superseded"],
      default: null,
    },
    completedAt: { type: Date, default: null },
  },
  { _id: false }
);

const AiriTurnContextSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    turnContextId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    ingressKey: { type: String },
    ingressKind: { type: String, enum: ["conversation_turn"] },
    messageDate: { type: Date },
    enqueuedAt: { type: Date },
    textPreview: { type: String, maxlength: 240 },
    ingressStatus: {
      type: String,
      enum: ["pending", "signaled", "failed"],
      default: null,
    },
    ingressAttempts: { type: Number, default: 0 },
    ingressAttemptedAt: { type: Date, default: null },
    ingressSignaledAt: { type: Date, default: null },
    ingressWorkflowId: { type: String, default: null },
    ingressLastError: { type: String, default: null },
    ingressNextRetryAt: { type: Date, default: null },
    ingressLeaseToken: { type: String, default: null },
    ingressLeaseExpiresAt: { type: Date, default: null },
    turnPreparation: { type: mongoose.Schema.Types.Mixed, select: false },
    turnDisposition: { type: mongoose.Schema.Types.Mixed },
    workspaceId: { type: String, required: true, index: true },
    conversationId: { type: String, required: true, index: true },
    messageId: { type: String, required: true, index: true },
    messageRecoveryRevision: { type: String },
    whatsappMessageContentUnavailable: { type: Boolean },
    channel: { type: String, default: null },
    sourceId: { type: String, default: null },
    triggerEventKind: { type: String, default: null },
    scenarioOverrideId: { type: String, default: null },
    scenarioTriggerNodeId: { type: String, default: null },
    skipTriggerMatch: { type: Boolean, default: false },
    proactiveTrigger: { type: Boolean, default: false },
    suppressGeneralAutoReply: { type: Boolean, default: false },
    quickReplyPayload: { type: String, default: null },
    whatsAppFlowResponseJson: { type: String, default: null },
    followUpInstruction: { type: String, default: null },
    systemPromptOverride: { type: String, default: null },
    timerReplanIngress: {
      type: TimerReplanIngressSchema,
      default: undefined,
    },
    chatId: { type: mongoose.Schema.Types.Mixed, default: null },
    chatType: { type: String, default: null },
    channelHints: {
      telegram: {
        businessConnectionId: { type: String, default: null },
      },
      whatsapp: {
        recipientTarget: {
          kind: {
            type: String,
            enum: ["phone", "bsuid", "parent_bsuid"],
            default: null,
          },
          value: { type: String, default: null },
        },
        contactName: { type: String, default: null },
        username: { type: String, default: null },
        referral: {
          sourceType: { type: String, default: null },
          sourceId: { type: String, default: null },
          sourceUrl: { type: String, default: null },
          sourcePlatform: { type: String, default: null },
          campaignId: { type: String, default: null },
          campaignName: { type: String, default: null },
          adSetId: { type: String, default: null },
          adSetName: { type: String, default: null },
          headline: { type: String, default: null },
          body: { type: String, default: null },
          mediaType: { type: String, default: null },
          imageUrl: { type: String, default: null },
          videoUrl: { type: String, default: null },
          thumbnailUrl: { type: String, default: null },
          ctwaClid: { type: String, default: null },
          welcomeMessageText: { type: String, default: null },
        },
      },
      instagram: {
        recipientId: { type: String, default: null },
        threadType: {
          type: String,
          enum: ["dm", "comment"],
          default: null,
        },
        commentId: { type: String, default: null },
        authMethod: { type: String, default: null },
        referral: {
          source: { type: String, default: null },
          type: { type: String, default: null },
          ref: { type: String, default: null },
          adId: { type: String, default: null },
          productId: { type: String, default: null },
          productRetailerId: { type: String, default: null },
          title: { type: String, default: null },
          body: { type: String, default: null },
          mediaUrl: { type: String, default: null },
          sourceUrl: { type: String, default: null },
        },
      },
    },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + AIRI_TURN_CONTEXT_TTL_MS),
    },
  },
  { timestamps: true }
);

AiriTurnContextSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
AiriTurnContextSchema.index(
  AIRI_CONVERSATION_INGRESS_QUEUE_INDEX.keys,
  AIRI_CONVERSATION_INGRESS_QUEUE_INDEX.options
);
AiriTurnContextSchema.index(
  AIRI_TIMER_REPLAN_INGRESS_UNIQUE_INDEX.keys,
  AIRI_TIMER_REPLAN_INGRESS_UNIQUE_INDEX.options
);
AiriTurnContextSchema.index(
  { workspaceId: 1, conversationId: 1, messageId: 1, turnContextId: 1 },
  { unique: true }
);
AiriTurnContextSchema.index(
  AIRI_TIMER_REPLAN_INGRESS_QUEUE_INDEX.keys,
  AIRI_TIMER_REPLAN_INGRESS_QUEUE_INDEX.options
);
AiriTurnContextSchema.index(
  AIRI_TIMER_REPLAN_INGRESS_SCENARIO_STATUS_INDEX.keys,
  AIRI_TIMER_REPLAN_INGRESS_SCENARIO_STATUS_INDEX.options
);

export default mongoose.models.AiriTurnContext ||
  mongoose.model("AiriTurnContext", AiriTurnContextSchema);
