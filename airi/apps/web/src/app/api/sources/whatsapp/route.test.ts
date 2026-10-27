const mockCreateClient = jest.fn();
const mockFetchSourceWithCredentials = jest.fn();
const mockUpdateManagedWhatsAppSourceBinding = jest.fn();
const mockRunWhatsAppAutoDefaults = jest.fn();
const mockDebugConfiguredMetaAccessToken = jest.fn();
const mockSubscribeToWABAWebhooks = jest.fn();
const mockBackfillCloudApiWhatsAppContacts = jest.fn();
const mockRequestWhatsAppContactSync = jest.fn();
const mockRequestWhatsAppHistorySync = jest.fn();
const mockSaveCredentialSnapshot = jest.fn();
const mockAdminFrom = jest.fn();
const mockValidateWABAAccess = jest.fn();
const mockGraphGetJson = jest.fn();

const mockReadSelectionSessionToken = jest.fn();

jest.mock("@/lib/analytics", () => ({ trackSourceConnected: jest.fn() }));
const mockCaptureFunnelEvent = jest.fn();
jest.mock("@/lib/funnel-analytics", () => ({
  captureFunnelEvent: (...args: unknown[]) => mockCaptureFunnelEvent(...args),
}));
jest.mock("@/lib/whatsapp/embedded-signup-selection-session", () => ({
  ...jest.requireActual("@/lib/whatsapp/embedded-signup-selection-session"),
  readWhatsAppSelectionSessionToken: (...args: unknown[]) =>
    mockReadSelectionSessionToken(...args),
}));
jest.mock("@/lib/crypto", () => ({
  encryptString: (value: string) => `encrypted:${value}`,
  decryptMaybeString: (value: unknown) => value,
}));
jest.mock("@/lib/meta/app-config", () => ({
  getMetaServerAppConfig: () => ({ appId: "app-1", appSecret: "secret-1" }),
  tryGetMetaServerAppConfig: () => ({ appId: "app-1", appSecret: "secret-1" }),
}));
jest.mock("@/lib/meta/debug-token", () => ({
  debugConfiguredMetaAccessToken: (...args: unknown[]) =>
    mockDebugConfiguredMetaAccessToken(...args),
}));
jest.mock("@/lib/limits/company-limits", () => ({
  buildCompanyChannelLimitExceededResponse: jest.fn(),
  ensureCompanyChannelCapacity: jest.fn(async () => ({ allowed: true })),
}));
jest.mock("@/lib/posthog/server", () => ({ flushServerPostHog: jest.fn() }));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: (...args: unknown[]) => mockAdminFrom(...args) },
}));
jest.mock("@/lib/supabase/company-users", () => ({
  getCompanyIdForWorkspace: jest.fn(async () => "company-1"),
}));
jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));
jest.mock("@/lib/whatsapp/account/inventory", () => ({
  findWhatsAppPhoneOwner: jest.fn(async () => null),
}));
jest.mock("@/lib/whatsapp/account/persistence", () => ({
  recordWhatsAppOnboardingEvent: jest.fn(),
  upsertWhatsAppAccountsForSource: jest.fn(),
}));
jest.mock("@/lib/whatsapp/auto-defaults", () => ({
  runWhatsAppAutoDefaults: (...args: unknown[]) =>
    mockRunWhatsAppAutoDefaults(...args),
}));
jest.mock("@/lib/whatsapp/catalog/setup", () => ({
  runWhatsAppCatalogSetup: jest.fn(async () => ({ success: true })),
}));
jest.mock("@/lib/whatsapp/qr-code-service", () => ({
  getPhoneNumberDetails: jest.fn(async () => ({
    status: "CONNECTED",
    platform_type: "CLOUD_API",
    is_on_biz_app: false,
  })),
}));
jest.mock("@/lib/whatsapp/cloud-api-contact-backfill", () => ({
  backfillCloudApiWhatsAppContacts: (...args: unknown[]) =>
    mockBackfillCloudApiWhatsAppContacts(...args),
}));
jest.mock("@/lib/whatsapp/company-access-token", () => ({
  resolveCompanyWhatsAppAccessToken: jest.fn(async () => "token-new"),
}));
jest.mock("@/lib/whatsapp/contact/sync", () => ({
  requestWhatsAppContactSync: (...args: unknown[]) =>
    mockRequestWhatsAppContactSync(...args),
}));
jest.mock("@/lib/whatsapp/flows/source-rebind-guard", () => ({
  createWhatsAppSourceCredentialSnapshotSaver: jest.fn(
    params => async (nextCredentials: Record<string, unknown>) =>
      mockSaveCredentialSnapshot({ ...params, nextCredentials })
  ),
  invalidateWhatsAppSourceBindingCaches: jest.fn(),
  ManagedWhatsAppFlowSourceRebindError: class extends Error {},
  updateManagedWhatsAppSourceBinding: (...args: unknown[]) =>
    mockUpdateManagedWhatsAppSourceBinding(...args),
}));
jest.mock("@/lib/whatsapp/history-sync", () => ({
  requestWhatsAppHistorySync: (...args: unknown[]) =>
    mockRequestWhatsAppHistorySync(...args),
}));
jest.mock("@/lib/whatsapp/source-resolver", () => ({
  resolveWhatsAppSourceByAccountIdentifiers: jest.fn(),
}));
jest.mock("@/lib/whatsapp/waba-service", () => ({
  getAllWABAs: jest.fn(async () => []),
  subscribeToWABAWebhooks: (...args: unknown[]) =>
    mockSubscribeToWABAWebhooks(...args),
  validateWABAAccess: (...args: unknown[]) => mockValidateWABAAccess(...args),
}));
jest.mock("@icecore/shared/lib/meta/api", () => ({
  ...jest.requireActual("@icecore/shared/lib/meta/api"),
  getWhatsAppGraphClient: () => ({
    getJson: (...args: unknown[]) => mockGraphGetJson(...args),
  }),
}));
jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentials: (...args: unknown[]) =>
    mockFetchSourceWithCredentials(...args),
  verifyWorkspaceAccess: jest.fn(async () => true),
}));

import { NextRequest } from "next/server";
import { runWhatsAppCatalogSetup } from "@/lib/whatsapp/catalog/setup";
import {
  recordWhatsAppOnboardingEvent,
  upsertWhatsAppAccountsForSource,
} from "@/lib/whatsapp/account/persistence";
import { createWhatsAppSourceCredentialSnapshotSaver } from "@/lib/whatsapp/flows/source-rebind-guard";
import { getWhatsAppConnectionMaintenanceStatus } from "@/lib/whatsapp/token-lifecycle";
import { PATCH, POST } from "./route";

describe("/api/sources/whatsapp", () => {
  const registration = {
    phone_registered: true,
    phone_registered_at: "2026-09-01T00:00:00.000Z",
    phone_registration_status: "REGISTERED",
    phone_registration_error: null,
  };
  const syncState = {
    history_sync: { requested_at: "2026-09-01T00:00:00.000Z" },
    contact_sync: { requested_at: "2026-09-01T00:00:00.000Z" },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockDebugConfiguredMetaAccessToken.mockReset();
    mockDebugConfiguredMetaAccessToken.mockResolvedValue({
      is_valid: true,
      app_id: "app-1",
      expires_at: 2000000000,
    });
    mockSubscribeToWABAWebhooks.mockResolvedValue({ success: true });
    mockValidateWABAAccess.mockReset();
    mockValidateWABAAccess.mockResolvedValue({
      valid: true,
      phoneNumbers: [{ id: "phone-1" }, { id: "phone-new" }],
    });
    mockBackfillCloudApiWhatsAppContacts.mockReset();
    mockBackfillCloudApiWhatsAppContacts.mockResolvedValue({ skipped: true });
    mockRequestWhatsAppContactSync.mockReset();
    mockRequestWhatsAppContactSync.mockResolvedValue({ skipped: true });
    mockRequestWhatsAppHistorySync.mockReset();
    mockRequestWhatsAppHistorySync.mockResolvedValue({ skipped: true });
    const membership = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn(async () => ({
        data: { workspace_id: "workspace-1" },
      })),
    };
    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: jest.fn(async () => ({ data: { user: { id: "user-1" } } })),
      },
      from: jest.fn(() => membership),
    });
    mockRunWhatsAppAutoDefaults.mockImplementation(async ({ credentials }) => ({
      success: true,
      credentials,
      warnings: [],
      statusPatch: {},
    }));
  });

  it.each([
    {
      previousPhone: { phone_number_id: "phone-old" },
      keepRegistration: false,
    },
    { previousPhone: { phone_number_id: "phone-new" }, keepRegistration: true },
    { previousPhone: { phoneNumberId: " phone-new " }, keepRegistration: true },
  ])(
    "scopes saved registration and sync state to the normalized phone: $previousPhone",
    async ({ previousPhone, keepRegistration }) => {
      const existingCredentials = {
        ...previousPhone,
        waba_id: "waba-1",
        access_token: "token-old",
        ...registration,
        ...syncState,
      };
      mockFetchSourceWithCredentials.mockResolvedValue({
        id: "source-1",
        credentials: existingCredentials,
      });
      let savedCredentials: Record<string, unknown> | undefined;
      // The binding store merges the built credentials onto the stored row.
      mockUpdateManagedWhatsAppSourceBinding.mockImplementation(
        async ({ buildCredentials }) => {
          savedCredentials = {
            ...existingCredentials,
            ...buildCredentials(existingCredentials),
          };
          return { credentials: savedCredentials };
        }
      );

      const response = await POST(
        new NextRequest("https://www.airi.chat/api/sources/whatsapp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace_id: "workspace-1",
            phone_number_id: "phone-new",
            waba_id: "waba-1",
            access_token: "token-new",
            embedded_signup_flow: "cloud_api",
          }),
        })
      );

      expect(response.status).toBe(200);
      expect(mockCaptureFunnelEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "whatsapp_connected",
          workspaceId: "workspace-1",
          properties: expect.objectContaining({
            flow: "cloud_api",
            reconnect: true,
          }),
        })
      );
      expect(savedCredentials).not.toHaveProperty("conversions_api");
      expect(savedCredentials).not.toHaveProperty("sales_webhook_secret");
      expect(savedCredentials).not.toHaveProperty("sales_webhook_enabled");
      expect(savedCredentials).toEqual(
        expect.objectContaining({ phone_number_id: "phone-new" })
      );
      if (keepRegistration) {
        expect(savedCredentials).toEqual(
          expect.objectContaining({ ...registration, ...syncState })
        );
      } else {
        for (const field of Object.keys({ ...registration, ...syncState })) {
          expect(savedCredentials).toHaveProperty(field, null);
        }
      }
      expect(mockRunWhatsAppAutoDefaults).toHaveBeenCalledWith(
        expect.objectContaining({ credentials: savedCredentials })
      );
      expect(createWhatsAppSourceCredentialSnapshotSaver).toHaveBeenCalledTimes(
        1
      );
      expect(createWhatsAppSourceCredentialSnapshotSaver).toHaveBeenCalledWith(
        expect.objectContaining({ expectedPhoneNumberId: "phone-new" })
      );
    }
  );

  describe.each(["POST", "PATCH"] as const)("%s", method => {
    let savedCredentials: Record<string, unknown> | undefined;
    let existingCredentials: Record<string, unknown>;

    beforeEach(() => {
      savedCredentials = undefined;
      existingCredentials = {
        phone_number_id: "phone-1",
        waba_id: "waba-1",
        business_id: "business-1",
        access_token: "token-old",
        token_expires_at: "2026-01-01T00:00:00.000Z",
        token_is_valid: false,
        token_maintenance_status: "reconnect_required",
        token_maintenance_error_code: "invalid_authorization",
        token_last_refresh_attempt_at: "2026-09-01T00:00:00.000Z",
        meta_diagnostics_reconnect_reason: "meta_authorization",
        webhook_requires_reconnect: true,
        waba_subscription_permanently_failed: true,
      };
      mockFetchSourceWithCredentials.mockResolvedValue({
        id: "source-1",
        credentials: existingCredentials,
      });
      mockUpdateManagedWhatsAppSourceBinding.mockImplementation(
        async ({ buildCredentials }) => {
          savedCredentials = buildCredentials(existingCredentials);
          return { credentials: savedCredentials };
        }
      );
    });

    function saveToken(additional: Record<string, unknown> = {}) {
      const request = new NextRequest(
        "https://www.airi.chat/api/sources/whatsapp",
        {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace_id: "workspace-1",
            access_token: "token-new",
            phone_number_id: "phone-1",
            waba_id: "waba-1",
            ...additional,
          }),
        }
      );
      return method === "POST" ? POST(request) : PATCH(request);
    }

    if (method === "POST") {
      it("connects with the Embedded Signup session token and clears the session", async () => {
        mockReadSelectionSessionToken.mockReturnValueOnce("token-from-session");

        const response = await saveToken({ access_token: undefined });

        expect(response.status).toBe(200);
        expect(mockReadSelectionSessionToken).toHaveBeenCalledWith(
          expect.any(Request),
          { workspaceId: "workspace-1", userId: "user-1" }
        );
        expect(
          jest.requireMock("@/lib/whatsapp/company-access-token")
            .resolveCompanyWhatsAppAccessToken
        ).toHaveBeenCalledWith(
          expect.objectContaining({ explicitAccessToken: "token-from-session" })
        );
        const setCookie = response.headers.get("set-cookie") || "";
        expect(setCookie).toContain("airi_wa_selection=;");
        expect(setCookie).toContain("Path=/api/sources/whatsapp");
      });

      it.each(["conversions_api", "sales_webhook_secret", "sales_webhook_enabled"])(
        "rejects caller-supplied %s during source creation",
        async key => {
          const response = await saveToken({ [key]: "injected" });
          expect(response.status).toBe(400);
          expect(mockUpdateManagedWhatsAppSourceBinding).not.toHaveBeenCalled();
          expect(mockDebugConfiguredMetaAccessToken).not.toHaveBeenCalled();
        }
      );
    }

    it.each([
      { is_valid: false, app_id: "app-1" },
      { app_id: "app-1" },
      { is_valid: true, app_id: "another-app" },
    ])(
      "rejects unverified or foreign tokens before any mutation: %j",
      async metadata => {
        mockDebugConfiguredMetaAccessToken.mockResolvedValue(metadata);
        const response = await saveToken();
        expect(response.status).toBe(400);
        expect(mockUpdateManagedWhatsAppSourceBinding).not.toHaveBeenCalled();
        expect(mockSubscribeToWABAWebhooks).not.toHaveBeenCalled();
        expect(mockRunWhatsAppAutoDefaults).not.toHaveBeenCalled();
      }
    );

    it("does not replace credentials when Meta token validation fails", async () => {
      mockDebugConfiguredMetaAccessToken.mockRejectedValue(
        new Error("Meta unavailable")
      );
      const response = await saveToken();
      expect(response.status).toBe(500);
      expect(mockUpdateManagedWhatsAppSourceBinding).not.toHaveBeenCalled();
      expect(mockSubscribeToWABAWebhooks).not.toHaveBeenCalled();
    });

    it.each([{ expires_at: 0 }, {}])(
      "clears stale stored expiry when Meta returns no deadline: %j",
      async expiry => {
        mockDebugConfiguredMetaAccessToken.mockResolvedValue({
          is_valid: true,
          app_id: "app-1",
          type: "SYSTEM_USER",
          ...expiry,
        });
        const response = await saveToken();
        expect(response.status).toBe(200);
        expect(savedCredentials).toEqual(
          expect.objectContaining({
            access_token: "encrypted:token-new",
            token_expires_at: null,
            token_type: "SYSTEM_USER",
            token_is_valid: true,
            token_verified_at: expect.any(String),
            token_never_expires: "expires_at" in expiry,
            token_provider_expires_at: null,
            token_data_access_expires_at: null,
            token_maintenance_status: "healthy",
            token_maintenance_error_code: null,
            token_last_refresh_attempt_at: null,
            meta_diagnostics_reconnect_reason: null,
            webhook_requires_reconnect: true,
            waba_subscription_permanently_failed: true,
          })
        );
        expect(getWhatsAppConnectionMaintenanceStatus(savedCredentials!).state)
          .toBe("expires_at" in expiry ? "healthy" : "unknown");
      }
    );

    it("persists the actual earliest provider deadline", async () => {
      mockDebugConfiguredMetaAccessToken.mockResolvedValue({
        is_valid: true,
        app_id: "app-1",
        expires_at: 2100000000,
        data_access_expires_at: 2000000000,
      });
      const response = await saveToken();
      expect(response.status).toBe(200);
      expect(savedCredentials?.token_expires_at).toBe(
        new Date(2000000000 * 1000).toISOString()
      );
      expect(savedCredentials?.token_provider_expires_at).toBe(
        new Date(2100000000 * 1000).toISOString()
      );
      expect(savedCredentials?.token_data_access_expires_at).toBe(
        new Date(2000000000 * 1000).toISOString()
      );
      expect(savedCredentials?.token_never_expires).toBe(false);
    });

    it("preserves the setup order, trigger, and response projection", async () => {
      existingCredentials.sales_webhook_secret = { ciphertext: "private-commerce-secret" };
      const response = await saveToken();
      const body = await response.json();
      expect(JSON.stringify(body)).not.toContain("private-commerce-secret");
      expect(body.auto_defaults).not.toHaveProperty("credentials");

      expect(mockRunWhatsAppAutoDefaults).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger: method === "POST" ? "source_connect" : "token_refresh",
        })
      );
      expect(
        mockRunWhatsAppAutoDefaults.mock.invocationCallOrder[0]
      ).toBeLessThan(
        mockBackfillCloudApiWhatsAppContacts.mock.invocationCallOrder[0]
      );
      expect(
        mockBackfillCloudApiWhatsAppContacts.mock.invocationCallOrder[0]
      ).toBeLessThan(
        (runWhatsAppCatalogSetup as jest.Mock).mock.invocationCallOrder[0]
      );
      expect(body.auto_defaults).toEqual({
        attempted: true,
        success: true,
        warnings: [],
        status: {},
      });
      expect(body.auto_catalog_setup).toEqual({
        attempted: true,
        skipped: false,
        success: true,
      });
      if (method === "POST") {
        expect(
          (runWhatsAppCatalogSetup as jest.Mock).mock.invocationCallOrder[0]
        ).toBeLessThan(
          mockRequestWhatsAppHistorySync.mock.invocationCallOrder[0]
        );
        expect(body.auto_history_sync).toEqual({ skipped: true });
      } else {
        expect(mockRequestWhatsAppHistorySync).not.toHaveBeenCalled();
        expect(body).not.toHaveProperty("auto_history_sync");
      }
    });

    it("keeps the saved connection successful when Cloud API contact backfill fails", async () => {
      mockBackfillCloudApiWhatsAppContacts.mockRejectedValue(
        new Error("Mongo unavailable")
      );

      const response = await saveToken();
      const body = await response.json();

      expect(mockUpdateManagedWhatsAppSourceBinding).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        success: true,
        auto_contact_sync: { error: "Mongo unavailable" },
      });
    });

    it("keeps the saved connection successful when coexistence contact sync fails", async () => {
      existingCredentials.embedded_signup_flow = "coexistence";
      existingCredentials.coexistence_mode = true;
      mockRequestWhatsAppContactSync.mockRejectedValue(
        new Error("Contact sync unavailable")
      );

      const response = await saveToken();
      const body = await response.json();

      expect(mockUpdateManagedWhatsAppSourceBinding).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        success: true,
        auto_contact_sync: { error: "Contact sync unavailable" },
      });
    });

    if (method === "POST") {
      describe("number picker after an upgrade from the Business app", () => {
        const { recordWhatsAppOnboardingEvent } = jest.requireMock(
          "@/lib/whatsapp/account/persistence"
        );
        const { getPhoneNumberDetails } = jest.requireMock(
          "@/lib/whatsapp/qr-code-service"
        );
        const { hasWhatsAppBusinessAppConnectionSignal } = jest.requireActual(
          "@icecore/shared/lib/whatsapp/phone-registration-mode"
        );
        const lastEventPayload = () =>
          (recordWhatsAppOnboardingEvent as jest.Mock).mock.calls.at(-1)?.[0]
            ?.payload;
        // Post-connect skips Cloud API registration when this is true.
        const signalsBusinessApp = (credentials: Record<string, unknown>) =>
          hasWhatsAppBusinessAppConnectionSignal({
            embeddedSignupFlow: credentials.embedded_signup_flow,
            isOnBizApp: credentials.is_on_biz_app,
            coexistenceMode: credentials.coexistence_mode,
            partnerAppInstalled: credentials.partner_app_installed,
            platformType: credentials.platform_type,
          });
        const cloudApiSignup = {
          embedded_signup: true,
          embedded_signup_flow: "cloud_api",
        };

        beforeEach(() => {
          Object.assign(existingCredentials, {
            embedded_signup_flow: "coexistence",
            coexistence_mode: true,
            partner_app_installed: true,
            is_on_biz_app: true,
            platform_type: "SMB",
          });
          (getPhoneNumberDetails as jest.Mock).mockClear();
          // The binding store merges the built credentials onto the stored row.
          mockUpdateManagedWhatsAppSourceBinding.mockImplementation(
            async ({ buildCredentials }) => {
              savedCredentials = {
                ...existingCredentials,
                ...buildCredentials(existingCredentials),
              };
              return { credentials: savedCredentials };
            }
          );
        });

        it("records an upgrade Meta confirms and stores the number's current status", async () => {
          (getPhoneNumberDetails as jest.Mock).mockResolvedValueOnce({
            status: "CONNECTED",
            platform_type: "CLOUD_API",
            is_on_biz_app: false,
          });

          const response = await saveToken({
            ...cloudApiSignup,
            intent: "upgrade",
          });

          expect(response.status).toBe(200);
          expect(getPhoneNumberDetails).toHaveBeenCalledWith(
            "phone-1",
            "token-new"
          );
          expect(savedCredentials).toMatchObject({
            embedded_signup_flow: "cloud_api",
            is_on_biz_app: false,
            platform_type: "CLOUD_API",
            coexistence_mode: false,
            partner_app_installed: false,
            previous_coexistence: true,
            coexistence_upgraded_at: expect.any(String),
          });
          expect(signalsBusinessApp(existingCredentials)).toBe(true);
          expect(signalsBusinessApp(savedCredentials!)).toBe(false);
          expect(mockRunWhatsAppAutoDefaults).toHaveBeenCalledWith(
            expect.objectContaining({ credentials: savedCredentials })
          );
          expect(lastEventPayload()).toMatchObject({ upgrade_intent: true });
        });

        it("records no upgrade while Meta still reports the Business app", async () => {
          (getPhoneNumberDetails as jest.Mock).mockResolvedValueOnce({
            status: "CONNECTED",
            platform_type: "CLOUD_API",
            is_on_biz_app: true,
          });

          await saveToken(cloudApiSignup);

          expect(savedCredentials).toMatchObject({
            is_on_biz_app: true,
            platform_type: "CLOUD_API",
          });
          expect(savedCredentials).not.toHaveProperty("previous_coexistence");
          expect(signalsBusinessApp(savedCredentials!)).toBe(true);
          expect(lastEventPayload()).toMatchObject({ upgrade_intent: false });
        });

        it("keeps the stored status of the same number when Meta cannot be read", async () => {
          (getPhoneNumberDetails as jest.Mock).mockRejectedValueOnce(
            new Error("Graph unavailable")
          );

          const response = await saveToken(cloudApiSignup);

          expect(response.status).toBe(200);
          expect(savedCredentials).toMatchObject({
            is_on_biz_app: true,
            platform_type: "SMB",
          });
          expect(savedCredentials).not.toHaveProperty(
            "coexistence_upgraded_at"
          );
        });

        it("drops the previous number's status when Meta cannot be read for a new one", async () => {
          // The route only accepts a number the token proves is on the WABA.
          mockValidateWABAAccess.mockResolvedValue({
            valid: true,
            phoneNumbers: [{ id: "phone-1" }, { id: "phone-2" }],
          });
          (getPhoneNumberDetails as jest.Mock).mockRejectedValueOnce(
            new Error("Graph unavailable")
          );

          await saveToken({ ...cloudApiSignup, phone_number_id: "phone-2" });

          expect(savedCredentials).toMatchObject({
            phone_number_id: "phone-2",
            is_on_biz_app: null,
            platform_type: null,
          });
          expect(signalsBusinessApp(savedCredentials!)).toBe(false);
        });

        it("keeps a Business app reconnect on coexistence", async () => {
          await saveToken({
            embedded_signup: true,
            embedded_signup_flow: "coexistence",
          });

          expect(getPhoneNumberDetails).not.toHaveBeenCalled();
          expect(savedCredentials).toMatchObject({
            coexistence_mode: true,
            partner_app_installed: true,
            is_on_biz_app: true,
            platform_type: "SMB",
          });
          expect(savedCredentials).not.toHaveProperty("previous_coexistence");
          expect(lastEventPayload()).toMatchObject({ upgrade_intent: false });
        });

        it("ignores an unknown intent", async () => {
          await saveToken({
            embedded_signup: true,
            embedded_signup_flow: "coexistence",
            intent: "downgrade",
          });

          expect(savedCredentials).toMatchObject({ coexistence_mode: true });
          expect(lastEventPayload()).toMatchObject({ upgrade_intent: false });
        });
      });
    }

    if (method === "POST") {
      it("passes the connected source to history's guarded request writer", async () => {
        existingCredentials.embedded_signup_flow = "coexistence";
        existingCredentials.coexistence_mode = true;
        mockRequestWhatsAppHistorySync.mockResolvedValue({ requested: true });

        const response = await saveToken();

        expect(response.status).toBe(200);
        expect(mockRequestWhatsAppHistorySync).toHaveBeenCalledWith(
          expect.objectContaining({
            sourceId: "source-1",
            workspaceId: "workspace-1",
            credentials: expect.objectContaining({
              phone_number_id: "phone-1",
            }),
          })
        );
      });

      it("keeps the saved connection successful when history sync fails", async () => {
        existingCredentials.embedded_signup_flow = "coexistence";
        existingCredentials.coexistence_mode = true;
        mockRequestWhatsAppHistorySync.mockRejectedValue(
          new Error("History sync unavailable")
        );

        const response = await saveToken();
        const body = await response.json();

        expect(mockUpdateManagedWhatsAppSourceBinding).toHaveBeenCalledTimes(1);
        expect(response.status).toBe(200);
        expect(body).toMatchObject({
          success: true,
          auto_history_sync: { error: "History sync unavailable" },
        });
      });
    }
  });

  it("creates a new WhatsApp source with the service role, never the member's client", async () => {
    mockFetchSourceWithCredentials.mockResolvedValue(null);
    const memberFrom = jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn(async () => ({
        data: { workspace_id: "workspace-1" },
      })),
    }));
    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: jest.fn(async () => ({ data: { user: { id: "user-1" } } })),
      },
      from: memberFrom,
    });
    const insert = jest.fn(() => ({
      select: () => ({
        single: async () => ({ data: { id: "source-new" }, error: null }),
      }),
    }));
    mockAdminFrom.mockReturnValue({ insert });

    const response = await POST(
      new NextRequest("https://www.airi.chat/api/sources/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: "workspace-1",
          phone_number_id: "phone-1",
          waba_id: "waba-1",
          access_token: "token-new",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      created: true,
    });
    expect(mockAdminFrom).toHaveBeenCalledWith("sources");
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: "company-1",
        workspace_id: "workspace-1",
        type: "whatsapp",
        credentials: expect.objectContaining({
          phone_number_id: "phone-1",
          access_token: "encrypted:token-new",
        }),
      })
    );
    expect(memberFrom).not.toHaveBeenCalledWith("sources");
  });

  describe("POST proves the token reaches the chosen number", () => {
    function connect(body: Record<string, unknown> = {}) {
      return POST(
        new NextRequest("https://www.airi.chat/api/sources/whatsapp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace_id: "workspace-1",
            phone_number_id: "another-tenants-phone",
            waba_id: "waba-1",
            ...body,
          }),
        })
      );
    }

    beforeEach(() => {
      mockFetchSourceWithCredentials.mockResolvedValue({
        id: "source-1",
        type: "whatsapp",
        credentials: { phone_number_id: "phone-1", waba_id: "waba-1" },
      });
    });

    it("refuses a number that is not on the WABA, even with the company's stored token", async () => {
      const response = await connect();

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("phone_not_in_waba");
      expect(mockValidateWABAAccess).toHaveBeenCalledWith(
        "waba-1",
        "token-new"
      );
      expect(mockUpdateManagedWhatsAppSourceBinding).not.toHaveBeenCalled();
      expect(mockAdminFrom).not.toHaveBeenCalled();
      expect(upsertWhatsAppAccountsForSource).not.toHaveBeenCalled();
    });

    it("refuses a WABA the token cannot read", async () => {
      mockValidateWABAAccess.mockResolvedValue({
        valid: false,
        error: "Access token does not have permissions to access WABA waba-2.",
      });

      const response = await connect({
        waba_id: "waba-2",
        phone_number_id: "phone-1",
        access_token: "token-new",
      });

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("invalid_waba");
      expect(mockUpdateManagedWhatsAppSourceBinding).not.toHaveBeenCalled();
      expect(upsertWhatsAppAccountsForSource).not.toHaveBeenCalled();
    });
  });

  describe("POST onto a suspended source", () => {
    const wabaGrant = {
      is_valid: true,
      app_id: "app-1",
      expires_at: 2000000000,
      scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
      granular_scopes: [
        { scope: "whatsapp_business_management", target_ids: ["waba-1"] },
        { scope: "whatsapp_business_messaging", target_ids: ["waba-1"] },
      ],
    };
    const removedCoexistence = {
      phone_number_id: "phone-1",
      waba_id: "waba-1",
      access_token: "token-old",
      embedded_signup_flow: "coexistence",
      coexistence_mode: true,
      partner_app_installed: false,
      cloud_api_messaging_suspended: true,
      coexistence_reonboarding_status: "removed",
      coexistence_reonboarding_event: "PARTNER_REMOVED",
      coexistence_reonboarding_removed_at: "2026-08-10T15:16:04.000Z",
      partner_removed_reason: "ACCOUNT_DISCONNECTED",
      partner_removed_initiated_by: "USER",
    };
    let savedCredentials: Record<string, unknown> | undefined;

    function useExistingSource(credentials: Record<string, unknown>) {
      savedCredentials = undefined;
      mockFetchSourceWithCredentials.mockResolvedValue({
        id: "source-1",
        type: "whatsapp",
        workspace_id: "workspace-1",
        credentials,
      });
      mockUpdateManagedWhatsAppSourceBinding.mockImplementation(
        async ({ buildCredentials }) => {
          savedCredentials = buildCredentials(credentials);
          return { credentials: savedCredentials };
        }
      );
    }

    function finishEmbeddedSignupInPicker(
      flow: "coexistence" | "cloud_api" = "coexistence"
    ) {
      return POST(
        new NextRequest("https://www.airi.chat/api/sources/whatsapp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace_id: "workspace-1",
            phone_number_id: "phone-1",
            waba_id: "waba-1",
            access_token: "token-new",
            embedded_signup: true,
            embedded_signup_flow: flow,
          }),
        })
      );
    }

    it("lifts a partner removal when the new token is granted this WABA", async () => {
      useExistingSource(removedCoexistence);
      mockDebugConfiguredMetaAccessToken.mockResolvedValue(wabaGrant);

      const response = await finishEmbeddedSignupInPicker();

      expect(response.status).toBe(200);
      expect(savedCredentials).toEqual(
        expect.objectContaining({
          access_token: "encrypted:token-new",
          coexistence_mode: true,
          partner_app_installed: true,
          partner_app_installed_at: expect.any(String),
          cloud_api_messaging_suspended: false,
          coexistence_reonboarding_status: null,
          coexistence_reonboarding_event: null,
          coexistence_reonboarding_removed_at: null,
          partner_removed_reason: null,
          partner_removed_initiated_by: null,
        })
      );
      expect(upsertWhatsAppAccountsForSource).toHaveBeenCalledWith(
        expect.objectContaining({ credentials: savedCredentials })
      );
      expect(recordWhatsAppOnboardingEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "source_reconnected",
          payload: expect.objectContaining({ partner_removal_cleared: true }),
        })
      );
    });

    it("lifts a partner removal for a Cloud API reconnect without coexistence flags", async () => {
      useExistingSource({
        ...removedCoexistence,
        embedded_signup_flow: "cloud_api",
        coexistence_mode: false,
      });
      mockDebugConfiguredMetaAccessToken.mockResolvedValue(wabaGrant);

      const response = await finishEmbeddedSignupInPicker("cloud_api");

      expect(response.status).toBe(200);
      expect(savedCredentials).toEqual(
        expect.objectContaining({
          coexistence_mode: false,
          partner_app_installed: false,
          cloud_api_messaging_suspended: false,
          coexistence_reonboarding_status: null,
        })
      );
    });

    it.each([
      [
        "an old token that lost the WABA grant",
        {
          is_valid: true,
          app_id: "app-1",
          expires_at: 0,
          scopes: ["public_profile"],
          granular_scopes: [],
        },
      ],
      [
        "a token granted a different WABA",
        {
          ...wabaGrant,
          granular_scopes: [
            { scope: "whatsapp_business_management", target_ids: ["waba-2"] },
            { scope: "whatsapp_business_messaging", target_ids: ["waba-2"] },
          ],
        },
      ],
    ])(
      "asks for a Meta reconnect instead of saving with %s",
      async (_label, tokenData) => {
        useExistingSource(removedCoexistence);
        mockDebugConfiguredMetaAccessToken.mockResolvedValue(tokenData);

        const response = await finishEmbeddedSignupInPicker();
        const body = await response.json();

        expect(response.status).toBe(409);
        expect(body.error).toBe("reauthorization_required");
        expect(mockUpdateManagedWhatsAppSourceBinding).not.toHaveBeenCalled();
        expect(upsertWhatsAppAccountsForSource).not.toHaveBeenCalled();
        expect(mockRunWhatsAppAutoDefaults).not.toHaveBeenCalled();
      }
    );

    it("lifts a partner removal for a request without a signup flow when the number is a Business app number", async () => {
      useExistingSource(removedCoexistence);
      mockDebugConfiguredMetaAccessToken.mockResolvedValue(wabaGrant);

      const response = await POST(
        new NextRequest("https://www.airi.chat/api/sources/whatsapp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace_id: "workspace-1",
            phone_number_id: "phone-1",
            waba_id: "waba-1",
            access_token: "token-new",
          }),
        })
      );

      expect(response.status).toBe(200);
      expect(savedCredentials).toEqual(
        expect.objectContaining({
          coexistence_mode: true,
          partner_app_installed: true,
          partner_app_installed_at: expect.any(String),
          cloud_api_messaging_suspended: false,
          coexistence_reonboarding_status: null,
        })
      );
    });

    describe("when Meta returns the grant without WABA targets", () => {
      const untargetedGrant = {
        ...wabaGrant,
        granular_scopes: [
          { scope: "whatsapp_business_management" },
          { scope: "whatsapp_business_messaging" },
        ],
      };

      it("lifts the removal when the token can read the WABA", async () => {
        useExistingSource(removedCoexistence);
        mockDebugConfiguredMetaAccessToken.mockResolvedValue(untargetedGrant);
        mockGraphGetJson.mockResolvedValueOnce({ id: "waba-1" });

        const response = await finishEmbeddedSignupInPicker();

        expect(response.status).toBe(200);
        expect(mockGraphGetJson).toHaveBeenCalledWith(
          "waba-1",
          expect.objectContaining({ token: "token-new" })
        );
        expect(savedCredentials).toEqual(
          expect.objectContaining({ coexistence_reonboarding_status: null })
        );
      });

      it("asks for a Meta reconnect when Meta denies the WABA read", async () => {
        useExistingSource(removedCoexistence);
        mockDebugConfiguredMetaAccessToken.mockResolvedValue(untargetedGrant);
        mockGraphGetJson.mockRejectedValueOnce(
          Object.assign(new Error("Unsupported get request"), {
            status: 400,
            metaError: { code: 100, error_subcode: 33 },
          })
        );

        const response = await finishEmbeddedSignupInPicker();

        expect(response.status).toBe(409);
        expect((await response.json()).error).toBe("reauthorization_required");
        expect(mockUpdateManagedWhatsAppSourceBinding).not.toHaveBeenCalled();
      });

      it("fails without saving when the WABA read hits a transient Meta error", async () => {
        useExistingSource(removedCoexistence);
        mockDebugConfiguredMetaAccessToken.mockResolvedValue(untargetedGrant);
        mockGraphGetJson.mockRejectedValueOnce(
          Object.assign(new Error("Service temporarily unavailable"), {
            status: 503,
            metaError: { code: 2 },
          })
        );

        const response = await finishEmbeddedSignupInPicker();

        expect(response.status).toBe(500);
        expect(mockUpdateManagedWhatsAppSourceBinding).not.toHaveBeenCalled();
        expect(upsertWhatsAppAccountsForSource).not.toHaveBeenCalled();
      });
    });

    it("keeps an offboarded number suspended until Meta reconnects it", async () => {
      useExistingSource({
        ...removedCoexistence,
        coexistence_reonboarding_status: "offboarded",
        coexistence_reonboarding_event: "ACCOUNT_OFFBOARDED",
        coexistence_reonboarding_removed_at: undefined,
      });
      mockDebugConfiguredMetaAccessToken.mockResolvedValue(wabaGrant);

      const response = await finishEmbeddedSignupInPicker();

      expect(response.status).toBe(200);
      expect(savedCredentials).toEqual(
        expect.objectContaining({
          access_token: "encrypted:token-new",
          partner_app_installed: false,
          cloud_api_messaging_suspended: true,
          coexistence_reonboarding_status: "offboarded",
        })
      );
      expect(recordWhatsAppOnboardingEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.not.objectContaining({
            partner_removal_cleared: expect.anything(),
          }),
        })
      );
    });
  });
});
