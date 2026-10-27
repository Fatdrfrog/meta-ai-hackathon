import { requireAppAdmin } from "@/lib/auth/app-admin";
import {
  buildTikTokAuthorizationUrl,
  resolveTikTokOAuthConfig,
} from "@/lib/tiktok-discovery/oauth-config";
import {
  generateTikTokOAuthState,
  registerTikTokOAuthState,
  TIKTOK_OAUTH_COOKIE_NAME,
  TIKTOK_OAUTH_STATE_TTL_SECONDS,
} from "@/lib/tiktok-discovery/oauth-state";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(_request: NextRequest): Promise<NextResponse> {
  const admin = await requireAppAdmin();
  if (admin.response) return admin.response;

  const configured = resolveTikTokOAuthConfig();
  if (configured.status !== "configured") {
    return NextResponse.json(
      { error: "TikTok Discovery is unavailable" },
      { status: 503 }
    );
  }

  const state = generateTikTokOAuthState();
  const registration = await registerTikTokOAuthState({
    state,
    userId: admin.userId,
    redirectUri: configured.config.redirectUri,
  });
  if (registration !== "acquired") {
    return NextResponse.json(
      { error: "TikTok Discovery is temporarily unavailable" },
      { status: 503 }
    );
  }

  const response = NextResponse.redirect(
    buildTikTokAuthorizationUrl({
      appId: configured.config.appId,
      redirectUri: configured.config.redirectUri,
      state,
    })
  );
  response.cookies.set(TIKTOK_OAUTH_COOKIE_NAME, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/internal/tiktok",
    maxAge: TIKTOK_OAUTH_STATE_TTL_SECONDS,
  });
  return response;
}
