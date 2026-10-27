import "server-only";

import { firstEnv, readEnv as compactEnv } from "@icecore/shared/lib/env";
import { ExternalAccountClient, GoogleAuth } from "google-auth-library";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

export type GoogleServiceAccountJson = {
  project_id?: string;
  client_email?: string;
  private_key?: string;
  type?: string;
};

export { compactEnv };

export function getGoogleCloudProjectId(primaryEnvName: string): string | null {
  return firstEnv(
    primaryEnvName,
    "GOOGLE_CLOUD_PROJECT",
    "GCP_PROJECT_ID",
    "GCP_PROJECT"
  );
}

export function parseGoogleServiceAccountJson():
  | GoogleServiceAccountJson
  | undefined {
  const raw = compactEnv("GOOGLE_APPLICATION_CREDENTIALS_JSON");
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as GoogleServiceAccountJson;
  if (parsed.type !== "service_account") {
    throw new Error(
      "GOOGLE_APPLICATION_CREDENTIALS_JSON must be a service_account key."
    );
  }
  return parsed;
}

const googleCloudAuthClients = new Map<string, GoogleAuth>();
const googleCloudAccessTokenPromises = new Map<string, Promise<string>>();

const VERCEL_GCP_ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;
const VERCEL_GCP_ACCESS_TOKEN_FALLBACK_TTL_MS = 45 * 60_000;

type VercelGcpWorkloadIdentityConfig = {
  projectNumber: string;
  serviceAccountEmail: string;
  poolId: string;
  providerId: string;
};

type CachedVercelGcpAccessToken = {
  cacheKey: string;
  token: string;
  expiresAtMs: number;
};

let cachedVercelGcpAccessToken: CachedVercelGcpAccessToken | null = null;
let pendingVercelGcpAccessToken: Promise<string> | null = null;

function getVercelGcpWorkloadIdentityConfig(): VercelGcpWorkloadIdentityConfig {
  const projectNumber = compactEnv("GCP_PROJECT_NUMBER");
  const serviceAccountEmail = compactEnv("GCP_SERVICE_ACCOUNT_EMAIL");
  const poolId = compactEnv("GCP_WORKLOAD_IDENTITY_POOL_ID");
  const providerId = compactEnv("GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID");
  if (!projectNumber || !serviceAccountEmail || !poolId || !providerId) {
    throw new Error(
      "Vercel GCP Workload Identity Federation is not configured."
    );
  }

  return { projectNumber, serviceAccountEmail, poolId, providerId };
}

function getVercelGcpAccessTokenCacheKey(
  config: VercelGcpWorkloadIdentityConfig
): string {
  return [
    config.projectNumber,
    config.serviceAccountEmail,
    config.poolId,
    config.providerId,
  ].join("|");
}

function getCredentialExpiryMs(authClient: unknown): number {
  const expiryDate = Number(
    (
      authClient as {
        credentials?: { expiry_date?: unknown } | null;
      }
    ).credentials?.expiry_date
  );

  return Number.isFinite(expiryDate) && expiryDate > Date.now()
    ? expiryDate
    : Date.now() + VERCEL_GCP_ACCESS_TOKEN_FALLBACK_TTL_MS;
}

function canReuseVercelGcpAccessToken(cacheKey: string): boolean {
  return Boolean(
    cachedVercelGcpAccessToken &&
      cachedVercelGcpAccessToken.cacheKey === cacheKey &&
      cachedVercelGcpAccessToken.expiresAtMs -
        VERCEL_GCP_ACCESS_TOKEN_REFRESH_SKEW_MS >
        Date.now()
  );
}

/**
 * Clears the process-local federation token after an authenticated Google API
 * rejects it. The next request obtains a fresh token through Vercel OIDC.
 */
export function invalidateVercelGcpAccessTokenCache(): void {
  cachedVercelGcpAccessToken = null;
}

export function getGoogleCloudAuthOptions(
  projectIdOverride?: string | null
): ConstructorParameters<typeof GoogleAuth>[0] {
  const serviceAccount = parseGoogleServiceAccountJson();
  const keyFilename = compactEnv("GOOGLE_APPLICATION_CREDENTIALS");
  const projectId =
    (projectIdOverride || "").trim() ||
    getGoogleCloudProjectId("GOOGLE_CLOUD_PROJECT") ||
    serviceAccount?.project_id ||
    undefined;

  return {
    scopes: [CLOUD_PLATFORM_SCOPE],
    projectId,
    ...(serviceAccount ? { credentials: serviceAccount as never } : {}),
    ...(!serviceAccount && keyFilename ? { keyFilename } : {}),
  };
}

function getGoogleCloudAuth(projectIdOverride?: string | null): GoogleAuth {
  const key = (projectIdOverride || "").trim() || "__default__";
  const existing = googleCloudAuthClients.get(key);
  if (existing) {
    return existing;
  }
  const auth = new GoogleAuth(getGoogleCloudAuthOptions(projectIdOverride));
  googleCloudAuthClients.set(key, auth);
  return auth;
}

export function hasVercelGcpWorkloadIdentityConfig(): boolean {
  return Boolean(
    compactEnv("GCP_PROJECT_NUMBER") &&
      compactEnv("GCP_SERVICE_ACCOUNT_EMAIL") &&
      compactEnv("GCP_WORKLOAD_IDENTITY_POOL_ID") &&
      compactEnv("GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID")
  );
}

export async function getVercelOidcTokenOrEnv(): Promise<string | null> {
  try {
    const { getVercelOidcToken } = await import("@vercel/oidc");
    const token = await getVercelOidcToken();
    if (token?.trim()) return token.trim();
  } catch {
    // Fall through to local/dev env token.
  }

  return compactEnv("VERCEL_OIDC_TOKEN");
}

async function getRequiredVercelOidcTokenForGcpFederation(): Promise<string> {
  const token = await getVercelOidcTokenOrEnv();
  if (token) return token;
  throw new Error("VERCEL_OIDC_TOKEN is not available for GCP federation.");
}

export async function getVercelGcpAccessToken(): Promise<string> {
  const config = getVercelGcpWorkloadIdentityConfig();
  const cacheKey = getVercelGcpAccessTokenCacheKey(config);
  if (canReuseVercelGcpAccessToken(cacheKey)) {
    return cachedVercelGcpAccessToken!.token;
  }

  if (pendingVercelGcpAccessToken) {
    return pendingVercelGcpAccessToken;
  }

  const request = (async () => {
    const authClient = ExternalAccountClient.fromJSON({
      type: "external_account",
      audience: `//iam.googleapis.com/projects/${config.projectNumber}/locations/global/workloadIdentityPools/${config.poolId}/providers/${config.providerId}`,
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      token_url: "https://sts.googleapis.com/v1/token",
      service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${config.serviceAccountEmail}:generateAccessToken`,
      subject_token_supplier: {
        getSubjectToken: getRequiredVercelOidcTokenForGcpFederation,
      },
    } as never);

    if (!authClient) {
      throw new Error(
        "Failed to initialize Vercel GCP external account client."
      );
    }

    const tokenResponse = await authClient.getAccessToken();
    const token =
      typeof tokenResponse === "string"
        ? tokenResponse
        : tokenResponse?.token || null;
    if (!token) {
      throw new Error("GCP external account client returned no access token.");
    }

    cachedVercelGcpAccessToken = {
      cacheKey,
      token,
      expiresAtMs: getCredentialExpiryMs(authClient),
    };
    return token;
  })();

  pendingVercelGcpAccessToken = request;
  try {
    return await request;
  } finally {
    if (pendingVercelGcpAccessToken === request) {
      pendingVercelGcpAccessToken = null;
    }
  }
}

async function getAccessTokenFromGoogleAuth(
  auth: GoogleAuth,
  sourceLabel: string
): Promise<string> {
  const accessToken = await auth.getAccessToken();
  if (!accessToken) {
    throw new Error(
      `Google Cloud auth returned no access token via ${sourceLabel}`
    );
  }
  return accessToken;
}

async function requestGoogleCloudPlatformAccessToken(
  projectIdOverride?: string | null
): Promise<string> {
  const failures: string[] = [];

  if (hasVercelGcpWorkloadIdentityConfig()) {
    try {
      return await getVercelGcpAccessToken();
    } catch (error) {
      failures.push(
        `workload identity federation: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  try {
    return await getAccessTokenFromGoogleAuth(
      getGoogleCloudAuth(projectIdOverride),
      "ADC"
    );
  } catch (error) {
    failures.push(
      `ADC: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  throw new Error(
    "Google Cloud auth failed. Configure Vercel GCP Workload Identity Federation, " +
      "GOOGLE_APPLICATION_CREDENTIALS_JSON, GOOGLE_APPLICATION_CREDENTIALS, " +
      `or local Application Default Credentials. Details: ${failures.join("; ")}`
  );
}

export async function getGoogleCloudPlatformAccessToken(
  projectIdOverride?: string | null
): Promise<string> {
  const key = (projectIdOverride || "").trim() || "__default__";
  const existing = googleCloudAccessTokenPromises.get(key);
  if (existing) {
    return existing;
  }

  const promise = requestGoogleCloudPlatformAccessToken(
    projectIdOverride
  ).finally(() => {
    googleCloudAccessTokenPromises.delete(key);
  });
  googleCloudAccessTokenPromises.set(key, promise);
  return promise;
}
