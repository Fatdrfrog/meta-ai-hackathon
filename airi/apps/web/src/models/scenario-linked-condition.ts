import mongoose from "mongoose";

const ScenarioLinkedConditionParentRefSchema = new mongoose.Schema<
  Record<string, unknown>
>(
  {
    parentScenarioId: { type: String, required: true, index: true },
    conditionNodeId: { type: String, required: true },
    branchType: {
      type: String,
      enum: ["user_replied", "no_reply_timeout"],
      required: true,
    },
    sourceActionNodeId: { type: String, required: true },
    scenarioLinkNodeId: { type: String, required: true },
  },
  { _id: false }
);

const ScenarioLinkedConditionSchema = new mongoose.Schema<
  Record<string, unknown>
>(
  {
    workspaceId: { type: String, required: true, index: true },
    childScenarioId: { type: String, required: true, index: true },
    childTriggerNodeId: { type: String, required: true },
    conditionType: {
      type: String,
      enum: ["user_replied", "no_reply_timeout"],
      required: true,
    },
    conditionConfig: { type: mongoose.Schema.Types.Mixed, default: {} },
    parentRefs: {
      type: [ScenarioLinkedConditionParentRefSchema],
      default: [],
    },
  },
  { timestamps: true }
);

ScenarioLinkedConditionSchema.index(
  { workspaceId: 1, childScenarioId: 1 },
  { unique: true }
);
ScenarioLinkedConditionSchema.index({
  workspaceId: 1,
  "parentRefs.parentScenarioId": 1,
});

const ScenarioLinkedCondition =
  mongoose.models.ScenarioLinkedCondition ||
  mongoose.model("ScenarioLinkedCondition", ScenarioLinkedConditionSchema);

export default ScenarioLinkedCondition;
