import {
  WHATSAPP_FLOW_PROVIDER_STATUSES,
  type EditableWhatsAppFlowConfig,
  type ManagedWhatsAppFlowProvisioningProjection,
} from "@icecore/scenario-contracts";

import type { SafeEndpointPhoneSecurityState } from "./endpoint-security-contract";

export const WHATSAPP_FLOW_PROVISIONING_STAGES = [
  "CREATING_FLOW",
  "ATTACHING_APPLICATION",
  "ENSURING_PHONE_KEYS",
  "UPLOADING_JSON",
  "PUBLISHING",
  "READING_BACK",
  "COMPLETED",
] as const;

export const WHATSAPP_FLOW_PROVISIONING_STATUSES = [
  "RUNNING",
  "FAILED",
  "COMPLETED",
  "SUPERSEDED",
  "MANUALLY_RESOLVED",
] as const;

export const WHATSAPP_FLOW_PROVISIONING_RELEASE_MODES = [
  "linear",
  "data_endpoint",
] as const;

export const WHATSAPP_FLOW_PROVISIONING_PROVIDER_STATUSES =
  WHATSAPP_FLOW_PROVIDER_STATUSES;

export type WhatsAppFlowProvisioningStage =
  | "VALIDATING"
  | (typeof WHATSAPP_FLOW_PROVISIONING_STAGES)[number];
type WhatsAppFlowProvisioningStatus =
  (typeof WHATSAPP_FLOW_PROVISIONING_STATUSES)[number];

export type ProvisionWhatsAppFlowRequest = {
  workspaceId: string;
  sourceId: string;
  scenarioId: string;
  nodeId: string;
  editableConfig: EditableWhatsAppFlowConfig;
};

export const WHATSAPP_FLOW_PROVISIONING_FAILURE_CODES = [
  "WHATSAPP_FLOW_PROVISIONING_INVALID_INPUT",
  "WHATSAPP_FLOW_PROVISIONING_ACCESS_DENIED",
  "WHATSAPP_FLOW_PROVISIONING_SOURCE_BINDING_CHANGED",
  "WHATSAPP_FLOW_PROVISIONING_INVALID_RESPONSE",
  "WHATSAPP_FLOW_PROVISIONING_FAILED",
  "WHATSAPP_FLOW_PROVISIONING_POLICY_DISABLED",
  "WHATSAPP_FLOW_PROVISIONING_LEGACY_DISABLED",
  "WHATSAPP_FLOW_PROVISIONING_WORKSPACE_DISABLED",
  "WHATSAPP_FLOW_PROVISIONING_TARGET_INVALID",
  "WHATSAPP_FLOW_PROVISIONING_TEMPLATE_REBIND_REQUIRED",
  "WHATSAPP_FLOW_PROVISIONING_ACTIVE_SCENARIO_MIGRATION_REQUIRED",
  "WHATSAPP_FLOW_PROVISIONING_SOURCE_REBIND_REQUIRED",
  "WHATSAPP_FLOW_PROVISIONING_CONTEXT_FAILED",
  "WHATSAPP_FLOW_PROVISIONING_PHONE_INVENTORY_EMPTY",
  "WHATSAPP_FLOW_PROVISIONING_ENDPOINT_FAILED",
  "WHATSAPP_FLOW_PROVISIONING_OPERATION_FAILED",
  "WHATSAPP_FLOW_PROVISIONING_MARKER_AMBIGUOUS",
  "WHATSAPP_FLOW_PROVISIONING_CREATE_FAILED",
  "WHATSAPP_FLOW_PROVISIONING_CLONE_SOURCE_UNAVAILABLE",
  "WHATSAPP_FLOW_PROVISIONING_PROVIDER_MISMATCH",
  "WHATSAPP_FLOW_PROVISIONING_APPLICATION_FAILED",
  "WHATSAPP_FLOW_PROVISIONING_PHONE_KEYS_NOT_READY",
  "WHATSAPP_FLOW_PROVISIONING_JSON_INVALID",
  "WHATSAPP_FLOW_PROVISIONING_PUBLISH_FAILED",
  "WHATSAPP_FLOW_PROVISIONING_READBACK_NOT_PUBLISHED",
] as const;

export type WhatsAppFlowProvisioningFailureCode =
  (typeof WHATSAPP_FLOW_PROVISIONING_FAILURE_CODES)[number];

export type SafeWhatsAppFlowValidationError = {
  message: string;
  path?: string;
};

type PersistedScenarioProjection = {
  projection: ManagedWhatsAppFlowProvisioningProjection;
  scenarioRevision: { finalUpdatedAt: string };
};

export type WhatsAppFlowProvisioningResult =
  | (PersistedScenarioProjection & {
      ok: true;
      operationId: string;
      status: "COMPLETED";
      stage: "COMPLETED";
      projection: ManagedWhatsAppFlowProvisioningProjection & {
        flowId: string;
        providerStatus: "PUBLISHED";
      };
      phones: SafeEndpointPhoneSecurityState[];
      validationErrors: [];
    })
  | ({
      ok: false;
      operationId?: string;
      status?: WhatsAppFlowProvisioningStatus;
      stage: WhatsAppFlowProvisioningStage;
      phones: SafeEndpointPhoneSecurityState[];
      validationErrors: SafeWhatsAppFlowValidationError[];
      error: {
        code: WhatsAppFlowProvisioningFailureCode;
        message: string;
        retryable: boolean;
        providerCode?: number;
        providerSubcode?: number;
      };
    } & (
      | PersistedScenarioProjection
      | { projection?: never; scenarioRevision?: never }
    ));
