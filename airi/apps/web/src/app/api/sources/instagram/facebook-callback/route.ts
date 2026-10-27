import { resolveUserWorkspaceMembership } from "@/lib/supabase/queries";
import { trackSourceConnected } from "@/lib/analytics";
import { encryptString } from "@/lib/crypto";
import {
  INSTAGRAM_FACEBOOK_LOGIN_COMMENT_WEBHOOK_FIELDS,
  INSTAGRAM_FACEBOOK_LOGIN_PAGE_WEBHOOK_FIELDS,
} from "@/lib/instagram/webhook-events";
import {
  COMPANY_CHANNEL_LIMIT_EXCEEDED_CODE,
  ensureCompanyChannelCapacity,
  toPublicLimitPayload,
} from "@/lib/limits/company-limits";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getCompanyIdForWorkspace } from "@/lib/supabase/company-users";
import { createClient } from "@/lib/supabase/server";
import { META_GRAPH_BASE_URL } from "@icecore/shared/lib/meta/graph-version";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { readNonEmptyStringOrUndefined as toOptionalString } from "@icecore/shared/lib/value-utils";

type FacebookCallbackPayload = {
  state?: string;
  access_token?: string;
  long_lived_token?: string;
  expires_in?: number | string;
  data_access_expiration_time?: number | string;
  page_id?: string;
  instagram_account_id?: string;
  granted_scopes?: string;
};

type FacebookPageAccount = {
  id?: string;
  name?: string;
  access_token?: string;
  instagram_business_account?: {
    id?: string;
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
  };
};

type FacebookPagesResponse = {
  data?: FacebookPageAccount[];
};

function withStateCookieCleared(
  payload: Record<string, unknown>,
  status: number = 200
) {
  const res = NextResponse.json(payload, { status });
  res.cookies.set({
    name: "ig_fb_oauth_state",
    value: "",
    path: "/",
    maxAge: 0,
  });
  return res;
}

function toOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function toOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return undefined;
}

function resolveTokenExpiryIso(
  payload: FacebookCallbackPayload
): string | null {
  const dataAccessExpiration = toOptionalNumber(
    payload.data_access_expiration_time
  );
  if (dataAccessExpiration && dataAccessExpiration > 0) {
    return new Date(dataAccessExpiration * 1000).toISOString();
  }

  const expiresIn = toOptionalNumber(payload.expires_in);
  if (expiresIn && expiresIn > 0) {
    return new Date(Date.now() + expiresIn * 1000).toISOString();
  }

  return null;
}

async function fetchFacebookPagesWithInstagram(
  userAccessToken: string
): Promise<FacebookPageAccount[]> {
  const fetchByFields = async (
    fields: string
  ): Promise<FacebookPageAccount[]> => {
    const url = new URL(`${META_GRAPH_BASE_URL}/me/accounts`);
    url.searchParams.set("fields", fields);
    url.searchParams.set("limit", "200");
    url.searchParams.set("access_token", userAccessToken);

    const res = await fetch(url.toString(), { method: "GET" });
    if (!res.ok) {
      const details = await res.text().catch(() => "");
      throw new Error(
        `Failed to fetch Facebook Pages: ${details || res.statusText}`
      );
    }

    const json = (await res.json()) as FacebookPagesResponse;
    return Array.isArray(json.data) ? json.data : [];
  };

  try {
    return await fetchByFields(
      "id,name,access_token,instagram_business_account{id,username,name,account_type,category_name,biography,website,profile_picture_url,followers_count,follows_count,media_count,is_verified}"
    );
  } catch {
    // Fallback to minimal fields if richer account metadata is unavailable.
    return fetchByFields(
      "id,name,access_token,instagram_business_account{id,username}"
    );
  }
}

async function subscribePageToWebhooks(
  pageId: string,
  pageAccessToken: string
) {
  const fieldAttempts = [
    [...INSTAGRAM_FACEBOOK_LOGIN_PAGE_WEBHOOK_FIELDS],
    ["messages", "message_reactions", "messaging_postbacks"],
  ];
  let lastError = "";

  for (const fields of fieldAttempts) {
    const url = new URL(
      `${META_GRAPH_BASE_URL}/${encodeURIComponent(pageId)}/subscribed_apps`
    );
    url.searchParams.set("subscribed_fields", fields.join(","));
    url.searchParams.set("access_token", pageAccessToken);

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

async function subscribeInstagramAccountToWebhooks(
  instagramBusinessId: string,
  pageAccessToken: string
) {
  const url = new URL(
    `${META_GRAPH_BASE_URL}/${encodeURIComponent(
      instagramBusinessId
    )}/subscribed_apps`
  );
  const fields = [...INSTAGRAM_FACEBOOK_LOGIN_COMMENT_WEBHOOK_FIELDS];
  url.searchParams.set("subscribed_fields", fields.join(","));
  url.searchParams.set("access_token", pageAccessToken);

  const res = await fetch(url.toString(), { method: "POST" });
  if (res.ok) {
    return { ok: true as const, subscribedFields: fields };
  }

  const details = await res.text().catch(() => "");
  return {
    ok: false as const,
    error: details || `HTTP ${res.status}: ${res.statusText}`,
  };
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return withStateCookieCleared({ error: "Unauthorized" }, 401);
  }

  const body = (await request
    .json()
    .catch(() => ({}))) as FacebookCallbackPayload;
  const callbackState = String(body.state || "");
  const cookieState = (await cookies()).get("ig_fb_oauth_state")?.value || "";
  if (!callbackState || callbackState !== cookieState) {
    return withStateCookieCleared({ error: "invalid_state" }, 400);
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
    return withStateCookieCleared({ error: access.error }, access.status);
  const companyUser = { workspace_id: access.workspaceId };

  const companyId = await getCompanyIdForWorkspace(
    supabase,
    companyUser.workspace_id
  );
  if (!companyId) {
    return withStateCookieCleared(
      {
        error: "company_not_found",
        workspaceId: companyUser.workspace_id,
      },
      400
    );
  }

  console.info("[instagram.facebook-callback] received callback payload", {
    callbackStatePreview: callbackState.slice(0, 20),
    cookieStatePreview: cookieState.slice(0, 20),
    stateMatches: !!callbackState && callbackState === cookieState,
    hasAccessToken: !!body.access_token,
    hasLongLivedToken: !!body.long_lived_token,
    pageId: body.page_id || "",
    instagramAccountId: body.instagram_account_id || "",
  });

  if (!callbackState || callbackState !== cookieState) {
    return withStateCookieCleared(
      { error: "invalid_state", workspaceId: companyUser.workspace_id },
      400
    );
  }

  const userAccessToken = String(
    body.long_lived_token || body.access_token || ""
  ).trim();
  if (!userAccessToken) {
    return withStateCookieCleared(
      { error: "missing_access_token", workspaceId: companyUser.workspace_id },
      400
    );
  }

  try {
    const pages = await fetchFacebookPagesWithInstagram(userAccessToken);
    console.info("[instagram.facebook-callback] fetched pages", {
      pagesCount: pages.length,
      eligiblePagesCount: pages.filter(
        page =>
          !!page.id &&
          !!page.access_token &&
          !!page.instagram_business_account?.id
      ).length,
    });
    const eligiblePages = pages.filter(
      page =>
        !!page.id &&
        !!page.access_token &&
        !!page.instagram_business_account?.id
    );

    if (eligiblePages.length === 0) {
      return withStateCookieCleared(
        {
          error: "no_instagram_account",
          workspaceId: companyUser.workspace_id,
        },
        400
      );
    }

    const selectedPageId = String(body.page_id || "");
    const selectedInstagramId = String(body.instagram_account_id || "");
    const selectedPage =
      (selectedPageId
        ? eligiblePages.find(page => page.id === selectedPageId)
        : undefined) ||
      (selectedInstagramId
        ? eligiblePages.find(
            page => page.instagram_business_account?.id === selectedInstagramId
          )
        : undefined) ||
      eligiblePages[0];

    const pageId = String(selectedPage.id || "");
    const pageAccessToken = String(selectedPage.access_token || "");
    const igProfile = selectedPage.instagram_business_account;
    const instagramBusinessId = String(igProfile?.id || "");
    const username = String(igProfile?.username || "");
    const displayName = toOptionalString(igProfile?.name);
    const accountType = toOptionalString(igProfile?.account_type);
    const categoryName = toOptionalString(igProfile?.category_name);
    const biography = toOptionalString(igProfile?.biography);
    const website = toOptionalString(igProfile?.website);
    const profilePictureUrl = toOptionalString(igProfile?.profile_picture_url);
    const followersCount = toOptionalNumber(igProfile?.followers_count);
    const followsCount = toOptionalNumber(igProfile?.follows_count);
    const mediaCount = toOptionalNumber(igProfile?.media_count);
    const isVerified = toOptionalBoolean(igProfile?.is_verified);

    if (!pageId || !pageAccessToken || !instagramBusinessId) {
      return withStateCookieCleared(
        {
          error: "no_instagram_account",
          error_details:
            "Connected Facebook Page is missing Instagram account or page token",
          workspaceId: companyUser.workspace_id,
        },
        400
      );
    }

    const tokenExpiresAt = resolveTokenExpiryIso(body);
    const encryptedToken = encryptString(pageAccessToken);
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
      instagram_business_account_id: instagramBusinessId,
      page_id: pageId,
      page_access_token: encryptedToken,
      token_expires_at: tokenExpiresAt,
      connected_at: connectedAt,
      auth_method: "facebook_login",
      token_type: "page",
      granted_permissions: String(body.granted_scopes || ""),
    };

    if (username) {
      nextCredentials.username = username;
    }
    if (displayName) {
      nextCredentials.name = displayName;
    }
    if (accountType) {
      nextCredentials.account_type = accountType;
    }
    if (categoryName) {
      nextCredentials.category_name = categoryName;
    }
    if (biography) {
      nextCredentials.biography = biography;
    }
    if (website) {
      nextCredentials.website = website;
    }
    if (profilePictureUrl) {
      nextCredentials.profile_picture_url = profilePictureUrl;
    }
    if (typeof followersCount === "number") {
      nextCredentials.followers_count = followersCount;
    }
    if (typeof followsCount === "number") {
      nextCredentials.follows_count = followsCount;
    }
    if (typeof mediaCount === "number") {
      nextCredentials.media_count = mediaCount;
    }
    if (typeof isVerified === "boolean") {
      nextCredentials.is_verified = isVerified;
    }

    if (existingSource?.id) {
      const { error } = await supabase
        .from("sources")
        .update({
          name: `Instagram (${instagramBusinessId.slice(-6)})`,
          credentials: nextCredentials,
        })
        .eq("id", existingSource.id);

      if (error) {
        return withStateCookieCleared(
          { error: "save_failed", workspaceId: companyUser.workspace_id },
          500
        );
      }
    } else {
      const channelCapacity = await ensureCompanyChannelCapacity(
        supabaseAdmin,
        companyUser.workspace_id,
        "instagram"
      );
      if (!channelCapacity.allowed) {
        return withStateCookieCleared(
          {
            error: COMPANY_CHANNEL_LIMIT_EXCEEDED_CODE,
            code: COMPANY_CHANNEL_LIMIT_EXCEEDED_CODE,
            limit: toPublicLimitPayload(channelCapacity.limit),
            workspaceId: companyUser.workspace_id,
          },
          402
        );
      }

      const { error } = await supabase.from("sources").insert({
        company_id: companyId,
        workspace_id: companyUser.workspace_id,
        type: "instagram",
        name: `Instagram (${instagramBusinessId.slice(-6)})`,
        credentials: nextCredentials,
      });

      if (error) {
        return withStateCookieCleared(
          { error: "save_failed", workspaceId: companyUser.workspace_id },
          500
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

    const [pageSubscription, instagramSubscription] = await Promise.all([
      subscribePageToWebhooks(pageId, pageAccessToken),
      subscribeInstagramAccountToWebhooks(instagramBusinessId, pageAccessToken),
    ]);
    if (pageSubscription.ok && instagramSubscription.ok) {
      await supabase
        .from("sources")
        .update({
          credentials: {
            ...nextCredentials,
            instagram_page_subscribed_fields: pageSubscription.subscribedFields,
            instagram_comment_subscribed_fields:
              instagramSubscription.subscribedFields,
            instagram_webhook_subscribed_at: new Date().toISOString(),
          },
        })
        .eq("workspace_id", companyUser.workspace_id)
        .eq("type", "instagram");
    }
    const subscriptionErrors = [
      pageSubscription.ok
        ? null
        : `page_subscribed_apps: ${pageSubscription.error || "failed"}`,
      instagramSubscription.ok
        ? null
        : `instagram_subscribed_apps: ${instagramSubscription.error || "failed"}`,
    ].filter(Boolean) as string[];

    return withStateCookieCleared({
      success: true,
      workspaceId: companyUser.workspace_id,
      ...(subscriptionErrors.length === 0
        ? {}
        : {
            warning: "webhook_subscription_failed",
            warning_details: subscriptionErrors.join(" | ").slice(0, 250),
          }),
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : "unknown_error";
    return withStateCookieCleared(
      {
        error: "facebook_login_failed",
        error_details: details.slice(0, 250),
        workspaceId: companyUser.workspace_id,
      },
      400
    );
  }
}
