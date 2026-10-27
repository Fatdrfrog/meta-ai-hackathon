import {
  buildTikTokAuthorizationUrl,
  resolveTikTokDiscoveryAppIdentity,
  resolveTikTokOAuthConfig,
} from "./oauth-config";

const productionRedirect = "https://www.airi.chat/api/internal/tiktok/callback";
const validEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  TIKTOK_BUSINESS_APP_ID: "app-1",
  TIKTOK_BUSINESS_APP_SECRET: "server-secret",
  TIKTOK_BUSINESS_REDIRECT_URI: productionRedirect,
};

describe("TikTok OAuth configuration", () => {
  it.each([
    [{ ...validEnv, TIKTOK_BUSINESS_APP_ID: "" }, "missing_app_id"],
    [{ ...validEnv, TIKTOK_BUSINESS_APP_SECRET: "" }, "missing_app_secret"],
    [{ ...validEnv, TIKTOK_BUSINESS_REDIRECT_URI: "" }, "missing_redirect"],
    [
      {
        ...validEnv,
        TIKTOK_BUSINESS_REDIRECT_URI:
          "http://www.airi.chat/api/internal/tiktok/callback",
      },
      "invalid_redirect",
    ],
    [
      {
        ...validEnv,
        TIKTOK_BUSINESS_REDIRECT_URI:
          "https://user:pass@www.airi.chat/api/internal/tiktok/callback",
      },
      "invalid_redirect",
    ],
    [
      {
        ...validEnv,
        TIKTOK_BUSINESS_REDIRECT_URI: `${productionRedirect}?q=1`,
      },
      "invalid_redirect",
    ],
    [
      {
        ...validEnv,
        TIKTOK_BUSINESS_REDIRECT_URI: `${productionRedirect}#fragment`,
      },
      "invalid_redirect",
    ],
    [
      {
        ...validEnv,
        TIKTOK_BUSINESS_REDIRECT_URI:
          "https://www.airi.chat/api/internal/tiktok/wrong",
      },
      "invalid_redirect",
    ],
    [
      {
        ...validEnv,
        TIKTOK_BUSINESS_REDIRECT_URI:
          "https://preview.airi.chat/api/internal/tiktok/callback",
      },
      "invalid_redirect",
    ],
    [
      { ...validEnv, TIKTOK_DISCOVERY_ADVERTISER_ID: "advertiser-1" },
      "invalid_advertiser_id",
    ],
    [
      {
        ...validEnv,
        TIKTOK_DISCOVERY_ADVERTISER_ID: "1".repeat(129),
      },
      "invalid_advertiser_id",
    ],
  ] as const)("rejects invalid config %#", (env, reason) => {
    expect(resolveTikTokOAuthConfig(env)).toEqual({
      status: "server_unconfigured",
      reason,
    });
  });

  it.each([
    [validEnv, productionRedirect],
    [
      {
        ...validEnv,
        NEXT_PUBLIC_APP_URL: "https://airi.chat",
      },
      productionRedirect,
    ],
    [
      {
        ...validEnv,
        TIKTOK_BUSINESS_REDIRECT_URI: undefined,
        NEXT_PUBLIC_APP_URL: "https://www.airi.chat",
      },
      productionRedirect,
    ],
    [
      {
        ...validEnv,
        NODE_ENV: "development",
        TIKTOK_BUSINESS_REDIRECT_URI:
          "http://localhost:3000/api/internal/tiktok/callback",
      },
      "http://localhost:3000/api/internal/tiktok/callback",
    ],
  ] as const)("accepts configured redirect %#", (env, redirectUri) => {
    expect(resolveTikTokOAuthConfig(env)).toMatchObject({
      status: "configured",
      config: { redirectUri, canonicalOrigin: new URL(redirectUri).origin },
    });
  });

  it("returns trimmed server-only values and a nullable advertiser preference", () => {
    expect(
      resolveTikTokOAuthConfig({
        ...validEnv,
        TIKTOK_BUSINESS_APP_ID: " app-1 ",
        TIKTOK_BUSINESS_APP_SECRET: " server-secret ",
        TIKTOK_DISCOVERY_ADVERTISER_ID: " 123456 ",
      })
    ).toEqual({
      status: "configured",
      config: {
        appId: "app-1",
        appSecret: "server-secret",
        redirectUri: productionRedirect,
        canonicalOrigin: "https://www.airi.chat",
        preferredAdvertiserId: "123456",
      },
    });
  });

  it("projects only the non-secret Discovery app identity", () => {
    const identity = resolveTikTokDiscoveryAppIdentity(validEnv);
    expect(identity).toEqual({ status: "configured", appId: "app-1" });
    const serialized = JSON.stringify(identity);
    expect(serialized).not.toContain("server-secret");
    expect(serialized).not.toContain("callback");
    expect(serialized).not.toContain("advertiser");
    expect(resolveTikTokDiscoveryAppIdentity({ NODE_ENV: "test" })).toEqual({
      status: "server_unconfigured",
    });
  });

  it("builds the exact provider URL without a scope or secret", () => {
    const url = buildTikTokAuthorizationUrl({
      appId: "app-1",
      redirectUri: productionRedirect,
      state: "state-1",
    });

    expect(`${url.origin}${url.pathname}`).toBe(
      "https://ads.tiktok.com/marketing_api/auth"
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      app_id: "app-1",
      redirect_uri: productionRedirect,
      state: "state-1",
    });
    expect(url.toString()).not.toContain("server-secret");
  });
});
