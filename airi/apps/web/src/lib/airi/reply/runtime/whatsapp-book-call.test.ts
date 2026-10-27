import {
  handleWhatsAppBookCallTap,
  resolveScenarioWhatsAppAppointmentAvailability,
  resolveWhatsAppBookCallAppointmentConfigFromScenarios,
} from "./whatsapp-book-call";
import {
  buildWhatsAppBookCallPayload,
  type ScenarioWhatsAppBookCallConfig,
} from "@icecore/scenario-contracts";
import type { AiriScenarioRuntimeConfig } from "@icecore/airi-runtime/scenario-runtime-types";

const APPOINTMENT_CONFIG = {
  enabled: true,
  dateRangeMode: "today",
  durationMinutes: 30,
  minNoticeMinutes: 60,
  horizonDays: 1,
  maxSlots: 2,
  timeZone: "Asia/Almaty",
  eventTitle: "Product demo",
  createMeetLink: false,
} satisfies ScenarioWhatsAppBookCallConfig;

const AVAILABILITY_CONTEXT = {
  calendarId: "primary",
  timeZone: "Asia/Almaty",
  timeMin: "2026-06-11T09:00:00.000Z",
  timeMax: "2026-06-11T10:00:00.000Z",
  busySlotCount: 0,
  windows: [
    {
      start: "2026-06-11T09:00:00.000Z",
      end: "2026-06-11T10:00:00.000Z",
    },
  ],
  signature: "availability-signature",
  promptBlock: "Calendar availability",
};

function createAppointmentRuntime(params: {
  actionNodeId: string;
  config: ScenarioWhatsAppBookCallConfig;
}): AiriScenarioRuntimeConfig {
  return {
    scenarioId: "scenario-1",
    scenarioName: "Appointment scenario",
    selectedActionNodeId: params.actionNodeId,
    actionType: "reply",
    actionReplyChannel: "whatsapp",
    actionWhatsAppServiceMessage: {
      version: 1,
      message: {
        kind: "appointment",
        body: { mode: "fixed", text: "Choose a time" },
        config: params.config,
      },
    },
    includeConversationTimeline: false,
    includeConversationSummaries: false,
    includeSnippets: false,
    includeKBArticles: false,
    includeIndexedUrls: false,
    includeQuickReplies: false,
    includeCustomerProfile: false,
    includePurchaseHistory: false,
    includeActiveSubscriptions: false,
    includeDynamicBusinessTags: false,
  };
}

describe("whatsapp book-call runtime helpers", () => {
  it("resolves dynamic WhatsApp slot choices from Calendar availability", async () => {
    const buildAvailabilityContext = jest.fn().mockResolvedValue({
      windows: [
        {
          start: "2026-06-11T09:00:00.000Z",
          end: "2026-06-11T10:00:00.000Z",
        },
      ],
    });
    const runtime = createAppointmentRuntime({
      actionNodeId: "book-call-1",
      config: {
        enabled: true,
        dateRangeMode: "tomorrow",
        durationMinutes: 30,
        minNoticeMinutes: 60,
        horizonDays: 1,
        maxSlots: 2,
        timeZone: "UTC",
        eventTitle: "Demo call",
        createMeetLink: true,
      },
    });

    const availability = await resolveScenarioWhatsAppAppointmentAvailability({
      runtime,
      workspaceId: "workspace-1",
      buildAvailabilityContext,
      now: new Date("2026-06-11T09:00:00.000Z"),
    });

    expect(buildAvailabilityContext).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        timeZone: "UTC",
        minimumNoticeMinutes: 60,
        horizonDays: 1,
        rangeStart: new Date("2026-06-12T00:00:00.000Z"),
        rangeEnd: new Date("2026-06-13T00:00:00.000Z"),
        minDurationMinutes: 30,
        maxWindowMinutes: 30,
        maxWindows: 2,
      })
    );
    expect(availability?.choices).toHaveLength(2);
    expect(availability?.choices[0]?.payload).toBe(
      "wbc:book-call-1:1781168400000:1781170200000"
    );
  });

  it("resolves a canonical appointment config from the referenced action", () => {
    const canonical = resolveWhatsAppBookCallAppointmentConfigFromScenarios({
      actionNodeId: "canonical-appointment",
      scenarios: [
        {
          nodes: [
            {
              id: "canonical-appointment",
              data: {
                kind: "action",
                actionType: "reply",
                actionWhatsAppServiceMessage: {
                  version: 1,
                  message: {
                    kind: "appointment",
                    body: { mode: "fixed", text: "Pick a time" },
                    config: APPOINTMENT_CONFIG,
                  },
                },
              },
            },
          ],
        },
      ],
    });
    expect(canonical).toEqual(APPOINTMENT_CONFIG);
  });

  it("fails closed when the referenced action is ambiguous or canonically owns another message kind", () => {
    const nonAppointmentNode = {
      id: "appointment",
      data: {
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "text",
            body: { mode: "fixed", text: "No booking" },
          },
        },
      },
    };

    expect(
      resolveWhatsAppBookCallAppointmentConfigFromScenarios({
        actionNodeId: "appointment",
        scenarios: [{ nodes: [nonAppointmentNode] }],
      })
    ).toBeNull();
    expect(
      resolveWhatsAppBookCallAppointmentConfigFromScenarios({
        actionNodeId: "appointment",
        scenarios: [
          { nodes: [nonAppointmentNode] },
          { nodes: [nonAppointmentNode] },
        ],
      })
    ).toBeNull();
  });

  it("uses one provider availability snapshot for both template context and appointment choices", async () => {
    const buildAvailabilityContext = jest
      .fn()
      .mockResolvedValue(AVAILABILITY_CONTEXT);
    const runtime = createAppointmentRuntime({
      actionNodeId: "book-call-snapshot",
      config: APPOINTMENT_CONFIG,
    });

    const snapshot = await resolveScenarioWhatsAppAppointmentAvailability({
      runtime,
      workspaceId: "workspace-1",
      now: new Date("2026-06-11T07:00:00.000Z"),
      buildAvailabilityContext,
    });

    expect(buildAvailabilityContext).toHaveBeenCalledTimes(1);
    expect(snapshot?.context).toBe(AVAILABILITY_CONTEXT);
    expect(snapshot?.choices).toHaveLength(2);
  });

  it("keeps appointment delivery fail-soft when Calendar availability cannot load", async () => {
    const buildAvailabilityContext = jest
      .fn()
      .mockRejectedValue(new Error("Calendar timeout"));

    const snapshot = await resolveScenarioWhatsAppAppointmentAvailability({
      runtime: createAppointmentRuntime({
        actionNodeId: "book-call-fail-soft",
        config: APPOINTMENT_CONFIG,
      }),
      workspaceId: "workspace-1",
      now: new Date("2026-06-11T07:00:00.000Z"),
      buildAvailabilityContext,
    });

    expect(buildAvailabilityContext).toHaveBeenCalledTimes(1);
    expect(snapshot).toEqual(
      expect.objectContaining({
        context: null,
        choices: [],
      })
    );
  });

  it("creates a Calendar event only for a currently offered slot and uses the action booking config", async () => {
    const payload = buildWhatsAppBookCallPayload({
      actionNodeId: "book-call-1",
      startMs: Date.parse("2026-06-11T09:00:00.000Z"),
      endMs: Date.parse("2026-06-11T09:30:00.000Z"),
    });
    const createBookingEvent = jest.fn().mockResolvedValue({
      status: "booked",
      eventId: "event-1",
      htmlLink: "https://calendar.google.com/event?eid=event-1",
    });

    const buildAvailabilityContext = jest
      .fn()
      .mockResolvedValue(AVAILABILITY_CONTEXT);
    const result = await handleWhatsAppBookCallTap({
      payload,
      workspaceId: "workspace-1",
      conversationId: "conv-1",
      contactData: {
        waId: "77012345678",
        profile: { name: "Ada" },
        primaryIdType: "wa_id",
      },
      now: new Date("2026-06-11T07:00:00.000Z"),
      resolveAppointmentConfig: jest.fn().mockResolvedValue(APPOINTMENT_CONFIG),
      buildAvailabilityContext,
      createBookingEvent,
    });

    expect(buildAvailabilityContext).toHaveBeenCalledTimes(1);
    expect(createBookingEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        customerWhatsAppNumber: "+77012345678",
        conversationId: "conv-1",
        actionNodeId: "book-call-1",
        eventTitle: "Product demo",
        timeZone: "Asia/Almaty",
        createMeetLink: false,
      })
    );
    expect(result?.eventResult.status).toBe("booked");
    expect(result?.confirmationText).toContain("Your call is booked");
  });

  it("rejects a forged slot that was not one of the configured offered choices", async () => {
    const payload = buildWhatsAppBookCallPayload({
      actionNodeId: "book-call-1",
      startMs: Date.parse("2026-06-11T09:15:00.000Z"),
      endMs: Date.parse("2026-06-11T09:45:00.000Z"),
    });
    const createBookingEvent = jest.fn();

    const result = await handleWhatsAppBookCallTap({
      payload,
      workspaceId: "workspace-1",
      conversationId: "conv-1",
      now: new Date("2026-06-11T07:00:00.000Z"),
      resolveAppointmentConfig: jest.fn().mockResolvedValue(APPOINTMENT_CONFIG),
      buildAvailabilityContext: jest
        .fn()
        .mockResolvedValue(AVAILABILITY_CONTEXT),
      createBookingEvent,
    });

    expect(result?.eventResult.status).toBe("slot_unavailable");
    expect(result?.rejectionReason).toBe("slot_not_offered");
    expect(createBookingEvent).not.toHaveBeenCalled();
  });

  it("rejects stale slot payloads before reading provider availability", async () => {
    const payload = buildWhatsAppBookCallPayload({
      actionNodeId: "book-call-1",
      startMs: Date.parse("2026-06-11T09:00:00.000Z"),
      endMs: Date.parse("2026-06-11T09:30:00.000Z"),
    });
    const buildAvailabilityContext = jest.fn();
    const createBookingEvent = jest.fn();

    const result = await handleWhatsAppBookCallTap({
      payload,
      workspaceId: "workspace-1",
      conversationId: "conv-1",
      now: new Date("2026-06-11T09:15:00.000Z"),
      resolveAppointmentConfig: jest.fn().mockResolvedValue(APPOINTMENT_CONFIG),
      buildAvailabilityContext,
      createBookingEvent,
    });

    expect(result?.eventResult.status).toBe("slot_unavailable");
    expect(result?.rejectionReason).toBe("slot_outside_current_window");
    expect(buildAvailabilityContext).not.toHaveBeenCalled();
    expect(createBookingEvent).not.toHaveBeenCalled();
  });

  it("rejects payloads when the referenced action is not an active appointment", async () => {
    const payload = buildWhatsAppBookCallPayload({
      actionNodeId: "removed-book-call",
      startMs: Date.parse("2026-06-11T09:00:00.000Z"),
      endMs: Date.parse("2026-06-11T09:30:00.000Z"),
    });
    const buildAvailabilityContext = jest.fn();
    const createBookingEvent = jest.fn();

    const result = await handleWhatsAppBookCallTap({
      payload,
      workspaceId: "workspace-1",
      conversationId: "conv-1",
      now: new Date("2026-06-11T07:00:00.000Z"),
      resolveAppointmentConfig: jest.fn().mockResolvedValue(null),
      buildAvailabilityContext,
      createBookingEvent,
    });

    expect(result?.eventResult.status).toBe("slot_unavailable");
    expect(result?.rejectionReason).toBe("appointment_not_found");
    expect(buildAvailabilityContext).not.toHaveBeenCalled();
    expect(createBookingEvent).not.toHaveBeenCalled();
  });
});
