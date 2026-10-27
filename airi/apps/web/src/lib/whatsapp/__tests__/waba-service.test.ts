const mockGetJson = jest.fn();
const mockPostJson = jest.fn();
const mockCacheGet = jest.fn();
const mockCacheSet = jest.fn();
const mockAppProfileCache = new Map<string, unknown>();

jest.mock("@icecore/shared/lib/meta/api", () => ({
  ...jest.requireActual("@icecore/shared/lib/meta/api"),
  getWhatsAppGraphClient: () => ({
    getJson: (...args: unknown[]) => mockGetJson(...args),
    postJson: (...args: unknown[]) => mockPostJson(...args),
  }),
}));

jest.mock("@icecore/shared/lib/cache", () => ({
  ...jest.requireActual("@icecore/shared/lib/cache"),
  cache: {
    get: (...args: unknown[]) => mockCacheGet(...args),
    set: (...args: unknown[]) => mockCacheSet(...args),
  },
}));

import {
  discoverWABAs,
  extractSubscribedFieldsForApp,
  getWABAPhoneNumbers,
  getWabaWebhookSubscriptionStatus,
  subscribeToWABAWebhooks,
} from "@/lib/whatsapp/waba-service";
import { getMetaCredentialOwner } from "@/lib/meta/credential-owner";
import {
  isMetaGraphRateLimitError,
  MetaGraphRequestError,
} from "@icecore/shared/lib/meta/api";
import { REQUIRED_FIELDS } from "@icecore/whatsapp/webhookFields";

describe("waba-service webhook subscription handling", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAppProfileCache.clear();
    mockCacheGet.mockImplementation(async (key: string) => {
      return mockAppProfileCache.get(key) ?? null;
    });
    mockCacheSet.mockImplementation(
      async (key: string, value: unknown, _ttlSeconds: number) => {
        mockAppProfileCache.set(key, value);
      }
    );
    process.env = {
      ...originalEnv,
      META_APP_ID: "",
      NEXT_PUBLIC_META_APP_ID: "app-1",
      META_APP_SECRET: "app-secret",
      NEXT_PUBLIC_APP_URL: "https://www.airi.chat",
      WHATSAPP_VERIFY_TOKEN: "verify-token",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("matches the configured app id when Graph nests it under whatsapp_business_api_data", () => {
    const selection = extractSubscribedFieldsForApp({
      data: [
        {
          whatsapp_business_api_data: {
            id: "app-1",
            name: "airi.chat",
          },
          override_callback_uri: "https://www.airi.chat/api/webhooks/whatsapp",
        },
      ],
    });

    expect(selection.appSubscribed).toBe(true);
    expect(selection.matchedPreferredApp).toBe(true);
    expect(selection.selectedAppId).toBe("app-1");
    expect(selection.selectedAppName).toBe("airi.chat");
  });

  it("does not treat another app as subscribed when a preferred app is configured", () => {
    const selection = extractSubscribedFieldsForApp({
      data: [
        {
          whatsapp_business_api_data: {
            id: "another-app",
            name: "Other app",
          },
        },
      ],
    });

    expect(selection.appSubscribed).toBe(false);
    expect(selection.matchedPreferredApp).toBe(false);
    expect(selection.availableAppIds).toEqual(["another-app"]);
  });

  it("does not report another app subscription as the configured app subscription", async () => {
    mockGetJson.mockResolvedValueOnce({
      data: [
        {
          id: "another-app",
          name: "Other app",
          whatsapp_business_api_data: {
            subscribed_fields: REQUIRED_FIELDS,
          },
        },
      ],
    });

    await expect(
      getWabaWebhookSubscriptionStatus("waba-1", "token-1")
    ).resolves.toMatchObject({
      subscribed: false,
      selectedAppId: "another-app",
      matchedPreferredApp: false,
    });
  });

  it("reports missing Meta app configuration as a configured-app failure", async () => {
    delete process.env.META_APP_ID;
    delete process.env.NEXT_PUBLIC_META_APP_ID;
    delete process.env.META_APP_SECRET;
    mockGetJson.mockResolvedValueOnce({
      data: [
        {
          id: "another-app",
          name: "Other app",
          whatsapp_business_api_data: {
            subscribed_fields: REQUIRED_FIELDS,
          },
        },
      ],
    });

    await expect(
      getWabaWebhookSubscriptionStatus("waba-1", "token-1")
    ).rejects.toMatchObject({
      name: "MetaServerAppConfigError",
      metaCredentialOwner: "configured_app",
    });
  });

  it("builds the discovery debug token from one server Meta app config", async () => {
    process.env.META_APP_ID = "server-app";
    process.env.NEXT_PUBLIC_META_APP_ID = "public-app";
    process.env.META_APP_SECRET = "server-secret";
    mockGetJson.mockImplementation(async (path: string) => {
      if (path === "debug_token") {
        return {
          data: {
            granular_scopes: [
              {
                scope: "whatsapp_business_management",
                target_ids: ["waba-1"],
              },
            ],
          },
        };
      }
      if (path === "waba-1") {
        return { id: "waba-1", name: "Primary" };
      }
      if (path === "waba-1/phone_numbers") {
        return {
          data: [
            {
              id: "phone-1",
              display_phone_number: "+1 555 0100",
            },
          ],
        };
      }
      throw new Error(`Unexpected Graph path ${path}`);
    });

    await expect(discoverWABAs("business-token")).resolves.toEqual([
      {
        waba: { id: "waba-1", name: "Primary" },
        phoneNumbers: [
          {
            id: "phone-1",
            display_phone_number: "+1 555 0100",
          },
        ],
        accountType: "owned",
        businessId: undefined,
        businessName: undefined,
      },
    ]);
    expect(mockGetJson).toHaveBeenCalledWith("debug_token", {
      token: "server-app|server-secret",
      query: {
        input_token: "business-token",
        access_token: "server-app|server-secret",
      },
    });
  });

  it("uses app-level webhook fields when WABA subscribed_apps omits subscribed_fields", async () => {
    mockPostJson.mockResolvedValue({ success: true });
    mockGetJson
      .mockResolvedValueOnce({
        data: [
          {
            whatsapp_business_api_data: {
              id: "app-1",
              name: "airi.chat",
            },
            override_callback_uri:
              "https://www.airi.chat/api/webhooks/whatsapp",
          },
        ],
      })
      .mockResolvedValueOnce({
        data: [
          {
            object: "whatsapp_business_account",
            active: true,
            fields: REQUIRED_FIELDS.map(name => ({
              name,
              version: "v25.0",
            })),
          },
        ],
      });

    const result = await subscribeToWABAWebhooks("waba-1", "token-1", {
      overrideCallbackUri: "https://www.airi.chat/api/webhooks/whatsapp",
      verifyToken: "verify-token",
    });

    expect(result.success).toBe(true);
    expect(result.subscribedFields).toEqual(REQUIRED_FIELDS);
    expect(mockGetJson).toHaveBeenLastCalledWith("app-1/subscriptions", {
      token: "app-1|app-secret",
    });
  });

  it("reuses one app-level field profile across WABAs attached to the same configured app", async () => {
    mockGetJson.mockImplementation(async (path: string) => {
      if (
        path === "waba-1/subscribed_apps" ||
        path === "waba-2/subscribed_apps"
      ) {
        return {
          data: [
            {
              id: "app-1",
              name: "airi.chat",
              whatsapp_business_api_data: { id: "app-1" },
            },
          ],
        };
      }
      if (path === "app-1/subscriptions") {
        return {
          data: [
            {
              object: "whatsapp_business_account",
              active: true,
              fields: [{ name: "messages" }, { name: "calls" }],
            },
          ],
        };
      }
      throw new Error(`Unexpected Graph path ${path}`);
    });

    await expect(
      getWabaWebhookSubscriptionStatus("waba-1", "token-1")
    ).resolves.toMatchObject({
      subscribed: true,
      fields: ["messages", "calls"],
    });
    await expect(
      getWabaWebhookSubscriptionStatus("waba-2", "token-2")
    ).resolves.toMatchObject({
      subscribed: true,
      fields: ["messages", "calls"],
    });

    expect(
      mockGetJson.mock.calls.filter(([path]) => path === "app-1/subscriptions")
    ).toHaveLength(1);
  });

  it("reuses a validated empty app-level field profile across WABAs", async () => {
    mockGetJson.mockImplementation(async (path: string) => {
      if (
        path === "waba-1/subscribed_apps" ||
        path === "waba-2/subscribed_apps"
      ) {
        return { data: [{ id: "app-1" }] };
      }
      if (path === "app-1/subscriptions") {
        return { data: [] };
      }
      throw new Error(`Unexpected Graph path ${path}`);
    });

    await expect(
      getWabaWebhookSubscriptionStatus("waba-1", "token-1")
    ).resolves.toMatchObject({ subscribed: true, fields: [] });
    await expect(
      getWabaWebhookSubscriptionStatus("waba-2", "token-2")
    ).resolves.toMatchObject({ subscribed: true, fields: [] });

    expect(
      mockGetJson.mock.calls.filter(([path]) => path === "app-1/subscriptions")
    ).toHaveLength(1);
  });

  it("coalesces concurrent app-level field reads for the same configured app", async () => {
    let releaseAppProfile: (value: unknown) => void = () => undefined;
    const appProfile = new Promise(resolve => {
      releaseAppProfile = resolve;
    });
    mockGetJson.mockImplementation(async (path: string) => {
      if (
        path === "waba-1/subscribed_apps" ||
        path === "waba-2/subscribed_apps"
      ) {
        return { data: [{ id: "app-1" }] };
      }
      if (path === "app-1/subscriptions") {
        return appProfile;
      }
      throw new Error(`Unexpected Graph path ${path}`);
    });

    const statuses = Promise.all([
      getWabaWebhookSubscriptionStatus("waba-1", "token-1"),
      getWabaWebhookSubscriptionStatus("waba-2", "token-2"),
    ]);
    releaseAppProfile({
      data: [
        {
          object: "whatsapp_business_account",
          active: true,
          fields: [{ name: "messages" }],
        },
      ],
    });

    await expect(statuses).resolves.toEqual([
      expect.objectContaining({ fields: ["messages"] }),
      expect.objectContaining({ fields: ["messages"] }),
    ]);
    expect(
      mockGetJson.mock.calls.filter(([path]) => path === "app-1/subscriptions")
    ).toHaveLength(1);
  });

  it("does not share app-level field profiles between configured apps", async () => {
    mockGetJson.mockImplementation(async (path: string) => {
      if (path === "waba-1/subscribed_apps") {
        return { data: [{ id: "app-1" }] };
      }
      if (path === "app-1/subscriptions") {
        return {
          data: [
            {
              object: "whatsapp_business_account",
              active: true,
              fields: [{ name: "messages" }],
            },
          ],
        };
      }
      if (path === "waba-2/subscribed_apps") {
        return { data: [{ id: "app-2" }] };
      }
      if (path === "app-2/subscriptions") {
        return {
          data: [
            {
              object: "whatsapp_business_account",
              active: true,
              fields: [{ name: "calls" }],
            },
          ],
        };
      }
      throw new Error(`Unexpected Graph path ${path}`);
    });

    await expect(
      getWabaWebhookSubscriptionStatus("waba-1", "token-1")
    ).resolves.toMatchObject({ fields: ["messages"] });

    process.env.NEXT_PUBLIC_META_APP_ID = "app-2";
    await expect(
      getWabaWebhookSubscriptionStatus("waba-2", "token-2")
    ).resolves.toMatchObject({ fields: ["calls"] });

    expect(
      mockGetJson.mock.calls.filter(([path]) =>
        /^app-[12]\/subscriptions$/.test(String(path))
      )
    ).toHaveLength(2);
  });

  it("retries an app-level field profile read after a provider failure", async () => {
    let appProfileAttempts = 0;
    mockGetJson.mockImplementation(async (path: string) => {
      if (
        path === "waba-1/subscribed_apps" ||
        path === "waba-2/subscribed_apps"
      ) {
        return { data: [{ id: "app-1" }] };
      }
      if (path === "app-1/subscriptions") {
        appProfileAttempts += 1;
        if (appProfileAttempts === 1) {
          throw new Error("temporary app subscription read failure");
        }
        return {
          data: [
            {
              object: "whatsapp_business_account",
              active: true,
              fields: [{ name: "messages" }],
            },
          ],
        };
      }
      throw new Error(`Unexpected Graph path ${path}`);
    });

    await expect(
      getWabaWebhookSubscriptionStatus("waba-1", "token-1")
    ).rejects.toThrow("temporary app subscription read failure");
    await expect(
      getWabaWebhookSubscriptionStatus("waba-2", "token-2")
    ).resolves.toMatchObject({ fields: ["messages"] });
    expect(appProfileAttempts).toBe(2);
  });

  it("attributes configured-app profile authorization failures to server credentials", async () => {
    const configuredAppAuthorizationError = new MetaGraphRequestError({
      message: "Invalid configured app access token",
      status: 401,
      statusText: "Unauthorized",
      url: "https://graph.facebook.com/v25.0/app-1/subscriptions",
      details: {
        error: {
          message: "Invalid configured app access token",
          type: "OAuthException",
          code: 190,
        },
      },
      metaError: {
        message: "Invalid configured app access token",
        type: "OAuthException",
        code: 190,
      },
    });
    mockGetJson.mockImplementation(async (path: string) => {
      if (path === "waba-1/subscribed_apps") {
        return { data: [{ id: "app-1" }] };
      }
      if (path === "app-1/subscriptions") {
        throw configuredAppAuthorizationError;
      }
      throw new Error(`Unexpected Graph path ${path}`);
    });

    let caughtError: unknown;
    try {
      await getWabaWebhookSubscriptionStatus("waba-1", "source-token");
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBe(configuredAppAuthorizationError);
    expect(getMetaCredentialOwner(caughtError)).toBe("configured_app");
  });

  it("attributes WABA edge authorization failures to the source token", async () => {
    const sourceAuthorizationError = new MetaGraphRequestError({
      message: "Invalid source access token",
      status: 401,
      statusText: "Unauthorized",
      url: "https://graph.facebook.com/v25.0/waba-1/subscribed_apps",
      details: null,
    });
    mockGetJson.mockRejectedValueOnce(sourceAuthorizationError);

    let caughtError: unknown;
    try {
      await getWabaWebhookSubscriptionStatus("waba-1", "source-token");
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBe(sourceAuthorizationError);
    expect(getMetaCredentialOwner(caughtError)).toBe("source_token");
  });

  it("does not report repair success when verification finds only another app", async () => {
    mockPostJson.mockResolvedValueOnce({ success: true });
    mockGetJson.mockResolvedValueOnce({
      data: [
        {
          id: "another-app",
          name: "Other app",
          whatsapp_business_api_data: {
            subscribed_fields: REQUIRED_FIELDS,
          },
        },
      ],
    });

    await expect(
      subscribeToWABAWebhooks("waba-1", "token-1")
    ).resolves.toMatchObject({
      success: false,
      error: "Configured Meta app subscription was not verified.",
    });
  });

  it("preserves bare HTTP 429 status when post-subscription verification is rate-limited", async () => {
    mockPostJson.mockResolvedValueOnce({ success: true });
    mockGetJson.mockRejectedValueOnce(
      new MetaGraphRequestError({
        message: "Too Many Requests",
        status: 429,
        statusText: "Too Many Requests",
        url: "https://graph.facebook.com/v25.0/waba-1/subscribed_apps",
        details: null,
      })
    );

    const result = await subscribeToWABAWebhooks("waba-1", "token-1");

    expect(result).toMatchObject({ success: false, status: 429 });
    expect(isMetaGraphRateLimitError(result)).toBe(true);
  });

  it("returns app selection metadata from the same subscribed_apps read", async () => {
    mockGetJson.mockResolvedValueOnce({
      data: [
        {
          id: "app-1",
          name: "airi.chat",
          whatsapp_business_api_data: {
            subscribed_fields: REQUIRED_FIELDS,
          },
        },
      ],
    });

    await expect(
      getWabaWebhookSubscriptionStatus("waba-1", "token-1")
    ).resolves.toMatchObject({
      selectedAppId: "app-1",
      selectedAppName: "airi.chat",
      matchedPreferredApp: true,
      availableAppIds: ["app-1"],
    });
    expect(mockGetJson).toHaveBeenCalledTimes(1);
  });

  it("keeps the legacy phone inventory caller fail-soft on Graph errors", async () => {
    mockGetJson.mockRejectedValue(
      new Error("Missing whatsapp_business_management")
    );

    await expect(
      getWABAPhoneNumbers("waba-1", "access-token")
    ).resolves.toEqual([]);
  });
});
