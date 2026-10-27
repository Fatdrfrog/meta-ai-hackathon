import {
  resolveScenarioReplyExecutionDecision,
  resolveScenarioWhatsAppDeliveryProjection,
} from "./reply-action-utils";

describe("resolveScenarioReplyExecutionDecision", () => {
  it("runs a bodyless canonical service message without invoking AI", () => {
    expect(
      resolveScenarioReplyExecutionDecision({
        actionType: "reply",
        actionReplyMode: "fixed",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "contacts",
            contacts: [{ formattedName: "Airi" }],
          },
        },
      })
    ).toEqual({ kind: "direct_fixed", replyText: "" });
  });

  it("uses the canonical fixed body even when the legacy reply mode is missing", () => {
    expect(
      resolveScenarioReplyExecutionDecision({
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "media_carousel",
            body: { mode: "fixed", text: "Pick a card" },
            cards: [],
          },
        },
      })
    ).toEqual({ kind: "direct_fixed", replyText: "Pick a card" });
  });

  it("routes a canonical AI body through generation despite the legacy fixed marker", () => {
    expect(
      resolveScenarioReplyExecutionDecision({
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "stale fixed copy",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "reply_buttons",
            body: {
              mode: "ai",
              instruction: "Answer from the selected knowledge",
            },
            options: [{ id: "details", label: "Details" }],
          },
        },
      })
    ).toEqual({ kind: "ai_context" });
  });

  it("keeps empty fixed replies on the fixed path instead of falling back to AI", () => {
    expect(
      resolveScenarioReplyExecutionDecision({
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "   ",
      })
    ).toEqual({ kind: "direct_fixed", replyText: "" });
  });

  it("routes AI-mode replies to the AI context path", () => {
    expect(
      resolveScenarioReplyExecutionDecision({
        actionType: "reply",
        actionReplyMode: "ai",
        actionReplyText: "Help the customer",
      })
    ).toEqual({ kind: "ai_context" });
  });

  it("routes fixed replies with body text to direct fixed", () => {
    expect(
      resolveScenarioReplyExecutionDecision({
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Сәлеметсіз бе!",
      })
    ).toEqual({ kind: "direct_fixed", replyText: "Сәлеметсіз бе!" });
  });
});

describe("resolveScenarioWhatsAppDeliveryProjection", () => {
  const appointmentChoices = [
    {
      id: "slot-1",
      text: "Tomorrow at 10:00",
      payload: "slot:1",
    },
  ];

  it("keeps canonical service-message delivery fields together", () => {
    const serviceMessage = {
      version: 1 as const,
      message: {
        kind: "appointment" as const,
        body: { mode: "fixed" as const, text: "Choose a time" },
        config: {
          enabled: true,
          dateRangeMode: "tomorrow" as const,
          durationMinutes: 30,
          minNoticeMinutes: 0,
          horizonDays: 1,
          maxSlots: 3,
          timeZone: "UTC",
        },
      },
    };

    expect(
      resolveScenarioWhatsAppDeliveryProjection({
        runtime: {
          actionWhatsAppServiceMessage: serviceMessage,
        },
        appointmentChoices,
      })
    ).toEqual({
      whatsappServiceMessage: serviceMessage,
      whatsappServiceAppointmentChoices: appointmentChoices,
    });
  });
});
