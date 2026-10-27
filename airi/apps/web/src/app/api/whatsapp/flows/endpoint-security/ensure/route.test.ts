export {};

const mockGetWhatsAppWorkspaceContext = jest.fn();
const mockResolveWhatsAppAccountContext = jest.fn();
const mockGetMetaServerAppConfig = jest.fn();
const mockAssertMutationEnabled = jest.fn();
const mockEnsure = jest.fn();

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
  ensureWhatsAppFlowEndpointSecurity: (...args: unknown[]) =>
    mockEnsure(...args),
}));

function postRequest(body: unknown, raw = false) {
  return new Request(
    "http://localhost/api/whatsapp/flows/endpoint-security/ensure",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw ? String(body) : JSON.stringify(body),
    }
  );
}

function readyStatus() {
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
    phones: [],
  };
}

describe("POST /api/whatsapp/flows/endpoint-security/ensure", () => {
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
    mockEnsure.mockResolvedValue(readyStatus());
  });

  it("authorizes first, live-resolves the canonical WABA, and calls manager ensure with server-only bindings", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      postRequest({ workspaceId: "workspace-1", sourceId: "source-1" })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(readyStatus());
    expect(mockGetWhatsAppWorkspaceContext).toHaveBeenCalledWith(
      "workspace-1",
      { requireManager: true, sourceId: "source-1" }
    );
    expect(mockResolveWhatsAppAccountContext).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      probeEdge: "phone_numbers",
      probeFields: "id",
      logScope: "Flow endpoint security phone inventory",
      failureMessage:
        "Unable to resolve the WhatsApp Business Account for Flow endpoint security",
    });
    expect(mockEnsure).toHaveBeenCalledWith({
      context: {
        workspaceId: "workspace-1",
        sourceId: "source-1",
        wabaId: "waba-canonical-1",
        applicationId: "app-server-1",
        accessToken: "access-token-secret",
      },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("access-token-secret");
    expect(serialized).not.toContain("app-secret-value");
    expect(serialized).not.toContain("waba-canonical-1");
  });

  it.each([
    ["missing source", { workspaceId: "workspace-1" }],
    [
      "request WABA",
      {
        workspaceId: "workspace-1",
        sourceId: "source-1",
        wabaId: "request-waba",
      },
    ],
    [
      "phone subset",
      {
        workspaceId: "workspace-1",
        sourceId: "source-1",
        phoneNumberIds: ["phone-1"],
      },
    ],
    [
      "endpoint URI",
      {
        workspaceId: "workspace-1",
        sourceId: "source-1",
        endpointUri: "https://attacker.example",
      },
    ],
    [
      "application ID",
      {
        workspaceId: "workspace-1",
        sourceId: "source-1",
        applicationId: "request-app",
      },
    ],
    [
      "generation",
      {
        workspaceId: "workspace-1",
        sourceId: "source-1",
        expectedGenerationId: "request-generation",
      },
    ],
    [
      "key material",
      {
        workspaceId: "workspace-1",
        sourceId: "source-1",
        publicKey: "-----BEGIN PUBLIC KEY-----secret",
      },
    ],
  ])("rejects $label before authorization", async (_label, body) => {
    const { POST } = await import("./route");
    const response = await POST(postRequest(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_INVALID_INPUT",
        message: "Request body must contain only workspaceId and sourceId",
      },
    });
    expect(mockGetWhatsAppWorkspaceContext).not.toHaveBeenCalled();
    expect(mockResolveWhatsAppAccountContext).not.toHaveBeenCalled();
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "{"],
    ["array JSON", "[]"],
    ["null JSON", "null"],
  ])("rejects $label without live resolution", async (_label, rawBody) => {
    const { POST } = await import("./route");
    const response = await POST(postRequest(rawBody, true));

    expect(response.status).toBe(400);
    expect(mockResolveWhatsAppAccountContext).not.toHaveBeenCalled();
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it.each(["declared", "streamed"])(
    "rejects a %s oversized JSON body before authorization",
    async transport => {
      const rawBody = `${" ".repeat(1_100)}{"workspaceId":"workspace-1","sourceId":"source-1"}`;
      const headers = { "Content-Type": "application/json" };
      const request =
        transport === "declared"
          ? new Request(
              "http://localhost/api/whatsapp/flows/endpoint-security/ensure",
              {
                method: "POST",
                headers: {
                  ...headers,
                  "Content-Length": String(
                    new TextEncoder().encode(rawBody).byteLength
                  ),
                },
                body: rawBody,
              }
            )
          : new Request(
              "http://localhost/api/whatsapp/flows/endpoint-security/ensure",
              {
                method: "POST",
                headers,
                body: new ReadableStream<Uint8Array>({
                  start(controller) {
                    const bytes = new TextEncoder().encode(rawBody);
                    controller.enqueue(bytes.slice(0, 700));
                    controller.enqueue(bytes.slice(700));
                    controller.close();
                  },
                }),
                duplex: "half",
              } as RequestInit & { duplex: "half" }
            );

      const { POST } = await import("./route");
      const response = await POST(request);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_INVALID_INPUT",
          message: "Request body must contain only workspaceId and sourceId",
        },
      });
      expect(mockGetWhatsAppWorkspaceContext).not.toHaveBeenCalled();
      expect(mockResolveWhatsAppAccountContext).not.toHaveBeenCalled();
      expect(mockEnsure).not.toHaveBeenCalled();
    }
  );

  it("returns the canonical policy conflict after authorization and before live probing", async () => {
    mockAssertMutationEnabled.mockImplementationOnce(() => {
      throw new MockEndpointSecurityServiceError(
        "WHATSAPP_FLOW_ENDPOINT_SECURITY_POLICY_DISABLED",
        "Managed WhatsApp Flow endpoint security is not enabled"
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
        message: "Managed WhatsApp Flow endpoint security is not enabled",
      },
    });
    expect(mockGetWhatsAppWorkspaceContext).toHaveBeenCalledTimes(1);
    expect(mockAssertMutationEnabled).toHaveBeenCalledWith("ENSURE");
    expect(mockResolveWhatsAppAccountContext).not.toHaveBeenCalled();
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it("maps live account resolution and typed provider errors without leaking arbitrary details", async () => {
    mockResolveWhatsAppAccountContext.mockRejectedValueOnce(
      new Error("raw Graph access-token-secret")
    );
    const { POST } = await import("./route");
    const first = await POST(
      postRequest({ workspaceId: "workspace-1", sourceId: "source-1" })
    );
    const firstBody = await first.json();

    expect(first.status).toBe(502);
    expect(firstBody).toEqual({
      error: {
        code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_PROVIDER_FAILED",
        message: "WhatsApp account resolution failed",
      },
    });
    expect(JSON.stringify(firstBody)).not.toContain("access-token-secret");

    mockResolveWhatsAppAccountContext.mockResolvedValue({
      accessToken: "access-token-secret",
      sourceId: "source-1",
      wabaId: "waba-canonical-1",
    });
    mockEnsure.mockRejectedValueOnce(
      new MockEndpointSecurityServiceError(
        "WHATSAPP_FLOW_ENDPOINT_SECURITY_PROVIDER_FAILED",
        "WhatsApp could not verify the Flow endpoint public key"
      )
    );
    const second = await POST(
      postRequest({ workspaceId: "workspace-1", sourceId: "source-1" })
    );

    expect(second.status).toBe(502);
    expect(await second.json()).toEqual({
      error: {
        code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_PROVIDER_FAILED",
        message: "WhatsApp could not verify the Flow endpoint public key",
      },
    });
  });

  it.each([
    [
      "mismatched source",
      {
        accessToken: "access-token-secret",
        sourceId: "source-other",
        wabaId: "waba-canonical-1",
      },
    ],
    [
      "missing WABA",
      { accessToken: "access-token-secret", sourceId: "source-1" },
    ],
    ["missing token", { sourceId: "source-1", wabaId: "waba-canonical-1" }],
  ])("fails closed on a live account with $label", async (_label, account) => {
    mockResolveWhatsAppAccountContext.mockResolvedValue(account);
    const { POST } = await import("./route");
    const response = await POST(
      postRequest({ workspaceId: "workspace-1", sourceId: "source-1" })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_BINDING_CONFLICT",
        message:
          "WhatsApp account binding changed during endpoint security resolution",
      },
    });
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it("fails closed on a missing server application ID before ensure", async () => {
    mockGetMetaServerAppConfig.mockReturnValue({
      appId: "",
      appSecret: "app-secret-value",
    });
    const { POST } = await import("./route");
    const response = await POST(
      postRequest({ workspaceId: "workspace-1", sourceId: "source-1" })
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_CONFIGURATION_FAILED",
        message: "WhatsApp Flow endpoint security is not configured",
      },
    });
    expect(mockEnsure).not.toHaveBeenCalled();
  });
});
