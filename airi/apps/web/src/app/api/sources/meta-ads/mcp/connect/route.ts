import { resolveMetaAdsMcpLoginConfigId } from "@/lib/meta-ads/meta-ads-login-config";
import {
  META_ADS_MCP_OAUTH_COOKIE_PREFIX,
  META_ADS_SOURCE_TYPE,
} from "@/lib/meta-ads/meta-ads-source";
import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { requiredFieldResponse } from "@/lib/api/json-body";

const META_OAUTH_URL = "https://www.facebook.com/v25.0/dialog/oauth";

function resolveMetaAdsMcpRedirectUri(origin: string): string {
  const configuredRedirectUri = (
    process.env.META_ADS_MCP_REDIRECT_URI ||
    process.env.NEXT_PUBLIC_META_ADS_MCP_REDIRECT_URI ||
    ""
  ).trim();
  if (configuredRedirectUri) return configuredRedirectUri;

  const base = (process.env.NEXT_PUBLIC_APP_URL || origin)
    .trim()
    .replace(/\/$/, "");
  return `${base}/api/sources/meta-ads/mcp/callback`;
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
  const { supabase } = access;

  const { data: existingSource, error: existingSourceError } = await supabase
    .from("sources")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("type", META_ADS_SOURCE_TYPE)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingSourceError) {
    return NextResponse.json(
      { error: "Failed to load Meta Ads source" },
      { status: 500 }
    );
  }
  if (!existingSource?.id) {
    return NextResponse.json(
      {
        error:
          "Connect Meta Ads first before enabling Ads MCP for this workspace",
      },
      { status: 400 }
    );
  }

  const appId = (process.env.NEXT_PUBLIC_META_APP_ID || "").trim();
  if (!appId) {
    return NextResponse.json(
      { error: "Meta Ads OAuth is not configured" },
      { status: 500 }
    );
  }

  const loginConfigId = resolveMetaAdsMcpLoginConfigId();
  if (!loginConfigId) {
    return NextResponse.json(
      {
        error:
          "Meta Ads MCP Login for Business is not configured. Set META_ADS_MCP_LOGIN_CONFIG_ID or META_ADS_LOGIN_CONFIG_ID.",
      },
      { status: 500 }
    );
  }

  const state = base64Url(crypto.randomBytes(24));
  const redirectUri = resolveMetaAdsMcpRedirectUri(origin);
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
    name: `${META_ADS_MCP_OAUTH_COOKIE_PREFIX}_oauth_state`,
    value: state,
  });
  response.cookies.set({
    ...cookieOptions,
    name: `${META_ADS_MCP_OAUTH_COOKIE_PREFIX}_oauth_workspace_id`,
    value: workspaceId,
  });
  response.cookies.set({
    ...cookieOptions,
    name: `${META_ADS_MCP_OAUTH_COOKIE_PREFIX}_oauth_redirect_uri`,
    value: redirectUri,
  });
  return response;
}
