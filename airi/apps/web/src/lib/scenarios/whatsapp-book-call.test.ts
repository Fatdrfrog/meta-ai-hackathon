import {
  buildWhatsAppBookCallDateRange,
  buildWhatsAppBookCallChoices,
  normalizeWhatsAppBookCallConfig,
} from "./whatsapp-book-call";
import {
  buildWhatsAppBookCallPayload,
  parseWhatsAppBookCallPayload,
} from "@icecore/scenario-contracts";

describe("WhatsApp book-call slot choices", () => {
  it("normalizes slot count and date range presets", () => {
    expect(
      normalizeWhatsAppBookCallConfig({
        enabled: true,
        dateRangeMode: "tomorrow",
        horizonDays: 99,
        maxSlots: 99,
        timeZone: "UTC",
      })
    ).toMatchObject({
      dateRangeMode: "tomorrow",
      horizonDays: 1,
      maxSlots: 10,
      timeZone: "UTC",
    });

    expect(
      normalizeWhatsAppBookCallConfig({
        enabled: true,
        dateRangeMode: "custom_days",
        horizonDays: 14,
      })
    ).toMatchObject({
      dateRangeMode: "custom_days",
      horizonDays: 14,
    });
  });

  it("builds today and tomorrow availability ranges from the selected date preset", () => {
    const now = new Date("2026-06-11T09:00:00.000Z");

    expect(
      buildWhatsAppBookCallDateRange({
        config: normalizeWhatsAppBookCallConfig({
          enabled: true,
          dateRangeMode: "today",
          minNoticeMinutes: 120,
          timeZone: "UTC",
        })!,
        now,
      })
    ).toEqual({
      rangeStart: new Date("2026-06-11T11:00:00.000Z"),
      rangeEnd: new Date("2026-06-12T00:00:00.000Z"),
    });

    expect(
      buildWhatsAppBookCallDateRange({
        config: normalizeWhatsAppBookCallConfig({
          enabled: true,
          dateRangeMode: "tomorrow",
          minNoticeMinutes: 120,
          timeZone: "UTC",
        })!,
        now,
      })
    ).toEqual({
      rangeStart: new Date("2026-06-12T00:00:00.000Z"),
      rangeEnd: new Date("2026-06-13T00:00:00.000Z"),
    });
  });

  it("builds compact WhatsApp choices from Calendar windows", () => {
    const choices = buildWhatsAppBookCallChoices({
      actionNodeId: "action-1",
      timeZone: "UTC",
      durationMinutes: 30,
      maxSlots: 3,
      windows: [
        {
          start: "2026-06-11T09:00:00.000Z",
          end: "2026-06-11T10:30:00.000Z",
        },
      ],
    });

    expect(choices).toEqual([
      {
        id: "slot-0",
        text: "Jun 11 09:00",
        payload: "wbc:action-1:1781168400000:1781170200000",
        description: "09:00-09:30 UTC",
      },
      {
        id: "slot-1",
        text: "Jun 11 09:30",
        payload: "wbc:action-1:1781170200000:1781172000000",
        description: "09:30-10:00 UTC",
      },
      {
        id: "slot-2",
        text: "Jun 11 10:00",
        payload: "wbc:action-1:1781172000000:1781173800000",
        description: "10:00-10:30 UTC",
      },
    ]);
  });

  it("caps dynamic choices to the WhatsApp session choice limit", () => {
    const choices = buildWhatsAppBookCallChoices({
      actionNodeId: "action-1",
      timeZone: "UTC",
      durationMinutes: 15,
      maxSlots: 99,
      windows: [
        {
          start: "2026-06-11T09:00:00.000Z",
          end: "2026-06-11T15:00:00.000Z",
        },
      ],
    });

    expect(choices).toHaveLength(10);
  });

  it("round-trips booking payloads", () => {
    const payload = buildWhatsAppBookCallPayload({
      actionNodeId: "action-1",
      startMs: 1781168400000,
      endMs: 1781170200000,
    });

    expect(parseWhatsAppBookCallPayload(payload)).toEqual({
      actionNodeId: "action-1",
      startMs: 1781168400000,
      endMs: 1781170200000,
    });
    expect(parseWhatsAppBookCallPayload("wsc:action-1:choice-1")).toBeNull();
  });
});
