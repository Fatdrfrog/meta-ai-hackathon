const mockDebug = jest.fn();
const mockGetJson = jest.fn();
jest.mock("@/lib/meta/debug-token", () => ({
  debugConfiguredMetaAccessToken: (...args: unknown[]) => mockDebug(...args),
}));
jest.mock("@icecore/shared/lib/meta/api", () => ({
  ...jest.requireActual("@icecore/shared/lib/meta/api"),
  getWhatsAppGraphClient: () => ({
    getJson: (...args: unknown[]) => mockGetJson(...args),
  }),
}));

import { maintainWhatsAppToken } from "./token-maintenance";
import { classifyWhatsAppMetaDiagnosticError } from "@/lib/meta/whatsapp-diagnostics";

const now = new Date("2026-09-17T00:00:00.000Z");
const oldExpiry = Date.parse("2026-10-01T00:00:00.000Z") / 1000;
const newExpiry = Date.parse("2026-11-16T00:00:00.000Z") / 1000;
const scopes = ["whatsapp_business_management", "whatsapp_business_messaging"];
const metadata = (patch: Record<string, unknown> = {}) => ({
  app_id: "app-1",
  user_id: "system-user-1",
  type: "SYSTEM_USER",
  is_valid: true,
  expires_at: oldExpiry,
  data_access_expires_at: 0,
  scopes,
  granular_scopes: scopes.map(scope => ({ scope, target_ids: ["waba-1"] })),
  ...patch,
});
const run = (credentials: Record<string, unknown> = {}) =>
  maintainWhatsAppToken({
    accessToken: "old-token",
    wabaId: "waba-1",
    credentials,
    now,
  });

describe("maintainWhatsAppToken", () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
    mockDebug
      .mockReset()
      .mockResolvedValueOnce(metadata())
      .mockResolvedValue(metadata({ expires_at: newExpiry }));
    mockGetJson
      .mockReset()
      .mockResolvedValue({ access_token: "new-token", expires_in: 5184000 });
    process.env.META_APP_ID = "app-1";
    process.env.META_APP_SECRET = "app-secret";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("renews a valid system-user token before the old fourteen-day warning and verifies its replacement", async () => {
    const result = await run();
    expect(result).toMatchObject({
      accessToken: "new-token",
      refreshed: true,
      requiresReconnect: false,
      credentialsPatch: { token_expires_at: "2026-11-16T00:00:00.000Z" },
    });
    expect(mockGetJson).toHaveBeenCalledWith(
      "oauth/access_token",
      expect.objectContaining({
        query: expect.objectContaining({
          grant_type: "fb_exchange_token",
          fb_exchange_token: "old-token",
          set_token_expires_in_60_days: "true",
        }),
      })
    );
    expect(mockDebug.mock.calls.map(call => call[0])).toEqual([
      "old-token",
      "new-token",
    ]);
  });

  it("uses the user-token exchange without the system-user-only flag", async () => {
    mockDebug
      .mockReset()
      .mockResolvedValueOnce(metadata({ type: "USER" }))
      .mockResolvedValue(metadata({ type: "USER", expires_at: newExpiry }));
    expect(await run()).toMatchObject({ refreshed: true });
    expect(mockGetJson.mock.calls[0][1].query).not.toHaveProperty(
      "set_token_expires_in_60_days"
    );
  });

  it("reconciles a synthetic stored expiry to the provider's non-expiring token without exchange", async () => {
    mockDebug.mockReset().mockResolvedValue(metadata({ expires_at: 0 }));
    expect(
      await run({ token_expires_at: "2026-09-16T00:00:00Z" })
    ).toMatchObject({
      accessToken: "old-token",
      refreshed: false,
      requiresReconnect: false,
      credentialsPatch: { token_expires_at: null },
    });
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it("does not exchange a healthy sixty-day token", async () => {
    mockDebug
      .mockReset()
      .mockResolvedValue(metadata({ expires_at: newExpiry }));
    expect(await run()).toMatchObject({
      refreshed: false,
      requiresReconnect: false,
    });
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it("requires reconnection for verified expiry and never attempts to renew an expired token", async () => {
    mockDebug
      .mockReset()
      .mockResolvedValue(
        metadata({ expires_at: Date.parse("2026-09-16T00:00:00Z") / 1000 })
      );
    expect(await run()).toMatchObject({
      accessToken: "old-token",
      refreshed: false,
      requiresReconnect: true,
    });
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it.each([
    { is_valid: false },
    { app_id: "different-app" },
    { scopes: ["public_profile"] },
    {
      granular_scopes: scopes.map(scope => ({
        scope,
        target_ids: ["other-waba"],
      })),
    },
  ])(
    "keeps the original token and requires reconnection when its provider authorization fails: %j",
    async patch => {
      mockDebug.mockReset().mockResolvedValue(metadata(patch));
      expect(await run()).toMatchObject({
        accessToken: "old-token",
        refreshed: false,
        requiresReconnect: true,
      });
      expect(mockGetJson).not.toHaveBeenCalled();
    }
  );

  it.each([
    { user_id: "different-user" },
    { app_id: "different-app" },
    { is_valid: false },
    { type: "USER" },
    { expires_at: oldExpiry },
    {},
    {
      granular_scopes: scopes.map(scope => ({
        scope,
        target_ids: ["other-waba"],
      })),
    },
    { scopes: ["whatsapp_business_management"] },
  ])(
    "never publishes an unverified or non-extending replacement: %j",
    async patch => {
      mockDebug
        .mockReset()
        .mockResolvedValueOnce(metadata())
        .mockResolvedValueOnce(
          Object.keys(patch).length
            ? metadata({ expires_at: newExpiry, ...patch })
            : metadata({ expires_at: undefined })
        );
      const result = await run();
      expect(result).toMatchObject({
        accessToken: "old-token",
        refreshed: false,
        requiresReconnect: false,
        credentialsPatch: { token_expires_at: "2026-10-01T00:00:00.000Z" },
      });
      expect(result.error).toBeDefined();
    }
  );

  it("does not claim renewal when unchanged data-access expiry still limits the token", async () => {
    mockDebug
      .mockReset()
      .mockResolvedValueOnce(metadata({ data_access_expires_at: oldExpiry }))
      .mockResolvedValue(
        metadata({ expires_at: newExpiry, data_access_expires_at: oldExpiry })
      );
    expect(await run()).toMatchObject({
      accessToken: "old-token",
      refreshed: false,
      credentialsPatch: { token_expires_at: "2026-10-01T00:00:00.000Z" },
    });
  });

  it("preserves credentials without reconnect when Meta diagnostics are temporarily unavailable", async () => {
    mockDebug.mockReset().mockRejectedValue(new Error("Meta unavailable"));
    expect(await run()).toMatchObject({
      accessToken: "old-token",
      credentialsPatch: {},
      refreshed: false,
      requiresReconnect: false,
      error: expect.any(Error),
    });
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it.each([{}, { is_valid: true }, { app_id: "app-1" }])(
    "does not replace verified evidence or request reconnection after an incomplete debugger response: %j",
    async data => {
      mockDebug.mockReset().mockResolvedValue(data);
      const result = await run({
        token_is_valid: true,
        token_expires_at: "2026-10-01T00:00:00.000Z",
      });
      expect(result).toMatchObject({
        accessToken: "old-token",
        refreshed: false,
        requiresReconnect: false,
        error: expect.any(Error),
      });
      expect(result.credentialsPatch).not.toHaveProperty("token_verified_at");
      expect(result.credentialsPatch).not.toHaveProperty("token_expires_at");
      expect(mockGetJson).not.toHaveBeenCalled();
    }
  );

  it("does not count a few seconds of lifetime drift as a renewal", async () => {
    mockDebug
      .mockReset()
      .mockResolvedValueOnce(metadata())
      .mockResolvedValue(metadata({ expires_at: oldExpiry + 5 }));
    expect(await run()).toMatchObject({
      accessToken: "old-token",
      refreshed: false,
    });
  });

  it("marks verified permission loss actionable even with a distant expiry", async () => {
    mockDebug
      .mockReset()
      .mockResolvedValue(
        metadata({ expires_at: newExpiry, scopes: ["public_profile"] })
      );
    expect(await run()).toMatchObject({
      requiresReconnect: true,
      credentialsPatch: {
        token_is_valid: false,
        token_maintenance_status: "reconnect_required",
      },
    });
  });

  it("checks the WABA directly when granular asset grants are omitted", async () => {
    mockDebug
      .mockReset()
      .mockResolvedValueOnce(metadata({ granular_scopes: undefined }))
      .mockResolvedValueOnce(
        metadata({ granular_scopes: undefined, expires_at: newExpiry })
      );
    mockGetJson
      .mockReset()
      .mockResolvedValueOnce({ id: "waba-1" })
      .mockResolvedValueOnce({ access_token: "new-token" })
      .mockResolvedValueOnce({ id: "waba-1" });
    expect(await run()).toMatchObject({
      refreshed: true,
      accessToken: "new-token",
    });
    expect(mockGetJson.mock.calls.map(call => call[0])).toEqual([
      "waba-1",
      "oauth/access_token",
      "waba-1",
    ]);
  });

  it("keeps the working original token when the replacement's asset probe loses authorization", async () => {
    mockDebug
      .mockReset()
      .mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(
        metadata({ granular_scopes: undefined, expires_at: newExpiry })
      );
    mockGetJson
      .mockReset()
      .mockResolvedValueOnce({ access_token: "new-token" })
      .mockRejectedValueOnce({ status: 403, metaError: { code: 200 } });
    const result = await run();
    expect(result).toMatchObject({
      refreshed: false,
      accessToken: "old-token",
      requiresReconnect: false,
      credentialsPatch: { token_is_valid: true },
    });
    expect(classifyWhatsAppMetaDiagnosticError(result.error)).toBe("transient");
  });

  it("does not interpret missing permission metadata as confirmed revocation", async () => {
    mockDebug.mockReset().mockResolvedValue(metadata({ scopes: undefined }));
    const result = await run();
    expect(result.requiresReconnect).toBe(false);
    expect(result.credentialsPatch).not.toHaveProperty("token_verified_at");
    expect(result.error).toBeDefined();
  });

  it("attributes app-authenticated debugger rejection to the platform rather than the customer's token", async () => {
    mockDebug
      .mockReset()
      .mockRejectedValue({ status: 401, metaError: { code: 190 } });
    const result = await run();
    expect(result.requiresReconnect).toBe(false);
    expect(classifyWhatsAppMetaDiagnosticError(result.error)).toBe(
      "configured_app"
    );
  });

  it("retains verified old metadata and token when an exchange is rate limited", async () => {
    mockGetJson.mockRejectedValue({ status: 429, metaError: { code: 80008 } });
    const result = await run();
    expect(result).toMatchObject({
      accessToken: "old-token",
      refreshed: false,
      requiresReconnect: false,
      credentialsPatch: { token_expires_at: "2026-10-01T00:00:00.000Z" },
    });
    expect(classifyWhatsAppMetaDiagnosticError(result.error)).toBe(
      "rate_limited"
    );
  });
});
