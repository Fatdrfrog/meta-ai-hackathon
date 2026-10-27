import mongoose from "mongoose";

export const SCENARIO_FLOW_SUBMITTED_MESSAGE_INDEX_NAME =
  "scenario_flow_events_submitted_message_v2";
export const SCENARIO_FLOW_SUBMITTED_MESSAGE_INDEX_KEYS = {
  workspaceId: 1,
  conversationId: 1,
  outboundMessageId: 1,
  eventType: 1,
} as const;
export const SCENARIO_FLOW_SUBMITTED_MESSAGE_INDEX_OPTIONS = {
  name: SCENARIO_FLOW_SUBMITTED_MESSAGE_INDEX_NAME,
  unique: true,
  partialFilterExpression: {
    outboundMessageId: { $type: "string" as const },
    eventType: "submitted",
  },
};
export const SCENARIO_FLOW_SUBMITTED_TOKEN_INDEX_NAME =
  "scenario_flow_events_submitted_unbound_token_v2";
export const SCENARIO_FLOW_SUBMITTED_TOKEN_INDEX_KEYS = {
  workspaceId: 1,
  conversationId: 1,
  flowId: 1,
  flowToken: 1,
  eventType: 1,
} as const;
export const SCENARIO_FLOW_SUBMITTED_TOKEN_INDEX_OPTIONS = {
  name: SCENARIO_FLOW_SUBMITTED_TOKEN_INDEX_NAME,
  unique: true,
  partialFilterExpression: {
    flowToken: { $type: "string" as const },
    outboundMessageId: null,
    eventType: "submitted",
  },
};
export const SCENARIO_FLOW_SUBMITTED_LEGACY_INDEX_NAME =
  "workspaceId_1_conversationId_1_flowId_1_flowToken_1_eventType_1";

const ScenarioFlowEventSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    workspaceId: { type: String, required: true, index: true },
    sourceId: { type: String, default: null, index: true },
    conversationId: { type: String, required: true, index: true },
    customerWaId: { type: String, default: null, index: true },
    evaluationId: { type: String, default: null, index: true },
    scenarioId: { type: String, default: null, index: true },
    scenarioName: { type: String, default: null },
    actionNodeId: { type: String, default: null },
    flowId: { type: String, required: true, index: true },
    flowToken: { type: String, default: null, index: true },
    outboundMessageId: { type: String, default: null, index: true },
    eventType: {
      type: String,
      enum: ["sent", "read", "submitted"],
      required: true,
      index: true,
    },
    eventAt: { type: Date, required: true, index: true },
    responseJson: { type: String, default: null },
  },
  { timestamps: true }
);

// Cohort reports start with a bounded send window and join exact submission instances.
ScenarioFlowEventSchema.index({
  workspaceId: 1,
  eventType: 1,
  eventAt: 1,
  sourceId: 1,
});
ScenarioFlowEventSchema.index({
  workspaceId: 1,
  conversationId: 1,
  eventType: 1,
  eventAt: 1,
  _id: 1,
});
ScenarioFlowEventSchema.index({
  workspaceId: 1,
  conversationId: 1,
  flowToken: 1,
  eventAt: 1,
});

ScenarioFlowEventSchema.index(
  {
    workspaceId: 1,
    outboundMessageId: 1,
    eventType: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      outboundMessageId: { $type: "string" },
      eventType: { $in: ["sent", "read"] },
    },
  }
);

ScenarioFlowEventSchema.index(
  {
    workspaceId: 1,
    eventAt: -1,
  },
  {
    name: "scenario_flow_events_workspace_event_at_desc",
    partialFilterExpression: {
      scenarioId: { $type: "string" },
    },
  }
);

ScenarioFlowEventSchema.index(
  {
    workspaceId: 1,
    evaluationId: 1,
    eventAt: -1,
  },
  {
    name: "scenario_flow_events_workspace_evaluation_event_at_desc",
    partialFilterExpression: {
      evaluationId: { $type: "string" },
    },
  }
);

ScenarioFlowEventSchema.index(
  SCENARIO_FLOW_SUBMITTED_MESSAGE_INDEX_KEYS,
  SCENARIO_FLOW_SUBMITTED_MESSAGE_INDEX_OPTIONS
);
ScenarioFlowEventSchema.index(
  SCENARIO_FLOW_SUBMITTED_TOKEN_INDEX_KEYS,
  SCENARIO_FLOW_SUBMITTED_TOKEN_INDEX_OPTIONS
);

export const ScenarioFlowEvent =
  mongoose.models.ScenarioFlowEvent ||
  mongoose.model("ScenarioFlowEvent", ScenarioFlowEventSchema);
