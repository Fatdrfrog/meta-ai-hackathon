/** @jest-environment node */
const mockContext = jest.fn();
const mockUpdate = jest.fn();
const mockProvision = jest.fn();
const mockDebugToken = jest.fn();
jest.mock("@/lib/meta/debug-token", () => ({
  debugConfiguredMetaAccessToken: (...args: unknown[]) =>
    mockDebugToken(...args),
}));
jest.mock("@/lib/meta/app-config", () => ({
  getMetaServerAppConfig: () => ({ appId: "app-1", appSecret: "app-secret" }),
}));

jest.mock("@/lib/whatsapp/get-workspace-context", () => ({
  getWhatsAppWorkspaceContext: (...args: unknown[]) => mockContext(...args),
}));
jest.mock("@/lib/crypto", () => ({
  encryptString: (value: string) => ({ ciphertext: `encrypted:${value}` }),
}));
jest.mock("@/lib/whatsapp/flows/source-rebind-guard", () => ({
  updateCurrentWhatsAppSourceCredentials: (...args: unknown[]) =>
    mockUpdate(...args),
}));
jest.mock("@/lib/whatsapp/flows/source-binding-fence-store", () => ({
  WhatsAppFlowSourceBindingFenceConflictError: class extends Error {},
}));
jest.mock("@/lib/meta-ads/whatsapp-conversions-api", () => ({
  provisionWhatsAppConversionDataset: (...args: unknown[]) =>
    mockProvision(...args),
}));

import { GET, PUT } from "./route";
import { WhatsAppFlowSourceBindingFenceConflictError } from "@/lib/whatsapp/flows/source-binding-fence-store";

const params = {
  params: Promise.resolve({ workspaceId: "workspace-1", sourceId: "source-1" }),
};
const url =
  "https://airi.chat/api/workspaces/workspace-1/sources/source-1/conversions";
const credentials = {
  waba_id: "123456789",
  access_token: { ciphertext: "token" },
  unrelated: "keep",
};
const request = (action: string) =>
  new Request(url, { method: "PUT", body: JSON.stringify({ action }) });

describe("source conversion settings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContext.mockResolvedValue({
      context: {
        sourceId: "source-1",
        wabaId: "123456789",
        accessToken: "decrypted-token",
        rawCredentials: credentials,
        membership: { role: "admin" },
      },
    });
    mockProvision.mockResolvedValue("111222333");
    mockDebugToken.mockResolvedValue({
      is_valid: true,
      app_id: "app-1",
      scopes: [
        "whatsapp_business_management",
        "whatsapp_business_manage_events",
      ],
    });
    mockUpdate.mockImplementation(async ({ buildCredentials }) => ({
      credentials: buildCredentials(credentials),
    }));
  });

  it("reads source-scoped status without provisioning or exposing credentials", async () => {
    const response = await GET(new Request(url), params);
    expect(await response.json()).toEqual({
      enabled: false,
      datasetId: null,
      wabaId: "123456789",
      hasWebhookSecret: false,
      webhookEnabled: false,
      webhookUrl: "https://airi.chat/api/conversions/events/source-1",
    });
    expect(mockContext).toHaveBeenCalledWith("workspace-1", {
      sourceId: "source-1",
      requireCredentials: false,
    });
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it("requires management authorization before any mutation", async () => {
    mockContext.mockResolvedValue({
      error: new Response("Forbidden", { status: 403 }),
    });
    expect((await PUT(request("rotate_webhook_secret"), params)).status).toBe(
      403
    );
    expect(mockContext).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({ sourceId: "source-1", requireManager: true })
    );
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it("provisions only on enable and fences persistence to the validated token and WABA", async () => {
    const response = await PUT(request("enable_meta"), params);
    expect(response.status).toBe(200);
    expect(mockProvision).toHaveBeenCalledWith({
      wabaId: "123456789",
      accessToken: "decrypted-token",
    });
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        expectedWabaId: "123456789",
        expectedCredentials: expect.objectContaining({
          access_token: credentials.access_token,
        }),
      })
    );
    const saved = mockUpdate.mock.calls[0][0].buildCredentials({
      ...credentials,
      unrelated: "newer",
    });
    expect(saved.unrelated).toBe("newer");
    expect(saved.conversions_api).toMatchObject({
      enabled: true,
      dataset_id: "111222333",
      waba_id: "123456789",
    });
  });

  it("does not save enablement after a provider permission error or expose its raw error", async () => {
    mockProvision.mockRejectedValue(new Error("token=secret-provider-token"));
    const response = await PUT(request("enable_meta"), params);
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain(
      "secret-provider-token"
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it.each([
    {
      is_valid: true,
      app_id: "app-1",
      scopes: ["whatsapp_business_management"],
    },
    { is_valid: true, app_id: "app-1" },
    {
      is_valid: false,
      app_id: "app-1",
      scopes: [
        "whatsapp_business_management",
        "whatsapp_business_manage_events",
      ],
    },
    {
      is_valid: true,
      app_id: "different-app",
      scopes: [
        "whatsapp_business_management",
        "whatsapp_business_manage_events",
      ],
    },
  ])(
    "requires confirmed event and management permissions before dataset creation",
    async metadata => {
      mockDebugToken.mockResolvedValue(metadata);
      const response = await PUT(request("enable_meta"), params);
      expect(response.status).toBe(409);
      expect(mockProvision).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
    }
  );

  it("shows the rotated secret once and stores only encrypted bytes", async () => {
    const response = await PUT(request("rotate_webhook_secret"), params);
    const body = await response.json();
    expect(body.webhookSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(body.hasWebhookSecret).toBe(true);
    expect(body.webhookEnabled).toBe(true);
    expect(body).not.toHaveProperty("sales_webhook_secret");
    const saved = mockUpdate.mock.calls[0][0].buildCredentials(credentials);
    expect(saved.sales_webhook_secret).toEqual({
      ciphertext: `encrypted:${body.webhookSecret}`,
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects malformed JSON and unrecognized actions without writes", async () => {
    expect(
      (await PUT(new Request(url, { method: "PUT", body: "{" }), params)).status
    ).toBe(400);
    expect((await PUT(request("set_token"), params)).status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("disables without calling Meta or removing unrelated connection data", async () => {
    const response = await PUT(request("disable_webhook"), params);
    expect(response.status).toBe(200);
    const saved = mockUpdate.mock.calls[0][0].buildCredentials(credentials);
    expect(saved).toMatchObject({
      ...credentials,
      sales_webhook_enabled: false,
    });
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it("does not return a secret when concurrent source changes reject its save", async () => {
    mockUpdate.mockRejectedValue(
      new WhatsAppFlowSourceBindingFenceConflictError()
    );
    const response = await PUT(request("rotate_webhook_secret"), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "source_changed" });
  });

  it.each(["enable_meta", "disable_meta"])(
    "preserves a rebind boundary through %s",
    async action => {
      const raw = {
        ...credentials,
        conversions_api: {
          enabled: false,
          attribution_boundary_at: "2026-09-09T00:00:00.000Z",
        },
      };
      const current = await mockContext();
      mockContext.mockResolvedValue({
        context: { ...current.context, rawCredentials: raw },
      });
      mockUpdate.mockImplementation(async ({ buildCredentials }) => ({
        credentials: buildCredentials(raw),
      }));
      expect((await PUT(request(action), params)).status).toBe(200);
      expect(
        mockUpdate.mock.calls[0][0].buildCredentials(raw).conversions_api
          .attribution_boundary_at
      ).toBe(raw.conversions_api.attribution_boundary_at);
    }
  );

  it.each(["enable_meta", "rotate_webhook_secret"])(
    "blocks %s for removed sources before provider calls",
    async action => {
      const current = await mockContext();
      mockContext.mockResolvedValue({
        context: {
          ...current.context,
          rawCredentials: {
            ...credentials,
            coexistence_reonboarding_status: "removed",
          },
        },
      });
      expect((await PUT(request(action), params)).status).toBe(409);
      expect(mockProvision).not.toHaveBeenCalled();
      expect(mockDebugToken).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
    }
  );

  it("rejects activation when the source is removed during dataset provisioning", async () => {
    mockUpdate.mockImplementation(async ({ buildCredentials }) => ({
      credentials: buildCredentials({
        ...credentials,
        coexistence_reonboarding_status: "removed",
      }),
    }));
    expect((await PUT(request("enable_meta"), params)).status).toBe(409);
  });

  it("preserves a valid test code on same-WABA re-enable", async () => {
    const raw = {
      ...credentials,
      conversions_api: {
        enabled: false,
        waba_id: credentials.waba_id,
        dataset_id: "111222333",
        configured_at: "2026-09-09T00:00:00.000Z",
        test_event_code: "TEST_123",
      },
    };
    const current = await mockContext();
    mockContext.mockResolvedValue({
      context: { ...current.context, rawCredentials: raw },
    });
    mockUpdate.mockImplementation(async ({ buildCredentials }) => ({
      credentials: buildCredentials(raw),
    }));
    expect((await PUT(request("enable_meta"), params)).status).toBe(200);
    expect(
      mockUpdate.mock.calls[0][0].buildCredentials(raw).conversions_api
        .test_event_code
    ).toBe("TEST_123");
  });
});
