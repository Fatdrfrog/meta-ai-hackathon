const mockGetJson = jest.fn();
const mockPostJson = jest.fn();
const mockUpdateCredentials = jest.fn();
jest.mock("@/lib/whatsapp/flows/source-rebind-guard", () => ({
  updateCurrentWhatsAppSourceCredentials: (...args: unknown[]) =>
    mockUpdateCredentials(...args),
}));

jest.mock("@/lib/crypto", () => ({
  decryptMaybeString: jest.fn((value: unknown) =>
    typeof value === "string" ? value : null
  ),
}));

jest.mock("@icecore/shared/lib/meta/api", () => ({
  ...jest.requireActual("@icecore/shared/lib/meta/api"),
  getWhatsAppGraphClient: () => ({
    getJson: (...args: unknown[]) => mockGetJson(...args),
    postJson: (...args: unknown[]) => mockPostJson(...args),
  }),
}));

import { requestWhatsAppContactSync } from "@/lib/whatsapp/contact/sync";
import { requestWhatsAppHistorySync } from "@/lib/whatsapp/history-sync";
import { MetaGraphRequestError } from "@icecore/shared/lib/meta/api";
import {
  WHATSAPP_COEXISTENCE_ONBOARDING_DOC_URL,
  WHATSAPP_SMB_APP_STATE_SYNC_DOC_URL,
  WHATSAPP_SMB_MESSAGE_ECHOES_DOC_URL,
} from "@/lib/whatsapp/docs";

const subscribedFields = [
  "history",
  "smb_app_state_sync",
  "smb_message_echoes",
];

function subscriptionResponse(appId = "app-1", fields = subscribedFields) {
  return {
    data: [
      {
        whatsapp_business_api_data: {
          id: appId,
          name: "airi.chat",
          subscribed_fields: fields,
        },
      },
    ],
  };
}

describe.each([
  [
    "contacts",
    requestWhatsAppContactSync,
    "contact_sync",
    "smb_app_state_sync",
  ],
  ["history", requestWhatsAppHistorySync, "history_sync", "history"],
] as const)(
  "%s sync webhook prerequisites",
  (_label, requestSync, stateKey, syncType) => {
    const originalEnv = process.env;
    const credentials = {
      waba_id: "waba-1",
      phone_number_id: "phone-1",
      access_token: "token-1",
      embedded_signup_flow: "coexistence",
      history_sync: {
        session_id: "session-1",
        session_started_at: new Date().toISOString(),
      },
    };
    let currentCredentials: Record<string, unknown>;

    beforeEach(() => {
      jest.resetAllMocks();
      process.env = {
        ...originalEnv,
        META_APP_ID: "app-1",
        NEXT_PUBLIC_META_APP_ID: "app-1",
        META_APP_SECRET: "app-secret",
      };
      mockGetJson.mockResolvedValue(subscriptionResponse());
      mockPostJson.mockResolvedValue({ request_id: "request-1" });
      currentCredentials = { ...credentials };
      mockUpdateCredentials.mockImplementation(async ({ buildCredentials }) => {
        currentCredentials = buildCredentials(currentCredentials);
        return { credentials: currentCredentials };
      });
      const { decryptMaybeString } = jest.requireMock("@/lib/crypto");
      decryptMaybeString.mockImplementation((value: unknown) =>
        typeof value === "string" ? value : null
      );
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("accepts the three coexistence fields without unrelated calls fields before requesting sync", async () => {
      const saveCredentials = jest.fn();
      const result = await requestSync({
        sourceId: "source-1",
        workspaceId: "workspace-1",
        credentials,
        saveCredentials,
      });

      expect(result).toMatchObject({ requested: true, requestId: "request-1" });
      expect(mockGetJson).toHaveBeenCalledWith("waba-1/subscribed_apps", {
        token: "token-1",
        query: { fields: "id,name,whatsapp_business_api_data" },
      });
      expect(mockPostJson).toHaveBeenCalledWith("phone-1/smb_app_data", {
        token: "token-1",
        body: { messaging_product: "whatsapp", sync_type: syncType },
        ...(syncType === "history" ? { signal: expect.any(AbortSignal) } : {}),
      });
      expect(mockGetJson.mock.invocationCallOrder[0]).toBeLessThan(
        mockPostJson.mock.invocationCallOrder[0]
      );
      const expectedCredentials = expect.objectContaining({
        [stateKey]: expect.objectContaining({
          requested_at: expect.any(String),
        }),
      });
      if (syncType === "history")
        expect(currentCredentials).toEqual(expectedCredentials);
      else expect(saveCredentials).toHaveBeenCalledWith(expectedCredentials);
    });

    it.each([
      ["missing app subscription", { data: [] }],
      ["another app with complete fields", subscriptionResponse("other-app")],
      [
        "missing coexistence fields",
        subscriptionResponse(
          "app-1",
          subscribedFields.filter(field => field !== "history")
        ),
      ],
    ])("does not consume sync when %s", async (_case, response) => {
      mockGetJson.mockResolvedValue(response);
      const saveCredentials = jest.fn();
      const result = await requestSync({
        sourceId: "source-1",
        workspaceId: "workspace-1",
        credentials,
        saveCredentials,
      });

      expect(result).toMatchObject({
        attempted: false,
        requested: false,
        skipped: true,
        reason: "webhooks_not_ready",
        error: expect.any(String),
        actionable: expect.any(String),
        docs: expect.arrayContaining([
          expect.stringContaining("onboarding-business-app-users"),
        ]),
      });
      expect(mockPostJson).not.toHaveBeenCalled();
      expect(saveCredentials).not.toHaveBeenCalled();
    });

    it("keeps sync unrequested if the webhook status read fails", async () => {
      mockGetJson.mockRejectedValue(new Error("Meta is unavailable"));
      const saveCredentials = jest.fn();
      const result = await requestSync({
        sourceId: "source-1",
        workspaceId: "workspace-1",
        credentials,
        saveCredentials,
      });

      expect(result).toMatchObject({
        attempted: false,
        requested: false,
        skipped: true,
        reason: "webhooks_not_ready",
        actionable: expect.any(String),
      });
      expect(mockPostJson).not.toHaveBeenCalled();
      expect(saveCredentials).not.toHaveBeenCalled();
    });

    it("does not request sync without a WABA whose subscription can be verified", async () => {
      const saveCredentials = jest.fn();
      const result = await requestSync({
        sourceId: "source-1",
        workspaceId: "workspace-1",
        credentials: { ...credentials, waba_id: undefined },
        saveCredentials,
      });

      expect(result).toMatchObject({
        reason: "webhooks_not_ready",
        skipped: true,
      });
      expect(mockGetJson).not.toHaveBeenCalled();
      expect(mockPostJson).not.toHaveBeenCalled();
      expect(saveCredentials).not.toHaveBeenCalled();
    });

    it("preserves the one-shot guard even when webhooks are currently unavailable", async () => {
      mockGetJson.mockRejectedValue(new Error("Meta is unavailable"));
      const saveCredentials = jest.fn();
      const result = await requestSync({
        sourceId: "source-1",
        workspaceId: "workspace-1",
        credentials: {
          ...credentials,
          [stateKey]: {
            requested_at: "2026-09-01T00:00:00.000Z",
            request_id: "existing-request",
            status: "error",
          },
        },
        saveCredentials,
      });

      expect(result).toMatchObject({
        reason: "already_requested",
        skipped: true,
      });
      expect(mockGetJson).not.toHaveBeenCalled();
      expect(mockPostJson).not.toHaveBeenCalled();
      expect(saveCredentials).not.toHaveBeenCalled();
    });

    it("allows the first sync request after a missing subscription is repaired", async () => {
      const saveCredentials = jest.fn();
      const params = {
        sourceId: "source-1",
        workspaceId: "workspace-1",
        credentials,
        saveCredentials,
      };
      mockGetJson.mockResolvedValueOnce({ data: [] });

      const blocked = await requestSync(params);
      expect(blocked).toMatchObject({
        reason: "webhooks_not_ready",
        requested: false,
      });
      expect(mockPostJson).not.toHaveBeenCalled();
      expect(saveCredentials).not.toHaveBeenCalled();

      const retried = await requestSync(params);
      expect(retried).toMatchObject({
        requested: true,
        requestId: "request-1",
      });
      expect(mockPostJson).toHaveBeenCalledTimes(1);
      if (syncType === "history") {
        expect(currentCredentials.history_sync).toMatchObject({ request_state: "accepted" });
      } else expect(saveCredentials).toHaveBeenCalledTimes(1);
    });

    it("rejects incomplete credentials before checking webhooks", async () => {
      const saveCredentials = jest.fn();
      const result = await requestSync({
        sourceId: "source-1",
        workspaceId: "workspace-1",
        credentials: { ...credentials, access_token: undefined },
        saveCredentials,
      });

      expect(result).toMatchObject({
        attempted: false,
        requested: false,
        skipped: true,
        reason: "missing_credentials",
        error: `Cannot auto-request WhatsApp ${syncType === "history" ? "history" : "contact"} sync because credentials are incomplete.`,
      });
      expect(mockGetJson).not.toHaveBeenCalled();
      expect(mockPostJson).not.toHaveBeenCalled();
      expect(saveCredentials).not.toHaveBeenCalled();
    });

    it("preserves formatted provider errors and each sync's documentation", async () => {
      mockPostJson.mockRejectedValue(
        new MetaGraphRequestError({
          message: "Provider request failed",
          status: 400,
          statusText: "Bad Request",
          url: "https://graph.facebook.com/phone-1/smb_app_data",
          details: {
            error: {
              message: "Invalid phone",
              type: "OAuthException",
              code: 100,
              error_subcode: 17,
            },
          },
        })
      );
      const saveCredentials = jest.fn();
      const result = await requestSync({
        sourceId: "source-1",
        workspaceId: "workspace-1",
        credentials,
        saveCredentials,
      });

      expect(result).toMatchObject({
        attempted: true,
        requested: false,
        skipped: false,
        reason: "meta_error",
        error: "Invalid parameter: Invalid phone",
        actionable: "Check that the WABA ID and phone number ID are correct.",
        errorCode: 100,
        errorSubcode: 17,
      });
      expect(result.docs).toEqual(
        syncType === "history"
          ? undefined
          : [
              WHATSAPP_COEXISTENCE_ONBOARDING_DOC_URL,
              WHATSAPP_SMB_APP_STATE_SYNC_DOC_URL,
            ]
      );
      expect(saveCredentials).not.toHaveBeenCalled();
    });

    it("keeps the history-only guidance for Meta's generic user error", async () => {
      mockPostJson.mockRejectedValue(
        new Error(
          JSON.stringify({
            error: {
              message: "Generic user error",
              type: "OAuthException",
              code: 135000,
            },
          })
        )
      );
      const saveCredentials = jest.fn();
      const result = await requestSync({
        sourceId: "source-1",
        workspaceId: "workspace-1",
        credentials,
        saveCredentials,
      });

      expect(result.error).toBe(
        syncType === "history"
          ? "History sync is not available for this WhatsApp account setup yet."
          : "OAuthException (135000): Generic user error"
      );
      expect(result.actionable).toBe(
        syncType === "history"
          ? "Finish coexistence onboarding in WhatsApp Manager or the WhatsApp Business app, then retry history sync."
          : undefined
      );
      expect(result.docs).toEqual([
        WHATSAPP_COEXISTENCE_ONBOARDING_DOC_URL,
        syncType === "history"
          ? WHATSAPP_SMB_MESSAGE_ECHOES_DOC_URL
          : WHATSAPP_SMB_APP_STATE_SYNC_DOC_URL,
      ]);
      expect(saveCredentials).not.toHaveBeenCalled();
    });

    it("keeps an accepted request distinguishable from a failed local save", async () => {
      const logError = jest.spyOn(console, "error").mockImplementation();
      const saveCredentials = jest
        .fn()
        .mockRejectedValue(new Error("Save failed"));
      if (syncType === "history") {
        mockUpdateCredentials.mockImplementationOnce(async ({ buildCredentials }) => {
          currentCredentials = buildCredentials(currentCredentials);
          return { credentials: currentCredentials };
        }).mockRejectedValue(new Error("Save failed"));
      }
      try {
        const result = await requestSync({
          sourceId: "source-1",
          workspaceId: "workspace-1",
          credentials,
          saveCredentials,
        });

        expect(result).toMatchObject({
          attempted: true,
          requested: true,
          skipped: false,
          reason: "persist_failed",
          requestId: "request-1",
          requestedAt: expect.any(String),
          actionable:
            syncType === "history" ? "Do not resend the history request. Refresh the status or contact support." : "Refresh this page before retrying to avoid duplicate requests.",
        });
        if (syncType === "history") expect(currentCredentials.history_sync).toMatchObject({ request_state: "requesting" });
        else expect(saveCredentials).toHaveBeenCalledWith(
          expect.objectContaining({
            [stateKey]: expect.objectContaining({
              requested_at: result.requestedAt,
              request_id: "request-1",
              status: "requested",
            }),
          })
        );
        expect(mockPostJson).toHaveBeenCalledTimes(1);
      } finally {
        logError.mockRestore();
      }
    });
  }
);
