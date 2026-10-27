import {
  SCENARIO_ACTION_BRANCH_TRANSITIONS,
  SCENARIO_ACTION_FIXED_OUTPUT_TRANSITIONS,
} from "@/lib/scenarios/transition-registry";
import type { ScenarioNodeData } from "../types";

export type ActionBranchSourceHandleDescriptor = {
  outputHandleId: string;
  usesBranchHandles: (nodeData: ScenarioNodeData) => boolean;
  parseSourceHandleId?: (handleId: string) => unknown;
};

export const ACTION_BRANCH_SOURCE_HANDLE_DESCRIPTORS: ActionBranchSourceHandleDescriptor[] =
  SCENARIO_ACTION_BRANCH_TRANSITIONS.map(descriptor => ({
    outputHandleId: descriptor.outputHandleId,
    usesBranchHandles: descriptor.usesBranchHandles,
    parseSourceHandleId: descriptor.parseSourceHandleId,
  }));

export type ActionFixedOutputSourceHandleDescriptor = {
  getSourceHandleIds: (nodeData: ScenarioNodeData) => string[];
  usesFixedHandles: (nodeData: ScenarioNodeData) => boolean;
  matchesSourceHandle: (handleId: string | null | undefined) => boolean;
};

export const ACTION_FIXED_OUTPUT_SOURCE_HANDLE_DESCRIPTORS: ActionFixedOutputSourceHandleDescriptor[] =
  SCENARIO_ACTION_FIXED_OUTPUT_TRANSITIONS.map(descriptor => ({
    getSourceHandleIds: descriptor.getSourceHandleIds,
    usesFixedHandles: descriptor.usesFixedHandles,
    matchesSourceHandle: descriptor.matchesSourceHandle,
  }));
