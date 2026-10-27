import { buildBirthdayCampaignOccurrence } from "./campaign-birthday-occurrence";

describe("birthday campaign occurrence identity", () => {
  it("uses one local calendar date regardless of the scheduled time", () => {
    const first = buildBirthdayCampaignOccurrence({
      date: new Date("2026-04-17T04:00:00.000Z"),
      timezone: "Asia/Almaty",
    });
    const second = buildBirthdayCampaignOccurrence({
      date: new Date("2026-04-17T05:00:00.000Z"),
      timezone: "Asia/Almaty",
    });
    expect(first).toEqual(second);
    expect(first).toEqual({
      runKey: "birthday:2026-04-17",
      start: "2026-04-16T19:00:00.000Z",
      end: "2026-04-17T19:00:00.000Z",
    });
  });

  it.each([
    [
      "2026-03-08T15:00:00.000Z",
      "America/New_York",
      "birthday:2026-03-08",
      "2026-03-08T05:00:00.000Z",
      "2026-03-09T04:00:00.000Z",
    ],
    [
      "2026-11-01T15:00:00.000Z",
      "America/New_York",
      "birthday:2026-11-01",
      "2026-11-01T04:00:00.000Z",
      "2026-11-02T05:00:00.000Z",
    ],
    [
      "2026-12-31T22:00:00.000Z",
      "Asia/Almaty",
      "birthday:2027-01-01",
      "2026-12-31T19:00:00.000Z",
      "2027-01-01T19:00:00.000Z",
    ],
    [
      "2028-02-29T09:00:00.000Z",
      "UTC",
      "birthday:2028-02-29",
      "2028-02-29T00:00:00.000Z",
      "2028-03-01T00:00:00.000Z",
    ],
    [
      "2027-02-28T09:00:00.000Z",
      "UTC",
      "birthday:2027-02-28",
      "2027-02-28T00:00:00.000Z",
      "2027-03-01T00:00:00.000Z",
    ],
  ])(
    "preserves local dates and real UTC day bounds for %s in %s",
    (date, timezone, runKey, start, end) => {
      expect(
        buildBirthdayCampaignOccurrence({ date: new Date(date), timezone })
      ).toEqual({ runKey, start, end });
    }
  );

  it("distinguishes the next year's birthday", () => {
    expect(
      buildBirthdayCampaignOccurrence({
        date: new Date("2027-04-17T09:00:00Z"),
        timezone: "UTC",
      }).runKey
    ).not.toBe(
      buildBirthdayCampaignOccurrence({
        date: new Date("2026-04-17T09:00:00Z"),
        timezone: "UTC",
      }).runKey
    );
  });
});
