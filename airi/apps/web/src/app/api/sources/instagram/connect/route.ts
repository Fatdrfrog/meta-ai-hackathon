import { resolveUserWorkspaceMembership } from "@/lib/supabase/queries";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

function resolveInstagramRedirectUri(origin: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || origin)
    .trim()
    .replace(/\/$/, "");
  const configured = (
    process.env.NEXT_PUBLIC_INSTAGRAM_REDIRECT_URI || ""
  ).trim();

  if (!configured) {
    return `${base}/api/sources/instagram/callback`;
  }

  try {
    // Keep absolute values as-is to preserve exact string matching in OAuth exchange.
    new URL(configured);
    return configured;
  } catch {
    try {
      return new URL(configured, `${base}/`).toString();
    } catch {
      return `${base}/api/sources/instagram/callback`;
    }
  }
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });

  const access = await resolveUserWorkspaceMembership(
    supabase,
    user.id,
    new URL(request.url).searchParams.get("workspaceId")
  );
  if (!access.ok)
    return NextResponse.json(
      { error: access.error },
      { status: access.status }
    );

  const appId = (
    process.env.NEXT_PUBLIC_INSTAGRAM_APP_ID ||
    process.env.NEXT_PUBLIC_META_APP_ID ||
    ""
  ).trim();
  const { origin } = new URL(request.url);
  // Instagram requires redirect_uri to be identical in OAuth dialog and token exchange.
  const redirectUri = resolveInstagramRedirectUri(origin);
  if (!appId || !redirectUri)
    return new Response(JSON.stringify({ error: "Server not configured" }), {
      status: 500,
    });

  const state = `${randomUUID()}:${access.workspaceId}`;
  const scopes = [
    "instagram_business_basic",
    "instagram_business_manage_insights",
    "instagram_business_manage_messages",
    "instagram_business_manage_comments",
    "instagram_business_content_publish",
  ].join(",");

  const url = new URL("https://www.instagram.com/oauth/authorize");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  // Optional: hide "continue with Facebook" on the IG OAuth screen.
  if (process.env.NEXT_PUBLIC_INSTAGRAM_ENABLE_FB_LOGIN === "false") {
    url.searchParams.set("enable_fb_login", "0");
  }

  console.info("[instagram.connect] redirecting to oauth", {
    appId,
    origin,
    redirectUri,
    scopeCount: scopes.split(",").length,
    oauthUrl: url.toString(),
  });

  // Store state in a transient cookie
  const res = NextResponse.redirect(url.toString());
  res.cookies.set({
    name: "ig_oauth_state",
    value: state,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 15,
  });
  res.cookies.set({
    name: "ig_oauth_redirect_uri",
    value: redirectUri,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 15,
  });
  res.cookies.set({
    name: "ig_oauth_app_id",
    value: appId,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 15,
  });
  return res;
}
