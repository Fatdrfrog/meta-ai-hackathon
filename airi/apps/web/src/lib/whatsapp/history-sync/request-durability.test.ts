const mockPostJson = jest.fn();
const mockUpdateCredentials = jest.fn();
const mockReadiness = jest.fn();

jest.mock("@/lib/crypto", () => ({
  decryptMaybeString: (value: unknown) => value,
}));
jest.mock("@/lib/whatsapp/flows/source-rebind-guard", () => ({
  updateCurrentWhatsAppSourceCredentials: (...args: unknown[]) =>
    mockUpdateCredentials(...args),
}));
jest.mock("@icecore/shared/lib/meta/api", () => ({
  ...jest.requireActual("@icecore/shared/lib/meta/api"),
  getWhatsAppGraphClient: () => ({
    postJson: (...args: unknown[]) => mockPostJson(...args),
  }),
}));
jest.mock("@/lib/whatsapp/waba-service", () => ({
  getWhatsAppCoexistenceSyncWebhookReadiness: (...args: unknown[]) =>
    mockReadiness(...args),
}));

import { requestWhatsAppHistorySync } from ".";
import { MetaGraphRequestError } from "@icecore/shared/lib/meta/api";
import type { WhatsAppHistorySyncState } from "@icecore/whatsapp/historySyncState";

describe("requestWhatsAppHistorySync durable one-shot requests", () => {
  let current: Record<string, unknown> & { history_sync: WhatsAppHistorySyncState };
  const call = () =>
    requestWhatsAppHistorySync({
      sourceId: "source-1",
      workspaceId: "workspace-1",
      credentials: JSON.parse(JSON.stringify(current)),
      rangeDays: 180,
    });

  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers().setSystemTime(new Date("2026-10-10T10:00:00Z"));
    current = {
      phone_number_id: "phone-1",
      waba_id: "waba-1",
      access_token: "token-1",
      embedded_signup_flow: "coexistence",
      history_sync: {
        session_id: "session-1",
        session_started_at: "2026-10-10T09:00:00Z",
      },
    };
    mockReadiness.mockResolvedValue({ ready: true });
    mockPostJson.mockResolvedValue({ request_id: "request-1" });
    mockUpdateCredentials.mockImplementation(async ({ buildCredentials }) => {
      current = buildCredentials(current);
      return { credentials: current };
    });
  });
  afterEach(() => jest.useRealTimers());

  it("records a finite import scope before requesting new history", async () => {
    const result = await requestWhatsAppHistorySync({ sourceId: "source-1", workspaceId: "workspace-1", credentials: current });
    expect(result.rangeDays).toBe(30);
    expect(current.history_sync).toMatchObject({ import_policy_version: 1, import_message_limit: 50_000, import_byte_limit: 256 * 1024 * 1024 });
  });

  it("persists the claim before Meta and preserves an immediate webhook's completion", async () => {
    mockPostJson.mockImplementation(async () => {
      expect(current.history_sync).toMatchObject({
        session_id: "session-1",
        request_state: "requesting",
        request_attempted_at: expect.any(String),
      });
      current.history_sync = {
        ...current.history_sync,
        status: "completed",
        last_progress: 100,
        processed_count_total: 42,
        webhook_count: 1,
      };
      return { request_id: "request-1" };
    });
    expect(await call()).toMatchObject({
      requested: true,
      historySync: {
        request_state: "accepted",
        status: "completed",
        processed_count_total: 42,
      },
    });
    expect(current.history_sync.last_progress).toBe(100);
  });

  it("allows only one provider request from concurrent stale callers", async () => {
    const results = await Promise.all([call(), call()]);
    expect(mockPostJson).toHaveBeenCalledTimes(1);
    expect(results.filter(result => result.requested)).toHaveLength(1);
  });

  it("does not send to Meta when the durable claim cannot be persisted", async () => {
    mockUpdateCredentials.mockRejectedValue(new Error("database unavailable"));
    expect(await call()).toMatchObject({
      requested: false,
      reason: "persist_failed",
    });
    expect(mockPostJson).not.toHaveBeenCalled();
  });

  it("records unknown acceptance after network failure and never resends", async () => {
    mockPostJson.mockRejectedValue(new TypeError("fetch failed"));
    expect(await call()).toMatchObject({
      requested: false,
      reason: "request_outcome_unknown",
      historySync: { request_state: "unknown" },
    });
    expect(await call()).toMatchObject({
      requested: false,
      reason: "request_outcome_unknown",
    });
    expect(mockPostJson).toHaveBeenCalledTimes(1);
  });

  it("treats a 2xx without request_id as ambiguous instead of marking accepted", async () => {
    mockPostJson.mockResolvedValue({});
    expect(await call()).toMatchObject({
      requested: false,
      reason: "request_outcome_unknown",
    });
    expect(current.history_sync.request_state).toBe("unknown");
  });

  it("bounds a stalled provider call and permanently marks its acceptance unknown", async () => {
    mockPostJson.mockImplementation((_path, { signal }) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("request timeout")));
    }));
    const result = call();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(await result).toMatchObject({ reason: "request_outcome_unknown", historySync: { request_state: "unknown" } });
  });

  it("permits explicit retry after a definite provider rejection", async () => {
    mockPostJson.mockRejectedValueOnce(
      new MetaGraphRequestError({
        message: "Permission denied",
        status: 400,
        statusText: "Bad Request",
        url: "https://graph.facebook.com/test",
        details: { error: { code: 10, message: "Permission denied" } },
        metaError: {
          code: 10,
          message: "Permission denied",
          type: "OAuthException",
        },
      })
    );
    expect(await call()).toMatchObject({
      requested: false,
      reason: "meta_error",
      historySync: { request_state: "rejected" },
    });
    expect(await call()).toMatchObject({ requested: true });
    expect(mockPostJson).toHaveBeenCalledTimes(2);
  });

  it("reports accepted-but-unpersisted state and blocks subsequent delivery", async () => {
    mockUpdateCredentials
      .mockImplementationOnce(async ({ buildCredentials }) => {
        current = buildCredentials(current);
        return { credentials: current };
      })
      .mockRejectedValue(new Error("save failed"));
    expect(await call()).toMatchObject({
      requested: true,
      reason: "persist_failed",
      historySync: { request_state: "accepted", request_id: "request-1" },
    });
    expect(current.history_sync.request_state).toBe("requesting");
    expect(await call()).toMatchObject({
      requested: false,
      reason: "request_in_flight",
    });
    expect(mockPostJson).toHaveBeenCalledTimes(1);
  });

  it.each(["sessionless", "expired", "accepted", "cloud"])(
    "does not auto-enroll or re-request %s sources",
    async kind => {
      if (kind === "sessionless") current.history_sync = {};
      if (kind === "expired")
        current.history_sync.session_started_at = "2026-10-08T00:00:00Z";
      if (kind === "accepted")
        current.history_sync.requested_at = "2026-10-10T09:30:00Z";
      if (kind === "cloud") current.embedded_signup_flow = "cloud_api";
      expect((await call()).requested).toBe(false);
      expect(mockPostJson).not.toHaveBeenCalled();
    }
  );

  it("checks webhook readiness before consuming the durable attempt", async () => {
    mockReadiness.mockResolvedValue({
      ready: false,
      error: "Repair subscriptions",
    });
    expect(await call()).toMatchObject({ reason: "webhooks_not_ready" });
    expect(mockUpdateCredentials).not.toHaveBeenCalled();
    expect(mockPostJson).not.toHaveBeenCalled();
  });
});
