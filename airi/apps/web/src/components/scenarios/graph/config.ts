import type { ScenarioNodeKind } from "@/components/scenarios/types";
import { MarkerType } from "@xyflow/react";

export type ScenarioHandleRule = {
  inputHandleId: string | null;
  outputHandleId: string | null;
};

export const SCENARIO_HANDLE_RULES: Record<
  ScenarioNodeKind,
  ScenarioHandleRule
> = {
  bulk: {
    inputHandleId: "left-target",
    outputHandleId: "right-source",
  },
  trigger: {
    inputHandleId: null,
    outputHandleId: "right-source",
  },
  context: {
    inputHandleId: "left-target",
    outputHandleId: "right-source",
  },
  logic: {
    inputHandleId: "left-target",
    outputHandleId: "right-source",
  },
  action: {
    inputHandleId: "left-target",
    outputHandleId: "right-source",
  },
  scenario_link: {
    inputHandleId: "left-target",
    outputHandleId: null,
  },
};

export const DEFAULT_SCENARIO_EDGE_STYLE = {
  type: "default" as const,
  markerEnd: { type: MarkerType.ArrowClosed },
};
