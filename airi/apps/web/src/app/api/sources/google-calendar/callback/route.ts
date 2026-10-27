import { encryptString } from "@/lib/crypto";
import {
  buildGoogleCalendarCredentials,
  GOOGLE_CALENDAR_BOOKING_SCOPES,
  GOOGLE_CALENDAR_DEFAULT_CALENDAR_ID,
  GOOGLE_CALENDAR_INTEGRATION_NAME,
  GOOGLE_CALENDAR_SOURCE_TYPE,
  hasGoogleCalendarBookingScope,
} from "@/lib/google-calendar/google-calendar-source";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { getCompanyIdForWorkspace } from "@/lib/supabase/company-users";
import { createClient } from "@/lib/supabase/server";
import type { GoogleCalendarCredentials } from "@icecore/shared/types/sources";
import { NextRequest, NextResponse } from "next/server";

type GoogleTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

function redirectToIntegrations(
  requestUrl: string,
  workspaceId: string,
  params: Record<string, string>
) {
  const url = new URL(
    `/panel/w/${workspaceId}/settings/integrations`,
    requestUrl
  );
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return NextResponse.redirect(url.toString());
}

async function exchangeGoogleCalendarCode(params: {
  code: string;
  redirectUri: string;
}): Promise<GoogleTokenResponse | null> {
  const clientId = (process.env.GOOGLE_AUTH_CLIENT_ID || "").trim();
  const clientSecret = (process.env.GOOGLE_AUTH_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) return null;

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: params.redirectUri,
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) return null;
  return (await response
    .json()
    .catch(() => null)) as GoogleTokenResponse | null;
}

function getExistingRefreshToken(
  credentials: unknown
): GoogleCalendarCredentials["refresh_token"] | undefined {
  if (!credentials || typeof credentials !== "object") return undefined;
  const value = (credentials as Record<string, unknown>).refresh_token;
  if (!value) return undefined;
  return value as GoogleCalendarCredentials["refresh_token"];
}

// OAuth providers redirect with GET; state cookie, user session, and workspace membership are verified before persistence.
// react-doctor-disable-next-line react-doctor/nextjs-no-side-effect-in-get-handler
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = (searchParams.get("code") || "").trim();
  const state = (searchParams.get("state") || "").trim();
  const cookieState =
    request.cookies.get(`${GOOGLE_CALENDAR_SOURCE_TYPE}_oauth_state`)?.value ||
    "";
  const workspaceId =
    request.cookies.get(`${GOOGLE_CALENDAR_SOURCE_TYPE}_oauth_workspace_id`)
      ?.value || "";
  const redirectUri =
    request.cookies.get(`${GOOGLE_CALENDAR_SOURCE_TYPE}_oauth_redirect_uri`)
      ?.value || "";

  if (
    !code ||
    !state ||
    state !== cookieState ||
    !workspaceId ||
    !redirectUri
  ) {
    return redirectToIntegrations(request.url, workspaceId || "", {
      integration: GOOGLE_CALENDAR_SOURCE_TYPE,
      error: "oauth_failed",
    });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return redirectToIntegrations(request.url, workspaceId, {
      integration: GOOGLE_CALENDAR_SOURCE_TYPE,
      error: "unauthorized",
    });
  }

  const hasAccess = await checkUserWorkspaceAccess(
    supabase,
    user.id,
    workspaceId
  );
  if (!hasAccess) {
    return redirectToIntegrations(request.url, workspaceId, {
      integration: GOOGLE_CALENDAR_SOURCE_TYPE,
      error: "forbidden",
    });
  }

  const token = await exchangeGoogleCalendarCode({ code, redirectUri });
  if (!token?.access_token) {
    return redirectToIntegrations(request.url, workspaceId, {
      integration: GOOGLE_CALENDAR_SOURCE_TYPE,
      error: "token_exchange_failed",
      ...(token?.error_description
        ? { error_details: token.error_description }
        : {}),
    });
  }
  const grantedScope = token.scope || GOOGLE_CALENDAR_BOOKING_SCOPES;
  if (!hasGoogleCalendarBookingScope(grantedScope)) {
    return redirectToIntegrations(request.url, workspaceId, {
      integration: GOOGLE_CALENDAR_SOURCE_TYPE,
      error: "booking_scope_denied",
    });
  }

  const companyId = await getCompanyIdForWorkspace(supabase, workspaceId);
  if (!companyId) {
    return redirectToIntegrations(request.url, workspaceId, {
      integration: GOOGLE_CALENDAR_SOURCE_TYPE,
      error: "workspace_missing",
    });
  }

  const { data: existingSource, error: existingSourceError } = await supabase
    .from("sources")
    .select("id, credentials")
    .eq("workspace_id", workspaceId)
    .eq("type", GOOGLE_CALENDAR_SOURCE_TYPE)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingSourceError) {
    console.error("[google-calendar.callback] failed to load existing source", {
      workspaceId,
      code: existingSourceError.code,
      message: existingSourceError.message,
    });
    return redirectToIntegrations(request.url, workspaceId, {
      integration: GOOGLE_CALENDAR_SOURCE_TYPE,
      error: "save_failed",
    });
  }

  const credentials = buildGoogleCalendarCredentials({
    encryptedAccessToken: encryptString(token.access_token),
    encryptedRefreshToken: token.refresh_token
      ? encryptString(token.refresh_token)
      : undefined,
    existingRefreshToken: getExistingRefreshToken(existingSource?.credentials),
    expiresIn: token.expires_in,
    scope: grantedScope,
    tokenType: token.token_type || "Bearer",
  });

  const saveResult = existingSource?.id
    ? await supabase
        .from("sources")
        .update({ name: GOOGLE_CALENDAR_INTEGRATION_NAME, credentials })
        .eq("id", existingSource.id)
    : await supabase.from("sources").insert({
        company_id: companyId,
        workspace_id: workspaceId,
        type: GOOGLE_CALENDAR_SOURCE_TYPE,
        name: GOOGLE_CALENDAR_INTEGRATION_NAME,
        credentials: {
          ...credentials,
          calendar_id:
            credentials.calendar_id || GOOGLE_CALENDAR_DEFAULT_CALENDAR_ID,
        },
      });

  if (saveResult.error) {
    console.error("[google-calendar.callback] failed to save source", {
      workspaceId,
      code: saveResult.error.code,
      message: saveResult.error.message,
    });
    return redirectToIntegrations(request.url, workspaceId, {
      integration: GOOGLE_CALENDAR_SOURCE_TYPE,
      error: "save_failed",
    });
  }

  const response = redirectToIntegrations(request.url, workspaceId, {
    integration: GOOGLE_CALENDAR_SOURCE_TYPE,
    success: "connected",
  });
  response.cookies.delete(`${GOOGLE_CALENDAR_SOURCE_TYPE}_oauth_state`);
  response.cookies.delete(`${GOOGLE_CALENDAR_SOURCE_TYPE}_oauth_workspace_id`);
  response.cookies.delete(`${GOOGLE_CALENDAR_SOURCE_TYPE}_oauth_redirect_uri`);
  return response;
}
