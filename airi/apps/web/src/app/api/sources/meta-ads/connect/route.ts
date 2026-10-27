import { META_ADS_OAUTH_COOKIE_PREFIX } from "@/lib/meta-ads/meta-ads-source";
import { resolveMetaAdsLoginConfigId } from "@/lib/meta-ads/meta-ads-login-config";
import {
  createServerLogger,
  flushServerLogsAfterResponse,
} from "@/lib/observability/server-logs";
import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { requiredFieldResponse } from "@/lib/api/json-body";

const META_OAUTH_URL = "https://www.facebook.com/v25.0/dialog/oauth";
const metaAdsConnectLogger = createServerLogger("meta-ads.connect");

function resolveMetaAdsRedirectUri(origin: string): string {
  const configuredRedirectUri = (
    process.env.META_ADS_REDIRECT_URI ||
    process.env.NEXT_PUBLIC_META_ADS_REDIRECT_URI ||
    ""
  ).trim();
  if (configuredRedirectUri) return configuredRedirectUri;

  const base = (process.env.NEXT_PUBLIC_APP_URL || origin)
    .trim()
    .replace(/\/$/, "");
  return `${base}/api/sources/meta-ads/callback`;
}

function base64Url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const workspaceId = (searchParams.get("workspaceId") || "").trim();
  if (!workspaceId) return requiredFieldResponse("workspaceId");

  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) return access.response;

  const appId = (process.env.NEXT_PUBLIC_META_APP_ID || "").trim();
  if (!appId) {
    return NextResponse.json(
      { error: "Meta Ads OAuth is not configured" },
      { status: 500 }
    );
  }

  const loginConfigId = resolveMetaAdsLoginConfigId();
  if (!loginConfigId) {
    return NextResponse.json(
      { error: "Meta Ads Login for Business is not configured" },
      { status: 500 }
    );
  }

  const state = base64Url(crypto.randomBytes(24));
  const redirectUri = resolveMetaAdsRedirectUri(origin);
  const url = new URL(META_OAUTH_URL);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("config_id", loginConfigId);
  url.searchParams.set("state", state);

  const response = NextResponse.redirect(url.toString());
  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 15,
  };
  response.cookies.set({
    ...cookieOptions,
    name: `${META_ADS_OAUTH_COOKIE_PREFIX}_oauth_state`,
    value: state,
  });
  response.cookies.set({
    ...cookieOptions,
    name: `${META_ADS_OAUTH_COOKIE_PREFIX}_oauth_workspace_id`,
    value: workspaceId,
  });
  response.cookies.set({
    ...cookieOptions,
    name: `${META_ADS_OAUTH_COOKIE_PREFIX}_oauth_redirect_uri`,
    value: redirectUri,
  });
  flushServerLogsAfterResponse();
  metaAdsConnectLogger.info("meta_ads_oauth_started", {
    workspaceId,
    appId,
    loginConfigId,
  });
  return response;
}
