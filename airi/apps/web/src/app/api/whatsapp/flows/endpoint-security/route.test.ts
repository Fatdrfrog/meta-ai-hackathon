export {};

const mockGetWhatsAppWorkspaceContext = jest.fn();
const mockResolveWhatsAppAccountContext = jest.fn();
const mockGetMetaServerAppConfig = jest.fn();
const mockGetStatus = jest.fn();

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
  getWhatsAppFlowEndpointSecurityStatus: (...args: unknown[]) =>
    mockGetStatus(...args),
}));

function configuredStatus() {
  return {
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
      generationId: "generation-1",
      origin: "WABA_GENERATED",
      rsaKeyId: "rsa-1",
      publicKeyFingerprint: "a".repeat(64),
      signingKeyId: "signing-1",
      createdAt: "2026-07-30T10:00:00.000Z",
    },
    pendingKey: null,
    previousKeys: [],
    provisioning: { status: "READY", generationId: "generation-1" },
    phones: [
      {
        phoneNumberId: "phone-1",
        generationId: "generation-1",
        publicKeyFingerprint: "a".repeat(64),
        signatureStatus: "VALID",
        stage: "READY",
        updatedAt: "2026-07-30T10:00:00.000Z",
      },
    ],
  };
}

describe("GET /api/whatsapp/flows/endpoint-security", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetWhatsAppWorkspaceContext.mockResolvedValue({
      context: {
        accessToken: "access-token-secret",
        credentials: {},
        membership: { role: "manager" },
        sourceId: "source-1",
        user: { id: "user-1" },
        wabaId: "waba-stored-1",
      },
    });
    mockResolveWhatsAppAccountContext.mockResolvedValue({
      accessToken: "access-token-secret",
      candidateSource: "credentials.waba_id",
      sourceId: "source-1",
      wabaId: "waba-server-1",
    });
    mockGetMetaServerAppConfig.mockReturnValue({
      appId: "app-server-1",
      appSecret: "app-secret-value",
    });
    mockGetStatus.mockResolvedValue(configuredStatus());
  });

  it("authorizes the exact source, resolves server bindings, and returns only the safe status", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost/api/whatsapp/flows/endpoint-security?workspaceId=workspace-1&sourceId=source-1"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toEqual(configuredStatus());
    expect(mockGetWhatsAppWorkspaceContext).toHaveBeenCalledWith(
      "workspace-1",
      { requireManager: true, sourceId: "source-1" }
    );
    expect(mockResolveWhatsAppAccountContext).not.toHaveBeenCalled();
    expect(mockGetStatus).toHaveBeenCalledWith({
      context: {
        workspaceId: "workspace-1",
        sourceId: "source-1",
        wabaId: "waba-stored-1",
        applicationId: "app-server-1",
        accessToken: "access-token-secret",
      },
    });
    const serialized = JSON.stringify(body);
    for (const secret of [
      "access-token-secret",
      "app-secret-value",
      "waba-server-1",
      "PRIVATE KEY",
      "ciphertext",
      "ownerToken",
      "fence",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it.each([
    ["missing source", "?workspaceId=workspace-1"],
    [
      "duplicate workspace",
      "?workspaceId=workspace-1&workspaceId=workspace-2&sourceId=source-1",
    ],
    [
      "unknown input",
      "?workspaceId=workspace-1&sourceId=source-1&wabaId=request-waba",
    ],
    [
      "key material input",
      "?workspaceId=workspace-1&sourceId=source-1&publicKey=secret-pem",
    ],
  ])("rejects $label before authorization", async (_label, query) => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        `http://localhost/api/whatsapp/flows/endpoint-security${query}`
      )
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_INVALID_INPUT",
        message: "workspaceId and sourceId are required exactly once",
      },
    });
    expect(mockGetWhatsAppWorkspaceContext).not.toHaveBeenCalled();
    expect(mockGetStatus).not.toHaveBeenCalled();
  });

  it("passes through the existing manager authorization response", async () => {
    const { NextResponse } = await import("next/server");
    mockGetWhatsAppWorkspaceContext.mockResolvedValue({
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });
    const { GET } = await import("./route");

    const response = await GET(
      new Request(
        "http://localhost/api/whatsapp/flows/endpoint-security?workspaceId=workspace-1&sourceId=source-1"
      )
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(mockResolveWhatsAppAccountContext).not.toHaveBeenCalled();
    expect(mockGetStatus).not.toHaveBeenCalled();
  });

  it.each([
    [
      "mismatched source",
      {
        accessToken: "access-token-secret",
        sourceId: "source-other",
        wabaId: "waba-stored-1",
      },
    ],
    [
      "missing WABA",
      { accessToken: "access-token-secret", sourceId: "source-1" },
    ],
    ["missing token", { sourceId: "source-1", wabaId: "waba-stored-1" }],
  ])(
    "fails closed on a $label without provider or service work",
    async (_label, values) => {
      mockGetWhatsAppWorkspaceContext.mockResolvedValue({
        context: {
          ...values,
          credentials: {},
          membership: { role: "manager" },
          user: { id: "user-1" },
        },
      });
      const { GET } = await import("./route");
      const response = await GET(
        new Request(
          "http://localhost/api/whatsapp/flows/endpoint-security?workspaceId=workspace-1&sourceId=source-1"
        )
      );

      expect(response.status).toBe(500);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({
        error: {
          code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_CONFIGURATION_FAILED",
          message: "Stored WhatsApp Flow endpoint credentials are incomplete",
        },
      });
      expect(mockResolveWhatsAppAccountContext).not.toHaveBeenCalled();
      expect(mockGetStatus).not.toHaveBeenCalled();
    }
  );

  it("maps application configuration and unknown service failures to fixed safe responses without provider I/O", async () => {
    mockGetMetaServerAppConfig.mockImplementationOnce(() => {
      throw new Error("app secret configuration detail");
    });
    const { GET } = await import("./route");
    const first = await GET(
      new Request(
        "http://localhost/api/whatsapp/flows/endpoint-security?workspaceId=workspace-1&sourceId=source-1"
      )
    );
    const firstBody = await first.json();

    expect(first.status).toBe(500);
    expect(firstBody).toEqual({
      error: {
        code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_CONFIGURATION_FAILED",
        message: "WhatsApp Flow endpoint security is not configured",
      },
    });
    expect(JSON.stringify(firstBody)).not.toContain("app secret");
    expect(mockResolveWhatsAppAccountContext).not.toHaveBeenCalled();

    mockGetStatus.mockRejectedValueOnce(new Error("database password secret"));
    const second = await GET(
      new Request(
        "http://localhost/api/whatsapp/flows/endpoint-security?workspaceId=workspace-1&sourceId=source-1"
      )
    );
    const secondBody = await second.json();

    expect(second.status).toBe(500);
    expect(secondBody).toEqual({
      error: {
        code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_STORAGE_FAILED",
        message: "WhatsApp Flow endpoint security request failed",
      },
    });
    expect(JSON.stringify(secondBody)).not.toContain("password");
    expect(mockResolveWhatsAppAccountContext).not.toHaveBeenCalled();
  });
});
