jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));
jest.mock("@/lib/whatsapp/source-resolver", () => ({
  resolveWhatsAppSourcesByAccountIdentifiers: jest.fn(),
}));
jest.mock("@/lib/whatsapp/flows/source-rebind-guard", () => ({
  ManagedWhatsAppFlowSourceRebindError: class ManagedWhatsAppFlowSourceRebindError extends Error {},
  invalidateWhatsAppSourceBindingCaches: jest.fn(),
  updateManagedWhatsAppSourceBinding: jest.fn(),
}));

import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  ManagedWhatsAppFlowSourceRebindError,
  updateManagedWhatsAppSourceBinding,
} from "@/lib/whatsapp/flows/source-rebind-guard";
import { resolveWhatsAppSourcesByAccountIdentifiers } from "@/lib/whatsapp/source-resolver";
import { handleAccountUpdateWebhook } from "./update-handler";

function setupSourcesMock(credentials: Record<string, unknown>) {
  let persistedCredentials = credentials;
  const updateEqWorkspace = jest.fn(async () => ({ error: null }));
  const updateEqId = jest.fn(() => ({ eq: updateEqWorkspace }));
  const update = jest.fn(() => ({ eq: updateEqId }));
  const sourceDeleteEqType = jest.fn(async () => ({ error: null }));
  const sourceDeleteEqWorkspace = jest.fn(() => ({ eq: sourceDeleteEqType }));
  const sourceDeleteEqId = jest.fn(() => ({ eq: sourceDeleteEqWorkspace }));
  const sourceDelete = jest.fn(() => ({ eq: sourceDeleteEqId }));
  const accountDeleteNeq = jest.fn();
  const accountDeleteQuery = {
    neq: accountDeleteNeq,
    then: (resolve: (value: { error: null }) => void) =>
      resolve({ error: null }),
  };
  accountDeleteNeq.mockReturnValue(accountDeleteQuery);
  const accountDeleteEqSource = jest.fn(() => accountDeleteQuery);
  const accountDelete = jest.fn(() => ({ eq: accountDeleteEqSource }));
  const accountUpsert = jest.fn(async () => ({ error: null }));
  const upsert = jest.fn(async () => ({ error: null }));
  const contains = jest.fn(async () => ({
    data: [
      {
        id: "source-1",
        workspace_id: "workspace-1",
        credentials,
      },
    ],
    error: null,
  }));
  const eq = jest.fn(() => ({ contains }));
  const select = jest.fn(() => ({ eq }));

  (supabaseAdmin.from as jest.Mock).mockImplementation((table: string) => {
    if (table === "sources") {
      return {
        select,
        update,
        delete: sourceDelete,
      };
    }

    if (table === "whatsapp_accounts") {
      return {
        delete: accountDelete,
        upsert: accountUpsert,
      };
    }

    return {
      upsert,
    };
  });
  (resolveWhatsAppSourcesByAccountIdentifiers as jest.Mock).mockResolvedValue([
    {
      id: "source-1",
      workspace_id: "workspace-1",
      company_id: "company-1",
      credentials,
    },
  ]);
  (updateManagedWhatsAppSourceBinding as jest.Mock).mockImplementation(
    async params => {
      persistedCredentials = params.buildCredentials
        ? params.buildCredentials(persistedCredentials)
        : { ...params.nextCredentials };
      return {
        id: "source-1",
        workspaceId: "workspace-1",
        credentials: persistedCredentials,
        rawCredentials: persistedCredentials,
      };
    }
  );

  return {
    update,
    updateEqId,
    updateEqWorkspace,
    sourceDelete,
    sourceDeleteEqId,
    sourceDeleteEqWorkspace,
    sourceDeleteEqType,
    accountDelete,
    accountDeleteEqSource,
    accountDeleteNeq,
    accountUpsert,
    eventUpsert: upsert,
    getPersistedCredentials: () => persistedCredentials,
  };
}

describe("handleAccountUpdateWebhook coexistence reonboarding", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "info").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("marks a coexistence source paused when Meta offboards it for automatic reconnect", async () => {
    const { getPersistedCredentials, sourceDelete } = setupSourcesMock({
      waba_id: "waba-1",
      phone_number_id: "phone-1",
      coexistence_mode: true,
      partner_app_installed: true,
    });

    await handleAccountUpdateWebhook({
      event: "ACCOUNT_OFFBOARDED",
      waba_info: {
        waba_id: "waba-1",
        owner_business_id: "",
      },
    });

    expect(getPersistedCredentials()).toEqual(
      expect.objectContaining({
        waba_id: "waba-1",
        coexistence_mode: true,
        partner_app_installed: false,
        cloud_api_messaging_suspended: true,
        coexistence_reonboarding_status: "offboarded",
        coexistence_reonboarding_event: "ACCOUNT_OFFBOARDED",
        coexistence_reonboarding_offboarded_at: expect.any(String),
        coexistence_reonboarding_last_event_at: expect.any(String),
      })
    );
    expect(updateManagedWhatsAppSourceBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        currentWabaId: "waba-1",
        nextWabaId: "waba-1",
        buildCredentials: expect.any(Function),
      })
    );
    expect(
      (updateManagedWhatsAppSourceBinding as jest.Mock).mock.calls[0][0]
    ).not.toHaveProperty("currentCredentials");
    expect(sourceDelete).not.toHaveBeenCalled();
  });

  it("marks a coexistence source removed and preserves Meta disconnection context", async () => {
    const {
      getPersistedCredentials,
      sourceDelete,
      accountDeleteEqSource,
      accountDeleteNeq,
      accountUpsert,
      eventUpsert,
    } = setupSourcesMock({
      waba_id: "waba-1",
      phone_number_id: "phone-1",
      coexistence_mode: true,
      partner_app_installed: true,
    });

    await handleAccountUpdateWebhook({
      event: "PARTNER_REMOVED",
      waba_info: {
        waba_id: "waba-1",
        owner_business_id: "",
      },
      disconnection_info: {
        reason: "CLIENT_DISCONNECTED",
        initiated_by: "CLIENT",
      },
    });

    expect(getPersistedCredentials()).toEqual(
      expect.objectContaining({
        waba_id: "waba-1",
        coexistence_mode: true,
        partner_app_installed: false,
        cloud_api_messaging_suspended: true,
        coexistence_reonboarding_status: "removed",
        coexistence_reonboarding_event: "PARTNER_REMOVED",
        coexistence_reonboarding_removed_at: expect.any(String),
        coexistence_reonboarding_last_event_at: expect.any(String),
        partner_removed_reason: "CLIENT_DISCONNECTED",
        partner_removed_initiated_by: "CLIENT",
        waba_health_state: "disconnected",
      })
    );
    expect(sourceDelete).not.toHaveBeenCalled();
    expect(updateManagedWhatsAppSourceBinding).toHaveBeenCalledWith(
      expect.objectContaining({ buildCredentials: expect.any(Function) })
    );
    expect(
      (updateManagedWhatsAppSourceBinding as jest.Mock).mock.calls[0][0]
    ).not.toHaveProperty("currentCredentials");
    // Only rows for other phone numbers of this source are cleaned up.
    expect(accountDeleteEqSource).toHaveBeenCalledWith("source_id", "source-1");
    expect(accountDeleteNeq).toHaveBeenCalledWith("phone_number_id", "phone-1");
    expect(accountUpsert).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          source_id: "source-1",
          company_id: "company-1",
          connection_status: "removed",
          updated_at: expect.any(String),
        }),
      ],
      { onConflict: "source_id,account_key" }
    );
    // A removed row keeps its last_observed_at so it cannot outrank a live
    // row for the same phone in source resolution.
    expect(
      (accountUpsert.mock.calls[0] as unknown as [unknown[]])[0][0]
    ).not.toHaveProperty("last_observed_at");
    expect(eventUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "PARTNER_REMOVED",
        source_id: "source-1",
        payload: {
          wabaId: "waba-1",
          removedSourceId: "source-1",
          disconnectionInfo: {
            reason: "CLIENT_DISCONNECTED",
            initiated_by: "CLIENT",
          },
        },
      }),
      expect.anything()
    );
  });

  it("marks a coexistence source as reconnected and resumes Cloud API sends", async () => {
    const { getPersistedCredentials } = setupSourcesMock({
      waba_id: "waba-1",
      phone_number_id: "phone-1",
      coexistence_mode: true,
      partner_app_installed: false,
      cloud_api_messaging_suspended: true,
      coexistence_reonboarding_status: "offboarded",
      coexistence_reonboarding_offboarded_at: "2026-05-19T08:00:00.000Z",
      coexistence_reonboarding_removed_at: "2026-05-18T08:00:00.000Z",
      partner_removed_alert_dismissed_at: "2026-05-18T09:00:00.000Z",
      partner_removed_alert_dismissed_by: "user-1",
      partner_removed_alert_dismissed_for: "2026-05-18T08:00:00.000Z",
      partner_removed_initiated_by: "USER",
      partner_removed_reason: "ACCOUNT_DISCONNECTED",
    });

    await handleAccountUpdateWebhook({
      event: "ACCOUNT_RECONNECTED",
      waba_info: {
        waba_id: "waba-1",
        owner_business_id: "",
      },
    });

    expect(getPersistedCredentials()).toEqual(
      expect.objectContaining({
        waba_id: "waba-1",
        coexistence_mode: true,
        coexistence_reonboarding_status: "reconnected",
        coexistence_reonboarding_event: "ACCOUNT_RECONNECTED",
        cloud_api_messaging_suspended: false,
        partner_app_installed: true,
        onboarding_completed: true,
        coexistence_reonboarding_reconnected_at: expect.any(String),
        coexistence_reonboarding_last_event_at: expect.any(String),
        coexistence_reonboarding_removed_at: null,
        partner_removed_alert_dismissed_at: null,
        partner_removed_alert_dismissed_by: null,
        partner_removed_alert_dismissed_for: null,
        partner_removed_initiated_by: null,
        partner_removed_reason: null,
      })
    );
  });

  it("applies reconnect to the latest credentials when alert dismissal races the webhook", async () => {
    const credentials = {
      waba_id: "waba-1",
      phone_number_id: "phone-1",
      coexistence_mode: true,
      partner_app_installed: false,
      cloud_api_messaging_suspended: true,
      coexistence_reonboarding_status: "removed",
      coexistence_reonboarding_event: "PARTNER_REMOVED",
      coexistence_reonboarding_removed_at: "2026-05-18T08:00:00.000Z",
    };
    setupSourcesMock(credentials);
    const credentialsAfterConcurrentDismissal = {
      ...credentials,
      partner_removed_alert_dismissed_at: "2026-05-18T09:00:00.000Z",
      partner_removed_alert_dismissed_by: "user-1",
      partner_removed_alert_dismissed_for: "2026-05-18T08:00:00.000Z",
    };
    let persistedCredentials: Record<string, unknown> | undefined;
    (updateManagedWhatsAppSourceBinding as jest.Mock)
      .mockRejectedValueOnce(new ManagedWhatsAppFlowSourceRebindError())
      .mockImplementationOnce(async params => {
        persistedCredentials = params.buildCredentials(
          credentialsAfterConcurrentDismissal
        );
        return {
          id: "source-1",
          workspaceId: "workspace-1",
          credentials: persistedCredentials,
          rawCredentials: persistedCredentials,
        };
      });

    await handleAccountUpdateWebhook({
      event: "ACCOUNT_RECONNECTED",
      waba_info: {
        waba_id: "waba-1",
        owner_business_id: "",
      },
    });

    expect(persistedCredentials).toEqual(
      expect.objectContaining({
        coexistence_reonboarding_status: "reconnected",
        coexistence_reonboarding_event: "ACCOUNT_RECONNECTED",
        cloud_api_messaging_suspended: false,
        partner_removed_alert_dismissed_at: null,
        partner_removed_alert_dismissed_by: null,
        partner_removed_alert_dismissed_for: null,
      })
    );
    expect(updateManagedWhatsAppSourceBinding).toHaveBeenCalledTimes(2);
  });

  describe("suspension timestamps and account rows", () => {
    const wabaInfo = { waba_id: "waba-1", owner_business_id: "" };

    async function handleAt(
      at: string,
      value: Parameters<typeof handleAccountUpdateWebhook>[0]
    ) {
      jest.setSystemTime(new Date(at));
      await handleAccountUpdateWebhook(value);
    }

    beforeEach(() => {
      jest.useFakeTimers({
        doNotFake: [
          "nextTick",
          "setImmediate",
          "setTimeout",
          "setInterval",
          "queueMicrotask",
        ],
      });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("starts a new offboarding timestamp after a reconnect", async () => {
      const { getPersistedCredentials } = setupSourcesMock({
        waba_id: "waba-1",
        phone_number_id: "phone-1",
        coexistence_mode: true,
        partner_app_installed: true,
      });

      await handleAt("2026-06-02T16:10:42.000Z", {
        event: "ACCOUNT_OFFBOARDED",
        waba_info: wabaInfo,
      });
      await handleAt("2026-06-20T10:00:00.000Z", {
        event: "ACCOUNT_RECONNECTED",
        waba_info: wabaInfo,
      });
      expect(getPersistedCredentials()).toEqual(
        expect.objectContaining({
          coexistence_reonboarding_offboarded_at: "2026-06-02T16:10:42.000Z",
          coexistence_reonboarding_reconnected_at: "2026-06-20T10:00:00.000Z",
        })
      );

      await handleAt("2026-07-24T09:08:29.000Z", {
        event: "ACCOUNT_OFFBOARDED",
        waba_info: wabaInfo,
      });

      expect(getPersistedCredentials()).toEqual(
        expect.objectContaining({
          coexistence_reonboarding_status: "offboarded",
          coexistence_reonboarding_offboarded_at: "2026-07-24T09:08:29.000Z",
          coexistence_reonboarding_reconnected_at: "2026-06-20T10:00:00.000Z",
        })
      );
    });

    it("keeps the offboarding timestamp while the source stays suspended", async () => {
      const { getPersistedCredentials } = setupSourcesMock({
        waba_id: "waba-1",
        phone_number_id: "phone-1",
        coexistence_mode: true,
        partner_app_installed: true,
      });

      await handleAt("2026-07-24T09:08:29.000Z", {
        event: "ACCOUNT_OFFBOARDED",
        waba_info: wabaInfo,
      });
      await handleAt("2026-07-24T09:08:35.000Z", {
        event: "ACCOUNT_OFFBOARDED",
        waba_info: wabaInfo,
      });
      await handleAt("2026-07-24T09:20:00.000Z", {
        event: "PARTNER_REMOVED",
        waba_info: wabaInfo,
      });

      expect(getPersistedCredentials()).toEqual(
        expect.objectContaining({
          coexistence_reonboarding_status: "removed",
          coexistence_reonboarding_offboarded_at: "2026-07-24T09:08:29.000Z",
          coexistence_reonboarding_removed_at: "2026-07-24T09:20:00.000Z",
          coexistence_reonboarding_last_event_at: "2026-07-24T09:20:00.000Z",
        })
      );
    });

    it("does not relabel a Cloud API source as coexistence on partner removal", async () => {
      const { getPersistedCredentials } = setupSourcesMock({
        waba_id: "waba-1",
        phone_number_id: "phone-1",
        embedded_signup_flow: "cloud_api",
      });

      await handleAt("2026-07-24T09:20:00.000Z", {
        event: "PARTNER_REMOVED",
        waba_info: wabaInfo,
      });

      expect(getPersistedCredentials()).not.toHaveProperty("coexistence_mode");
      expect(getPersistedCredentials()).toEqual(
        expect.objectContaining({
          coexistence_reonboarding_status: "removed",
          cloud_api_messaging_suspended: true,
        })
      );
    });

    it("keeps the whatsapp_accounts row in step with the source status", async () => {
      const { accountUpsert } = setupSourcesMock({
        waba_id: "waba-1",
        phone_number_id: "phone-1",
        coexistence_mode: true,
        partner_app_installed: true,
      });
      const lastRow = () =>
        (
          accountUpsert.mock.calls.at(-1) as unknown as [
            Array<Record<string, unknown>>,
          ]
        )[0][0];

      await handleAt("2026-07-24T09:08:29.000Z", {
        event: "ACCOUNT_OFFBOARDED",
        waba_info: wabaInfo,
      });
      expect(lastRow()).toEqual(
        expect.objectContaining({
          source_id: "source-1",
          workspace_id: "workspace-1",
          company_id: "company-1",
          connection_status: "offboarded",
          last_observed_at: "2026-07-24T09:08:29.000Z",
          updated_at: "2026-07-24T09:08:29.000Z",
        })
      );

      await handleAt("2026-07-24T09:09:26.000Z", {
        event: "ACCOUNT_RECONNECTED",
        waba_info: wabaInfo,
      });
      expect(lastRow()).toEqual(
        expect.objectContaining({
          company_id: "company-1",
          connection_status: "active",
          updated_at: "2026-07-24T09:09:26.000Z",
        })
      );
    });
  });
});
