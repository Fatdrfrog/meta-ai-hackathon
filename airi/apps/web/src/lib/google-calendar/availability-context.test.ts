import {
  buildGoogleCalendarAvailabilityContext,
  computeAvailableWindows,
  createGoogleCalendarBookingEvent,
} from "./availability-context";

const NOW = new Date("2026-06-02T09:00:00.000Z");
const decryptCredential = (value: unknown) => String(value || "");

function jsonResponse(body: unknown) {
  return { ok: true, json: jest.fn().mockResolvedValue(body) };
}

function freeBusyResponse(primary: Record<string, unknown> = { busy: [] }) {
  return jsonResponse({ calendars: { primary } });
}

function connectedSourceRepository(credentials: Record<string, unknown> = {}) {
  return {
    findGoogleCalendarSource: jest.fn().mockResolvedValue({
      id: "source-1",
      workspace_id: "workspace-1",
      type: "google_calendar",
      credentials: {
        access_token: "access-token",
        expires_at: "2026-06-02T12:00:00.000Z",
        calendar_id: "primary",
        ...credentials,
      },
    }),
    updateGoogleCalendarCredentials: jest.fn(),
  };
}

const bookingInput = {
  workspaceId: "workspace-1",
  start: new Date("2026-06-02T09:00:00.000Z"),
  end: new Date("2026-06-02T09:30:00.000Z"),
  timeZone: "UTC",
  eventTitle: "Call",
  customerWhatsAppNumber: "+77012345678",
  conversationId: "conversation-1",
  actionNodeId: "action-1",
  decryptCredential,
};

describe("Google Calendar availability context", () => {
  it("does not fetch freebusy when the workspace has no Calendar source", async () => {
    const fetchImpl = jest.fn();
    const sourceRepository = {
      findGoogleCalendarSource: jest.fn().mockResolvedValue(null),
      updateGoogleCalendarCredentials: jest.fn(),
    };

    const result = await buildGoogleCalendarAvailabilityContext({
      workspaceId: "workspace-1",
      now: NOW,
      fetchImpl,
      sourceRepository,
      decryptCredential,
      timeZone: "UTC",
    });

    expect(result).toBeNull();
    expect(sourceRepository.findGoogleCalendarSource).toHaveBeenCalledWith(
      "workspace-1"
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("loads freebusy and formats open windows for a connected Calendar source", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      freeBusyResponse({
        busy: [
          {
            start: "2026-06-02T12:00:00.000Z",
            end: "2026-06-02T13:00:00.000Z",
          },
        ],
      })
    );

    const result = await buildGoogleCalendarAvailabilityContext({
      workspaceId: "workspace-1",
      now: NOW,
      fetchImpl,
      sourceRepository: connectedSourceRepository(),
      decryptCredential,
      timeZone: "UTC",
      horizonDays: 1,
      minimumNoticeMinutes: 0,
      maxWindows: 3,
      maxWindowMinutes: 60,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://www.googleapis.com/calendar/v3/freeBusy",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer access-token",
          "Content-Type": "application/json",
        }),
      })
    );
    expect(result?.promptBlock).toContain(
      "Google Calendar availability (free/busy only)"
    );
    expect(result?.promptBlock).toContain("Tue, Jun 2, 2026, 09:00-10:00 UTC");
    expect(result?.promptBlock).toContain(
      "Do not mention Google Calendar or reveal busy events"
    );
    expect(result?.signature).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses an explicit availability range when one is provided", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(freeBusyResponse());

    const result = await buildGoogleCalendarAvailabilityContext({
      workspaceId: "workspace-1",
      now: NOW,
      rangeStart: new Date("2026-06-03T00:00:00.000Z"),
      rangeEnd: new Date("2026-06-04T00:00:00.000Z"),
      fetchImpl,
      sourceRepository: connectedSourceRepository(),
      decryptCredential,
      timeZone: "UTC",
      horizonDays: 7,
      minimumNoticeMinutes: 0,
      maxWindows: 1,
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.timeMin).toBe("2026-06-03T00:00:00.000Z");
    expect(body.timeMax).toBe("2026-06-04T00:00:00.000Z");
    expect(result?.timeMin).toBe("2026-06-03T00:00:00.000Z");
    expect(result?.timeMax).toBe("2026-06-04T00:00:00.000Z");
  });

  it("builds a stable cache signature from bucketed availability context", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(freeBusyResponse());
    const sourceRepository = connectedSourceRepository();
    const contextAt = (now: string) =>
      buildGoogleCalendarAvailabilityContext({
        workspaceId: "workspace-1",
        now: new Date(now),
        fetchImpl,
        sourceRepository,
        decryptCredential,
        timeZone: "UTC",
        horizonDays: 1,
        minimumNoticeMinutes: 0,
        maxWindows: 1,
        maxWindowMinutes: 60,
      });

    const first = await contextAt("2026-06-02T09:02:00.000Z");
    const second = await contextAt("2026-06-02T09:10:00.000Z");

    expect(first?.timeMin).not.toBe(second?.timeMin);
    expect(first?.signature).toBe(second?.signature);
  });

  it("refreshes and retries freebusy once when Google returns an auth failure", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: jest.fn(),
      })
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "fresh-access-token",
          expires_in: 3600,
          token_type: "Bearer",
        })
      )
      .mockResolvedValueOnce(freeBusyResponse());
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const sourceRepository = connectedSourceRepository({
      access_token: "stale-access-token",
      refresh_token: "refresh-token",
    });

    const result = await buildGoogleCalendarAvailabilityContext({
      workspaceId: "workspace-1",
      now: NOW,
      fetchImpl,
      sourceRepository,
      decryptCredential,
      encryptCredential: value => ({ encrypted: value }) as never,
      clientId: "calendar-client-id",
      clientSecret: "calendar-client-secret",
      timeZone: "UTC",
      horizonDays: 1,
      minimumNoticeMinutes: 0,
    });

    expect(result).not.toBeNull();
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      "https://www.googleapis.com/calendar/v3/freeBusy",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer fresh-access-token",
        }),
      })
    );
    expect(
      sourceRepository.updateGoogleCalendarCredentials
    ).toHaveBeenCalledWith(
      "source-1",
      expect.objectContaining({
        access_token: { encrypted: "fresh-access-token" },
      })
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "[google-calendar.availability] freebusy auth failed",
      expect.objectContaining({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        status: 401,
      })
    );
    warnSpy.mockRestore();
  });

  it("treats freebusy per-calendar errors as unavailable", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        freeBusyResponse({ errors: [{ reason: "notFound" }], busy: [] })
      );
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const result = await buildGoogleCalendarAvailabilityContext({
      workspaceId: "workspace-1",
      now: NOW,
      fetchImpl,
      sourceRepository: connectedSourceRepository(),
      decryptCredential,
      timeZone: "UTC",
    });

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      "[google-calendar.availability] freebusy calendar unavailable",
      expect.objectContaining({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        calendarId: "primary",
      })
    );
    warnSpy.mockRestore();
  });

  it("computes open windows from busy intervals without exposing busy details", () => {
    const windows = computeAvailableWindows({
      rangeStart: new Date("2026-06-02T09:00:00.000Z"),
      rangeEnd: new Date("2026-06-02T13:00:00.000Z"),
      busy: [
        {
          start: "2026-06-02T10:00:00.000Z",
          end: "2026-06-02T11:00:00.000Z",
        },
      ],
      minDurationMinutes: 30,
      maxWindowMinutes: 60,
      maxWindows: 3,
    });

    expect(windows).toEqual([
      {
        start: "2026-06-02T09:00:00.000Z",
        end: "2026-06-02T10:00:00.000Z",
      },
      {
        start: "2026-06-02T11:00:00.000Z",
        end: "2026-06-02T12:00:00.000Z",
      },
      {
        start: "2026-06-02T12:00:00.000Z",
        end: "2026-06-02T13:00:00.000Z",
      },
    ]);
  });

  it("creates a Calendar booking event without attendee email", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(freeBusyResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          id: "event-1",
          htmlLink: "https://calendar.google.com/event?eid=event-1",
        })
      );

    const result = await createGoogleCalendarBookingEvent({
      ...bookingInput,
      fetchImpl,
      sourceRepository: connectedSourceRepository(),
      createMeetLink: true,
    });

    expect(result).toEqual({
      status: "booked",
      eventId: "event-1",
      htmlLink: "https://calendar.google.com/event?eid=event-1",
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer access-token",
          "Content-Type": "application/json",
        }),
      })
    );
    const insertBody = JSON.parse(fetchImpl.mock.calls[1][1].body as string);
    expect(insertBody.attendees).toBeUndefined();
    expect(insertBody.summary).toBe("Call with +77012345678");
    expect(insertBody.description).toContain("WhatsApp: +77012345678");
    expect(insertBody.extendedProperties.private).toEqual({
      airiConversationId: "conversation-1",
      airiActionNodeId: "action-1",
      whatsappNumber: "+77012345678",
    });
    expect(insertBody.conferenceData.createRequest.requestId).toMatch(
      /^airi-conversation-1-action-1-/
    );
  });

  it("does not create a Calendar event when the selected slot is busy", async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(
      freeBusyResponse({
        busy: [
          {
            start: "2026-06-02T09:15:00.000Z",
            end: "2026-06-02T09:45:00.000Z",
          },
        ],
      })
    );

    const result = await createGoogleCalendarBookingEvent({
      ...bookingInput,
      fetchImpl,
      sourceRepository: connectedSourceRepository(),
    });

    expect(result).toEqual({ status: "slot_unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
