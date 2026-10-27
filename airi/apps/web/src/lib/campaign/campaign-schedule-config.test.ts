import {
  buildCampaignScheduleSummary,
  compileCampaignScheduleSpec,
  normalizeCampaignScheduleConfig,
  normalizeCampaignTimezone,
  parseCampaignScheduleConfigV2,
} from "./campaign-schedule-config";

describe("normalizeCampaignTimezone", () => {
  it.each([undefined, null, 42, "", "  ", "Not/A_Timezone", "UTC+25"])(
    "falls back to UTC for %s",
    timezone => {
      expect(normalizeCampaignTimezone(timezone)).toBe("UTC");
    }
  );

  it.each(["UTC", "Asia/Qyzylorda", "America/New_York", "US/Eastern"])(
    "preserves the supported identifier %s",
    timezone => {
      expect(normalizeCampaignTimezone(` ${timezone} `)).toBe(timezone);
    }
  );
});

describe("campaign schedule config", () => {
  it("normalizes legacy weekly nodes into v2 config", () => {
    expect(
      normalizeCampaignScheduleConfig({
        timezone: "Asia/Qyzylorda",
        legacy: {
          scheduleType: "weekly",
          day: "Monday",
          time: "15:30",
        },
      })
    ).toEqual({
      version: 2,
      mode: "recurring",
      timezone: "Asia/Qyzylorda",
      recurrence: {
        kind: "weekly",
        weekdays: ["monday"],
        time: "15:30",
      },
    });
  });

  it("preserves legacy relative polling cadence as a v2 interval", () => {
    expect(
      normalizeCampaignScheduleConfig({
        timezone: "UTC",
        legacy: {
          scheduleType: "relative",
          delayDays: 3,
        },
      })
    ).toEqual({
      version: 2,
      mode: "recurring",
      timezone: "UTC",
      recurrence: {
        kind: "interval",
        every: 5,
        unit: "minutes",
      },
    });
  });

  it("compiles every-24h intervals without cron", () => {
    const spec = compileCampaignScheduleSpec({
      version: 2,
      mode: "recurring",
      timezone: "UTC",
      recurrence: {
        kind: "interval",
        every: 24,
        unit: "hours",
      },
    });

    expect(spec).toMatchObject({
      intervals: [{ every: 24 * 60 * 60 * 1000 }],
      timezone: "UTC",
    });
    expect(spec).not.toHaveProperty("cronExpressions");
  });

  it("compiles weekly Monday 15:30 schedules", () => {
    expect(
      compileCampaignScheduleSpec({
        version: 2,
        mode: "recurring",
        timezone: "Asia/Qyzylorda",
        recurrence: {
          kind: "weekly",
          weekdays: ["monday"],
          time: "15:30",
        },
      })
    ).toMatchObject({
      calendars: [
        {
          dayOfWeek: ["MONDAY"],
          hour: 15,
          minute: 30,
          second: 0,
        },
      ],
      timezone: "Asia/Qyzylorda",
    });
  });

  it("compiles monthly day-of-month schedules", () => {
    expect(
      compileCampaignScheduleSpec({
        version: 2,
        mode: "recurring",
        timezone: "UTC",
        recurrence: {
          kind: "monthly_day",
          dayOfMonth: 15,
          time: "09:45",
        },
      })
    ).toMatchObject({
      calendars: [{ dayOfMonth: 15, hour: 9, minute: 45, second: 0 }],
      timezone: "UTC",
    });
  });

  it("compiles first Tuesday and last Monday schedules", () => {
    expect(
      compileCampaignScheduleSpec({
        version: 2,
        mode: "recurring",
        timezone: "UTC",
        recurrence: {
          kind: "monthly_weekday",
          ordinal: 1,
          weekday: "tuesday",
          time: "10:00",
        },
      })
    ).toMatchObject({
      calendars: [
        {
          dayOfMonth: { start: 1, end: 7 },
          dayOfWeek: "TUESDAY",
          hour: 10,
          minute: 0,
          second: 0,
        },
      ],
    });

    expect(
      compileCampaignScheduleSpec({
        version: 2,
        mode: "recurring",
        timezone: "UTC",
        recurrence: {
          kind: "monthly_weekday",
          ordinal: -1,
          weekday: "monday",
          time: "08:15",
        },
      })
    ).toMatchObject({
      calendars: [
        {
          dayOfMonth: { start: 22, end: 31 },
          dayOfWeek: "MONDAY",
          hour: 8,
          minute: 15,
          second: 0,
        },
      ],
    });
  });

  it("returns a readable schedule summary", () => {
    expect(
      buildCampaignScheduleSummary({
        version: 2,
        mode: "recurring",
        timezone: "Asia/Qyzylorda",
        recurrence: {
          kind: "monthly_weekday",
          ordinal: -1,
          weekday: "monday",
          time: "15:30",
        },
      })
    ).toBe("Every last Monday at 15:30 (Asia/Qyzylorda)");
  });
});

describe("parseCampaignScheduleConfigV2", () => {
  it.each([
    ["missing", undefined],
    ["legacy v1", { version: 1, mode: "recurring" }],
    ["unrecognized recurrence", { version: 2, mode: "recurring" }],
    ["array", [{ version: 2, mode: "once" }]],
  ])(
    "returns null for a %s config instead of the weekly fallback",
    (_label, config) => {
      expect(parseCampaignScheduleConfigV2(config, "UTC")).toBeNull();
    }
  );

  it("parses a v2 daily config with its own timezone", () => {
    expect(
      parseCampaignScheduleConfigV2(
        {
          version: 2,
          mode: "recurring",
          timezone: "Asia/Qyzylorda",
          recurrence: { kind: "daily", time: "09:30" },
        },
        "UTC"
      )
    ).toEqual({
      version: 2,
      mode: "recurring",
      timezone: "Asia/Qyzylorda",
      recurrence: { kind: "daily", time: "09:30" },
    });
  });
});
