export {};

const mockGetWhatsAppWorkspaceContext = jest.fn();
const mockResolveWhatsAppAccountContext = jest.fn();
const mockGetMetaServerAppConfig = jest.fn();
const mockAssertMutationEnabled = jest.fn();
const mockRotate = jest.fn();

class MockEndpointSecurityServiceError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "EndpointSecurityServiceError";
  }
}

jest.mock("@/lib/whatsapp/get-workspace-context", () => ({
  getWhatsAppWorkspaceContext: (...args: unknown[]) =>
    mockGetWhatsAppWorkspaceContext(...args),
}));

jest.mock("@/lib/whatsapp/account/resolution", () => ({
  resolveWhatsAppAccountContext: (...args: unknown[]) =>
    mockResolveWhatsAppAccountContext(...args),
}));

jest.mock("@/lib/meta/app-config", () => ({
  getMetaServerAppConfig: () => mockGetMetaServerAppConfig(),
}));

jest.mock("@/lib/whatsapp/flows/endpoint-security-service", () => ({
  EndpointSecurityServiceError: MockEndpointSecurityServiceError,
  assertWhatsAppFlowEndpointSecurityMutationEnabled: (...args: unknown[]) =>
    mockAssertMutationEnabled(...args),
  rotateWhatsAppFlowEndpointSecurity: (...args: unknown[]) =>
    mockRotate(...args),
}));

function postRequest(body: unknown) {
  return new Request(
    "http://localhost/api/whatsapp/flows/endpoint-security/rotate",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

const SAFE_STATUS = {
  configured: true,
  endpointUri:
    "https://public.example/api/webhooks/whatsapp/flow-endpoint/endpoint-1",
  release: {
    stage: "MANAGED",
    managedFlowEnabled: true,
    legacyFlowAllowed: false,
    legacyCutoffAt: "2026-07-30T10:00:00.000Z",
  },
  activeKey: {
    generationId: "generation-2",
    origin: "WABA_GENERATED",
    rsaKeyId: "rsa-2",
    publicKeyFingerprint: "b".repeat(64),
    signingKeyId: "signing-2",
    createdAt: "2026-07-30T10:00:00.000Z",
  },
  pendingKey: null,
  previousKeys: [],
  provisioning: { status: "READY", generationId: "generation-2" },
  phones: [],
};

describe("POST /api/whatsapp/flows/endpoint-security/rotate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetWhatsAppWorkspaceContext.mockResolvedValue({
      context: {
        credentials: {},
        membership: { role: "manager" },
        sourceId: "source-1",
        user: { id: "user-1" },
      },
    });
    mockResolveWhatsAppAccountContext.mockResolvedValue({
      accessToken: "access-token-secret",
      candidateSource: "credentials.waba_id",
      sourceId: "source-1",
      wabaId: "waba-canonical-1",
    });
    mockGetMetaServerAppConfig.mockReturnValue({
      appId: "app-server-1",
      appSecret: "app-secret-value",
    });
    mockAssertMutationEnabled.mockReturnValue(undefined);
    mockRotate.mockResolvedValue(SAFE_STATUS);
  });

  it("calls only dedicated rotate with the canonical server-resolved context", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      postRequest({ workspaceId: "workspace-1", sourceId: "source-1" })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SAFE_STATUS);
    expect(mockRotate).toHaveBeenCalledWith({
      context: {
        workspaceId: "workspace-1",
        sourceId: "source-1",
        wabaId: "waba-canonical-1",
        applicationId: "app-server-1",
        accessToken: "access-token-secret",
      },
    });
    expect(mockRotate).toHaveBeenCalledTimes(1);
    expect(mockAssertMutationEnabled).toHaveBeenCalledWith("ROTATE");
  });

  it("blocks legacy-window rotation after authorization and before live probing", async () => {
    mockAssertMutationEnabled.mockImplementationOnce(() => {
      throw new MockEndpointSecurityServiceError(
        "WHATSAPP_FLOW_ENDPOINT_SECURITY_POLICY_DISABLED",
        "Dedicated WhatsApp Flow endpoint key rotation is not enabled"
      );
    });
    const { POST } = await import("./route");
    const response = await POST(
      postRequest({ workspaceId: "workspace-1", sourceId: "source-1" })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_POLICY_DISABLED",
        message: "Dedicated WhatsApp Flow endpoint key rotation is not enabled",
      },
    });
    expect(mockGetWhatsAppWorkspaceContext).toHaveBeenCalledTimes(1);
    expect(mockAssertMutationEnabled).toHaveBeenCalledWith("ROTATE");
    expect(mockResolveWhatsAppAccountContext).not.toHaveBeenCalled();
    expect(mockRotate).not.toHaveBeenCalled();
  });

  it("passes through the exact-source authorization failure before live probing", async () => {
    const { NextResponse } = await import("next/server");
    mockGetWhatsAppWorkspaceContext.mockResolvedValue({
      error: NextResponse.json(
        { error: "WhatsApp source not found" },
        { status: 404 }
      ),
    });
    const { POST } = await import("./route");

    const response = await POST(
      postRequest({ workspaceId: "workspace-1", sourceId: "wrong-source" })
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "WhatsApp source not found",
    });
    expect(mockResolveWhatsAppAccountContext).not.toHaveBeenCalled();
    expect(mockRotate).not.toHaveBeenCalled();
  });

  it.each([
    [null],
    [[]],
    [{ workspaceId: "workspace-1", sourceId: "source-1", fence: 7 }],
    [
      {
        workspaceId: "workspace-1",
        sourceId: "source-1",
        privateKey: "private-secret",
      },
    ],
  ])("rejects a non-contract body before authorization", async body => {
    const { POST } = await import("./route");
    const response = await POST(postRequest(body));

    expect(response.status).toBe(400);
    expect(mockGetWhatsAppWorkspaceContext).not.toHaveBeenCalled();
    expect(mockRotate).not.toHaveBeenCalled();
  });

  it.each([
    [
      "policy",
      "WHATSAPP_FLOW_ENDPOINT_SECURITY_POLICY_DISABLED",
      "Dedicated WhatsApp Flow endpoint key rotation is not enabled",
    ],
    [
      "history",
      "WHATSAPP_FLOW_ENDPOINT_SECURITY_HISTORY_CAPACITY",
      "WhatsApp Flow endpoint key history is at capacity",
    ],
    [
      "not configured",
      "WHATSAPP_FLOW_ENDPOINT_SECURITY_NOT_CONFIGURED",
      "Ensure endpoint security before rotation",
    ],
    [
      "mutation",
      "WHATSAPP_FLOW_ENDPOINT_SECURITY_MUTATION_CONFLICT",
      "Endpoint security mutation is busy",
    ],
    [
      "binding",
      "WHATSAPP_FLOW_ENDPOINT_SECURITY_BINDING_CONFLICT",
      "Endpoint security binding changed",
    ],
    [
      "foreign key",
      "WHATSAPP_FLOW_ENDPOINT_SECURITY_FOREIGN_KEY",
      "A phone uses a different public key",
    ],
  ])("maps a typed $label conflict to 409", async (_label, code, message) => {
    mockRotate.mockRejectedValueOnce(
      new MockEndpointSecurityServiceError(code, message)
    );
    const { POST } = await import("./route");

    const response = await POST(
      postRequest({ workspaceId: "workspace-1", sourceId: "source-1" })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code, message } });
  });
});
