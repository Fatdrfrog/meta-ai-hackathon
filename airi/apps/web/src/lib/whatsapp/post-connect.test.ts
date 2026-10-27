jest.mock("@/lib/whatsapp/auto-defaults", () => ({
  runWhatsAppAutoDefaults: jest.fn(),
}));
jest.mock("@/lib/whatsapp/catalog/setup", () => ({
  runWhatsAppCatalogSetup: jest.fn(),
}));
jest.mock("@/lib/whatsapp/cloud-api-contact-backfill", () => ({
  backfillCloudApiWhatsAppContacts: jest.fn(),
}));
jest.mock("@/lib/whatsapp/contact/sync", () => ({
  requestWhatsAppContactSync: jest.fn(),
}));
jest.mock("@/lib/whatsapp/history-sync", () => ({
  requestWhatsAppHistorySync: jest.fn(),
}));
jest.mock("@/lib/crypto", () => ({
  decryptMaybeString: (value: unknown) => value,
}));

import { runWhatsAppAutoDefaults } from "@/lib/whatsapp/auto-defaults";
import { runWhatsAppCatalogSetup } from "@/lib/whatsapp/catalog/setup";
import { backfillCloudApiWhatsAppContacts } from "@/lib/whatsapp/cloud-api-contact-backfill";
import { requestWhatsAppContactSync } from "@/lib/whatsapp/contact/sync";
import { requestWhatsAppHistorySync } from "@/lib/whatsapp/history-sync";
import { runWhatsAppPostConnectSetup } from "./post-connect";

describe("runWhatsAppPostConnectSetup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (runWhatsAppCatalogSetup as jest.Mock).mockResolvedValue(null);
  });

  it("recovers an accepted contact save without re-requesting it before history setup", async () => {
    (runWhatsAppAutoDefaults as jest.Mock).mockImplementation(
      async ({ credentials }) => ({ credentials })
    );
    const contactSync = {
      requested_at: "2026-09-06T10:00:00.000Z",
      request_id: "accepted-contact",
    };
    (requestWhatsAppContactSync as jest.Mock).mockImplementation(
      async ({ credentials, saveCredentials }) => {
        await expect(
          saveCredentials({ ...credentials, contact_sync: contactSync })
        ).rejects.toThrow("Temporary save failure");
        return {
          attempted: true,
          requested: true,
          skipped: false,
          reason: "persist_failed",
          error: "Temporary save failure",
        };
      }
    );
    (requestWhatsAppHistorySync as jest.Mock).mockImplementation(
      async ({ credentials }) => {
        expect(credentials.contact_sync).toEqual(contactSync);
        return {
          attempted: true,
          requested: true,
          skipped: false,
          historySync: { requested_at: "2026-09-06T10:01:00.000Z" },
        };
      }
    );
    const saveCredentials = jest
      .fn()
      .mockRejectedValueOnce(new Error("Temporary save failure"))
      .mockResolvedValue(undefined);

    const result = await runWhatsAppPostConnectSetup({
      sourceId: "source-1",
      workspaceId: "workspace-1",
      trigger: "embedded_signup_connect",
      credentials: {
        waba_id: "waba-1",
        phone_number_id: "phone-1",
        embedded_signup_flow: "coexistence",
      },
      saveCredentials,
    });

    expect(result.credentials).toMatchObject({
      contact_sync: contactSync,
      history_sync: expect.any(Object),
    });
    expect(saveCredentials).toHaveBeenLastCalledWith(
      expect.objectContaining({ contact_sync: contactSync })
    );
    expect(result.failures).toEqual([
      expect.objectContaining({
        step: "contact_sync",
        reason: "persist_failed",
      }),
    ]);
    expect(requestWhatsAppContactSync).toHaveBeenCalledTimes(1);
    expect(runWhatsAppCatalogSetup).not.toHaveBeenCalled();
  });

  it("passes current contact state to catalog setup while keeping the defaults response snapshot", async () => {
    const initial = {
      waba_id: "waba-1",
      phone_number_id: "phone-1",
      embedded_signup_flow: "cloud_api",
    };
    (runWhatsAppAutoDefaults as jest.Mock).mockImplementation(
      async ({ credentials }) => ({
        credentials,
        success: true,
        warnings: [],
        statusPatch: {},
      })
    );
    (backfillCloudApiWhatsAppContacts as jest.Mock).mockImplementation(
      async ({ credentials, saveCredentials }) => {
        await saveCredentials({
          ...credentials,
          cloud_contact_backfill: { status: "completed" },
        });
        return { attempted: true, skipped: false, completed: true };
      }
    );
    (runWhatsAppCatalogSetup as jest.Mock).mockImplementation(
      async ({ credentials, saveCredentials }) => {
        expect(credentials.cloud_contact_backfill).toEqual({
          status: "completed",
        });
        await saveCredentials({ ...credentials, catalog_ids: ["catalog-1"] });
        return { setupStatus: "ready" };
      }
    );
    const saveCredentials = jest.fn();

    const result = await runWhatsAppPostConnectSetup({
      sourceId: "source-1",
      workspaceId: "workspace-1",
      credentials: initial,
      trigger: "token_refresh",
      includeHistory: false,
      saveCredentials,
    });

    expect(result.autoDefaults.credentials).toEqual(initial);
    expect(result.credentials).toEqual({
      ...initial,
      cloud_contact_backfill: { status: "completed" },
      catalog_ids: ["catalog-1"],
    });
    expect(saveCredentials).toHaveBeenLastCalledWith(result.credentials);
    expect(requestWhatsAppHistorySync).not.toHaveBeenCalled();
    expect(result.catalogSetup).toEqual({
      attempted: true,
      skipped: false,
      setupStatus: "ready",
    });
  });

  it("requests contact sync before history sync and preserves both credential states", async () => {
    const persistedCredentials: Record<string, unknown>[] = [];

    (runWhatsAppAutoDefaults as jest.Mock).mockImplementation(
      async ({ credentials, saveCredentials }) => {
        const nextCredentials = {
          ...credentials,
          auto_defaults_applied: true,
        };
        await saveCredentials(nextCredentials);
        return { credentials: nextCredentials };
      }
    );

    (requestWhatsAppContactSync as jest.Mock).mockImplementation(
      async ({ credentials, saveCredentials }) => {
        expect(credentials).toEqual(
          expect.objectContaining({
            auto_defaults_applied: true,
          })
        );
        const nextCredentials = {
          ...credentials,
          contact_sync: {
            requested_at: "2026-05-06T10:00:00.000Z",
            status: "requested",
          },
        };
        await saveCredentials(nextCredentials);
        return {
          attempted: true,
          requested: true,
          skipped: false,
        };
      }
    );

    (requestWhatsAppHistorySync as jest.Mock).mockImplementation(
      async ({ credentials }) => {
        expect(credentials).toEqual(
          expect.objectContaining({
            auto_defaults_applied: true,
            contact_sync: expect.objectContaining({
              requested_at: "2026-05-06T10:00:00.000Z",
            }),
          })
        );
        const nextCredentials = {
          ...credentials,
          history_sync: {
            requested_at: "2026-05-06T10:01:00.000Z",
            status: "requested",
          },
        };
        return {
          attempted: true,
          requested: true,
          skipped: false,
          historySync: nextCredentials.history_sync,
        };
      }
    );

    const result = await runWhatsAppPostConnectSetup({
      sourceId: "source-1",
      workspaceId: "workspace-1",
      trigger: "embedded_signup_connect",
      credentials: {
        waba_id: "waba-1",
        phone_number_id: "phone-1",
        access_token: "token-1",
        embedded_signup_flow: "coexistence",
      },
      saveCredentials: async nextCredentials => {
        persistedCredentials.push(nextCredentials);
      },
    });

    expect(requestWhatsAppContactSync).toHaveBeenCalledTimes(1);
    expect(requestWhatsAppHistorySync).toHaveBeenCalledTimes(1);
    expect(result.credentials).toEqual(
      expect.objectContaining({
        contact_sync: expect.objectContaining({
          requested_at: "2026-05-06T10:00:00.000Z",
        }),
        history_sync: expect.objectContaining({
          requested_at: "2026-05-06T10:01:00.000Z",
        }),
      })
    );
    expect(persistedCredentials[persistedCredentials.length - 1]).toMatchObject(
      { contact_sync: result.credentials.contact_sync }
    );
  });

  it("backfills conversation contacts instead of requesting smb_app_state_sync for full Cloud API", async () => {
    const persistedCredentials: Record<string, unknown>[] = [];

    (runWhatsAppAutoDefaults as jest.Mock).mockImplementation(
      async ({ credentials }) => ({ credentials })
    );
    (backfillCloudApiWhatsAppContacts as jest.Mock).mockImplementation(
      async ({ credentials, saveCredentials }) => {
        const nextCredentials = {
          ...credentials,
          cloud_contact_backfill: {
            status: "completed",
            processed_count: 2,
            linked_count: 2,
            error_count: 0,
          },
        };
        await saveCredentials(nextCredentials);
        return {
          attempted: true,
          skipped: false,
          processedCount: 2,
          linkedCount: 2,
          errorCount: 0,
        };
      }
    );
    (requestWhatsAppHistorySync as jest.Mock).mockResolvedValue({
      skipped: true,
      reason: "not_coexistence",
    });

    const result = await runWhatsAppPostConnectSetup({
      sourceId: "source-1",
      workspaceId: "workspace-1",
      trigger: "embedded_signup_connect",
      credentials: {
        waba_id: "waba-1",
        phone_number_id: "phone-1",
        access_token: "token-1",
        embedded_signup_flow: "cloud_api",
        coexistence_mode: false,
      },
      saveCredentials: async nextCredentials => {
        persistedCredentials.push(nextCredentials);
      },
    });

    expect(requestWhatsAppContactSync).not.toHaveBeenCalled();
    expect(backfillCloudApiWhatsAppContacts).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "source-1",
        workspaceId: "workspace-1",
      })
    );
    expect(result.contactSync).toEqual(
      expect.objectContaining({
        attempted: true,
        processedCount: 2,
      })
    );
    expect(result.credentials).toEqual(
      expect.objectContaining({
        cloud_contact_backfill: expect.objectContaining({
          status: "completed",
        }),
      })
    );
    expect(persistedCredentials.at(-1)).toEqual(result.credentials);
  });
});
