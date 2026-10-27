import {
  createClientMessageTriggerData,
  type ScenarioNodeData,
} from "@icecore/scenario-contracts";

function omitUndefinedValues<T extends object>(value: T | undefined): Partial<T> {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

export function makeClientMessageTriggerNode(
  overrides: Partial<ScenarioNodeData> = {},
): ScenarioNodeData {
  return createClientMessageTriggerData(overrides);
}

export function makeLegacyPersistedTrigger(
  triggerType: string,
  triggerConfig: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "trigger",
    triggerType,
    triggerConfig: {
      enabled: true,
      ...omitUndefinedValues(triggerConfig),
    },
  };
}
