import type { ScenarioTriggerConfig } from "@icecore/scenario-contracts";
import { normalizeClientMessageTriggerConfig } from "@icecore/scenario-contracts";
import { migrateLegacyTriggerNodeData } from "@/lib/scenarios/legacy-trigger-adapter";

export function normalizeScenarioTriggerConfig(params: {
  nodeData?: unknown;
}): ScenarioTriggerConfig {
  const migrated = migrateLegacyTriggerNodeData(params.nodeData);
  return normalizeClientMessageTriggerConfig(migrated.triggerConfig);
}

export function resolveScenarioTrigger(
  nodeData: unknown
): ScenarioTriggerConfig {
  return normalizeScenarioTriggerConfig({ nodeData });
}
