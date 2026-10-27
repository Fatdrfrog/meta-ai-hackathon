const mockAuthGetUser = jest.fn();
const mockCreateClient = jest.fn();
const mockFrom = jest.fn();
const mockAdminFrom = jest.fn();
const mockGraphGetJson = jest.fn();
const mockGraphPostJson = jest.fn();
const mockServerLoggerInfo = jest.fn();
const mockServerLoggerWarn = jest.fn();
const mockServerLoggerError = jest.fn();
const mockFlushServerLogsAfterResponse = jest.fn();

jest.mock("@/lib/limits/company-limits", () => ({
  COMPANY_CHANNEL_LIMIT_EXCEEDED_CODE: "company_channel_limit_exceeded",
  ensureCompanyChannelCapacity: jest.fn(),
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    client: "supabase-admin",
    from: (...args: unknown[]) => mockAdminFrom(...args),
  },
}));

jest.mock("@/lib/supabase/company-users", () => ({
  getCompanyIdForWorkspace: jest.fn(),
}));

jest.mock("@/lib/observability/server-logs", () => ({
  createServerLogger: jest.fn(() => ({
    info: (...args: unknown[]) => mockServerLoggerInfo(...args),
    warn: (...args: unknown[]) => mockServerLoggerWarn(...args),
    error: (...args: unknown[]) => mockServerLoggerError(...args),
  })),
  flushServerLogsAfterResponse: (...args: unknown[]) =>
    mockFlushServerLogsAfterResponse(...args),
}));

jest.mock("@/lib/crypto", () => ({
  decryptMaybeString: jest.fn((value: unknown) =>
    typeof value === "string" ? value : null
  ),
  encryptString: jest.fn((value: string) => `encrypted:${value}`),
}));

jest.mock("@/lib/whatsapp/auto-defaults", () => ({
  runWhatsAppAutoDefaults: jest.fn(),
}));

jest.mock("@/lib/whatsapp/catalog/setup", () => ({
  runWhatsAppCatalogSetup: jest.fn(),
}));

jest.mock("@icecore/shared/lib/meta/api", () => ({
  MetaGraphRequestError: class MetaGraphRequestError extends Error {},
  parseMetaGraphAPIError: jest.fn(() => null),
  formatMetaGraphAPIError: jest.fn(),
  getWhatsAppGraphClient: jest.fn(() => ({
    getJson: (...args: unknown[]) => mockGraphGetJson(...args),
    postJson: (...args: unknown[]) => mockGraphPostJson(...args),
  })),
}));

jest.mock("@/lib/whatsapp/history-sync", () => ({
  requestWhatsAppHistorySync: jest.fn(),
}));

jest.mock("@/lib/whatsapp/contact/sync", () => ({
  requestWhatsAppContactSync: jest.fn(),
}));

jest.mock("@/lib/whatsapp/cloud-api-contact-backfill", () => ({
  backfillCloudApiWhatsAppContacts: jest.fn(),
}));

jest.mock("@/lib/whatsapp/qr-code-service", () => ({
  getPhoneNumberDetails: jest.fn(),
  registerPhoneNumberWithPin: jest.fn(),
}));

jest.mock("@/lib/whatsapp/redirect-uri", () => {
  const actual = jest.requireActual("@/lib/whatsapp/redirect-uri");
  return {
    ...actual,
    getEmbeddedSignupRedirectUri: jest.fn(),
    validateRedirectUri: jest.fn(),
  };
});

jest.mock("@/lib/whatsapp/waba-service", () => ({
  discoverWABAs: jest.fn(),
  formatMetaGraphAPIError: jest.fn(),
  getAllWABAs: jest.fn(),
  getBusinessPortfolios: jest.fn(),
  parseMetaGraphAPIError: jest.fn(),
  subscribeToWABAWebhooks: jest.fn(),
}));

jest.mock("@/lib/whatsapp/account/persistence", () => ({
  recordWhatsAppOnboardingEvent: jest.fn(async () => ({ persisted: true })),
  upsertWhatsAppAccountsForSource: jest.fn(async () => ({ persisted: true })),
}));

const mockCaptureFunnelEvent = jest.fn();
jest.mock("@/lib/funnel-analytics", () => ({
  captureFunnelEvent: (...args: unknown[]) => mockCaptureFunnelEvent(...args),
}));

jest.mock("@/lib/whatsapp/account/inventory", () => ({
  findWhatsAppPhoneOwner: jest.fn(async () => null),
}));

jest.mock("@/lib/whatsapp/flows/source-rebind-guard", () => ({
  ManagedWhatsAppFlowSourceRebindError: class extends Error {},
  createWhatsAppSourceCredentialSnapshotSaver: jest.fn(
    () => async (credentials: Record<string, unknown>) => ({ credentials })
  ),
  invalidateWhatsAppSourceBindingCaches: jest.fn(),
  updateManagedWhatsAppSourceBinding: jest.fn(),
}));

import { ensureCompanyChannelCapacity } from "@/lib/limits/company-limits";
import { getCompanyIdForWorkspace } from "@/lib/supabase/company-users";
import { upsertWhatsAppAccountsForSource } from "@/lib/whatsapp/account/persistence";
import { runWhatsAppAutoDefaults } from "@/lib/whatsapp/auto-defaults";
import { runWhatsAppCatalogSetup } from "@/lib/whatsapp/catalog/setup";
import { backfillCloudApiWhatsAppContacts } from "@/lib/whatsapp/cloud-api-contact-backfill";
import { requestWhatsAppContactSync } from "@/lib/whatsapp/contact/sync";
import { requestWhatsAppHistorySync } from "@/lib/whatsapp/history-sync";
import {
  createWhatsAppSourceCredentialSnapshotSaver,
  updateManagedWhatsAppSourceBinding,
} from "@/lib/whatsapp/flows/source-rebind-guard";
import {
  getPhoneNumberDetails,
  registerPhoneNumberWithPin,
} from "@/lib/whatsapp/qr-code-service";
import {
  getEmbeddedSignupRedirectUri,
  validateRedirectUri,
} from "@/lib/whatsapp/redirect-uri";
import {
  discoverWABAs,
  getBusinessPortfolios,
  subscribeToWABAWebhooks,
} from "@/lib/whatsapp/waba-service";
import {
  buildEmbeddedSignupTokenExchangeQueries,
  buildEmbeddedSignupTokenExchangeQuery,
  describeEmbeddedSignupCallbackOutcome,
  handleEmbeddedSignupCallback,
  resolveEmbeddedSignupFlow,
  resolveEmbeddedSignupSessionAssetState,
  resolveEmbeddedSignupSessionAssets,
  shouldAttemptEmbeddedSignupPhoneRegistration,
} from "./embedded-signup-handler";

describe("describeEmbeddedSignupCallbackOutcome", () => {
  function redirect(location: string) {
    return new Response(null, { status: 307, headers: { location } });
  }

  it("summarizes a failure redirect with its error code and workspace", () => {
    expect(
      describeEmbeddedSignupCallbackOutcome(
        redirect(
          "https://www.airi.chat/panel/w/workspace-1/settings/integrations?type=whatsapp&error=token_invalid&error_details=Meta%20said%20no&requires_reconnect=true"
        )
      )
    ).toEqual({
      outcome: "failed",
      status: 307,
      workspaceId: "workspace-1",
      error: "token_invalid",
      errorDetails: "Meta said no",
      requiresReconnect: true,
    });
  });

  it("marks a successful connection", () => {
    expect(
      describeEmbeddedSignupCallbackOutcome(
        redirect(
          "https://www.airi.chat/panel/w/workspace-1/settings/integrations?type=whatsapp&new=true&embedded_signup=true"
        )
      )
    ).toMatchObject({ outcome: "connected", workspaceId: "workspace-1" });
  });

  it("never copies the business token or signup code into logs", () => {
    const selection = describeEmbeddedSignupCallbackOutcome(
      redirect(
        "https://www.airi.chat/panel/w/workspace-1/settings/integrations/whatsapp/select?embedded=true&source=embedded_signup"
      )
    );
    const login = describeEmbeddedSignupCallbackOutcome(
      redirect(
        "https://www.airi.chat/login?redirect=%2Fapi%2Fsources%2Fwhatsapp%2Fcallback%3Fcode%3Dsecret-code"
      )
    );

    expect(selection).toEqual({
      outcome: "selection_required",
      status: 307,
      workspaceId: "workspace-1",
    });
    expect(login).toEqual({
      outcome: "login_required",
      status: 307,
      workspaceId: undefined,
    });
    expect(JSON.stringify([selection, login])).not.toMatch(/secret/i);
  });

  it("reports a response without a redirect", () => {
    expect(
      describeEmbeddedSignupCallbackOutcome(new Response(null, { status: 500 }))
    ).toEqual({ outcome: "no_redirect", status: 500 });
  });
});

function mockCompanyUserLookup(data: { workspace_id: string } | null) {
  const maybeSingle = jest.fn().mockResolvedValue({ data, error: null });
  const limit = jest.fn().mockReturnValue({ maybeSingle });
  const eq = jest.fn().mockReturnValue({ limit });
  const select = jest.fn().mockReturnValue({ eq });
  mockFrom.mockReturnValue({ select });
  return { select, eq, limit, maybeSingle };
}

describe("handleEmbeddedSignupCallback redirects", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAdminFrom.mockReset();
    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: mockAuthGetUser,
      },
      from: mockFrom,
    });
  });

  it("uses the user's workspace integrations route when the callback has no code and no state", async () => {
    mockAuthGetUser.mockResolvedValue({
      data: { user: { id: "user-1" } },
    });
    mockCompanyUserLookup({ workspace_id: "workspace-1" });

    const response = await handleEmbeddedSignupCallback(
      new Request(
        "http://localhost/api/sources/whatsapp/callback?embedded=true"
      )
    );

    const location = response.headers.get("location");
    expect(location).toBeTruthy();
    const redirectUrl = new URL(location!);
    expect(redirectUrl.pathname).toBe(
      "/panel/w/workspace-1/settings/integrations"
    );
    expect(redirectUrl.searchParams.get("type")).toBe("whatsapp");
    expect(redirectUrl.searchParams.get("error")).toBe("missing_code");
    expect(mockFrom).toHaveBeenCalledWith("company_users");
  });

  it("logs one findable outcome line and flushes logs for an early failure", async () => {
    mockAuthGetUser.mockResolvedValue({
      data: { user: { id: "user-1" } },
    });
    mockCompanyUserLookup({ workspace_id: "workspace-1" });

    await handleEmbeddedSignupCallback(
      new Request(
        "http://localhost/api/sources/whatsapp/callback?embedded=true"
      )
    );

    expect(mockFlushServerLogsAfterResponse).toHaveBeenCalledTimes(1);
    expect(mockServerLoggerWarn).toHaveBeenCalledWith(
      "embedded_signup.callback_completed",
      expect.objectContaining({
        outcome: "failed",
        error: "missing_code",
        workspaceId: "workspace-1",
        status: 307,
      })
    );
  });

  it("logs only the code and message when saving the source fails", async () => {
    process.env.NEXT_PUBLIC_META_APP_ID = "app-1";
    process.env.META_APP_SECRET = "secret-1";
    mockAuthGetUser.mockResolvedValue({
      data: { user: { id: "user-1" } },
    });
    mockCompanyUserLookup({ workspace_id: "workspace-1" });
    (getCompanyIdForWorkspace as jest.Mock).mockResolvedValue("company-1");
    (getEmbeddedSignupRedirectUri as jest.Mock).mockReturnValue(
      "http://localhost/api/sources/whatsapp/callback?embedded=true"
    );
    (validateRedirectUri as jest.Mock).mockReturnValue({ valid: true });
    (ensureCompanyChannelCapacity as jest.Mock).mockResolvedValue({
      allowed: true,
    });
    (getPhoneNumberDetails as jest.Mock).mockRejectedValue(
      new Error("phone details unavailable")
    );
    mockGraphGetJson.mockImplementation(async (path: string) => {
      if (path === "oauth/access_token") {
        return { access_token: "business-token", token_type: "bearer" };
      }
      if (path === "debug_token") {
        return {
          data: {
            app_id: "app-1",
            type: "SYSTEM_USER",
            is_valid: true,
            expires_at: 0,
            scopes: ["whatsapp_business_management"],
          },
        };
      }
      if (path === "waba-1") {
        return { id: "waba-1", phone_numbers: { data: [{ id: "phone-1" }] } };
      }
      throw new Error(`unexpected Graph path ${path}`);
    });

    const persistError = {
      code: "23505",
      message: "duplicate key value violates unique constraint",
      details: "Failing row contains (secret-credentials)",
    };
    // A chainable select(...).eq(...).limit(...).maybeSingle() double.
    function selectQuery(data: unknown) {
      const query: Record<"eq" | "limit" | "maybeSingle", jest.Mock> = {
        eq: jest.fn(),
        limit: jest.fn(),
        maybeSingle: jest.fn().mockResolvedValue({ data, error: null }),
      };
      query.eq.mockReturnValue(query);
      query.limit.mockReturnValue(query);
      return query;
    }
    mockFrom.mockImplementation((table: string) => {
      if (table === "company_users") {
        const query = selectQuery({ workspace_id: "workspace-1" });
        return { select: jest.fn(() => query) };
      }
      const query = selectQuery(null);
      return { select: jest.fn(() => query) };
    });
    mockAdminFrom.mockReturnValueOnce({
      insert: jest.fn(() => ({
        select: jest.fn(() => ({
          single: jest
            .fn()
            .mockResolvedValue({ data: null, error: persistError }),
        })),
      })),
    });

    const response = await handleEmbeddedSignupCallback(
      new Request(
        "http://localhost/api/sources/whatsapp/callback?embedded=true&code=code-1&state=workspace-1&waba_id=waba-1&phone_number_id=phone-1"
      )
    );

    expect(
      new URL(response.headers.get("location")!).searchParams.get("error")
    ).toBe("whatsapp_save_failed");
    expect(mockServerLoggerError).toHaveBeenCalledWith(
      "embedded_signup.source_persist_failed",
      undefined,
      {
        workspaceId: "workspace-1",
        dbErrorCode: "23505",
        dbErrorMessage: "duplicate key value violates unique constraint",
      }
    );
    expect(JSON.stringify(mockServerLoggerError.mock.calls)).not.toContain(
      "secret-credentials"
    );
  });

  it("logs a crash before rethrowing it", async () => {
    const crash = new Error("supabase unavailable");
    mockCreateClient.mockRejectedValue(crash);

    await expect(
      handleEmbeddedSignupCallback(
        new Request(
          "http://localhost/api/sources/whatsapp/callback?embedded=true&code=code-1"
        )
      )
    ).rejects.toThrow("supabase unavailable");

    expect(mockServerLoggerError).toHaveBeenCalledWith(
      "embedded_signup.callback_crashed",
      crash,
      expect.objectContaining({ errorType: "Error" })
    );
  });

  it("falls back to the existing panel route when the user has no workspace", async () => {
    mockAuthGetUser.mockResolvedValue({
      data: { user: { id: "user-1" } },
    });
    mockCompanyUserLookup(null);

    const response = await handleEmbeddedSignupCallback(
      new Request(
        "http://localhost/api/sources/whatsapp/callback?embedded=true&code=code-1"
      )
    );

    const location = response.headers.get("location");
    expect(location).toBeTruthy();
    const redirectUrl = new URL(location!);
    expect(redirectUrl.pathname).toBe("/panel");
    expect(redirectUrl.searchParams.get("type")).toBe("whatsapp");
    expect(redirectUrl.searchParams.get("error")).toBe(
      "User not associated with a workspace"
    );
  });

  it("resolves the company user from the callback state workspace when state is present", async () => {
    mockAuthGetUser.mockResolvedValue({
      data: { user: { id: "user-1" } },
    });

    const stateMembership = {
      workspace_id: "workspace-from-state",
    };
    const maybeSingle = jest
      .fn()
      .mockResolvedValue({ data: stateMembership, error: null });
    const eqWorkspaceId = jest.fn().mockReturnValue({ maybeSingle });
    const eqUserId = jest.fn().mockReturnValue({ eq: eqWorkspaceId });
    const select = jest.fn().mockReturnValue({ eq: eqUserId });
    mockFrom.mockReturnValue({ select });

    const response = await handleEmbeddedSignupCallback(
      new Request(
        "http://localhost/api/sources/whatsapp/callback?embedded=true&state=workspace-from-state"
      )
    );

    const location = response.headers.get("location");
    expect(location).toBeTruthy();
    const redirectUrl = new URL(location!);
    expect(redirectUrl.pathname).toBe(
      "/panel/w/workspace-from-state/settings/integrations"
    );
    expect(redirectUrl.searchParams.get("type")).toBe("whatsapp");
    expect(redirectUrl.searchParams.get("error")).toBe("missing_code");
    expect(eqUserId).toHaveBeenCalledWith("user_id", "user-1");
    expect(eqWorkspaceId).toHaveBeenCalledWith(
      "workspace_id",
      "workspace-from-state"
    );
    expect(maybeSingle).toHaveBeenCalled();
  });

  it("does not attach a completed signup to another workspace when state membership is missing", async () => {
    mockAuthGetUser.mockResolvedValue({
      data: { user: { id: "user-1" } },
    });

    const stateMaybeSingle = jest
      .fn()
      .mockResolvedValue({ data: null, error: null });
    const stateEqWorkspaceId = jest
      .fn()
      .mockReturnValue({ maybeSingle: stateMaybeSingle });
    const stateEqUserId = jest.fn().mockReturnValue({ eq: stateEqWorkspaceId });
    const stateSelect = jest.fn().mockReturnValue({ eq: stateEqUserId });

    const fallbackMaybeSingle = jest.fn().mockResolvedValue({
      data: { workspace_id: "workspace-other" },
      error: null,
    });
    const fallbackLimit = jest
      .fn()
      .mockReturnValue({ maybeSingle: fallbackMaybeSingle });
    const fallbackEq = jest.fn().mockReturnValue({ limit: fallbackLimit });
    const fallbackSelect = jest.fn().mockReturnValue({ eq: fallbackEq });

    mockFrom
      .mockReturnValueOnce({ select: stateSelect })
      .mockReturnValueOnce({ select: fallbackSelect });

    const response = await handleEmbeddedSignupCallback(
      new Request(
        "http://localhost/api/sources/whatsapp/callback?embedded=true&code=code-1&state=workspace-from-state"
      )
    );

    const location = response.headers.get("location");
    expect(location).toBeTruthy();
    const redirectUrl = new URL(location!);
    expect(redirectUrl.pathname).toBe(
      "/panel/w/workspace-from-state/settings/integrations"
    );
    expect(redirectUrl.searchParams.get("type")).toBe("whatsapp");
    expect(redirectUrl.searchParams.get("error")).toBe(
      "User not associated with a workspace"
    );
    expect(fallbackSelect).not.toHaveBeenCalled();
  });

  it("logs direct WABA discovery without secrets and persists before post-connect sync", async () => {
    mockFrom.mockReset();
    mockGraphGetJson.mockReset();
    mockGraphPostJson.mockReset();
    process.env.NEXT_PUBLIC_META_APP_ID = "app-1";
    process.env.META_APP_SECRET = "secret-1";

    mockAuthGetUser.mockResolvedValue({
      data: { user: { id: "user-1" } },
    });
    (getCompanyIdForWorkspace as jest.Mock).mockResolvedValue("company-1");
    (ensureCompanyChannelCapacity as jest.Mock).mockResolvedValue({
      allowed: true,
    });
    (getEmbeddedSignupRedirectUri as jest.Mock).mockReturnValue(
      "http://localhost/api/sources/whatsapp/callback?embedded=true"
    );
    (validateRedirectUri as jest.Mock).mockReturnValue({ valid: true });
    (getPhoneNumberDetails as jest.Mock).mockResolvedValue({
      id: "phone-1",
      display_phone_number: "+1 555 0100",
      verified_name: "Preview number",
      code_verification_status: "NOT_VERIFIED",
      platform_type: "SMB",
      is_on_biz_app: true,
    });
    (runWhatsAppAutoDefaults as jest.Mock).mockImplementation(
      async ({ credentials }) => ({ success: true, warnings: [], credentials })
    );
    (requestWhatsAppContactSync as jest.Mock).mockResolvedValue({
      skipped: true,
    });
    (requestWhatsAppHistorySync as jest.Mock).mockResolvedValue({
      skipped: true,
    });
    (getBusinessPortfolios as jest.Mock).mockResolvedValue([]);
    (discoverWABAs as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          waba: { id: "waba-1", name: "Primary" },
          phoneNumbers: [
            {
              id: "phone-1",
              display_phone_number: "+1 555 0100",
            },
          ],
          accountType: "owned",
        },
      ]);
    mockGraphGetJson
      .mockRejectedValueOnce(
        new Error("redirect_uri business-token secret-1 code-1")
      )
      .mockResolvedValueOnce({
        access_token: "business-token",
        token_type: "bearer",
        expires_in: 5183999,
      })
      .mockResolvedValueOnce({
        data: { business_id: "business-1", app_id: "app-1", is_valid: true },
      })
      .mockResolvedValueOnce({
        data: {
          app_id: "app-1",
          type: "SYSTEM_USER",
          granular_scopes: [
            {
              scope: "whatsapp_business_management",
              target_ids: ["waba-1"],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        id: "waba-1",
        phone_numbers: {
          data: [
            {
              id: "phone-1",
              display_phone_number: "+1 555 0100",
            },
          ],
        },
      });

    const stateMaybeSingle = jest.fn().mockResolvedValue({
      data: { workspace_id: "workspace-1" },
      error: null,
    });
    const stateEqWorkspaceId = jest
      .fn()
      .mockReturnValue({ maybeSingle: stateMaybeSingle });
    const stateEqUserId = jest.fn().mockReturnValue({ eq: stateEqWorkspaceId });
    const stateSelect = jest.fn().mockReturnValue({ eq: stateEqUserId });

    const existingMaybeSingle = jest
      .fn()
      .mockResolvedValue({ data: null, error: null });
    const existingEqType = jest
      .fn()
      .mockReturnValue({ maybeSingle: existingMaybeSingle });
    const existingEqWorkspace = jest
      .fn()
      .mockReturnValue({ eq: existingEqType });
    const existingSelect = jest
      .fn()
      .mockReturnValue({ eq: existingEqWorkspace });

    const persistSingle = jest.fn().mockResolvedValue({
      data: { id: "source-1" },
      error: null,
    });
    const persistSelect = jest.fn().mockReturnValue({ single: persistSingle });
    const insert = jest.fn().mockReturnValue({ select: persistSelect });

    mockFrom
      .mockReturnValueOnce({ select: stateSelect })
      .mockReturnValueOnce({ select: existingSelect })
      .mockReturnValueOnce({ select: existingSelect });
    mockAdminFrom.mockReturnValueOnce({ insert });

    const response = await handleEmbeddedSignupCallback(
      new Request(
        "http://localhost/api/sources/whatsapp/callback?embedded=true&code=code-1&state=workspace-1&messaging_account_id=messaging-1&waac_id=waac-1&cs_id=cs-1&business_id=business-1&flow=coexistence"
      )
    );

    // Members may not write WhatsApp rows; the verified callback inserts as
    // the service role.
    expect(mockAdminFrom).toHaveBeenCalledWith("sources");
    expect(mockFrom).toHaveBeenCalledTimes(3);

    const location = response.headers.get("location");
    expect(location).toContain("/panel/w/workspace-1/settings/integrations");
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: expect.objectContaining({
          phone_number_id: "phone-1",
          cs_id: "cs-1",
          waba_id: "waba-1",
          messaging_account_id: "messaging-1",
          waac_id: "waac-1",
          webhook_requires_reconnect: false,
          webhook_error: null,
        }),
      })
    );
    expect(insert.mock.calls[0][0].credentials).not.toHaveProperty(
      "paid_messaging_account_id"
    );
    expect(upsertWhatsAppAccountsForSource).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "source-1",
        workspaceId: "workspace-1",
        companyId: "company-1",
        credentials: expect.objectContaining({
          messaging_account_id: "messaging-1",
          waac_id: "waac-1",
        }),
      })
    );
    expect(runWhatsAppAutoDefaults).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "source-1",
        trigger: "embedded_signup_connect",
      })
    );
    expect(insert.mock.invocationCallOrder[0]).toBeLessThan(
      (runWhatsAppAutoDefaults as jest.Mock).mock.invocationCallOrder[0]
    );
    expect(subscribeToWABAWebhooks).not.toHaveBeenCalled();
    expect(discoverWABAs).toHaveBeenCalledTimes(2);
    for (const call of (discoverWABAs as jest.Mock).mock.calls) {
      expect(call).toEqual(["business-token"]);
    }
    expect(getPhoneNumberDetails).toHaveBeenCalledTimes(1);
    expect(mockServerLoggerInfo).toHaveBeenCalledWith(
      "embedded_signup.token_exchange_succeeded",
      {
        tokenType: "bearer",
        hasExpiresIn: true,
        expiresInSeconds: 5183999,
      }
    );
    expect(mockServerLoggerInfo).toHaveBeenCalledWith(
      "embedded_signup.waba_discovery.granular_scope_succeeded",
      {
        wabaId: "waba-1",
        phoneNumberId: "phone-1",
      }
    );
    expect(mockServerLoggerWarn).toHaveBeenCalledWith(
      "embedded_signup.token_exchange.retry_without_redirect_uri",
      { errorType: "Error" }
    );

    const structuredLogs = JSON.stringify({
      info: mockServerLoggerInfo.mock.calls,
      warn: mockServerLoggerWarn.mock.calls,
      error: mockServerLoggerError.mock.calls,
    });
    expect(structuredLogs).not.toContain("business-token");
    expect(structuredLogs).not.toContain("secret-1");
    expect(structuredLogs).not.toContain("code-1");
    expect(mockCaptureFunnelEvent).toHaveBeenCalledWith({
      event: "whatsapp_connected",
      userId: "user-1",
      workspaceId: "workspace-1",
      companyId: "company-1",
      properties: expect.objectContaining({
        path: "embedded_signup",
        reconnect: false,
      }),
    });
  });
});

describe("handleEmbeddedSignupCallback phone registration", () => {
  const originalEnv = {
    NEXT_PUBLIC_META_APP_ID: process.env.NEXT_PUBLIC_META_APP_ID,
    META_APP_SECRET: process.env.META_APP_SECRET,
    WHATSAPP_DEFAULT_PIN: process.env.WHATSAPP_DEFAULT_PIN,
  };
  const existingCredentials = {
    waba_id: "waba-1",
    phone_number_id: "phone-1",
    access_token: "old-token",
    token_expires_at: "2026-10-01T00:00:00.000Z",
    token_type: "USER",
    token_is_valid: false,
    token_maintenance_status: "reconnect_required",
    token_maintenance_error_code: "invalid_authorization",
    token_last_refresh_attempt_at: "2026-09-01T00:00:00.000Z",
    meta_diagnostics_reconnect_reason: "meta_authorization",
    phone_registered: true,
    phone_registration_status: "REGISTERED",
    phone_registration_error: "Previous registration failed",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    process.env.NEXT_PUBLIC_META_APP_ID = "app-1";
    process.env.META_APP_SECRET = "secret-1";
    process.env.WHATSAPP_DEFAULT_PIN = "123456";
    mockAuthGetUser.mockResolvedValue({
      data: { user: { id: "user-1" } },
    });
    mockCreateClient.mockResolvedValue({
      auth: { getUser: mockAuthGetUser },
      from: mockFrom,
    });
    mockFrom.mockReset().mockImplementation((table: string) => {
      const query = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({
          data:
            table === "company_users"
              ? { workspace_id: "workspace-1" }
              : { id: "source-1", credentials: existingCredentials },
          error: null,
        }),
      };
      return query;
    });
    mockAdminFrom.mockReset();
    mockGraphGetJson
      .mockReset()
      .mockResolvedValueOnce({ access_token: "new-token", expires_in: 5184000 })
      .mockResolvedValueOnce({
        data: { business_id: "business-1", app_id: "app-1", is_valid: true },
      })
      // The session's phone must be on the session's WABA under the new token.
      .mockImplementation(async (path: string) =>
        path === "waba-1"
          ? { id: "waba-1", phone_numbers: { data: [{ id: "phone-1" }] } }
          : undefined
      );
    (getCompanyIdForWorkspace as jest.Mock).mockResolvedValue("company-1");
    (getEmbeddedSignupRedirectUri as jest.Mock).mockReturnValue(
      "http://localhost/api/sources/whatsapp/callback?embedded=true"
    );
    (validateRedirectUri as jest.Mock).mockReturnValue({ valid: true });
    (getPhoneNumberDetails as jest.Mock).mockReset().mockResolvedValue({
      id: "phone-1",
      status: "PENDING",
      code_verification_status: "VERIFIED",
      platform_type: "CLOUD_API",
      is_on_biz_app: false,
    });
    (registerPhoneNumberWithPin as jest.Mock).mockReset().mockResolvedValue({
      success: true,
    });
    (updateManagedWhatsAppSourceBinding as jest.Mock).mockImplementation(
      async ({ buildCredentials }) => ({
        credentials: buildCredentials(existingCredentials),
      })
    );
    (runWhatsAppAutoDefaults as jest.Mock).mockImplementation(
      async ({ credentials }) => ({ success: true, warnings: [], credentials })
    );
    (backfillCloudApiWhatsAppContacts as jest.Mock).mockResolvedValue({
      skipped: true,
    });
    (requestWhatsAppContactSync as jest.Mock).mockResolvedValue({
      skipped: true,
    });
    (requestWhatsAppHistorySync as jest.Mock).mockResolvedValue({
      skipped: true,
    });
    (runWhatsAppCatalogSetup as jest.Mock).mockResolvedValue({ skipped: true });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function completeSignup(
    flow: "cloud_api" | "coexistence" = "cloud_api",
    event?: string
  ) {
    const response = await handleEmbeddedSignupCallback(
      new Request(
        `http://localhost/api/sources/whatsapp/callback?embedded=true&code=code-1&state=workspace-1&waba_id=waba-1&phone_number_id=phone-1&flow=${flow}${event ? `&event=${event}` : ""}`
      )
    );
    expect(
      new URL(response.headers.get("location")!).searchParams.get("error")
    ).toBeNull();
    expect(updateManagedWhatsAppSourceBinding).toHaveBeenCalledTimes(1);
    expect(upsertWhatsAppAccountsForSource).toHaveBeenCalledTimes(1);
    expect(createWhatsAppSourceCredentialSnapshotSaver).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "source-1",
        expectedPhoneNumberId: "phone-1",
      })
    );
    return (upsertWhatsAppAccountsForSource as jest.Mock).mock.calls[0][0]
      .credentials as Record<string, unknown>;
  }

  it("refuses a session phone number that is not on the signed-up WABA", async () => {
    const response = await handleEmbeddedSignupCallback(
      new Request(
        "http://localhost/api/sources/whatsapp/callback?embedded=true&code=code-1&state=workspace-1&waba_id=waba-1&phone_number_id=another-tenants-phone&flow=cloud_api"
      )
    );

    expect(
      new URL(response.headers.get("location")!).searchParams.get("error")
    ).not.toBeNull();
    expect(mockGraphGetJson).toHaveBeenCalledWith(
      "waba-1",
      expect.objectContaining({ token: "new-token" })
    );
    expect(updateManagedWhatsAppSourceBinding).not.toHaveBeenCalled();
    expect(mockAdminFrom).not.toHaveBeenCalled();
    expect(upsertWhatsAppAccountsForSource).not.toHaveBeenCalled();
  });

  function mockTokenMetadata(
    data: Record<string, unknown>,
    expiresIn?: number
  ) {
    mockGraphGetJson
      .mockReset()
      .mockResolvedValueOnce({
        access_token: "new-token",
        expires_in: expiresIn,
      })
      .mockResolvedValueOnce({
        data: { app_id: "app-1", is_valid: true, ...data },
      })
      .mockImplementation(async (path: string) =>
        path === "waba-1"
          ? { id: "waba-1", phone_numbers: { data: [{ id: "phone-1" }] } }
          : undefined
      );
  }

  it.each([
    { is_valid: false },
    { is_valid: undefined },
    { app_id: "another-app" },
    { expires_at: 1 },
    { expires_at: 0, data_access_expires_at: 1 },
  ])(
    "rejects unusable tokens before provider setup or persistence: %j",
    async data => {
      mockTokenMetadata(data);
      const response = await handleEmbeddedSignupCallback(
        new Request(
          "http://localhost/api/sources/whatsapp/callback?embedded=true&code=code-1&state=workspace-1&waba_id=waba-1&phone_number_id=phone-1&flow=cloud_api"
        )
      );

      expect(
        new URL(response.headers.get("location")!).searchParams.get("error")
      ).not.toBeNull();
      expect(getPhoneNumberDetails).not.toHaveBeenCalled();
      expect(registerPhoneNumberWithPin).not.toHaveBeenCalled();
      expect(updateManagedWhatsAppSourceBinding).not.toHaveBeenCalled();
      expect(upsertWhatsAppAccountsForSource).not.toHaveBeenCalled();
    }
  );

  it("does not save a token when Meta's debugger is unavailable", async () => {
    mockGraphGetJson
      .mockReset()
      .mockResolvedValueOnce({ access_token: "new-token" })
      .mockRejectedValueOnce(new Error("Meta debugger unavailable"));
    const response = await handleEmbeddedSignupCallback(
      new Request(
        "http://localhost/api/sources/whatsapp/callback?embedded=true&code=code-1&state=workspace-1&waba_id=waba-1&phone_number_id=phone-1&flow=cloud_api"
      )
    );

    expect(
      new URL(response.headers.get("location")!).searchParams.get("error")
    ).not.toBeNull();
    expect(updateManagedWhatsAppSourceBinding).not.toHaveBeenCalled();
    expect(registerPhoneNumberWithPin).not.toHaveBeenCalled();
  });

  it.each([
    { metadata: { expires_at: 0 }, expiresIn: 5184000 },
    { metadata: {}, expiresIn: undefined },
    { metadata: {}, expiresIn: 0 },
  ])(
    "clears an old expiry when the new token has no dated expiry: %j",
    async ({ metadata, expiresIn }) => {
      mockTokenMetadata(metadata, expiresIn);
      const credentials = await completeSignup();
      expect(credentials.token_expires_at).toBeNull();
    }
  );

  it("persists verified non-expiring metadata and clears a previous renewal failure", async () => {
    mockTokenMetadata({
      type: "SYSTEM_USER",
      expires_at: 0,
      data_access_expires_at: 0,
    });
    const credentials = await completeSignup();
    expect(credentials).toEqual(expect.objectContaining({
      token_type: "SYSTEM_USER",
      token_is_valid: true,
      token_verified_at: expect.any(String),
      token_never_expires: true,
      token_provider_expires_at: null,
      token_data_access_expires_at: null,
      token_expires_at: null,
      token_maintenance_status: "healthy",
      token_maintenance_error_code: null,
      token_last_refresh_attempt_at: null,
      meta_diagnostics_reconnect_reason: null,
    }));
  });

  it("keeps an unknown lifetime distinct from confirmed non-expiring access", async () => {
    mockTokenMetadata({});
    const credentials = await completeSignup();
    expect(credentials).toEqual(expect.objectContaining({
      token_type: null,
      token_is_valid: true,
      token_never_expires: false,
      token_expires_at: null,
    }));
  });

  it("stores Meta's absolute expiry ahead of the exchange duration", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 86400;
    mockTokenMetadata({ expires_at: expiresAt }, 5184000);
    const credentials = await completeSignup();
    expect(credentials.token_expires_at).toBe(
      new Date(expiresAt * 1000).toISOString()
    );
    expect(credentials.token_provider_expires_at).toBe(
      new Date(expiresAt * 1000).toISOString()
    );
    expect(credentials.token_never_expires).toBe(false);
  });

  it("uses the exchange's real duration when debugger expiry is absent", async () => {
    mockTokenMetadata({}, 3600);
    const expectedExpiry = new Date(Date.now() + 3600 * 1000).toISOString();
    const credentials = await completeSignup();
    expect(credentials.token_expires_at).toBe(expectedExpiry);
  });

  it("does not fabricate expiry in a phone-selection redirect", async () => {
    mockTokenMetadata({ expires_at: 0 });
    mockGraphGetJson.mockResolvedValueOnce({
      phone_numbers: { data: [{ id: "phone-1" }, { id: "phone-2" }] },
    });
    const response = await handleEmbeddedSignupCallback(
      new Request(
        "http://localhost/api/sources/whatsapp/callback?embedded=true&code=code-1&state=workspace-1&waba_id=waba-1&flow=cloud_api"
      )
    );
    const redirect = new URL(response.headers.get("location")!);
    expect(redirect.pathname).toContain("/whatsapp/select");
    expect(redirect.searchParams.has("expires_in")).toBe(false);
    expect(updateManagedWhatsAppSourceBinding).not.toHaveBeenCalled();
  });

  it("keeps the business token out of the phone-selection URL", async () => {
    mockTokenMetadata({ expires_at: 0 });
    mockGraphGetJson.mockResolvedValueOnce({
      phone_numbers: { data: [{ id: "phone-1" }, { id: "phone-2" }] },
    });
    const response = await handleEmbeddedSignupCallback(
      new Request(
        "http://localhost/api/sources/whatsapp/callback?embedded=true&code=code-1&state=workspace-1&waba_id=waba-1&flow=cloud_api"
      )
    );
    const location = response.headers.get("location")!;
    const redirect = new URL(location);
    expect(redirect.pathname).toContain("/whatsapp/select");
    expect(redirect.searchParams.has("token")).toBe(false);
    expect(redirect.searchParams.get("source")).toBe("embedded_signup");

    const setCookie = response.headers.get("set-cookie") || "";
    expect(setCookie).toContain("airi_wa_selection=");
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toContain("Path=/api/sources/whatsapp");
  });

  describe("upgrade intent through the number picker", () => {
    const twoAccounts = [
      {
        waba: { id: "waba-1", name: "Primary" },
        phoneNumbers: [{ id: "phone-1", display_phone_number: "+1 555 0101" }],
        accountType: "owned",
      },
      {
        waba: { id: "waba-2", name: "Second" },
        phoneNumbers: [{ id: "phone-2", display_phone_number: "+1 555 0102" }],
        accountType: "owned",
      },
    ];

    async function redirectToPicker(query: string) {
      mockTokenMetadata({ expires_at: 0 });
      mockGraphGetJson.mockResolvedValueOnce({
        phone_numbers: { data: [{ id: "phone-1" }, { id: "phone-2" }] },
      });
      (getBusinessPortfolios as jest.Mock).mockResolvedValue([]);
      (discoverWABAs as jest.Mock).mockResolvedValue(twoAccounts);
      const response = await handleEmbeddedSignupCallback(
        new Request(
          `http://localhost/api/sources/whatsapp/callback?embedded=true&code=code-1&state=workspace-1&flow=cloud_api&${query}`
        )
      );
      const redirect = new URL(response.headers.get("location")!);
      expect(redirect.pathname).toContain("/whatsapp/select");
      expect(updateManagedWhatsAppSourceBinding).not.toHaveBeenCalled();
      return redirect;
    }

    it.each([
      ["a number on the signed-up account", "waba_id=waba-1&"],
      ["one of several accounts", ""],
    ])("keeps it when the user picks %s", async (_label, account) => {
      const redirect = await redirectToPicker(`${account}intent=upgrade`);

      expect(redirect.searchParams.get("intent")).toBe("upgrade");
    });

    it("adds no intent to an ordinary signup", async () => {
      const redirect = await redirectToPicker("waba_id=waba-1");

      expect(redirect.searchParams.has("intent")).toBe(false);
    });
  });

  it("clears prior registration success when registering a verified Cloud API phone fails", async () => {
    (registerPhoneNumberWithPin as jest.Mock).mockRejectedValue(
      new Error("Registration rejected")
    );

    const credentials = await completeSignup();

    expect(registerPhoneNumberWithPin).toHaveBeenCalledWith({
      phoneNumberId: "phone-1",
      pin: "123456",
      accessToken: "new-token",
    });
    expect(credentials).toEqual(
      expect.objectContaining({
        phone_registered: false,
        phone_registration_error: "Registration rejected",
      })
    );
  });

  it.each(["cloud_api", "coexistence"] as const)(
    "keeps the saved %s connection successful when its contact import throws",
    async flow => {
      const contactImport =
        flow === "cloud_api"
          ? backfillCloudApiWhatsAppContacts
          : requestWhatsAppContactSync;
      (contactImport as jest.Mock).mockRejectedValueOnce(
        new Error("Contact store unavailable")
      );

      await completeSignup(flow);

      expect(requestWhatsAppHistorySync).toHaveBeenCalledTimes(1);
      expect(mockServerLoggerWarn).toHaveBeenCalledWith(
        "embedded_signup.contact_sync_failed",
        expect.objectContaining({
          sourceId: "source-1",
          error: "Contact store unavailable",
        })
      );
    }
  );

  it("keeps the saved connection successful when optional history setup throws", async () => {
    (requestWhatsAppHistorySync as jest.Mock).mockRejectedValueOnce(
      new Error("History setup unavailable")
    );

    await completeSignup("coexistence");

    expect(mockServerLoggerWarn).toHaveBeenCalledWith(
      "embedded_signup.history_sync_failed",
      expect.objectContaining({ error: "History setup unavailable" })
    );
  });

  it.each(["phone-1", "phone-2"])(
    "keeps import markers only for the same phone during callback rebinding: %s",
    async previousPhone => {
      (getPhoneNumberDetails as jest.Mock).mockResolvedValueOnce({
        id: "phone-1",
        platform_type: "CLOUD_API",
        is_on_biz_app: true,
      });
      const priorCredentials = {
        ...existingCredentials,
        phone_number_id: previousPhone,
        contact_sync: { requested_at: "2026-09-01T00:00:00Z" },
        history_sync: { requested_at: "2026-09-01T00:00:00Z" },
      };
      // The binding store merges the built credentials onto the stored row.
      (updateManagedWhatsAppSourceBinding as jest.Mock).mockImplementationOnce(
        async ({ buildCredentials }) => ({
          credentials: {
            ...priorCredentials,
            ...buildCredentials(priorCredentials),
          },
        })
      );

      const credentials = await completeSignup("coexistence");

      expect(credentials.contact_sync).toEqual(
        previousPhone === "phone-1" ? priorCredentials.contact_sync : null
      );
      expect(credentials.history_sync).toEqual(
        previousPhone === "phone-1"
          ? priorCredentials.history_sync
          : {
              session_id: expect.any(String),
              session_started_at: expect.any(String),
            }
      );
    }
  );

  it("creates a fresh history generation when Embedded Signup follows confirmed offboarding", async () => {
    (getPhoneNumberDetails as jest.Mock).mockResolvedValueOnce({
      id: "phone-1",
      platform_type: "CLOUD_API",
      is_on_biz_app: true,
    });
    (updateManagedWhatsAppSourceBinding as jest.Mock).mockImplementationOnce(async ({ buildCredentials }) => ({
      credentials: buildCredentials({
        ...existingCredentials,
        phone_number_id: "phone-1",
        history_sync: { requested_at: "2026-05-01T00:00:00Z", status: "completed" },
        coexistence_reonboarding_status: "removed",
        coexistence_reonboarding_last_event_at: "2026-10-01T00:00:00Z",
      }),
    }));
    const credentials = await completeSignup("coexistence", "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING");
    expect(credentials.history_sync).toEqual({ session_id: expect.any(String), session_started_at: expect.any(String) });
  });

  it("does not retain prior registration success when the Cloud API PIN is missing", async () => {
    delete process.env.WHATSAPP_DEFAULT_PIN;

    const credentials = await completeSignup();

    expect(registerPhoneNumberWithPin).not.toHaveBeenCalled();
    expect(credentials).toEqual(
      expect.objectContaining({
        phone_registered: false,
        phone_registration_error:
          "PIN not configured. Manual registration required.",
      })
    );
  });

  it("persists successful Cloud API registration and clears its previous error", async () => {
    const credentials = await completeSignup();

    expect(registerPhoneNumberWithPin).toHaveBeenCalledTimes(1);
    expect(credentials).toEqual(
      expect.objectContaining({
        phone_registered: true,
        phone_registration_status: "REGISTERED",
        phone_registration_error: null,
      })
    );
  });

  it("keeps a live CONNECTED Cloud API phone registered without requiring a PIN", async () => {
    delete process.env.WHATSAPP_DEFAULT_PIN;
    (getPhoneNumberDetails as jest.Mock).mockResolvedValue({
      id: "phone-1",
      status: "CONNECTED",
      platform_type: "CLOUD_API",
      is_on_biz_app: false,
    });

    const credentials = await completeSignup();

    expect(registerPhoneNumberWithPin).not.toHaveBeenCalled();
    expect(credentials).toEqual(
      expect.objectContaining({
        phone_registered: true,
        phone_registration_status: "CONNECTED",
        phone_registration_error: null,
        coexistence_mode: false,
      })
    );
  });

  it("records an already-registered response as registration rather than code verification", async () => {
    (registerPhoneNumberWithPin as jest.Mock).mockRejectedValue(
      new Error("Phone number already registered")
    );

    const credentials = await completeSignup();

    expect(credentials).toEqual(
      expect.objectContaining({
        phone_registered: true,
        phone_registration_status: "REGISTERED",
        phone_registration_error: null,
      })
    );
  });

  it("does not mark a pending coexistence phone registered from verification or platform alone", async () => {
    const credentials = await completeSignup("coexistence");

    expect(registerPhoneNumberWithPin).not.toHaveBeenCalled();
    expect(credentials).toEqual(
      expect.objectContaining({
        coexistence_mode: true,
        phone_registered: false,
      })
    );
  });

  it("marks a live CONNECTED coexistence phone registered without calling register", async () => {
    (getPhoneNumberDetails as jest.Mock).mockResolvedValue({
      id: "phone-1",
      status: "CONNECTED",
      platform_type: "SMB",
      is_on_biz_app: true,
    });

    const credentials = await completeSignup("coexistence");

    expect(registerPhoneNumberWithPin).not.toHaveBeenCalled();
    expect(credentials).toEqual(
      expect.objectContaining({
        coexistence_mode: true,
        phone_registered: true,
        phone_registration_error: null,
      })
    );
  });

  it("preserves the coexistence register bypass when phone details cannot be fetched", async () => {
    (getPhoneNumberDetails as jest.Mock).mockRejectedValue(
      new Error("Phone lookup failed")
    );

    const credentials = await completeSignup("coexistence");

    expect(registerPhoneNumberWithPin).not.toHaveBeenCalled();
    expect(credentials).toEqual(
      expect.objectContaining({
        coexistence_mode: true,
        partner_app_installed: true,
        phone_registered: false,
      })
    );
  });
});

describe("resolveEmbeddedSignupSessionAssets", () => {
  it("reads WABA, phone number, and business IDs returned by session logging", () => {
    const params = new URLSearchParams({
      waba_id: "waba-1",
      phone_number_id: "phone-1",
      messaging_account_id: "messaging-1",
      waac_id: "waac-1",
      cs_id: "cs-1",
      business_id: "business-1",
      catalog_ids: "catalog-1,catalog-2",
    });

    expect(resolveEmbeddedSignupSessionAssets(params)).toEqual({
      wabaId: "waba-1",
      phoneNumberId: "phone-1",
      messagingAccountId: "messaging-1",
      waacId: "waac-1",
      csId: "cs-1",
      businessId: "business-1",
      wabaIds: [],
      catalogIds: ["catalog-1", "catalog-2"],
    });
  });

  it("reads multi-WABA IDs returned by grant-only session logging", () => {
    const params = new URLSearchParams({
      waba_ids: "waba-1,waba-2",
    });

    expect(resolveEmbeddedSignupSessionAssets(params)).toEqual({
      wabaId: undefined,
      phoneNumberId: undefined,
      csId: undefined,
      messagingAccountId: undefined,
      waacId: undefined,
      businessId: undefined,
      wabaIds: ["waba-1", "waba-2"],
      catalogIds: [],
    });
  });
});

describe("resolveEmbeddedSignupSessionAssetState", () => {
  it("keeps the selected WABA when co-existence session logging omits the phone number id", () => {
    expect(
      resolveEmbeddedSignupSessionAssetState({
        wabaId: "waba-1",
        phoneNumberId: undefined,
        csId: undefined,
        messagingAccountId: undefined,
        waacId: undefined,
        businessId: undefined,
        wabaIds: [],
        catalogIds: [],
      })
    ).toBe("waba_only");
  });

  it("treats one returned WABA ID without a phone as WABA-only", () => {
    expect(
      resolveEmbeddedSignupSessionAssetState({
        wabaId: undefined,
        phoneNumberId: undefined,
        csId: undefined,
        messagingAccountId: undefined,
        waacId: undefined,
        businessId: undefined,
        wabaIds: ["waba-1"],
        catalogIds: [],
      })
    ).toBe("waba_only");
  });
});

describe("resolveEmbeddedSignupFlow", () => {
  it("uses the explicit flow marker from the client callback", () => {
    const params = new URLSearchParams({
      flow: "coexistence",
    });

    expect(resolveEmbeddedSignupFlow(params)).toBe("coexistence");
  });

  it("detects coexistence from the WhatsApp Business app finish event", () => {
    const params = new URLSearchParams({
      event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
    });

    expect(resolveEmbeddedSignupFlow(params)).toBe("coexistence");
  });

  it("prefers the WhatsApp Business app finish event over a stale Cloud API flow marker", () => {
    const params = new URLSearchParams({
      flow: "cloud_api",
      event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
    });

    expect(resolveEmbeddedSignupFlow(params)).toBe("coexistence");
  });

  it("uses the OAuth state flow marker for direct WhatsApp Business app onboarding", () => {
    const params = new URLSearchParams();

    expect(resolveEmbeddedSignupFlow(params, "coexistence")).toBe(
      "coexistence"
    );
  });

  it("falls back to Cloud API for the normal finish event", () => {
    const params = new URLSearchParams({
      event: "FINISH",
    });

    expect(resolveEmbeddedSignupFlow(params)).toBe("cloud_api");
  });
});

describe("shouldAttemptEmbeddedSignupPhoneRegistration", () => {
  it("registers Cloud API phones even when Meta already reports code verification as verified", () => {
    expect(
      shouldAttemptEmbeddedSignupPhoneRegistration({
        flow: "cloud_api",
        codeVerificationStatus: "VERIFIED",
        platformType: "CLOUD_API",
        isOnBizApp: false,
      })
    ).toBe(true);
  });

  it("skips phone registration for co-existence phones", () => {
    expect(
      shouldAttemptEmbeddedSignupPhoneRegistration({
        flow: "coexistence",
        codeVerificationStatus: "VERIFIED",
        platformType: "CLOUD_API",
        isOnBizApp: true,
      })
    ).toBe(false);
  });
});

describe("buildEmbeddedSignupTokenExchangeQueries", () => {
  it("preserves the old redirect_uri exchange first and keeps a no-redirect fallback", () => {
    expect(
      buildEmbeddedSignupTokenExchangeQueries({
        appId: "app-1",
        appSecret: "secret-1",
        code: "code-1",
        redirectUri:
          "https://app.example.com/api/sources/whatsapp/callback?embedded=true",
      })
    ).toEqual([
      {
        client_id: "app-1",
        client_secret: "secret-1",
        code: "code-1",
        redirect_uri:
          "https://app.example.com/api/sources/whatsapp/callback?embedded=true",
      },
      {
        client_id: "app-1",
        client_secret: "secret-1",
        code: "code-1",
      },
    ]);
  });

  it("can prefer the no-redirect exchange for JS SDK callbacks", () => {
    expect(
      buildEmbeddedSignupTokenExchangeQueries({
        appId: "app-1",
        appSecret: "secret-1",
        code: "code-1",
        redirectUri:
          "https://app.example.com/api/sources/whatsapp/callback?embedded=true",
        preferRedirectUri: false,
      })
    ).toEqual([
      {
        client_id: "app-1",
        client_secret: "secret-1",
        code: "code-1",
      },
      {
        client_id: "app-1",
        client_secret: "secret-1",
        code: "code-1",
        redirect_uri:
          "https://app.example.com/api/sources/whatsapp/callback?embedded=true",
      },
    ]);
  });

  it("keeps the existing single-query helper available for no-redirect calls", () => {
    expect(
      buildEmbeddedSignupTokenExchangeQuery({
        appId: "app-1",
        appSecret: "secret-1",
        code: "code-1",
      })
    ).not.toHaveProperty("redirect_uri");
  });
});
