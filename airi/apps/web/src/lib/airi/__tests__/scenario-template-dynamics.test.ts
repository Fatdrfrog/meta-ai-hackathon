import {
  buildMessagingWindowCountdownContext,
  formatCalendarNextFreeSlot,
  scenarioReplyNeedsCalendarTokens,
  toScenarioCalendarTemplateAvailability,
} from "@/lib/airi/scenario/scenario-template-dynamics";
import { applyScenarioReplyTemplate } from "@/lib/airi/scenario/scenario-template";

describe("scenario template dynamics", () => {
  it("detects calendar tokens in reply text", () => {
    expect(
      scenarioReplyNeedsCalendarTokens("Hi {{calendar.next_free_slot}}")
    ).toBe(true);
    expect(scenarioReplyNeedsCalendarTokens("Hi {{first_name}}")).toBe(false);
    expect(
      scenarioReplyNeedsCalendarTokens("Slots: {calendar.slot_count}")
    ).toBe(true);
  });

  it("skips loading availability for calendar tokens that render empty", () => {
    for (const text of [
      "{{calendar.unknown}}",
      "{{Calendar.next_free_slot}}",
      "{{calendar}}",
      "calendar.next_free_slot",
    ]) {
      expect([text, scenarioReplyNeedsCalendarTokens(text)]).toEqual([
        text,
        false,
      ]);
    }
  });

  it("formats the next free calendar slot", () => {
    const text = formatCalendarNextFreeSlot({
      start: "2026-07-13T10:00:00.000Z",
      end: "2026-07-13T10:30:00.000Z",
      timeZone: "UTC",
    });
    expect(text).toContain("Jul");
    expect(text).toContain("10:00");
  });

  it("maps availability context into template fields", () => {
    const mapped = toScenarioCalendarTemplateAvailability({
      calendarId: "primary",
      timeZone: "UTC",
      timeMin: "2026-07-13T00:00:00.000Z",
      timeMax: "2026-07-20T00:00:00.000Z",
      busySlotCount: 1,
      windows: [
        {
          start: "2026-07-13T10:00:00.000Z",
          end: "2026-07-13T10:30:00.000Z",
        },
      ],
      signature: "sig",
      promptBlock: "block",
    });
    expect(mapped.connected).toBe(true);
    expect(mapped.slotCount).toBe(1);
    expect(mapped.nextFreeSlot).toContain("10:00");
  });

  it("builds messaging-window countdown from last_inbound_at", () => {
    const now = new Date("2026-07-12T12:00:00.000Z");
    const lastInbound = new Date("2026-07-12T10:00:00.000Z");
    const countdown = buildMessagingWindowCountdownContext({
      lastInboundAt: lastInbound,
      language: "en",
      now,
    });
    expect(countdown.expired).toBe(false);
    expect(countdown.hours).toBe(22);
    expect(countdown.humanized).toBe("22 hours left");
  });

  it("marks countdown expired when the 24h window has passed", () => {
    const now = new Date("2026-07-14T12:00:00.000Z");
    const lastInbound = new Date("2026-07-12T10:00:00.000Z");
    const countdown = buildMessagingWindowCountdownContext({
      lastInboundAt: lastInbound,
      language: "en",
      now,
    });
    expect(countdown.expired).toBe(true);
    expect(countdown.humanized).toBe("expired");
  });
});

describe("applyScenarioReplyTemplate calendar + countdown", () => {
  it("renders countdown and calendar tokens", () => {
    const now = new Date("2026-07-12T12:00:00.000Z");
    const result = applyScenarioReplyTemplate({
      reply:
        "Hi {{first_name}}, next: {{calendar.next_free_slot}}. Window: {{countdown}}.",
      channel: "whatsapp",
      conversation: {
        _id: "conv_1",
        channel: "whatsapp",
        last_inbound_at: "2026-07-12T10:00:00.000Z",
        preferred_language: "en",
      } as unknown as Parameters<
        typeof applyScenarioReplyTemplate
      >[0]["conversation"],
      chatDocument: {
        first_name: "Ada",
      } as Parameters<typeof applyScenarioReplyTemplate>[0]["chatDocument"],
      calendarAvailability: {
        connected: true,
        nextFreeSlot: "Mon, Jul 13, 10:00 AM UTC",
        nextFreeSlotEnd: "",
        timeZone: "UTC",
        slotCount: 2,
      },
      now,
    });

    expect(result).toBe(
      "Hi Ada, next: Mon, Jul 13, 10:00 AM UTC. Window: 22 hours left."
    );
  });
});
