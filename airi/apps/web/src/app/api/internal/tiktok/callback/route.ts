import { requireAppAdmin } from "@/lib/auth/app-admin";
import { createRequestLogger } from "@/lib/observability/server-logs";
import { completeTikTokPlatformOAuth } from "@/lib/tiktok-discovery/complete-platform-oauth";
import { resolveTikTokOAuthConfig } from "@/lib/tiktok-discovery/oauth-config";
import type { TikTokAdminOAuthResult } from "@/lib/tiktok-discovery/oauth-result";
import {
  consumeTikTokOAuthState,
  TIKTOK_OAUTH_COOKIE_NAME,
} from "@/lib/tiktok-discovery/oauth-state";
import { type NextRequest, NextResponse } from "next/server";

function clearOAuthCookie(response: NextResponse): void {
  response.cookies.set(TIKTOK_OAUTH_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/internal/tiktok",
    maxAge: 0,
  });
}

function redirectToStatus(
  origin: string,
  result: TikTokAdminOAuthResult
): NextResponse {
  const response = NextResponse.redirect(
    new URL(`/api/internal/tiktok/status?result=${result}`, origin)
  );
  clearOAuthCookie(response);
  return response;
}

// GET deliberately performs a one-time OAuth callback side effect.
export async function GET(request: NextRequest): Promise<NextResponse> {
  // OAuth callback headers and URL parameters are attacker-controlled and can
  // contain authorization material. Preserve request-method observability
  // without inheriting any request context into the completion event.
  const logger = createRequestLogger(
    "api.internal.tiktok.callback",
    new Request("https://callback.invalid", { method: request.method })
  );
  const configured = resolveTikTokOAuthConfig();
  if (configured.status !== "configured") {
    const response = NextResponse.json(
      { error: "TikTok Discovery is unavailable" },
      { status: 503 }
    );
    clearOAuthCookie(response);
    logger.success("TikTok OAuth callback completed", {
      result: "server_unconfigured",
    });
    return response;
  }

  const admin = await requireAppAdmin();
  if (admin.response) {
    const result = admin.response.status === 401 ? "unauthorized" : "forbidden";
    logger.success("TikTok OAuth callback completed", { result });
    return redirectToStatus(configured.config.canonicalOrigin, result);
  }

  const queryState = request.nextUrl.searchParams.get("state");
  const cookieState =
    request.cookies.get(TIKTOK_OAUTH_COOKIE_NAME)?.value ?? null;
  if (!queryState || !cookieState || queryState !== cookieState) {
    logger.success("TikTok OAuth callback completed", {
      adminUserId: admin.userId,
      result: "invalid_state",
    });
    return redirectToStatus(configured.config.canonicalOrigin, "invalid_state");
  }

  const consumed = await consumeTikTokOAuthState({
    state: queryState,
    userId: admin.userId,
    redirectUri: configured.config.redirectUri,
  });
  if (consumed !== "consumed") {
    const result =
      consumed === "unavailable" ? "state_unavailable" : "invalid_state";
    logger.success("TikTok OAuth callback completed", {
      adminUserId: admin.userId,
      result,
    });
    return redirectToStatus(configured.config.canonicalOrigin, result);
  }

  if (request.nextUrl.searchParams.get("error")) {
    logger.success("TikTok OAuth callback completed", {
      adminUserId: admin.userId,
      result: "cancelled",
    });
    return redirectToStatus(configured.config.canonicalOrigin, "cancelled");
  }

  const authCode = request.nextUrl.searchParams.get("auth_code");
  if (!authCode) {
    logger.success("TikTok OAuth callback completed", {
      adminUserId: admin.userId,
      result: "token_exchange_failed",
    });
    return redirectToStatus(
      configured.config.canonicalOrigin,
      "token_exchange_failed"
    );
  }

  const completion = await completeTikTokPlatformOAuth({
    authCode,
    adminUserId: admin.userId,
    config: configured.config,
  });
  logger.success("TikTok OAuth callback completed", {
    adminUserId: admin.userId,
    result: completion.result,
    advertiserCount: completion.advertiserCount,
    selectedAdvertiserPresent: completion.selectedAdvertiserPresent,
    providerRequestId: completion.providerRequestId,
  });
  return redirectToStatus(configured.config.canonicalOrigin, completion.result);
}
