import { resolveUserWorkspaceMembership } from "@/lib/supabase/queries";
import { trackSourceConnected } from "@/lib/analytics";
import { encryptString } from "@/lib/crypto";
import { INSTAGRAM_BUSINESS_LOGIN_WEBHOOK_FIELDS } from "@/lib/instagram/webhook-events";
import {
  COMPANY_CHANNEL_LIMIT_EXCEEDED_CODE,
  ensureCompanyChannelCapacity,
} from "@/lib/limits/company-limits";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getCompanyIdForWorkspace } from "@/lib/supabase/company-users";
import { createClient } from "@/lib/supabase/server";
import { META_INSTAGRAM_GRAPH_BASE_URL } from "@icecore/shared/lib/meta/graph-version";
import { createHash } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { readNonEmptyStringOrUndefined as toOptionalString } from "@icecore/shared/lib/value-utils";

type InstagramShortLivedTokenResponse =
  | {
      access_token?: string;
      user_id?: string;
      permissions?: string;
      token_type?: string;
    }
  | {
      data?: Array<{
        access_token?: string;
        user_id?: string;
        permissions?: string;
        token_type?: string;
      }>;
    };

type InstagramLongLivedTokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
};

type InstagramMeResponse =
  | {
      id?: string;
      user_id?: string;
      username?: string;
      name?: string;
      account_type?: string;
      category_name?: string;
      biography?: string;
      website?: string;
      profile_picture_url?: string;
      followers_count?: number | string;
      follows_count?: number | string;
      media_count?: number | string;
      is_verified?: boolean | string;
    }
  | {
      data?: Array<{
        id?: string;
        user_id?: string;
        username?: string;
        name?: string;
        account_type?: string;
        category_name?: string;
        biography?: string;
        website?: string;
        profile_picture_url?: string;
        followers_count?: number | string;
        follows_count?: number | string;
        media_count?: number | string;
        is_verified?: boolean | string;
      }>;
    };

function toWorkspaceRedirect(
  requestUrl: string,
  workspaceId: string | undefined,
  params: Record<string, string>
) {
  const query = new URLSearchParams();
  query.set("type", "instagram");
  query.set("integration", "instagram");
  for (const [key, value] of Object.entries(params)) {
    query.set(key, value);
  }
  const path = `/panel/w/${workspaceId || ""}/settings/integrations?${query.toString()}`;
  return new URL(path, requestUrl).toString();
}

function getRawQueryParam(requestUrl: string, paramName: string): string {
  const query = requestUrl.split("?")[1]?.split("#")[0] || "";
  if (!query) {
    return "";
  }

  for (const chunk of query.split("&")) {
    if (!chunk) continue;
    const [key, ...rest] = chunk.split("=");
    if (key !== paramName) continue;
    const rawValue = rest.join("=");
    try {
      // Keep '+' intact. URLSearchParams decodes '+' as space.
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }
  return "";
}

function previewValue(value: string): string {
  if (!value) return "";
  if (value.length <= 14) return value;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function fingerprint(value: string): string {
  if (!value) return "empty";
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function asAbsoluteUrlOrEmpty(value: string, origin?: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    new URL(trimmed);
    return trimmed;
  } catch {
    try {
      const decoded = decodeURIComponent(trimmed);
      new URL(decoded);
      return decoded;
    } catch {
      if (!origin) return "";
      try {
        return new URL(trimmed, `${origin.replace(/\/$/, "")}/`).toString();
      } catch {
        return "";
      }
    }
  }
}

function resolveConfiguredRedirectUri(origin: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || origin)
    .trim()
    .replace(/\/$/, "");
  const configured = (
    process.env.NEXT_PUBLIC_INSTAGRAM_REDIRECT_URI || ""
  ).trim();
  if (!configured) {
    return `${base}/api/sources/instagram/callback`;
  }
  return asAbsoluteUrlOrEmpty(configured, origin);
}

function getInstagramAppSecretCandidates(): string[] {
  return uniqueNonEmpty([
    (process.env.INSTAGRAM_APP_SECRET || "").trim(),
    (process.env.META_APP_SECRET || "").trim(),
    (process.env.NEXT_PUBLIC_META_APP_SECRET || "").trim(),
  ]);
}

function getFirstObject<T extends Record<string, unknown>>(value: unknown): T {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as T;
  }
  if (Array.isArray(value) && value[0] && typeof value[0] === "object") {
    return value[0] as T;
  }
  return {} as T;
}

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return undefined;
}

type TokenExchangeAttempt = {
  appId: string;
  appSecret: string;
  redirectUri: string;
};

async function exchangeCodeForShortToken(
  appId: string,
  appSecret: string,
  redirectUri: string,
  code: string
) {
  const codeHasSpace = code.includes(" ");
  const codeHasPlus = code.includes("+");

  console.info("[instagram.callback] exchange short token request", {
    appId,
    redirectUri,
    codeLength: code.length,
    codePreview: previewValue(code),
    codeHasSpace,
    codeHasPlus,
    appSecretLength: appSecret.length,
    appSecretFingerprint: fingerprint(appSecret),
  });

  const debugPayload = new URLSearchParams();
  debugPayload.set("client_id", appId);
  debugPayload.set("client_secret", appSecret);
  debugPayload.set("grant_type", "authorization_code");
  debugPayload.set("redirect_uri", redirectUri);
  debugPayload.set("code", code);

  const body = new FormData();
  body.set("client_id", appId);
  body.set("client_secret", appSecret);
  body.set("grant_type", "authorization_code");
  body.set("redirect_uri", redirectUri);
  body.set("code", code);

  const encodedBody = debugPayload.toString();
  console.info("[instagram.callback] exchange short token payload", {
    requestContentType: "multipart/form-data",
    payload: encodedBody.replace(
      /client_secret=[^&]*/g,
      "client_secret=[redacted]"
    ),
    payloadLength: encodedBody.length,
    codeEncodedHasPlusLiteral: /code=[^&]*\+/.test(encodedBody),
    codeEncodedHasPct2B: /code=[^&]*%2B/i.test(encodedBody),
  });

  const res = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    body,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    let appCredentialProbe:
      | { ok: true; status: number }
      | { ok: false; status: number; error: string }
      | undefined;
    try {
      const probeUrl = new URL("https://graph.facebook.com/oauth/access_token");
      probeUrl.searchParams.set("client_id", appId);
      probeUrl.searchParams.set("client_secret", appSecret);
      probeUrl.searchParams.set("grant_type", "client_credentials");
      const probeRes = await fetch(probeUrl.toString(), { method: "GET" });
      if (probeRes.ok) {
        appCredentialProbe = { ok: true, status: probeRes.status };
      } else {
        const probeError = await probeRes.text().catch(() => "");
        appCredentialProbe = {
          ok: false,
          status: probeRes.status,
          error: (probeError || probeRes.statusText || "unknown_error").slice(
            0,
            180
          ),
        };
      }
    } catch (probeError) {
      appCredentialProbe = {
        ok: false,
        status: 0,
        error:
          probeError instanceof Error
            ? probeError.message.slice(0, 180)
            : "credential_probe_failed",
      };
    }

    console.error("[instagram.callback] exchange short token failed", {
      status: res.status,
      statusText: res.statusText,
      errorText: errText,
      appCredentialProbe,
    });
    let parsedMessage = "";
    if (errText) {
      try {
        const parsed = JSON.parse(errText) as {
          error_type?: string;
          code?: number | string;
          error_message?: string;
          error?: {
            type?: string;
            code?: number | string;
            message?: string;
          };
          message?: string;
        };

        const errType = parsed.error_type || parsed.error?.type || "";
        const errCode = String(parsed.code || parsed.error?.code || "");
        const errMessage =
          parsed.error_message || parsed.error?.message || parsed.message || "";
        const parts = [errType, errCode ? `code ${errCode}` : "", errMessage]
          .filter(Boolean)
          .join(": ");
        parsedMessage = parts;
      } catch {
        // Keep raw error text fallback if payload is not JSON.
      }
    }

    throw new Error(
      `Failed to exchange code: ${parsedMessage || errText || res.statusText}`
    );
  }

  const json = (await res.json()) as InstagramShortLivedTokenResponse;
  const root = getFirstObject<{
    access_token?: string;
    user_id?: string;
    permissions?: string;
  }>(json);
  const nested = getFirstObject<{
    access_token?: string;
    user_id?: string;
    permissions?: string;
  }>((json as { data?: unknown }).data);

  const accessToken = root.access_token || nested.access_token;
  if (!accessToken) {
    throw new Error("Missing short-lived access token");
  }

  return {
    access_token: accessToken,
    user_id: root.user_id || nested.user_id,
    permissions: root.permissions || nested.permissions,
  };
}

async function exchangeForLongLivedToken(
  appSecret: string,
  shortToken: string
) {
  const url = new URL("https://graph.instagram.com/access_token");
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("access_token", shortToken);

  const res = await fetch(url.toString(), { method: "GET" });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `Failed to get long-lived token: ${errText || res.statusText}`
    );
  }

  const json = (await res.json()) as InstagramLongLivedTokenResponse;
  if (!json.access_token) {
    throw new Error("Missing long-lived access token");
  }
  return json;
}

async function fetchInstagramIdentity(accessToken: string) {
  const fetchByFields = async (fields: string) => {
    const url = new URL(`${META_INSTAGRAM_GRAPH_BASE_URL}/me`);
    url.searchParams.set("fields", fields);
    url.searchParams.set("access_token", accessToken);

    const res = await fetch(url.toString(), { method: "GET" });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(
        `Failed to fetch IG identity: ${errText || res.statusText}`
      );
    }

    return (await res.json()) as InstagramMeResponse;
  };

  let json: InstagramMeResponse;
  try {
    json = await fetchByFields(
      [
        "id",
        "user_id",
        "username",
        "name",
        "account_type",
        "category_name",
        "biography",
        "website",
        "profile_picture_url",
        "followers_count",
        "follows_count",
        "media_count",
        "is_verified",
      ].join(",")
    );
  } catch {
    // Fallback to minimal fields if richer profile fields are unavailable.
    json = await fetchByFields("id,user_id,username,account_type");
  }

  const root = getFirstObject<{
    id?: string;
    user_id?: string;
    username?: string;
    name?: string;
    account_type?: string;
    category_name?: string;
    biography?: string;
    website?: string;
    profile_picture_url?: string;
    followers_count?: number | string;
    follows_count?: number | string;
    media_count?: number | string;
    is_verified?: boolean | string;
  }>(json);
  const nested = getFirstObject<{
    id?: string;
    user_id?: string;
    username?: string;
    name?: string;
    account_type?: string;
    category_name?: string;
    biography?: string;
    website?: string;
    profile_picture_url?: string;
    followers_count?: number | string;
    follows_count?: number | string;
    media_count?: number | string;
    is_verified?: boolean | string;
  }>((json as { data?: unknown }).data);

  const identity = {
    instagram_scoped_id: toOptionalString(root.id || nested.id) || "",
    instagram_business_account_id:
      toOptionalString(root.user_id || nested.user_id) || "",
    username: toOptionalString(root.username || nested.username) || "",
    account_type:
      toOptionalString(root.account_type || nested.account_type) || "",
    name: toOptionalString(root.name || nested.name),
    category_name: toOptionalString(root.category_name || nested.category_name),
    biography: toOptionalString(root.biography || nested.biography),
    website: toOptionalString(root.website || nested.website),
    profile_picture_url: toOptionalString(
      root.profile_picture_url || nested.profile_picture_url
    ),
    followers_count: toOptionalNumber(
      root.followers_count ?? nested.followers_count
    ),
    follows_count: toOptionalNumber(root.follows_count ?? nested.follows_count),
    media_count: toOptionalNumber(root.media_count ?? nested.media_count),
    is_verified: toOptionalBoolean(root.is_verified ?? nested.is_verified),
  };

  return identity;
}

async function subscribeToInstagramWebhooks(
  targetId: string,
  accessToken: string
) {
  const fieldAttempts = [
    [...INSTAGRAM_BUSINESS_LOGIN_WEBHOOK_FIELDS],
    [
      "messages",
      "message_reactions",
      "messaging_postbacks",
      "comments",
      "live_comments",
    ],
  ];
  let lastError = "";

  for (const fields of fieldAttempts) {
    const url = new URL(
      `${META_INSTAGRAM_GRAPH_BASE_URL}/${encodeURIComponent(
        targetId
      )}/subscribed_apps`
    );
    url.searchParams.set("subscribed_fields", fields.join(","));
    url.searchParams.set("access_token", accessToken);

    const res = await fetch(url.toString(), { method: "POST" });
    if (res.ok) {
      return { ok: true as const, subscribedFields: fields };
    }

    const details = await res.text().catch(() => "");
    lastError = details || `HTTP ${res.status}: ${res.statusText}`;
  }

  return {
    ok: false as const,
    error: lastError,
  };
}

// OAuth providers redirect with GET; session and workspace ownership checks run before source persistence.
// react-doctor-disable-next-line react-doctor/nextjs-no-side-effect-in-get-handler
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  }

  const cookieStore = await cookies();
  const { searchParams } = new URL(request.url);
  const state =
    getRawQueryParam(request.url, "state") || searchParams.get("state") || "";
  const cookieState = cookieStore.get("ig_oauth_state")?.value || "";
  if (!state || state !== cookieState) {
    return NextResponse.json({ error: "invalid_state" }, { status: 400 });
  }
  const boundWorkspaceId = cookieState.includes(":")
    ? cookieState.slice(cookieState.indexOf(":") + 1)
    : undefined;
  const access = await resolveUserWorkspaceMembership(
    supabase,
    user.id,
    boundWorkspaceId
  );
  if (!access.ok)
    return NextResponse.json(
      { error: access.error },
      { status: access.status }
    );
  const companyUser = { workspace_id: access.workspaceId };

  const companyId = await getCompanyIdForWorkspace(
    supabase,
    companyUser.workspace_id
  );
  if (!companyId) {
    return NextResponse.redirect(
      toWorkspaceRedirect(request.url, companyUser.workspace_id, {
        error: "company_not_found",
      })
    );
  }

  const appId = (
    process.env.NEXT_PUBLIC_INSTAGRAM_APP_ID ||
    process.env.NEXT_PUBLIC_META_APP_ID ||
    ""
  ).trim();
  const appSecretCandidates = getInstagramAppSecretCandidates();

  if (!appId || appSecretCandidates.length === 0) {
    return new Response(JSON.stringify({ error: "Server not configured" }), {
      status: 500,
    });
  }

  const requestUrl = new URL(request.url);
  const { origin } = requestUrl;
  const requestRedirectUri = `${requestUrl.origin}${requestUrl.pathname}`;
  const cookieRedirectUri = asAbsoluteUrlOrEmpty(
    cookieStore.get("ig_oauth_redirect_uri")?.value || "",
    origin
  );
  const configuredRedirectUri = resolveConfiguredRedirectUri(origin);
  const redirectUriCandidates = uniqueNonEmpty([
    cookieRedirectUri,
    requestRedirectUri,
    configuredRedirectUri,
  ]);
  const redirectUriForExchange = redirectUriCandidates[0] || requestRedirectUri;

  const cookieAppId = (cookieStore.get("ig_oauth_app_id")?.value || "").trim();
  const appIdCandidates = uniqueNonEmpty([
    cookieAppId,
    appId,
    (process.env.NEXT_PUBLIC_META_APP_ID || "").trim(),
  ]);
  const appIdForExchange = appIdCandidates[0] || appId;
  const appSecretFingerprints = appSecretCandidates.map(fingerprint);

  const oauthError = searchParams.get("error");
  if (oauthError) {
    const description =
      searchParams.get("error_description") || searchParams.get("error_reason");
    return NextResponse.redirect(
      toWorkspaceRedirect(request.url, companyUser.workspace_id, {
        error: "oauth_failed",
        ...(description ? { error_details: description } : {}),
      })
    );
  }

  const code =
    getRawQueryParam(request.url, "code") || searchParams.get("code") || "";
  const rawCode = getRawQueryParam(request.url, "code");

  console.info("[instagram.callback] received oauth callback", {
    appId,
    appIdForExchange,
    appIdFromCookie: cookieAppId,
    appIdCandidates,
    origin,
    requestRedirectUri,
    cookieRedirectUri,
    configuredRedirectUri,
    redirectUriForExchange,
    redirectUriCandidates,
    codeLength: code.length,
    codePreview: previewValue(code),
    rawCodeLength: rawCode.length,
    rawCodePreview: previewValue(rawCode),
    rawCodeHasPlus: rawCode.includes("+"),
    rawCodeHasPct2B: /%2B/i.test(rawCode),
    state,
    cookieState,
    stateMatches: !!state && state === cookieState,
    appSecretCandidatesCount: appSecretCandidates.length,
    appSecretFingerprints,
  });

  if (!code || !state || state !== cookieState) {
    return NextResponse.redirect(
      toWorkspaceRedirect(request.url, companyUser.workspace_id, {
        error: "invalid_state",
      })
    );
  }

  let successfulExchangeAttempt: TokenExchangeAttempt | undefined;

  try {
    const attempts: TokenExchangeAttempt[] = [];
    const seenAttempts = new Set<string>();

    for (const candidateAppId of appIdCandidates) {
      for (const candidateAppSecret of appSecretCandidates) {
        for (const candidateRedirectUri of redirectUriCandidates) {
          const key = `${candidateAppId}|${candidateAppSecret}|${candidateRedirectUri}`;
          if (seenAttempts.has(key)) continue;
          seenAttempts.add(key);
          attempts.push({
            appId: candidateAppId,
            appSecret: candidateAppSecret,
            redirectUri: candidateRedirectUri,
          });
        }
      }
    }

    if (attempts.length === 0) {
      attempts.push({
        appId: appIdForExchange,
        appSecret: appSecretCandidates[0] || "",
        redirectUri: redirectUriForExchange,
      });
    }

    let short:
      | {
          access_token: string;
          user_id?: string;
          permissions?: string;
        }
      | undefined;
    let lastExchangeError: unknown;

    for (const attempt of attempts) {
      try {
        short = await exchangeCodeForShortToken(
          attempt.appId,
          attempt.appSecret,
          attempt.redirectUri,
          code
        );
        successfulExchangeAttempt = attempt;
        break;
      } catch (attemptError) {
        lastExchangeError = attemptError;
        console.warn(
          "[instagram.callback] exchange short token attempt failed",
          {
            appId: attempt.appId,
            redirectUri: attempt.redirectUri,
            appSecretFingerprint: fingerprint(attempt.appSecret),
            error:
              attemptError instanceof Error
                ? attemptError.message.slice(0, 220)
                : "unknown_error",
          }
        );
      }
    }

    if (!short || !successfulExchangeAttempt) {
      throw (
        lastExchangeError ||
        new Error("Failed to exchange code for access token")
      );
    }

    const long = await exchangeForLongLivedToken(
      successfulExchangeAttempt.appSecret,
      short.access_token
    );
    const identity = await fetchInstagramIdentity(long.access_token || "");

    const igBusinessId =
      identity.instagram_business_account_id || identity.instagram_scoped_id;
    if (!igBusinessId) {
      return NextResponse.redirect(
        toWorkspaceRedirect(request.url, companyUser.workspace_id, {
          error: "no_instagram_account",
        })
      );
    }

    const encryptedToken = encryptString(long.access_token || "");
    const tokenExpiresAt = long.expires_in
      ? new Date(Date.now() + long.expires_in * 1000).toISOString()
      : null;
    const connectedAt = new Date().toISOString();

    const { data: existingSource } = await supabase
      .from("sources")
      .select("id, credentials")
      .eq("workspace_id", companyUser.workspace_id)
      .eq("type", "instagram")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const existingCredentials =
      (existingSource?.credentials as Record<string, unknown>) || {};
    const nextCredentials: Record<string, unknown> = {
      ...existingCredentials,
      instagram_business_account_id: igBusinessId,
      instagram_scoped_id:
        identity.instagram_scoped_id || existingCredentials.instagram_scoped_id,
      page_access_token: encryptedToken,
      token_expires_at: tokenExpiresAt,
      connected_at: connectedAt,
      auth_method: "instagram_business_login",
      token_type: long.token_type || "bearer",
      granted_permissions: short.permissions || "",
    };

    if (identity.username) nextCredentials.username = identity.username;
    if (identity.account_type)
      nextCredentials.account_type = identity.account_type;
    if (identity.name) nextCredentials.name = identity.name;
    if (identity.category_name)
      nextCredentials.category_name = identity.category_name;
    if (identity.biography) nextCredentials.biography = identity.biography;
    if (identity.website) nextCredentials.website = identity.website;
    if (identity.profile_picture_url)
      nextCredentials.profile_picture_url = identity.profile_picture_url;
    if (typeof identity.followers_count === "number") {
      nextCredentials.followers_count = identity.followers_count;
    }
    if (typeof identity.follows_count === "number") {
      nextCredentials.follows_count = identity.follows_count;
    }
    if (typeof identity.media_count === "number") {
      nextCredentials.media_count = identity.media_count;
    }
    if (typeof identity.is_verified === "boolean") {
      nextCredentials.is_verified = identity.is_verified;
    }

    if (existingSource?.id) {
      const { error } = await supabase
        .from("sources")
        .update({
          name: `Instagram (${igBusinessId.slice(-6)})`,
          credentials: nextCredentials,
        })
        .eq("id", existingSource.id);
      if (error) {
        return NextResponse.redirect(
          toWorkspaceRedirect(request.url, companyUser.workspace_id, {
            error: "save_failed",
          })
        );
      }
    } else {
      const channelCapacity = await ensureCompanyChannelCapacity(
        supabaseAdmin,
        companyUser.workspace_id,
        "instagram"
      );
      if (!channelCapacity.allowed) {
        return NextResponse.redirect(
          toWorkspaceRedirect(request.url, companyUser.workspace_id, {
            error: COMPANY_CHANNEL_LIMIT_EXCEEDED_CODE,
          })
        );
      }

      const { error } = await supabase.from("sources").insert({
        company_id: companyId,
        workspace_id: companyUser.workspace_id,
        type: "instagram",
        name: `Instagram (${igBusinessId.slice(-6)})`,
        credentials: nextCredentials,
      });
      if (error) {
        return NextResponse.redirect(
          toWorkspaceRedirect(request.url, companyUser.workspace_id, {
            error: "save_failed",
          })
        );
      }
    }

    try {
      trackSourceConnected(
        companyId,
        companyUser.workspace_id,
        "instagram",
        "active"
      );
    } catch {}

    const subscriptionTargets = [
      identity.instagram_scoped_id,
      identity.instagram_business_account_id,
    ].filter(Boolean) as string[];

    let webhookSuccess = false;
    let webhookFailureDetails = "";
    let webhookSubscribedFields: string[] = [];
    for (const targetId of [...new Set(subscriptionTargets)]) {
      try {
        const subscription = await subscribeToInstagramWebhooks(
          targetId,
          long.access_token || ""
        );
        webhookSuccess = subscription.ok;
        if (subscription.ok) {
          webhookSubscribedFields = subscription.subscribedFields;
        }
        if (!subscription.ok && subscription.error) {
          webhookFailureDetails = subscription.error.slice(0, 250);
        }
      } catch {
        webhookSuccess = false;
      }
      if (webhookSuccess) break;
    }

    if (webhookSuccess && webhookSubscribedFields.length > 0) {
      await supabase
        .from("sources")
        .update({
          credentials: {
            ...nextCredentials,
            instagram_subscribed_fields: webhookSubscribedFields,
            instagram_webhook_subscribed_at: new Date().toISOString(),
          },
        })
        .eq("workspace_id", companyUser.workspace_id)
        .eq("type", "instagram");
    }

    const redirectParams: Record<string, string> = { new: "true" };
    if (!webhookSuccess) {
      redirectParams.warning = "webhook_subscription_failed";
      if (webhookFailureDetails) {
        redirectParams.warning_details = webhookFailureDetails;
      }
    }
    return NextResponse.redirect(
      toWorkspaceRedirect(request.url, companyUser.workspace_id, redirectParams)
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    const details = `[redirect_uri=${
      successfulExchangeAttempt?.redirectUri || redirectUriForExchange
    }] ${message}`;
    return NextResponse.redirect(
      toWorkspaceRedirect(request.url, companyUser.workspace_id, {
        error: "token_exchange_failed",
        error_details: details.slice(0, 500),
      })
    );
  }
}
