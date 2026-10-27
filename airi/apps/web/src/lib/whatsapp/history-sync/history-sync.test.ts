const mockPostJson = jest.fn();
jest.mock("@/lib/whatsapp/flows/source-rebind-guard", () => ({
  updateCurrentWhatsAppSourceCredentials: jest.fn(),
}));

jest.mock("@/lib/crypto", () => ({
  decryptMaybeString: (value: unknown) =>
    typeof value === "string" ? value : null,
}));

jest.mock("@icecore/shared/lib/meta/api", () => ({
  MetaGraphRequestError: class MetaGraphRequestError extends Error {},
  getWhatsAppGraphClient: jest.fn(() => ({
    postJson: (...args: unknown[]) => mockPostJson(...args),
  })),
}));

jest.mock("@/lib/whatsapp/waba-service", () => ({
  getWhatsAppCoexistenceSyncWebhookReadiness: jest
    .fn()
    .mockResolvedValue({ ready: true }),
}));

import { requestWhatsAppHistorySync } from ".";

describe("requestWhatsAppHistorySync", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("skips plain Cloud API connections because Meta history sync is coexistence-only", async () => {
    const saveCredentials = jest.fn();

    const result = await requestWhatsAppHistorySync({
      sourceId: "source-1",
      workspaceId: "workspace-1",
      credentials: {
        phone_number_id: "phone-1",
        access_token: "token-1",
        embedded_signup_flow: "cloud_api",
        platform_type: "CLOUD_API",
      },
      rangeDays: 180,
    });

    expect(result).toMatchObject({
      attempted: false,
      requested: false,
      skipped: true,
      reason: "not_coexistence",
      rangeDays: 180,
    });
    expect(mockPostJson).not.toHaveBeenCalled();
    expect(saveCredentials).not.toHaveBeenCalled();
  });

  it("does not retry a previous history sync request because Meta only allows it once", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-06-07T00:00:00.000Z"));
    const saveCredentials = jest.fn();

    const result = await requestWhatsAppHistorySync({
      sourceId: "source-1",
      workspaceId: "workspace-1",
      credentials: {
        phone_number_id: "phone-1",
        waba_id: "waba-1",
        messaging_account_id: "waba-1",
        access_token: "token-1",
        embedded_signup_flow: "coexistence",
        coexistence_mode: true,
        history_sync: {
          requested_at: "2026-05-02T15:59:47.701Z",
          request_id: "old-request",
          range_days: 180,
        },
      },
      rangeDays: 180,
    });

    expect(mockPostJson).not.toHaveBeenCalled();
    expect(saveCredentials).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      attempted: false,
      requested: false,
      skipped: true,
      reason: "already_requested",
      requestId: "old-request",
      requestedAt: "2026-05-02T15:59:47.701Z",
      actionable:
        "Meta only allows one history sync request for this onboarding. To request it again, the customer must offboard and complete Embedded Signup again.",
    });
  });

  it("does not request history again when webhook completion already exists", async () => {
    mockPostJson.mockResolvedValue({ request_id: "request-1" });
    const saveCredentials = jest.fn();
    const webhookState = {
      status: "completed",
      last_webhook_at: "2026-06-07T00:00:00.000Z",
      last_progress: 100,
      processed_count_total: 42,
      webhook_count: 2,
      range_days: 90,
    };

    const result = await requestWhatsAppHistorySync({
      sourceId: "source-1",
      workspaceId: "workspace-1",
      credentials: {
        phone_number_id: "phone-1",
        waba_id: "waba-1",
        access_token: "token-1",
        embedded_signup_flow: "coexistence",
        history_sync: webhookState,
        contact_sync: { request_id: "contacts-1" },
      },
      rangeDays: 999,
    });

    expect(result).toMatchObject({
      requested: false,
      reason: "already_requested",
      rangeDays: 180,
      historySync: webhookState,
    });
    expect(mockPostJson).not.toHaveBeenCalled();
    expect(saveCredentials).not.toHaveBeenCalled();
  });
});
