const mockExchange = jest.fn();
const mockPublishReplacement = jest.fn();

jest.mock("@/lib/tiktok-discovery/oauth-token", () => ({
  exchangeTikTokOAuthCode: (...args: unknown[]) => mockExchange(...args),
  TikTokOAuthTokenError: class TikTokOAuthTokenError extends Error {
    constructor(readonly code: string) {
      super(code);
      this.name = "TikTokOAuthTokenError";
    }
  },
}));

jest.mock("@/lib/tiktok-discovery/platform-credential-coordinate", () => ({
  replaceTikTokPlatformCredentialAndPublish: (...args: unknown[]) =>
    mockPublishReplacement(...args),
}));

import type { TikTokOAuthConfig } from "@/lib/tiktok-discovery/oauth-config";
import { TikTokOAuthTokenError } from "@/lib/tiktok-discovery/oauth-token";

import { completeTikTokPlatformOAuth } from "./complete-platform-oauth";

const baseConfig: TikTokOAuthConfig = {
  appId: "app-1",
  appSecret: "server-secret",
  redirectUri: "https://www.airi.chat/api/internal/tiktok/callback",
  canonicalOrigin: "https://www.airi.chat",
  preferredAdvertiserId: null,
};

describe("completeTikTokPlatformOAuth", () => {
  beforeEach(() => {
    mockExchange.mockReset();
    mockPublishReplacement.mockReset();
  });

  it.each([
    [[], null, "advertiser_not_authorized", null],
    [["101"], null, "connected", "101"],
    [["101", "202"], null, "advertiser_selection_required", null],
    [["101", "202"], "202", "connected", "202"],
    [["101", "202"], "303", "advertiser_not_authorized", null],
  ] as const)(
    "selects from %j with preferred %s",
    async (
      advertiserIds,
      preferredAdvertiserId,
      result,
      selectedAdvertiserId
    ) => {
      mockExchange.mockResolvedValue({
        accessToken: "secret-token",
        advertiserIds: [...advertiserIds],
        grantedScopes: ["18000000"],
        requestId: "request-1",
      });
      mockPublishReplacement.mockResolvedValue({
        status: "published",
        record: {
          generation: "a".repeat(32),
          advertiserId: selectedAdvertiserId,
          status: "connected",
        },
      });

      const completion = await completeTikTokPlatformOAuth({
        authCode: "code-1",
        adminUserId: "admin-1",
        config: { ...baseConfig, preferredAdvertiserId },
      });

      expect(completion).toMatchObject({
        result,
        advertiserCount: advertiserIds.length,
        selectedAdvertiserPresent: selectedAdvertiserId !== null,
        providerRequestId: "request-1",
      });
      expect(JSON.stringify(completion)).not.toContain("secret-token");

      if (selectedAdvertiserId === null) {
        expect(mockPublishReplacement).not.toHaveBeenCalled();
      } else {
        expect(mockPublishReplacement).toHaveBeenCalledWith({
          accessToken: "secret-token",
          selectedAdvertiserId,
          authorizedAdvertiserCount: advertiserIds.length,
          grantedScopes: ["18000000"],
          connectedByUserId: "admin-1",
        });
        expect(JSON.stringify(mockPublishReplacement.mock.calls)).not.toContain(
          advertiserIds.find(id => id !== selectedAdvertiserId) ?? "never-match"
        );
      }
    }
  );

  it("returns connected only after the serialized publication succeeds", async () => {
    mockExchange.mockResolvedValue({
      accessToken: "secret-token",
      advertiserIds: ["101"],
      grantedScopes: ["18000000"],
      requestId: "request-1",
    });
    mockPublishReplacement.mockResolvedValue({
      status: "published",
      record: {
        generation: "a".repeat(32),
        advertiserId: "101",
        status: "connected",
      },
    });

    await expect(
      completeTikTokPlatformOAuth({
        authCode: "code-1",
        adminUserId: "admin-1",
        config: baseConfig,
      })
    ).resolves.toMatchObject({ result: "connected" });
    expect(mockPublishReplacement).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "secret-token",
        selectedAdvertiserId: "101",
      })
    );
  });

  it.each([
    [
      "exchange",
      new TikTokOAuthTokenError("provider_rejected"),
      "token_exchange_failed",
    ],
    ["publish", new Error("mongo unavailable"), "save_failed"],
  ] as const)("normalizes %s failures", async (stage, failure, result) => {
    mockExchange.mockImplementation(async () => {
      if (stage === "exchange") throw failure;
      return {
        accessToken: "secret-token",
        advertiserIds: ["101"],
        grantedScopes: [],
        requestId: null,
      };
    });
    mockPublishReplacement.mockImplementation(async () => {
      if (stage === "publish") throw failure;
      return {
        status: "published",
        record: {
          generation: "a".repeat(32),
          advertiserId: "101",
          status: "connected",
        },
      };
    });

    const completion = await completeTikTokPlatformOAuth({
      authCode: "code-1",
      adminUserId: "admin-1",
      config: baseConfig,
    });

    expect(completion.result).toBe(result);
    expect(JSON.stringify(completion)).not.toContain(failure.message);
  });

  it("reports coordination unavailable after the Mongo credential is safely committed", async () => {
    mockExchange.mockResolvedValue({
      accessToken: "secret-token",
      advertiserIds: ["101"],
      grantedScopes: [],
      requestId: null,
    });
    mockPublishReplacement.mockResolvedValue({
      status: "coordination_unavailable",
      record: {
        generation: "a".repeat(32),
        advertiserId: "101",
        status: "connected",
      },
    });

    await expect(
      completeTikTokPlatformOAuth({
        authCode: "code-1",
        adminUserId: "admin-1",
        config: baseConfig,
      })
    ).resolves.toMatchObject({ result: "coordination_unavailable" });
    expect(mockPublishReplacement).toHaveBeenCalledTimes(1);
  });
});
