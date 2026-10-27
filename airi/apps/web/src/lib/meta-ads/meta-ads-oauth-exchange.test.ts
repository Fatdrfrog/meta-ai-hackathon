import {
  exchangeMetaAdsOAuthCode,
  resolveMetaAdsOAuthAccessToken,
} from "./meta-ads-oauth-exchange";

describe("canonical Meta Ads OAuth token exchange", () => {
  const originalFetch = global.fetch;
  const mockFetch = jest.fn();
  const params = {
    code: "fixture-code",
    appId: "app-1",
    appSecret: "fixture-secret",
  };
  const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = mockFetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("does not exchange a non-expiring business token again", async () => {
    mockFetch.mockResolvedValue(response({ access_token: "business-token" }));
    expect(await resolveMetaAdsOAuthAccessToken(params)).toMatchObject({
      ok: true,
      token: { access_token: "business-token" },
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("exchanges a token with an explicit duration and does not inherit its claims", async () => {
    mockFetch
      .mockResolvedValueOnce(
        response({
          access_token: "code-token",
          expires_in: 3600,
          scope: "ads_read",
        })
      )
      .mockResolvedValueOnce(response({ access_token: "final-token" }));
    expect(await resolveMetaAdsOAuthAccessToken(params)).toMatchObject({
      ok: true,
      token: { access_token: "final-token" },
    });
    expect(
      new URL(mockFetch.mock.calls[1][0]).searchParams.get("fb_exchange_token")
    ).toBe("code-token");
  });

  it("retries a JS SDK redirect URI mismatch without redirect_uri", async () => {
    mockFetch
      .mockResolvedValueOnce(
        response({ error: { message: "Invalid redirect_uri" } }, 400)
      )
      .mockResolvedValueOnce(response({ access_token: "sdk-token" }));
    expect(
      await exchangeMetaAdsOAuthCode({
        ...params,
        redirectUri: "http://localhost/callback",
      })
    ).toEqual({ access_token: "sdk-token" });
    expect(
      new URL(mockFetch.mock.calls[0][0]).searchParams.has("redirect_uri")
    ).toBe(true);
    expect(
      new URL(mockFetch.mock.calls[1][0]).searchParams.has("redirect_uri")
    ).toBe(false);
  });

  it("does not retry another failed code exchange", async () => {
    mockFetch.mockResolvedValue(
      response({ error: { message: "Code already used" } }, 400)
    );
    expect(
      await resolveMetaAdsOAuthAccessToken({
        ...params,
        redirectUri: "http://localhost/callback",
      })
    ).toMatchObject({ ok: false, stage: "code" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not silently reuse the short-lived token when long-lived exchange fails", async () => {
    mockFetch
      .mockResolvedValueOnce(
        response({ access_token: "code-token", expires_in: 3600 })
      )
      .mockResolvedValueOnce(response({ error: { message: "Failed" } }, 400));
    expect(await resolveMetaAdsOAuthAccessToken(params)).toMatchObject({
      ok: false,
      stage: "long_lived",
    });
  });
});
