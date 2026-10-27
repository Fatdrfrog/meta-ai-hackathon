const mockLogin = jest.fn();
jest.mock("@/lib/facebook-sdk", () => ({
  loadFacebookSDK: async () => ({ login: mockLogin }),
  createFacebookLoginCallback: (callback: unknown) => callback,
}));

import { connectMetaAdsMcpViaFacebookSdk } from "./connect-meta-ads-mcp-client";
import { evaluateMetaAdsMcpReadiness } from "./meta-ads-mcp-readiness";

describe("unified Meta Ads SDK connection", () => {
  const originalFetch = global.fetch;
  const mockFetch = jest.fn();
  const readiness = evaluateMetaAdsMcpReadiness({
    hasMetaAdsSource: true,
    credentials: {},
  });
  const reporting = {
    canRead: true,
    reason: "ready",
    selectedAdAccountId: "act_1",
  };
  const session = {
    appConfigured: true,
    configId: "ai-config",
    reportingConfigId: "reporting-config",
    readiness,
    reporting,
    adAccounts: [{ id: "act_1" }],
    selectedAdAccountId: "act_1",
  };
  const complete = {
    success: true,
    reportingReady: true,
    reporting,
    readiness,
    adAccounts: [{ id: "act_1" }],
    selectedAdAccountId: "act_1",
  };
  const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    global.fetch = mockFetch;
    mockLogin.mockImplementation(callback =>
      callback({ authResponse: { code: "fixture-code" } })
    );
    mockFetch.mockResolvedValueOnce(response(session));
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("uses reporting configuration and never calls optional MCP after reporting authorization", async () => {
    mockFetch.mockResolvedValueOnce(response(complete));
    expect(
      await connectMetaAdsMcpViaFacebookSdk({
        workspaceId: "workspace-1",
        intent: "reporting",
        allowCreateGraphSource: true,
      })
    ).toMatchObject({ ok: true, reportingReady: true });
    expect(mockLogin).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ config_id: "reporting-config" })
    );
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toMatchObject({
      intent: "reporting",
      allowCreateGraphSource: true,
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps Graph success when optional AI provider recheck fails", async () => {
    mockFetch
      .mockResolvedValueOnce(
        response({
          ...complete,
          readiness: { ...readiness, missingReadScopes: [] },
        })
      )
      .mockRejectedValueOnce(new Error("Provider unavailable"));
    expect(
      await connectMetaAdsMcpViaFacebookSdk({ workspaceId: "workspace-1" })
    ).toMatchObject({ ok: true, reportingReady: true });
    expect(mockLogin).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ config_id: "ai-config" })
    );
    expect(mockFetch.mock.calls[2][0]).toContain("&probe=1");
  });

  it("returns ready AI capability only from the separate provider check", async () => {
    mockFetch
      .mockResolvedValueOnce(
        response({
          ...complete,
          readiness: { ...readiness, missingReadScopes: [] },
        })
      )
      .mockResolvedValueOnce(
        response({
          ...session,
          readiness: {
            ...readiness,
            state: "ready",
            canRead: true,
            canWrite: false,
          },
        })
      );
    expect(
      await connectMetaAdsMcpViaFacebookSdk({ workspaceId: "workspace-1" })
    ).toMatchObject({
      ok: true,
      readiness: { state: "ready", canRead: true, canWrite: false },
    });
  });

  it("keeps unavailable prior selection and exposes account recovery instead of false reporting success", async () => {
    mockFetch.mockResolvedValueOnce(
      response({
        ...complete,
        reportingReady: false,
        reporting: {
          canRead: false,
          reason: "account_unavailable",
          selectedAdAccountId: "act_old",
        },
        selectedAdAccountId: "act_old",
      })
    );
    expect(
      await connectMetaAdsMcpViaFacebookSdk({
        workspaceId: "workspace-1",
        intent: "reporting",
      })
    ).toMatchObject({
      ok: true,
      reportingReady: false,
      reporting: { reason: "account_unavailable" },
      selectedAdAccountId: "act_old",
      adAccounts: [{ id: "act_1" }],
    });
  });

  it("returns a structured error code for safe localized failure copy", async () => {
    mockFetch.mockResolvedValueOnce(
      response({ error: "ads_permissions_missing" }, 400)
    );
    expect(
      await connectMetaAdsMcpViaFacebookSdk({
        workspaceId: "workspace-1",
        intent: "reporting",
      })
    ).toMatchObject({ ok: false, errorCode: "ads_permissions_missing" });
  });

  it("identifies missing operator configuration without opening the customer's Meta login", async () => {
    mockFetch
      .mockReset()
      .mockResolvedValueOnce(response({ ...session, reportingConfigId: null }));
    expect(
      await connectMetaAdsMcpViaFacebookSdk({
        workspaceId: "workspace-1",
        intent: "reporting",
      })
    ).toMatchObject({ ok: false, errorCode: "server_not_configured" });
    expect(mockLogin).not.toHaveBeenCalled();
  });
});
