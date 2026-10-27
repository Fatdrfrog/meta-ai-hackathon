export type WhatsAppFlowEndpointSecurityRequest = {
  workspaceId: string;
  sourceId: string;
};

export type WhatsAppFlowEndpointSecurityErrorCode =
  | "WHATSAPP_FLOW_ENDPOINT_SECURITY_INVALID_INPUT"
  | "WHATSAPP_FLOW_ENDPOINT_SECURITY_POLICY_DISABLED"
  | "WHATSAPP_FLOW_ENDPOINT_SECURITY_NOT_CONFIGURED"
  | "WHATSAPP_FLOW_ENDPOINT_SECURITY_MUTATION_CONFLICT"
  | "WHATSAPP_FLOW_ENDPOINT_SECURITY_BINDING_CONFLICT"
  | "WHATSAPP_FLOW_ENDPOINT_SECURITY_FOREIGN_KEY"
  | "WHATSAPP_FLOW_ENDPOINT_SECURITY_HISTORY_CAPACITY"
  | "WHATSAPP_FLOW_ENDPOINT_SECURITY_PROVIDER_FAILED"
  | "WHATSAPP_FLOW_ENDPOINT_SECURITY_CONFIGURATION_FAILED"
  | "WHATSAPP_FLOW_ENDPOINT_SECURITY_STORAGE_FAILED";

export type SafeEndpointKeyDescriptor = {
  generationId: string;
  origin: "LEGACY_IMPORTED" | "WABA_GENERATED";
  rsaKeyId: string;
  publicKeyFingerprint: string;
  signingKeyId: string;
  createdAt: string;
  activatedAt?: string;
  retireAt?: string;
};

export type SafeEndpointPhoneSecurityState = {
  phoneNumberId: string;
  generationId?: string;
  publicKeyFingerprint?: string;
  signatureStatus: "UNKNOWN" | "VALID" | "INVALID";
  stage: "DISCOVERED" | "UPLOADING" | "VERIFYING" | "READY" | "FAILED";
  verifiedAt?: string;
  updatedAt: string;
  lastError?: SafeEndpointSecurityError;
};

export type SafeEndpointSecurityError = {
  code: string;
  message: string;
  stage?: string;
  providerCode?: number;
  providerSubcode?: number;
  retryable: boolean;
  at: string;
};

export type SafeEndpointSecurityStatus = {
  configured: boolean;
  endpointUri: string | null;
  release: {
    stage: "DARK" | "INACTIVE" | "LEGACY_WINDOW" | "MANAGED" | "INVALID";
    managedFlowEnabled: boolean;
    legacyFlowAllowed: boolean;
    legacyCutoffAt: string | null;
  };
  activeKey: SafeEndpointKeyDescriptor | null;
  pendingKey: SafeEndpointKeyDescriptor | null;
  previousKeys: SafeEndpointKeyDescriptor[];
  provisioning: {
    status: "NOT_STARTED" | "IN_PROGRESS" | "READY" | "FAILED";
    generationId?: string;
    updatedAt?: string;
    lastError?: SafeEndpointSecurityError;
  };
  phones: SafeEndpointPhoneSecurityState[];
};

export type SafeEndpointIdentity = Pick<
  SafeEndpointSecurityStatus,
  "configured" | "endpointUri" | "release" | "activeKey" | "pendingKey"
> & {
  expectedGenerationId: string;
};
