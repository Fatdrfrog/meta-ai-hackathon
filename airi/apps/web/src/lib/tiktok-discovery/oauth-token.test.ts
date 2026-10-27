const mockFetchJsonWithinLimits = jest.fn();
jest.mock("@/lib/http/bounded-json-response", () => {
  const actual = jest.requireActual<
    typeof import("@/lib/http/bounded-json-response")
  >("@/lib/http/bounded-json-response");
  return {
    ...actual,
    fetchJsonWithinLimits: (...args: unknown[]) =>
      mockFetchJsonWithinLimits(...args),
  };
});

import { BoundedJsonResponseError } from "@/lib/http/bounded-json-response";

import { exchangeTikTokOAuthCode, TikTokOAuthTokenError } from "./oauth-token";

const exchangeInput = {
  appId: "1",
  appSecret: "secret",
  authCode: "code",
};

describe("TikTok OAuth token exchange", () => {
  beforeEach(() => {
    mockFetchJsonWithinLimits.mockReset();
  });

  it("exchanges a code using bounded JSON and normalizes IDs and scopes", async () => {
    mockFetchJsonWithinLimits.mockResolvedValue({
      response: new Response("", { status: 200 }),
      payload: {
        code: 0,
        request_id: "request-1",
        data: {
          access_token: "token",
          advertiser_ids: ["123", "123"],
          scope: [18000000, "18000000"],
        },
      },
    });

    await expect(exchangeTikTokOAuthCode(exchangeInput)).resolves.toEqual({
      accessToken: "token",
      advertiserIds: ["123"],
      grantedScopes: ["18000000"],
      requestId: "request-1",
    });
    const [url, init, limits] = mockFetchJsonWithinLimits.mock.calls[0];
    expect(url).toBe(
      "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/"
    );
    expect(init).toEqual({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        app_id: "1",
        secret: "secret",
        auth_code: "code",
      }),
      redirect: "error",
    });
    expect(limits).toEqual({ maxBytes: 2 * 1024 * 1024, timeoutMs: 8_000 });
    expect(url).not.toContain("secret");
    expect(url).not.toContain("code");
  });

  it("trims and deduplicates normalized string scopes", async () => {
    mockFetchJsonWithinLimits.mockResolvedValue({
      response: new Response("", { status: 200 }),
      payload: {
        code: 0,
        data: {
          access_token: "token",
          advertiser_ids: ["123"],
          scope: [" 18000000 ", "18000000"],
        },
      },
    });

    await expect(exchangeTikTokOAuthCode(exchangeInput)).resolves.toMatchObject(
      {
        grantedScopes: ["18000000"],
      }
    );
  });

  it("enforces the scope length bound after trimming", async () => {
    const boundedScope = "s".repeat(128);
    mockFetchJsonWithinLimits.mockResolvedValue({
      response: new Response("", { status: 200 }),
      payload: {
        code: 0,
        data: {
          access_token: "token",
          advertiser_ids: ["123"],
          scope: [` ${boundedScope} `],
        },
      },
    });

    await expect(exchangeTikTokOAuthCode(exchangeInput)).resolves.toMatchObject(
      {
        grantedScopes: [boundedScope],
      }
    );
  });

  it("accepts an empty advertiser list for a safe authorization outcome", async () => {
    mockFetchJsonWithinLimits.mockResolvedValue({
      response: new Response("", { status: 200 }),
      payload: {
        code: 0,
        data: { access_token: "token", advertiser_ids: [], scope: [] },
      },
    });

    await expect(exchangeTikTokOAuthCode(exchangeInput)).resolves.toEqual({
      accessToken: "token",
      advertiserIds: [],
      grantedScopes: [],
      requestId: null,
    });
  });

  it.each([
    [
      { code: 40101, message: "raw provider message", request_id: "r1" },
      "provider_rejected",
    ],
    [
      { code: 0, data: { advertiser_ids: ["123"], scope: [] } },
      "invalid_response",
    ],
    [
      {
        code: 0,
        data: {
          access_token: "token",
          advertiser_ids: Array.from({ length: 501 }, () => "123"),
          scope: [],
        },
      },
      "invalid_response",
    ],
    [
      {
        code: 0,
        data: {
          access_token: "token",
          advertiser_ids: ["bad-id"],
          scope: [],
        },
      },
      "invalid_response",
    ],
    [
      {
        code: 0,
        data: {
          access_token: "token",
          advertiser_ids: ["123"],
          scope: [{}],
        },
      },
      "invalid_response",
    ],
  ] as const)("normalizes invalid token payload %#", async (payload, code) => {
    mockFetchJsonWithinLimits.mockResolvedValue({
      response: new Response("", { status: 200 }),
      payload,
    });

    await expect(exchangeTikTokOAuthCode(exchangeInput)).rejects.toMatchObject({
      name: "TikTokOAuthTokenError",
      code,
    });
  });

  it("never retains provider messages in a normalized rejection", async () => {
    mockFetchJsonWithinLimits.mockResolvedValue({
      response: new Response("", { status: 200 }),
      payload: {
        code: 40101,
        message: "sensitive raw message",
        request_id: "safe-request-id",
      },
    });

    const error = await exchangeTikTokOAuthCode(exchangeInput).catch(
      (value: unknown) => value
    );
    expect(error).toBeInstanceOf(TikTokOAuthTokenError);
    expect(error).toMatchObject({
      code: "provider_rejected",
      requestId: "safe-request-id",
      message: "provider_rejected",
    });
    expect(JSON.stringify(error)).not.toContain("sensitive raw message");
  });

  it.each([
    [
      new BoundedJsonResponseError("provider_response_timeout", 8_000),
      "timeout",
    ],
    [
      new BoundedJsonResponseError(
        "provider_response_too_large",
        2 * 1024 * 1024
      ),
      "response_too_large",
    ],
  ] as const)("maps bounded fetch %s", async (failure, code) => {
    mockFetchJsonWithinLimits.mockRejectedValue(failure);

    await expect(exchangeTikTokOAuthCode(exchangeInput)).rejects.toMatchObject({
      name: "TikTokOAuthTokenError",
      code,
    });
  });

  it("normalizes native/helper and HTTP failures without retaining details", async () => {
    const sensitiveInput = {
      ...exchangeInput,
      appSecret: "app-secret-sensitive-12345",
      authCode: "auth-code-sensitive-98765",
    };
    const redirectDetails =
      `redirected to https://provider.invalid/callback?auth_code=${sensitiveInput.authCode}` +
      ` body={\"secret\":\"${sensitiveInput.appSecret}\"}`;
    mockFetchJsonWithinLimits.mockRejectedValueOnce(
      new TypeError(`fetch failed: ${redirectDetails}`)
    );
    const networkError = await exchangeTikTokOAuthCode(sensitiveInput).catch(
      (value: unknown) => value
    );
    expect(networkError).toMatchObject({
      name: "TikTokOAuthTokenError",
      code: "provider_unavailable",
      requestId: null,
      message: "provider_unavailable",
    });
    const serializedError = JSON.stringify(networkError);
    expect(serializedError).not.toContain(sensitiveInput.appSecret);
    expect(serializedError).not.toContain(sensitiveInput.authCode);
    expect(serializedError).not.toContain("provider.invalid");
    expect(serializedError).not.toContain("body");

    mockFetchJsonWithinLimits.mockResolvedValueOnce({
      response: new Response("", { status: 503 }),
      payload: null,
    });
    await expect(exchangeTikTokOAuthCode(exchangeInput)).rejects.toMatchObject({
      code: "provider_unavailable",
    });
  });

  it("drops an overlong provider request ID from a valid token response", async () => {
    mockFetchJsonWithinLimits.mockResolvedValue({
      response: new Response("", { status: 200 }),
      payload: {
        code: 0,
        request_id: "r".repeat(129),
        data: {
          access_token: "token",
          advertiser_ids: ["123"],
          scope: [18000000],
        },
      },
    });

    await expect(exchangeTikTokOAuthCode(exchangeInput)).resolves.toMatchObject(
      {
        requestId: null,
      }
    );
  });

  it.each([
    ["reflected auth code", `request-${exchangeInput.authCode}-suffix`],
    ["control characters", "request-id\r\nreflected"],
    ["provider prose", "raw provider request id"],
  ] as const)(
    "drops a %s from a valid token response",
    async (_caseName, requestId) => {
      mockFetchJsonWithinLimits.mockResolvedValue({
        response: new Response("", { status: 200 }),
        payload: {
          code: 0,
          request_id: requestId,
          data: {
            access_token: "token",
            advertiser_ids: ["123"],
            scope: [18000000],
          },
        },
      });

      await expect(
        exchangeTikTokOAuthCode(exchangeInput)
      ).resolves.toMatchObject({ requestId: null });
    }
  );

  it("drops a reflected app secret from a normalized provider error", async () => {
    mockFetchJsonWithinLimits.mockResolvedValue({
      response: new Response("", { status: 200 }),
      payload: {
        code: 40101,
        request_id: `request-${exchangeInput.appSecret}-suffix`,
      },
    });

    const error = await exchangeTikTokOAuthCode(exchangeInput).catch(
      (value: unknown) => value
    );
    expect(error).toMatchObject({
      name: "TikTokOAuthTokenError",
      code: "provider_rejected",
      requestId: null,
    });
    expect(JSON.stringify(error)).not.toContain(exchangeInput.appSecret);
  });

  it("keeps a normal identifier-safe provider request ID", async () => {
    mockFetchJsonWithinLimits.mockResolvedValue({
      response: new Response("", { status: 200 }),
      payload: {
        code: 0,
        request_id: "request_ABC-123",
        data: {
          access_token: "token",
          advertiser_ids: ["123"],
          scope: [18000000],
        },
      },
    });

    await expect(exchangeTikTokOAuthCode(exchangeInput)).resolves.toMatchObject(
      { requestId: "request_ABC-123" }
    );
  });

  it.each([
    [{ access_token: "token", advertiser_ids: [123], scope: [] }],
    [{ access_token: "token", advertiser_ids: ["123"], scope: "18000000" }],
    [{ access_token: "token", advertiser_ids: ["123"] }],
  ] as const)("rejects malformed token lists %#", async data => {
    mockFetchJsonWithinLimits.mockResolvedValue({
      response: new Response("", { status: 200 }),
      payload: { code: 0, data },
    });

    await expect(exchangeTikTokOAuthCode(exchangeInput)).rejects.toMatchObject({
      name: "TikTokOAuthTokenError",
      code: "invalid_response",
    });
  });
});
