import {
  GOOGLE_CALENDAR_BOOKING_SCOPES,
  GOOGLE_CALENDAR_EVENT_WRITE_SCOPE,
  GOOGLE_CALENDAR_FREEBUSY_SCOPE,
  hasGoogleCalendarBookingScope,
  toPublicGoogleCalendarCredentials,
} from "./google-calendar-source";

describe("Google Calendar booking scopes", () => {
  it("requests free/busy and owned event write access", () => {
    expect(GOOGLE_CALENDAR_BOOKING_SCOPES.split(/\s+/).sort()).toEqual(
      [GOOGLE_CALENDAR_FREEBUSY_SCOPE, GOOGLE_CALENDAR_EVENT_WRITE_SCOPE].sort()
    );
  });

  it("detects whether granted scopes can create booking events", () => {
    expect(hasGoogleCalendarBookingScope(GOOGLE_CALENDAR_BOOKING_SCOPES)).toBe(
      true
    );
    expect(hasGoogleCalendarBookingScope(GOOGLE_CALENDAR_FREEBUSY_SCOPE)).toBe(
      false
    );
    expect(
      hasGoogleCalendarBookingScope(
        "https://www.googleapis.com/auth/calendar.events"
      )
    ).toBe(true);
    expect(
      hasGoogleCalendarBookingScope("https://www.googleapis.com/auth/calendar")
    ).toBe(true);
  });
});

describe("toPublicGoogleCalendarCredentials", () => {
  it("redacts OAuth tokens and exposes only connection metadata", () => {
    expect(
      toPublicGoogleCalendarCredentials({
        access_token: { iv: "iv", tag: "tag", ciphertext: "access" },
        refresh_token: { iv: "iv", tag: "tag", ciphertext: "refresh" },
        expires_at: "2026-06-01T12:00:00.000Z",
        scope: "https://www.googleapis.com/auth/calendar.freebusy",
        token_type: "Bearer",
        connected_at: "2026-06-01T10:00:00.000Z",
        account_email: "owner@example.com",
        calendar_id: "primary",
      })
    ).toEqual({
      has_access_token: true,
      has_refresh_token: true,
      expires_at: "2026-06-01T12:00:00.000Z",
      scope: "https://www.googleapis.com/auth/calendar.freebusy",
      token_type: "Bearer",
      connected_at: "2026-06-01T10:00:00.000Z",
      account_email: "owner@example.com",
      calendar_id: "primary",
    });
  });
});
