import mongoose from "mongoose";
import { resolveTtlSeconds, SCENARIO_TRIGGER_LOG_RETENTION } from "@/lib/scenarios/ttl-utils";

const ScenarioTriggerLogSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    workspaceId: { type: String, required: true, index: true },
    conversationId: { type: String, required: true, index: true },
    scenarioId: { type: String, required: true },
    scenarioName: { type: String, default: null },
    evaluationId: { type: String, default: null },
    scenarioPriority: { type: Number, default: null },
    candidateOrder: { type: Number, default: null },
    matchingRole: { type: String, default: null },
    result: { type: String, default: null, index: true },
    winnerScenarioId: { type: String, default: null },
    shadowedByScenarioId: { type: String, default: null },
    shadowedByOrder: { type: Number, default: null },
    triggerType: { type: String, default: null },
    eventKind: { type: String, required: true },
    matched: { type: Boolean, required: true },
    mismatchReason: { type: String, default: null },
    selectedActionNodeId: { type: String, default: null },
    selectedActionType: { type: String, default: null },
    branchNodeIds: { type: [String], default: [] },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
    evaluatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

ScenarioTriggerLogSchema.index({
  workspaceId: 1,
  scenarioId: 1,
  evaluatedAt: -1,
});
ScenarioTriggerLogSchema.index({
  workspaceId: 1,
  evaluatedAt: -1,
});
ScenarioTriggerLogSchema.index({
  workspaceId: 1,
  conversationId: 1,
  evaluatedAt: -1,
});
ScenarioTriggerLogSchema.index(
  { evaluatedAt: 1 },
  {
    expireAfterSeconds: resolveTtlSeconds(SCENARIO_TRIGGER_LOG_RETENTION),
  }
);

export const ScenarioTriggerLog =
  mongoose.models.ScenarioTriggerLog ||
  mongoose.model("ScenarioTriggerLog", ScenarioTriggerLogSchema);
