const mockGetWhatsAppWorkspaceContext = jest.fn();
const mockAttachWhatsAppFlowProviderReference = jest.fn();

jest.mock("@/lib/whatsapp/get-workspace-context", () => ({
  getWhatsAppWorkspaceContext: (...args: unknown[]) =>
    mockGetWhatsAppWorkspaceContext(...args),
}));

jest.mock("@/lib/whatsapp/flows/provider-reference-service", () => ({
  attachWhatsAppFlowProviderReference: (...args: unknown[]) =>
    mockAttachWhatsAppFlowProviderReference(...args),
}));

jest.mock("@/lib/meta/app-config", () => ({
  getMetaServerAppConfig: () => ({
    appId: "application-1",
    appSecret: "secret-1",
  }),
}));

import { POST } from "./route";

const VALID_BODY = {
  workspaceId: "workspace-1",
  sourceId: "source-1",
  scenarioId: "scenario-1",
  nodeId: "action-1",
  flowId: "flow-1",
  expectedUpdatedAt: "2026-08-05T10:00:00.000Z",
};

function request(body: unknown) {
  return new Request("http://localhost/api/whatsapp/flows/reference", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/whatsapp/flows/reference", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetWhatsAppWorkspaceContext.mockResolvedValue({
      context: {
        sourceId: "source-1",
        accessToken: "token-1",
        phoneNumberId: "phone-1",
        wabaId: "waba-1",
        user: { id: "user-1" },
        membership: { role: "admin" },
        credentials: {},
      },
    });
    mockAttachWhatsAppFlowProviderReference.mockResolvedValue({
      ok: true,
      flowConfig: {
        templateId: "provider_reference",
        screens: [{ id: "APPOINTMENT", title: "Appointment", fields: [] }],
        ctaText: "Open",
        flowNavigationMode: "data_endpoint",
        providerReference: {
          flowId: "flow-1",
          sourceId: "source-1",
          wabaId: "waba-1",
          providerStatus: "PUBLISHED",
        },
      },
      previousScenarioUpdatedAt: "2026-08-05T10:00:00.000Z",
      scenarioUpdatedAt: "2026-08-05T10:00:01.000Z",
    });
  });

  it("authorizes the exact source and passes only server credentials to attachment", async () => {
    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(200);
    expect(mockGetWhatsAppWorkspaceContext).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        requireManager: true,
        sourceId: "source-1",
      })
    );
    expect(mockAttachWhatsAppFlowProviderReference).toHaveBeenCalledWith({
      ...VALID_BODY,
      accessToken: "token-1",
      applicationId: "application-1",
      phoneNumberId: "phone-1",
      wabaId: "waba-1",
      updatedBy: "user-1",
    });
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      flowConfig: {
        providerReference: { flowId: "flow-1" },
      },
      previousScenarioUpdatedAt: "2026-08-05T10:00:00.000Z",
      scenarioUpdatedAt: "2026-08-05T10:00:01.000Z",
    });
  });

  it.each([
    { ...VALID_BODY, providerReference: { flowId: "forged" } },
    { ...VALID_BODY, extra: true },
    { ...VALID_BODY, expectedUpdatedAt: "not-a-date" },
  ])("rejects unknown or malformed input before authorization", async body => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "Request must contain one strict provider Flow reference",
        retryable: false,
      },
    });
    expect(mockGetWhatsAppWorkspaceContext).not.toHaveBeenCalled();
    expect(mockAttachWhatsAppFlowProviderReference).not.toHaveBeenCalled();
  });

  it("fails closed when the authorized source binding changes", async () => {
    mockGetWhatsAppWorkspaceContext.mockResolvedValueOnce({
      context: {
        sourceId: "source-2",
        accessToken: "token-1",
        wabaId: "waba-1",
        user: { id: "user-1" },
        membership: { role: "admin" },
        credentials: {},
      },
    });

    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "SOURCE_BINDING_CHANGED",
        message: "WhatsApp source binding changed; refresh and retry",
        retryable: false,
      },
    });
    expect(mockAttachWhatsAppFlowProviderReference).not.toHaveBeenCalled();
  });

  it("preserves the service conflict revision and returns HTTP 409", async () => {
    mockAttachWhatsAppFlowProviderReference.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "SCENARIO_REVISION_CONFLICT",
        message: "Scenario changed; refresh before attaching this Flow",
        retryable: false,
      },
      previousScenarioUpdatedAt: "2026-08-05T10:01:00.000Z",
      scenarioUpdatedAt: "2026-08-05T10:01:00.000Z",
    });

    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "SCENARIO_REVISION_CONFLICT" },
      previousScenarioUpdatedAt: "2026-08-05T10:01:00.000Z",
      scenarioUpdatedAt: "2026-08-05T10:01:00.000Z",
    });
  });

  it("returns a conflict without hiding connected Flow branches", async () => {
    mockAttachWhatsAppFlowProviderReference.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "FLOW_BRANCHES_CONNECTED",
        message:
          "Disconnect existing WhatsApp Flow branches before attaching a provider Flow",
        retryable: false,
      },
      previousScenarioUpdatedAt: "2026-08-05T10:00:00.000Z",
      scenarioUpdatedAt: "2026-08-05T10:00:00.000Z",
    });

    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "FLOW_BRANCHES_CONNECTED" },
      previousScenarioUpdatedAt: "2026-08-05T10:00:00.000Z",
      scenarioUpdatedAt: "2026-08-05T10:00:00.000Z",
    });
  });

  it("returns HTTP 409 for a provider Flow bound to this app's managed endpoint", async () => {
    mockAttachWhatsAppFlowProviderReference.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "MANAGED_ENDPOINT_INCOMPATIBLE",
        message:
          "This Flow uses airi.chat's managed endpoint and cannot be attached as a provider-managed reference",
        retryable: false,
      },
    });

    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "MANAGED_ENDPOINT_INCOMPATIBLE" },
    });
  });
});
