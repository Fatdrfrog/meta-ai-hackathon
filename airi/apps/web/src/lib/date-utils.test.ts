import {
  formatCompactRelativeTime,
  formatConversationDate,
  formatDateOrTime,
  formatWhatsAppDisplayId,
} from "./date-utils";

describe("formatConversationDate", () => {
  it("keeps the year and writes Kazakh dates as numbers", () => {
    const date = new Date(2025, 2, 7, 12, 0);
    expect(formatConversationDate(date, "en")).toBe("Mar 7, 2025");
    expect(formatConversationDate(date, "kz")).toBe("07.03.2025");
  });
});

describe("formatDateOrTime", () => {
  it("uses the provided reference date for hydration-stable today labels", () => {
    expect(
      formatDateOrTime("2026-01-10T08:15:00", "en", "2026-01-10T12:00:00")
    ).toBe("08:15 AM");
  });

  it("uses the provided reference date for hydration-stable yesterday labels", () => {
    expect(
      formatDateOrTime("2026-01-09T10:15:00", "en", "2026-01-10T12:00:00")
    ).toBe("Yesterday");
  });

  it("takes the yesterday label from the caller and writes Kazakh dates as day.month", () => {
    const referenceAt = "2026-10-20T12:00:00Z";
    expect(
      formatDateOrTime("2026-10-19T10:00:00Z", "kz", referenceAt, "UTC", "Кеше")
    ).toBe("Кеше");
    expect(
      formatDateOrTime("2026-10-17T22:00:00Z", "kz", referenceAt, "Asia/Almaty")
    ).toBe("18.10");
    expect(
      formatDateOrTime("2026-10-17T10:00:00Z", "ru", referenceAt, "UTC")
    ).toBe("17 окт.");
  });

  it("uses the provided time zone for hydration-stable calendar labels", () => {
    const messageAt = "2026-06-25T00:30:00.000Z";
    const referenceAt = "2026-06-25T23:00:00.000Z";

    expect(formatDateOrTime(messageAt, "en", referenceAt, "UTC")).toBe(
      "12:30 AM"
    );
    expect(
      formatDateOrTime(messageAt, "en", referenceAt, "America/Los_Angeles")
    ).toBe("Yesterday");
  });
});

describe("formatCompactRelativeTime", () => {
  const now = "2026-06-11T12:00:00.000Z";

  it("formats recent chat timestamps as compact backward time", () => {
    expect(formatCompactRelativeTime("2026-06-11T11:59:20.000Z", now)).toBe(
      "now"
    );
    expect(formatCompactRelativeTime("2026-06-11T11:55:00.000Z", now)).toBe(
      "5m"
    );
    expect(formatCompactRelativeTime("2026-06-11T06:00:00.000Z", now)).toBe(
      "6h"
    );
    expect(formatCompactRelativeTime("2026-06-09T12:00:00.000Z", now)).toBe(
      "2d"
    );
    expect(formatCompactRelativeTime("2026-05-28T12:00:00.000Z", now)).toBe(
      "2w"
    );
    expect(formatCompactRelativeTime("2026-01-11T12:00:00.000Z", now)).toBe(
      "5mo"
    );
  });
});

describe("formatWhatsAppDisplayId", () => {
  it("strips the wa_ prefix used on WhatsApp chat identifiers", () => {
    expect(formatWhatsAppDisplayId("wa_77001234567")).toBe("77001234567");
  });

  it("strips wa_bsuid_ before the generic wa_ prefix", () => {
    expect(formatWhatsAppDisplayId("wa_bsuid_abc123")).toBe("abc123");
  });

  it("leaves other identifiers unchanged", () => {
    expect(formatWhatsAppDisplayId("77001234567")).toBe("77001234567");
    expect(formatWhatsAppDisplayId(undefined)).toBeUndefined();
  });
});
