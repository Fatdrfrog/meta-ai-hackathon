jest.mock("@/lib/crypto", () => ({
  decryptString: jest.fn(() => "decrypted-token"),
}));

jest.mock("@/lib/meta/app-config", () => ({
  tryGetMetaServerAppConfig: jest.fn(() => ({
    appId: "app-1",
    appSecret: "secret-1",
  })),
}));

jest.mock("@/lib/meta/debug-token", () => ({
  debugConfiguredMetaAccessToken: jest.fn(),
}));

import { debugConfiguredMetaAccessToken } from "@/lib/meta/debug-token";
import {
  checkTokenRefreshNeeded,
  validateStoredToken,
  validateWhatsAppToken,
} from "./token-refresh";

const mockDebugToken = debugConfiguredMetaAccessToken as jest.Mock;
const NOW_MS = Date.parse("2026-09-06T12:00:00.000Z");
const NOW_SECONDS = NOW_MS / 1000;
const DAY_SECONDS = 24 * 60 * 60;

describe("WhatsApp token validation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(NOW_MS);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([false, undefined])(
    "rejects a successful debug response with is_valid=%s",
    async is_valid => {
      mockDebugToken.mockResolvedValue({
        app_id: "app-1",
        is_valid,
        expires_at: 0,
      });

      await expect(validateWhatsAppToken("token")).resolves.toEqual(
        expect.objectContaining({ valid: false })
      );
    }
  );

  it.each([
    { app_id: "other-app", revoked: true },
    { app_id: undefined, revoked: false },
  ])(
    "rejects unconfirmed app ownership without assuming revocation: %j",
    async ({ app_id, revoked }) => {
      mockDebugToken.mockResolvedValue({
        app_id,
        is_valid: true,
        expires_at: 0,
      });

      await expect(validateWhatsAppToken("token")).resolves.toEqual(
        expect.objectContaining({ valid: false, revoked })
      );
    }
  );

  it.each([
    {},
    { is_valid: true },
    { app_id: "app-1" },
    { app_id: "", is_valid: true },
  ])(
    "requests verification instead of reconnection for incomplete debugger metadata: %j",
    async metadata => {
      mockDebugToken.mockResolvedValue(metadata);
      await expect(
        validateStoredToken("encrypted", "2026-01-01T00:00:00Z")
      ).resolves.toMatchObject({
        valid: false,
        needsRefresh: false,
        actionRequired: "validate",
        validation: { valid: false, expired: false, revoked: false },
      });
    }
  );

  it.each([
    { is_valid: false },
    { expires_at: NOW_SECONDS - 1 },
    { data_access_expires_at: NOW_SECONDS - 1 },
    { app_id: "other-app" },
  ])(
    "retains confirmed authorization failures despite otherwise incomplete metadata: %j",
    async metadata => {
      mockDebugToken.mockResolvedValue(metadata);
      await expect(validateStoredToken("encrypted")).resolves.toMatchObject({
        valid: false,
        needsRefresh: true,
        actionRequired: "reconnect",
      });
    }
  );

  it("treats an elapsed provider expiry as invalid despite is_valid=true", async () => {
    mockDebugToken.mockResolvedValue({
      app_id: "app-1",
      is_valid: true,
      expires_at: NOW_SECONDS - 1,
    });

    await expect(validateWhatsAppToken("token")).resolves.toEqual(
      expect.objectContaining({ valid: false, expired: true })
    );
  });

  it("honors an earlier data-access expiry for a token that otherwise never expires", async () => {
    mockDebugToken.mockResolvedValue({
      app_id: "app-1",
      is_valid: true,
      expires_at: 0,
      data_access_expires_at: NOW_SECONDS - 1,
    });

    await expect(validateWhatsAppToken("token")).resolves.toEqual(
      expect.objectContaining({ valid: false, expired: true })
    );
  });

  it("does not describe an absent expiry as explicitly never expiring", async () => {
    mockDebugToken.mockResolvedValue({ app_id: "app-1", is_valid: true });

    const result = await checkTokenRefreshNeeded("token");

    expect(result.needsRefresh).toBe(false);
    expect(result.message).not.toMatch(/doesn't expire|never expires/i);
    expect(result.validation).toEqual(expect.objectContaining({ valid: true }));
  });

  it("identifies an explicit zero provider expiry as non-expiring", async () => {
    mockDebugToken.mockResolvedValue({
      app_id: "app-1",
      is_valid: true,
      expires_at: 0,
      data_access_expires_at: 0,
    });

    const result = await checkTokenRefreshNeeded("token");

    expect(result.needsRefresh).toBe(false);
    expect(result.message).toMatch(/doesn't expire|never expires/i);
  });

  it("consults Meta instead of rejecting a token using a stale cached expiry", async () => {
    mockDebugToken.mockResolvedValue({
      app_id: "app-1",
      is_valid: true,
      expires_at: 0,
      data_access_expires_at: 0,
    });

    const result = await validateStoredToken(
      "encrypted",
      "2026-01-01T00:00:00Z"
    );

    expect(mockDebugToken).toHaveBeenCalledWith(
      "decrypted-token",
      expect.any(Object)
    );
    expect(result).toEqual(
      expect.objectContaining({
        valid: true,
        needsRefresh: false,
        actionRequired: "none",
      })
    );
  });

  it("uses the provider's nearer expiry even when the cached expiry is far away", async () => {
    mockDebugToken.mockResolvedValue({
      app_id: "app-1",
      is_valid: true,
      expires_at: NOW_SECONDS + 60 * DAY_SECONDS,
      data_access_expires_at: NOW_SECONDS + 3 * DAY_SECONDS,
    });

    const result = await validateStoredToken(
      "encrypted",
      "2099-01-01T00:00:00Z"
    );

    expect(result).toEqual(
      expect.objectContaining({
        valid: true,
        needsRefresh: true,
        actionRequired: "reconnect",
        validation: expect.objectContaining({ daysUntilExpiry: 3 }),
      })
    );
  });

  it("recognizes renewable system-user credentials before the customer warning window", async () => {
    mockDebugToken.mockResolvedValue({
      app_id: "app-1",
      type: "SYSTEM_USER",
      is_valid: true,
      expires_at: NOW_SECONDS + 14 * DAY_SECONDS,
      data_access_expires_at: 0,
    });
    await expect(checkTokenRefreshNeeded("token")).resolves.toMatchObject({
      needsRefresh: true,
      canRefresh: true,
      actionRequired: "validate",
    });
  });

  it("does not ask the customer to reconnect when verification is temporarily unavailable", async () => {
    mockDebugToken.mockRejectedValue(new Error("Provider unavailable"));
    await expect(checkTokenRefreshNeeded("token")).resolves.toMatchObject({
      needsRefresh: false,
      actionRequired: "validate",
    });
  });
});
