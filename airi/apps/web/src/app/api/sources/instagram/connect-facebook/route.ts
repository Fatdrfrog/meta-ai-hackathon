import { resolveUserWorkspaceMembership } from "@/lib/supabase/queries";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

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

  const appId = (process.env.NEXT_PUBLIC_META_APP_ID || "").trim();
  const { origin } = new URL(request.url);
  const base = (process.env.NEXT_PUBLIC_APP_URL || origin).replace(/\/$/, "");
  const redirectUri = (
    process.env.NEXT_PUBLIC_INSTAGRAM_FB_REDIRECT_URI ||
    `${base}/instagram/callback`
  ).trim();

  if (!appId || !redirectUri) {
    return new Response(JSON.stringify({ error: "Server not configured" }), {
      status: 500,
    });
  }

  const nonce = randomUUID();
  const state = `${nonce}:${access.workspaceId}`;
  const scopes = [
    "instagram_basic",
    "instagram_manage_insights",
    "instagram_manage_messages",
    "instagram_manage_comments",
    "instagram_content_publish",
    "pages_show_list",
    "pages_manage_metadata",
    "pages_read_engagement",
  ].join(",");

  const url = new URL("https://www.facebook.com/v25.0/dialog/oauth");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes);
  url.searchParams.set("response_type", "token");
  url.searchParams.set("display", "page");
  url.searchParams.set(
    "extras",
    JSON.stringify({ setup: { channel: "IG_API_ONBOARDING" } })
  );
  url.searchParams.set("state", state);

  console.info("[instagram.connect-facebook] redirecting to oauth", {
    appId,
    origin,
    base,
    redirectUri,
    scopeCount: scopes.split(",").length,
    statePreview: state.slice(0, 12),
    oauthUrl: url.toString(),
  });

  const res = NextResponse.redirect(url.toString());
  res.cookies.set({
    name: "ig_fb_oauth_state",
    value: state,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 15,
  });

  return res;
}
