import { META_GRAPH_BASE_URL } from "@icecore/shared/lib/meta/graph-version";

export type MetaOAuthTokenResponse = {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: {
    message?: string;
    type?: string;
    code?: number;
  };
};

export type MetaResolvedOAuthToken = MetaOAuthTokenResponse & {
  access_token: string;
};

export type MetaOAuthUser = {
  id?: string;
  name?: string;
};

function readJson<T>(response: Response): Promise<T | null> {
  return response.json().catch(() => null) as Promise<T | null>;
}

export function hasMetaOAuthAccessToken(
  token: MetaOAuthTokenResponse | null
): token is MetaResolvedOAuthToken {
  return (
    typeof token?.access_token === "string" && token.access_token.length > 0
  );
}

export function metaOAuthTokenHasExplicitExpiry(
  token: MetaOAuthTokenResponse
): boolean {
  return typeof token.expires_in === "number" && token.expires_in > 0;
}

export function metaOAuthErrorDetails(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const error = (value as { error?: { message?: unknown } }).error;
  if (!error || typeof error.message !== "string") return undefined;
  return error.message.slice(0, 250);
}

function isRedirectUriMismatchError(value: unknown): boolean {
  const message = metaOAuthErrorDetails(value)?.toLowerCase() || "";
  return message.includes("redirect_uri");
}

async function requestMetaAccessToken(query: Record<string, string>) {
  const url = new URL(`${META_GRAPH_BASE_URL}/oauth/access_token`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url.toString(), { method: "GET" });
  return readJson<MetaOAuthTokenResponse>(response);
}

/**
 * Exchange an OAuth code. When redirectUri is set, try with it first, then
 * retry without (JS SDK / FB.login sessions often omit redirect_uri).
 */
export async function exchangeMetaAdsOAuthCode(params: {
  code: string;
  appId: string;
  appSecret: string;
  redirectUri?: string | null;
}): Promise<MetaOAuthTokenResponse | null> {
  const baseQuery = {
    client_id: params.appId,
    client_secret: params.appSecret,
    code: params.code,
  };
  const redirectUri = (params.redirectUri || "").trim();

  if (!redirectUri) {
    return requestMetaAccessToken(baseQuery);
  }

  const withRedirect = await requestMetaAccessToken({
    ...baseQuery,
    redirect_uri: redirectUri,
  });
  if (hasMetaOAuthAccessToken(withRedirect)) return withRedirect;
  if (!isRedirectUriMismatchError(withRedirect)) return withRedirect;

  return requestMetaAccessToken(baseQuery);
}

export async function exchangeLongLivedMetaToken(params: {
  accessToken: string;
  appId: string;
  appSecret: string;
}): Promise<MetaOAuthTokenResponse | null> {
  return requestMetaAccessToken({
    grant_type: "fb_exchange_token",
    client_id: params.appId,
    client_secret: params.appSecret,
    fb_exchange_token: params.accessToken,
  });
}

export async function fetchMetaOAuthUser(
  accessToken: string
): Promise<MetaOAuthUser | null> {
  const url = new URL(`${META_GRAPH_BASE_URL}/me`);
  url.searchParams.set("fields", "id,name");
  url.searchParams.set("access_token", accessToken);
  const response = await fetch(url.toString(), { method: "GET" });
  if (!response.ok) return null;
  return readJson<MetaOAuthUser>(response);
}

export async function resolveMetaAdsOAuthAccessToken(params: {
  code: string;
  appId: string;
  appSecret: string;
  redirectUri?: string | null;
}): Promise<
  | { ok: true; token: MetaResolvedOAuthToken; shortLived: MetaResolvedOAuthToken }
  | { ok: false; error: MetaOAuthTokenResponse | null; stage: "code" | "long_lived" }
> {
  const codeToken = await exchangeMetaAdsOAuthCode(params);
  if (!hasMetaOAuthAccessToken(codeToken)) {
    return { ok: false, error: codeToken, stage: "code" };
  }

  if (!metaOAuthTokenHasExplicitExpiry(codeToken)) {
    return { ok: true, token: codeToken, shortLived: codeToken };
  }

  const longToken = await exchangeLongLivedMetaToken({
    accessToken: codeToken.access_token,
    appId: params.appId,
    appSecret: params.appSecret,
  });
  if (!hasMetaOAuthAccessToken(longToken)) {
    return { ok: false, error: longToken, stage: "long_lived" };
  }

  return { ok: true, token: longToken, shortLived: codeToken };
}
