const mockGetJson = jest.fn();

jest.mock("@icecore/shared/lib/meta/api", () => ({
  ...jest.requireActual("@icecore/shared/lib/meta/api"),
  getWhatsAppGraphClient: () => ({
    getJson: (...args: unknown[]) => mockGetJson(...args),
  }),
}));

import { MetaServerAppConfigError } from "./app-config";
import { debugConfiguredMetaAccessToken } from "./debug-token";

describe("debugConfiguredMetaAccessToken", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      META_APP_ID: "server-app",
      META_APP_SECRET: "server-secret",
      NEXT_PUBLIC_META_APP_ID: "public-app",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("uses the configured server app token and returns typed data", async () => {
    mockGetJson.mockResolvedValueOnce({
      data: {
        app_id: "server-app",
        business_id: "business-1",
        granular_scopes: [
          { scope: "whatsapp_business_management", target_ids: ["waba-1"] },
        ],
      },
    });

    await expect(
      debugConfiguredMetaAccessToken("customer-token")
    ).resolves.toEqual(
      expect.objectContaining({
        app_id: "server-app",
        business_id: "business-1",
      })
    );
    expect(mockGetJson).toHaveBeenCalledWith("debug_token", {
      token: "server-app|server-secret",
      query: {
        input_token: "customer-token",
        access_token: "server-app|server-secret",
      },
    });
  });

  it("supports an explicit input-token fallback for optional flows", async () => {
    mockGetJson.mockResolvedValueOnce({ data: { business_id: "business-1" } });

    await expect(
      debugConfiguredMetaAccessToken("customer-token", {
        appConfig: null,
        allowInputTokenFallback: true,
      })
    ).resolves.toEqual({ business_id: "business-1" });
    expect(mockGetJson).toHaveBeenCalledWith("debug_token", {
      token: "customer-token",
      query: {
        input_token: "customer-token",
        access_token: "customer-token",
      },
    });
  });

  it("forwards an optional abort signal to the Graph request", async () => {
    const controller = new AbortController();
    mockGetJson.mockResolvedValueOnce({ data: { is_valid: true } });

    await debugConfiguredMetaAccessToken("customer-token", {
      signal: controller.signal,
    });

    expect(mockGetJson).toHaveBeenCalledWith(
      "debug_token",
      expect.objectContaining({ signal: controller.signal })
    );
  });

  it("propagates a successful Meta response that is missing debug data", async () => {
    mockGetJson.mockResolvedValueOnce({});

    await expect(
      debugConfiguredMetaAccessToken("customer-token")
    ).rejects.toThrow("Meta debug_token response did not include data");
  });

  it("preserves typed configuration failures when fallback is not allowed", async () => {
    delete process.env.META_APP_ID;
    delete process.env.NEXT_PUBLIC_META_APP_ID;
    delete process.env.META_APP_SECRET;

    await expect(
      debugConfiguredMetaAccessToken("customer-token", { appConfig: null })
    ).rejects.toMatchObject({
      name: "MetaServerAppConfigError",
      code: "missing_meta_app_id",
    } satisfies Partial<MetaServerAppConfigError>);
    expect(mockGetJson).not.toHaveBeenCalled();
  });
});
