import {
  combineTimeoutMinutes,
  formatNoReplyDuration,
  isNoReplyTimeoutUnit,
  maxAmountForUnit,
  splitTimeoutMinutes,
} from "./no-reply-timeout";

describe("formatNoReplyDuration", () => {
  // Mirrors the en catalog value of noReplyDuration.
  const t = jest.fn(
    (key: string, values?: Record<string, string | number | Date>) => {
      const count = Number(values?.count);
      switch (values?.unit) {
        case "minutes":
          return `${count} min`;
        case "hours":
          return `${count} h`;
        default:
          return count === 1 ? `${count} day` : `${count} days`;
      }
    }
  );

  beforeEach(() => t.mockClear());

  it.each([
    [30, "minutes", 30, "30 min"],
    [120, "hours", 2, "2 h"],
    [1440, "days", 1, "1 day"],
    [4320, "days", 3, "3 days"],
    [90, "minutes", 90, "90 min"],
  ])(
    "formats %i minutes in its largest whole unit",
    (minutes, unit, count, expected) => {
      expect(formatNoReplyDuration(minutes, t)).toBe(expected);
      expect(t).toHaveBeenCalledWith("noReplyDuration", { unit, count });
    }
  );

  it("never formats less than one minute", () => {
    expect(formatNoReplyDuration(0, t)).toBe("1 min");
  });
});

describe("no-reply timeout units", () => {
  it("prefers days, then hours, then minutes", () => {
    expect(splitTimeoutMinutes(1440)).toEqual({ amount: 1, unit: "days" });
    expect(splitTimeoutMinutes(120)).toEqual({ amount: 2, unit: "hours" });
    expect(splitTimeoutMinutes(30)).toEqual({ amount: 30, unit: "minutes" });
  });

  it("uses a preferred unit only when it divides the value exactly", () => {
    expect(splitTimeoutMinutes(1440, "hours")).toEqual({
      amount: 24,
      unit: "hours",
    });
    expect(splitTimeoutMinutes(1440, "minutes")).toEqual({
      amount: 1440,
      unit: "minutes",
    });
    expect(splitTimeoutMinutes(90, "hours")).toEqual({
      amount: 90,
      unit: "minutes",
    });
    expect(splitTimeoutMinutes(120, "days")).toEqual({
      amount: 2,
      unit: "hours",
    });
  });

  it("keeps the typed amount when converting units", () => {
    expect(combineTimeoutMinutes(30, "hours", 525_600)).toBe(1800);
    expect(combineTimeoutMinutes(2, "days", 525_600)).toBe(2880);
    expect(combineTimeoutMinutes(0, "minutes", 525_600)).toBe(1);
  });

  it("clamps to the stored minute ceiling", () => {
    expect(combineTimeoutMinutes(999, "days", 100)).toBe(100);
    expect(maxAmountForUnit("hours", 180)).toBe(3);
  });

  it("guards the unit union", () => {
    expect(isNoReplyTimeoutUnit("hours")).toBe(true);
    expect(isNoReplyTimeoutUnit("weeks")).toBe(false);
    expect(isNoReplyTimeoutUnit("toString")).toBe(false);
    expect(isNoReplyTimeoutUnit("__proto__")).toBe(false);
  });
});
