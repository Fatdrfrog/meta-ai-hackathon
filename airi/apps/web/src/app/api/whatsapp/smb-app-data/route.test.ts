/** @jest-environment node */

const mockCreateClient = jest.fn();
const mockContactSync = jest.fn();
const mockHistorySync = jest.fn();
const mockUpdateCredentials = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));
jest.mock("@/lib/whatsapp/contact/sync", () => ({
  requestWhatsAppContactSync: (...args: unknown[]) => mockContactSync(...args),
}));
jest.mock("@/lib/whatsapp/history-sync", () => ({
  requestWhatsAppHistorySync: (...args: unknown[]) => mockHistorySync(...args),
}));
jest.mock("@/lib/whatsapp/flows/source-rebind-guard", () => ({
  updateCurrentWhatsAppSourceCredentials: (...args: unknown[]) =>
    mockUpdateCredentials(...args),
}));
jest.mock("@/lib/crypto", () => ({
  decryptMaybeString: (value: unknown) =>
    typeof value === "string" ? value : null,
}));

import { NextRequest } from "next/server";
import { POST } from "./route";

describe.each(["history", "smb_app_state_sync"] as const)(
  "manual %s sync",
  syncType => {
    const sourceCredentials = {
      waba_id: "waba-1",
      phone_number_id: "phone-original",
      access_token: "token-1",
      embedded_signup_flow: "coexistence",
    };

    function request() {
      return new NextRequest("https://airi.chat/api/whatsapp/smb-app-data", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: "workspace-1",
          syncType,
          rangeValue: 180,
          rangeUnit: "days",
        }),
      });
    }

    beforeEach(() => {
      jest.resetAllMocks();
      mockCreateClient.mockResolvedValue({
        auth: {
          getUser: jest
            .fn()
            .mockResolvedValue({ data: { user: { id: "user-1" } } }),
        },
        from: (table: string) => {
          const query = {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data:
                table === "company_users"
                  ? { role: "admin" }
                  : { id: "source-1", credentials: sourceCredentials },
              error: null,
            }),
          };
          return query;
        },
      });
      mockUpdateCredentials.mockResolvedValue(undefined);
    });

    it("returns a repairable conflict when webhook delivery is not ready", async () => {
      const sync = syncType === "history" ? mockHistorySync : mockContactSync;
      sync.mockResolvedValue({
        attempted: false,
        requested: false,
        skipped: true,
        reason: "webhooks_not_ready",
        error: "Sync has not been requested.",
        actionable: "Repair webhook subscriptions, then retry.",
        docs: [
          "https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users",
        ],
      });

      const response = await POST(request());

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error_code: "webhooks_not_ready",
        actionable: "Repair webhook subscriptions, then retry.",
      });
      expect(mockUpdateCredentials).not.toHaveBeenCalled();
    });

    it("reports provider acceptance with a failed save as incomplete, including state", async () => {
      const sync = syncType === "history" ? mockHistorySync : mockContactSync;
      sync.mockResolvedValue({
        requested: true,
        reason: "persist_failed",
        requestId: "accepted-1",
        error: "The accepted request could not be saved.",
        historySync: { request_state: "accepted", request_id: "accepted-1" },
      });
      const response = await POST(request());
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        error_code: "persist_failed",
        data: { history_sync: { request_id: "accepted-1" } },
      });
    });

    it("fences persisted sync state to the phone selected when the request began", async () => {
      const sync = syncType === "history" ? mockHistorySync : mockContactSync;
      if (syncType === "history") {
        sync.mockResolvedValue({ requested: true, requestId: "sync-1" });
        expect((await POST(request())).status).toBe(200);
        expect(sync).toHaveBeenCalledWith(
          expect.objectContaining({
            sourceId: "source-1",
            workspaceId: "workspace-1",
            credentials: sourceCredentials,
          })
        );
        expect(sync.mock.calls[0][0]).not.toHaveProperty("saveCredentials");
        return;
      }
      const stateKey = syncType === "history" ? "history_sync" : "contact_sync";
      sync.mockImplementation(async ({ saveCredentials }) => {
        await saveCredentials({
          ...sourceCredentials,
          [stateKey]: {
            requested_at: "2026-09-06T00:00:00.000Z",
            request_id: "sync-1",
          },
        });
        return { requested: true, requestId: "sync-1" };
      });

      const response = await POST(request());

      expect(response.status).toBe(200);
      expect(mockUpdateCredentials).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "workspace-1",
          sourceId: "source-1",
          expectedWabaId: "waba-1",
          expectedPhoneNumberId: "phone-original",
        })
      );
    });
  }
);
