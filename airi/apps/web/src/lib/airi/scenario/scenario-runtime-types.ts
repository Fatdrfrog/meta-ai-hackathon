import type { ScenarioActionType } from "@icecore/scenario-contracts";
import type {
  AiriScenarioRuntimeConfig,
  ScenarioRuntimeBlockedAction,
} from "@icecore/airi-runtime/scenario-runtime-types";
import type { CampaignProductOutcome } from "@/lib/scenarios/campaign-product-routing";
import type { ScenarioTriggerLogMeta } from "@/lib/scenarios/trigger-log-meta";

export type ScenarioRuntimeBuildResult = {
  runtime: AiriScenarioRuntimeConfig | null;
  blockedScenarioAction?: ScenarioRuntimeBlockedAction;
  triggerNodeId?: string | null;
  mismatchReason?:
    | "trigger_mismatch"
    | "flow_no_matching_action"
    | "action_channel_mismatch"
    | CampaignProductOutcome;
  selectedActionNodeId?: string;
  selectedActionType?: ScenarioActionType;
  selectedBranchNodeIds?: string[];
  meta?: ScenarioTriggerLogMeta | null;
};

export type ScenarioEvaluationContextSnapshot = {
  classificationCategory: string | null;
  internalLabels: string[];
  funnelStage: string | null;
  hasPurchaseHistory: boolean;
  isNewCustomer: boolean;
};

export type ContextBinding = {
  allItems: boolean;
  itemIds: Set<string>;
};
