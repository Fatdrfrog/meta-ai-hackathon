import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";

export type AttachWhatsAppFlowProviderReferenceRequest = {
  workspaceId: string;
  sourceId: string;
  scenarioId: string;
  nodeId: string;
  flowId: string;
  expectedUpdatedAt: string;
};

export type WhatsAppFlowProviderReferenceFailureCode =
  | "INVALID_INPUT"
  | "ACCESS_DENIED"
  | "SOURCE_BINDING_CHANGED"
  | "PROVIDER_UNAVAILABLE"
  | "FLOW_NOT_OWNED"
  | "FLOW_JSON_UNAVAILABLE"
  | "FLOW_INVALID"
  | "MANAGED_ENDPOINT_INCOMPATIBLE"
  | "FLOW_BRANCHES_CONNECTED"
  | "SCENARIO_NOT_FOUND"
  | "TARGET_INVALID"
  | "ACTIVE_SCENARIO_REQUIRES_PUBLISHED_FLOW"
  | "SCENARIO_REVISION_CONFLICT"
  | "ATTACH_FAILED";

export type WhatsAppFlowProviderReferenceResult =
  | {
      ok: true;
      flowConfig: WhatsAppFlowConfig;
      previousScenarioUpdatedAt: string;
      scenarioUpdatedAt: string;
    }
  | {
      ok: false;
      error: {
        code: WhatsAppFlowProviderReferenceFailureCode;
        message: string;
        retryable: boolean;
      };
      previousScenarioUpdatedAt?: string | null;
      scenarioUpdatedAt?: string | null;
    };
