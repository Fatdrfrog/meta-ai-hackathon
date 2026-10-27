const mockGetVercelOidcToken = jest.fn();
const mockExternalAccountGetAccessToken = jest.fn();
const mockExternalAccountFromJson = jest.fn((_value?: unknown) => ({
  credentials: {
    expiry_date: Date.now() + 60 * 60 * 1000,
  },
  getAccessToken: mockExternalAccountGetAccessToken,
}));

jest.mock("@vercel/oidc", () => ({
  getVercelOidcToken: () => mockGetVercelOidcToken(),
}));
jest.mock("google-auth-library", () => ({
  ExternalAccountClient: {
    fromJSON: (value: unknown) => mockExternalAccountFromJson(value),
  },
  GoogleAuth: jest.fn(),
}));
jest.mock("server-only", () => ({}));

import {
  compactEnv,
  getGoogleCloudProjectId,
  getVercelGcpAccessToken,
  getVercelOidcTokenOrEnv,
  hasVercelGcpWorkloadIdentityConfig,
  invalidateVercelGcpAccessTokenCache,
  parseGoogleServiceAccountJson,
} from "./gcp-auth";

describe("GCP auth helpers", () => {
  const envKeys = [
    "CUSTOM_PROJECT_ID",
    "GOOGLE_CLOUD_PROJECT",
    "GCP_PROJECT_ID",
    "GCP_PROJECT",
    "GOOGLE_APPLICATION_CREDENTIALS_JSON",
    "GCP_PROJECT_NUMBER",
    "GCP_SERVICE_ACCOUNT_EMAIL",
    "GCP_WORKLOAD_IDENTITY_POOL_ID",
    "GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID",
    "VERCEL_OIDC_TOKEN",
  ] as const;
  const previousEnv = Object.fromEntries(
    envKeys.map(key => [key, process.env[key]])
  ) as Record<(typeof envKeys)[number], string | undefined>;

  beforeEach(() => {
    jest.clearAllMocks();
    invalidateVercelGcpAccessTokenCache();
    for (const key of envKeys) delete process.env[key];
  });

  afterAll(() => {
    for (const key of envKeys) {
      const value = previousEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("compacts env values and resolves project ids through shared fallbacks", () => {
    process.env.CUSTOM_PROJECT_ID = " ";
    process.env.GOOGLE_CLOUD_PROJECT = " google-project ";
    process.env.GCP_PROJECT_ID = "gcp-project";

    expect(compactEnv("CUSTOM_PROJECT_ID")).toBeNull();
    expect(getGoogleCloudProjectId("CUSTOM_PROJECT_ID")).toBe("google-project");
  });

  it("parses service account JSON only when it is a service account key", () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({
      type: "service_account",
      project_id: "project-1",
      client_email: "svc@example.com",
      private_key: "secret",
    });

    expect(parseGoogleServiceAccountJson()).toEqual(
      expect.objectContaining({
        project_id: "project-1",
        client_email: "svc@example.com",
      })
    );

    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({
      type: "authorized_user",
    });
    expect(() => parseGoogleServiceAccountJson()).toThrow(/service_account/);
  });

  it("detects complete Vercel GCP workload identity config", () => {
    expect(hasVercelGcpWorkloadIdentityConfig()).toBe(false);
    process.env.GCP_PROJECT_NUMBER = "123";
    process.env.GCP_SERVICE_ACCOUNT_EMAIL = "svc@example.com";
    process.env.GCP_WORKLOAD_IDENTITY_POOL_ID = "pool";
    process.env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID = "provider";
    expect(hasVercelGcpWorkloadIdentityConfig()).toBe(true);
  });

  it("prefers the Vercel OIDC helper and falls back to local env token", async () => {
    mockGetVercelOidcToken.mockResolvedValueOnce(" oidc-token ");
    await expect(getVercelOidcTokenOrEnv()).resolves.toBe("oidc-token");

    mockGetVercelOidcToken.mockRejectedValueOnce(new Error("local"));
    process.env.VERCEL_OIDC_TOKEN = " env-token ";
    await expect(getVercelOidcTokenOrEnv()).resolves.toBe("env-token");
  });

  it("reuses a valid Vercel workload identity access token", async () => {
    process.env.GCP_PROJECT_NUMBER = "123";
    process.env.GCP_SERVICE_ACCOUNT_EMAIL = "svc@example.com";
    process.env.GCP_WORKLOAD_IDENTITY_POOL_ID = "pool";
    process.env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID = "provider";
    mockExternalAccountGetAccessToken.mockResolvedValue({ token: "gcp-token" });

    await expect(getVercelGcpAccessToken()).resolves.toBe("gcp-token");
    await expect(getVercelGcpAccessToken()).resolves.toBe("gcp-token");

    expect(mockExternalAccountFromJson).toHaveBeenCalledTimes(1);
    expect(mockExternalAccountGetAccessToken).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent Vercel workload identity token requests", async () => {
    process.env.GCP_PROJECT_NUMBER = "123";
    process.env.GCP_SERVICE_ACCOUNT_EMAIL = "svc@example.com";
    process.env.GCP_WORKLOAD_IDENTITY_POOL_ID = "pool";
    process.env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID = "provider";
    mockExternalAccountGetAccessToken.mockResolvedValue({ token: "gcp-token" });

    await expect(
      Promise.all([getVercelGcpAccessToken(), getVercelGcpAccessToken()])
    ).resolves.toEqual(["gcp-token", "gcp-token"]);

    expect(mockExternalAccountFromJson).toHaveBeenCalledTimes(1);
    expect(mockExternalAccountGetAccessToken).toHaveBeenCalledTimes(1);
  });
});
