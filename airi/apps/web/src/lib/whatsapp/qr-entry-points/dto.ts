import type { WhatsAppQrReadiness } from "./readiness";

export type WhatsAppQrScenarioSummary = {
  entryPointId: string;
  placementName: string;
  status: "DRAFT" | "ACTIVE" | "DETACHED" | string;
  sourceId?: string;
  hasCurrentCode: boolean;
  readiness: WhatsAppQrReadiness;
  reconcilePending: boolean;
  version: number;
};

export type WhatsAppQrCodeDetail = {
  codeId: string;
  referenceCode: string;
  providerCode?: string;
  deepLink?: string;
  prefilledMessage?: string;
  placementBindingState: string;
  routingState: string;
  providerState: string;
  version: number;
};

export type WhatsAppQrEntryPointDetail = {
  entryPoint: {
    entryPointId: string;
    workspaceId: string;
    scenarioId?: string;
    nodeId?: string;
    placementName: string;
    desiredMessage?: string;
    sourceId?: string;
    wabaId?: string;
    phoneNumberId?: string;
    currentCodeId?: string;
    status: "DRAFT" | "ACTIVE" | "DETACHED" | string;
    version: number;
    updatedAt: string;
  };
  assignment: WhatsAppQrAssignmentSummary | null;
  currentCode?: WhatsAppQrCodeDetail;
  historicalCodes: WhatsAppQrCodeDetail[];
  historicalCodesHasMore: boolean;
  canCreateReplacement: boolean;
  operationPending: boolean;
  reconcileOperation?: {
    operationId: string;
    sourceId: string;
    kind: string;
    codeId?: string;
  };
};

export type WhatsAppQrProviderCodeOption = {
  code: string;
  prefilledMessage?: string;
  deepLink?: string;
};

export type WhatsAppQrProviderCodesResponse = {
  codes: WhatsAppQrProviderCodeOption[];
  nextCursor?: string;
};

export type WhatsAppQrAssignmentSummary = {
  scenarioId: string;
  nodeId: string;
  scenarioName: string;
  scenarioStatus: "draft" | "active";
  scenarioUpdatedAt: string;
};

export type WhatsAppQrManagerListItem = {
  entryPointId: string;
  placementName: string;
  desiredMessage?: string;
  sourceId?: string;
  status: "DRAFT" | "ACTIVE" | "DETACHED";
  version: number;
  updatedAt: string;
  readiness: WhatsAppQrReadiness;
  currentCode?: {
    codeId: string;
    deepLink?: string;
    placementBindingState: string;
    routingState: string;
    providerState: string;
  };
  reconcilePending: boolean;
  assignment: WhatsAppQrAssignmentSummary | null;
};

export type WhatsAppQrManagerPage = {
  items: WhatsAppQrManagerListItem[];
  nextCursor: string | null;
};
