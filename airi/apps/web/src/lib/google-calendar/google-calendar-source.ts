import type { GoogleCalendarCredentials } from "@icecore/shared/types/sources";
import { asRecord, cleanString } from "@icecore/shared/lib/value-utils";

export const GOOGLE_CALENDAR_SOURCE_TYPE = "google_calendar" as const;
export const GOOGLE_CALENDAR_INTEGRATION_NAME = "Google Calendar";
export const GOOGLE_CALENDAR_DEFAULT_CALENDAR_ID = "primary";
export const GOOGLE_CALENDAR_FREEBUSY_SCOPE =
  "https://www.googleapis.com/auth/calendar.freebusy";
export const GOOGLE_CALENDAR_EVENT_WRITE_SCOPE =
  "https://www.googleapis.com/auth/calendar.events.owned";
export const GOOGLE_CALENDAR_BOOKING_SCOPES = [
  GOOGLE_CALENDAR_FREEBUSY_SCOPE,
  GOOGLE_CALENDAR_EVENT_WRITE_SCOPE,
].join(" ");

function hasCredential(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return Boolean(
    value &&
      typeof value === "object" &&
      "iv" in value &&
      "tag" in value &&
      "ciphertext" in value
  );
}

export function toPublicGoogleCalendarCredentials(
  credentials: unknown
): Record<string, unknown> {
  const raw = asRecord(credentials);

  return {
    has_access_token: hasCredential(raw.access_token),
    has_refresh_token: hasCredential(raw.refresh_token),
    expires_at: cleanString(raw.expires_at, 100) || null,
    scope: cleanString(raw.scope, 400) || null,
    token_type: cleanString(raw.token_type, 50) || null,
    connected_at: cleanString(raw.connected_at, 100) || null,
    account_email: cleanString(raw.account_email, 320) || null,
    calendar_id:
      cleanString(raw.calendar_id, 200) || GOOGLE_CALENDAR_DEFAULT_CALENDAR_ID,
  };
}

export function hasGoogleCalendarBookingScope(scope: unknown): boolean {
  if (typeof scope !== "string") return false;
  const scopes = new Set(
    scope
      .split(/\s+/)
      .map(item => item.trim())
      .filter(Boolean)
  );
  return (
    scopes.has(GOOGLE_CALENDAR_EVENT_WRITE_SCOPE) ||
    scopes.has("https://www.googleapis.com/auth/calendar.events") ||
    scopes.has("https://www.googleapis.com/auth/calendar")
  );
}

export function buildGoogleCalendarCredentials(params: {
  encryptedAccessToken: GoogleCalendarCredentials["access_token"];
  encryptedRefreshToken?: GoogleCalendarCredentials["refresh_token"];
  expiresIn?: number | null;
  scope?: string | null;
  tokenType?: string | null;
  existingRefreshToken?: GoogleCalendarCredentials["refresh_token"];
}): GoogleCalendarCredentials {
  const refreshToken =
    params.encryptedRefreshToken || params.existingRefreshToken || undefined;

  return {
    access_token: params.encryptedAccessToken,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    expires_at:
      typeof params.expiresIn === "number" && Number.isFinite(params.expiresIn)
        ? new Date(Date.now() + params.expiresIn * 1000).toISOString()
        : null,
    scope: params.scope || GOOGLE_CALENDAR_BOOKING_SCOPES,
    token_type: params.tokenType || "Bearer",
    connected_at: new Date().toISOString(),
    calendar_id: GOOGLE_CALENDAR_DEFAULT_CALENDAR_ID,
  };
}
