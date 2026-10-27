import {
  GOOGLE_CALENDAR_BOOKING_SCOPES,
  GOOGLE_CALENDAR_SOURCE_TYPE,
} from "@/lib/google-calendar/google-calendar-source";
import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { requiredFieldResponse } from "@/lib/api/json-body";

function resolveGoogleCalendarRedirectUri(origin: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || origin)
    .trim()
    .replace(/\/$/, "");
  return `${base}/api/sources/google-calendar/callback`;
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

  const clientId = (process.env.GOOGLE_AUTH_CLIENT_ID || "").trim();
  if (!clientId) {
    return NextResponse.json(
      { error: "Google Calendar OAuth is not configured" },
      { status: 500 }
    );
  }

  const state = base64Url(crypto.randomBytes(24));
  const redirectUri = resolveGoogleCalendarRedirectUri(origin);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_CALENDAR_BOOKING_SCOPES);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
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
    name: `${GOOGLE_CALENDAR_SOURCE_TYPE}_oauth_state`,
    value: state,
  });
  response.cookies.set({
    ...cookieOptions,
    name: `${GOOGLE_CALENDAR_SOURCE_TYPE}_oauth_workspace_id`,
    value: workspaceId,
  });
  response.cookies.set({
    ...cookieOptions,
    name: `${GOOGLE_CALENDAR_SOURCE_TYPE}_oauth_redirect_uri`,
    value: redirectUri,
  });
  return response;
}
