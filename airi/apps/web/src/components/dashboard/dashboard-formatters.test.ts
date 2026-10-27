import { createDashboardFormatters } from "./dashboard-formatters";

function withIncompleteKazakhIntl(
  mode: "unsupported" | "generic-month",
  verify: (formatters: ReturnType<typeof createDashboardFormatters>) => void
) {
  const NativeDateTimeFormat = Intl.DateTimeFormat;
  const spy = jest
    .spyOn(Intl, "DateTimeFormat")
    .mockImplementation((locale, options) => {
      const isKazakh = typeof locale === "string" && locale.startsWith("kk");
      const formatter = new NativeDateTimeFormat(
        isKazakh && mode === "unsupported" ? "en-US" : locale,
        options
      );
      if (isKazakh && mode === "generic-month" && options?.month === "short") {
        const nativeParts = formatter.formatToParts.bind(formatter);
        formatter.formatToParts = date =>
          nativeParts(date).map(part =>
            part.type === "month" ? { ...part, value: "M09" } : part
          );
        Object.defineProperty(formatter, "format", {
          value: (date: Date) =>
            formatter
              .formatToParts(date)
              .map(part => part.value)
              .join(""),
        });
      }
      return formatter;
    });

  try {
    // Each simulation needs a fresh canonical formatter cache.
    jest.isolateModules(() => {
      const { createDashboardFormatters: createFreshFormatters } =
        jest.requireActual<typeof import("./dashboard-formatters")>(
          "./dashboard-formatters"
        );
      verify(createFreshFormatters("kz"));
    });
  } finally {
    spy.mockRestore();
  }
}

describe("createDashboardFormatters", () => {
  it("formats dashboard values with the active Russian locale", () => {
    const formatters = createDashboardFormatters("ru");

    expect(formatters.number(12_345.6)).toBe("12 345,6");
    expect(formatters.percent(12.6)).toBe("13 %");
    expect(formatters.currency(9.5, "KZT")).toBe("9,50 KZT");
    expect(formatters.shortDate("2026-07-31")).toBe("31 июл.");
  });

  it("maps the product Kazakh locale to kk-KZ at every Intl boundary", () => {
    const numberFormatSpy = jest.spyOn(Intl, "NumberFormat");
    const dateTimeFormatSpy = jest.spyOn(Intl, "DateTimeFormat");

    try {
      const formatters = createDashboardFormatters("kz");

      expect(formatters.number(4.5)).toBe("4,5");
      expect(formatters.percent(2.5, 1)).toBe("2,5%");
      expect(formatters.currency(9.5, "KZT")).toBe("9,50 ₸");
      expect(formatters.shortDate("2026-07-31")).toBe("31 шіл.");
      expect(numberFormatSpy).toHaveBeenCalledWith("kk-KZ", expect.any(Object));
      expect(dateTimeFormatSpy).toHaveBeenCalledWith(
        "kk-KZ",
        expect.any(Object)
      );
    } finally {
      numberFormatSpy.mockRestore();
      dateTimeFormatSpy.mockRestore();
    }
  });

  it("uses a stable missing-value marker for invalid values", () => {
    const formatters = createDashboardFormatters("en");

    expect(formatters.number(Number.NaN)).toBe("—");
    expect(formatters.percent(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatters.currency(null, "USD")).toBe("—");
    expect(formatters.shortDate("not-a-date")).toBe("—");
  });

  it("reuses Intl formatter instances for repeated locale and option sets", () => {
    const numberFormatSpy = jest.spyOn(Intl, "NumberFormat");
    const dateTimeFormatSpy = jest.spyOn(Intl, "DateTimeFormat");

    try {
      const first = createDashboardFormatters("de-DE");
      first.percent(12.5, 1);
      first.currency(9.5, "EUR");
      first.currency(9.5, null);

      const numberFormatterCount = numberFormatSpy.mock.calls.length;
      const dateFormatterCount = dateTimeFormatSpy.mock.calls.length;

      const second = createDashboardFormatters("de-DE");
      second.percent(25, 1);
      second.currency(8.5, "EUR");
      second.currency(8.5, null);

      expect(numberFormatSpy).toHaveBeenCalledTimes(numberFormatterCount);
      expect(dateTimeFormatSpy).toHaveBeenCalledTimes(dateFormatterCount);
    } finally {
      numberFormatSpy.mockRestore();
      dateTimeFormatSpy.mockRestore();
    }
  });

  it("formats signed integers and nullable percentage changes", () => {
    const formatters = createDashboardFormatters("en");

    expect(formatters.signedInteger(1_234)).toBe("+1,234");
    expect(formatters.signedInteger(-250)).toBe("-250");
    expect(formatters.signedInteger(0)).toBe("0");
    expect(formatters.signedPercent(25.5, 1)).toBe("+25.5%");
    expect(formatters.signedPercent(-100)).toBe("-100%");
    expect(formatters.signedPercent(null)).toBe("—");
  });

  it("formats exact inclusive labels from normalized half-open ranges", () => {
    const formatters = createDashboardFormatters("en");

    expect(
      formatters.dateRange(
        {
          start: "2026-07-25T00:00:00.000Z",
          endExclusive: "2026-08-01T00:00:00.000Z",
        },
        "UTC"
      )
    ).toBe("Jul 25, 2026 – Jul 31, 2026");
  });

  it("includes exact localized times for a rolling 30-day noon window", () => {
    const formatters = createDashboardFormatters("en");

    expect(
      formatters.dateRange(
        {
          start: "2026-07-06T07:00:00.000Z",
          endExclusive: "2026-08-05T07:00:00.000Z",
        },
        "Asia/Qyzylorda"
      )
    ).toBe("Jul 6, 2026, 12:00 PM – Aug 5, 2026, 12:00 PM");
  });

  it("keeps local-midnight calendar ranges concise in their dashboard timezone", () => {
    const formatters = createDashboardFormatters("en");

    expect(
      formatters.dateRange(
        {
          start: "2026-04-30T19:00:00.000Z",
          endExclusive: "2026-05-07T19:00:00.000Z",
        },
        "Asia/Qyzylorda"
      )
    ).toBe("May 1, 2026 – May 7, 2026");
  });

  it("reuses signed and time-zone-specific Intl formatters", () => {
    const numberFormatSpy = jest.spyOn(Intl, "NumberFormat");
    const dateTimeFormatSpy = jest.spyOn(Intl, "DateTimeFormat");

    try {
      const formatters = createDashboardFormatters("en-GB");
      formatters.signedInteger(1);
      formatters.signedPercent(10, 1);
      formatters.dateRange(
        {
          start: "2026-07-25T12:00:00.000Z",
          endExclusive: "2026-08-01T12:00:00.000Z",
        },
        "UTC"
      );

      const numberFormatterCount = numberFormatSpy.mock.calls.length;
      const dateFormatterCount = dateTimeFormatSpy.mock.calls.length;

      formatters.signedInteger(2);
      formatters.signedPercent(20, 1);
      formatters.dateRange(
        {
          start: "2026-08-01T12:00:00.000Z",
          endExclusive: "2026-08-08T12:00:00.000Z",
        },
        "UTC"
      );

      expect(numberFormatSpy).toHaveBeenCalledTimes(numberFormatterCount);
      expect(dateTimeFormatSpy).toHaveBeenCalledTimes(dateFormatterCount);
    } finally {
      numberFormatSpy.mockRestore();
      dateTimeFormatSpy.mockRestore();
    }
  });

  it.each(["unsupported", "generic-month"] as const)(
    "localizes Kazakh dates when browser Intl has %s locale data",
    mode => {
      withIncompleteKazakhIntl(mode, formatters => {
        expect(formatters.shortDate("2026-09-01")).toBe("1 қыр.");
        expect(
          formatters.dateRange(
            {
              start: "2026-09-01T00:00:00.000Z",
              endExclusive: "2026-10-01T00:00:00.000Z",
            },
            "Asia/Qyzylorda"
          )
        ).toBe("2026 ж. 1 қыр., 5:00 – 2026 ж. 1 қаз., 5:00");
        expect(
          formatters.dateRange(
            {
              start: "2026-08-31T19:00:00.000Z",
              endExclusive: "2026-09-30T19:00:00.000Z",
            },
            "Asia/Qyzylorda"
          )
        ).toBe("2026 ж. 1 қыр. – 2026 ж. 30 қыр.");
      });
    }
  );

  it("retains missing values and exact exclusive times in the Kazakh fallback", () => {
    withIncompleteKazakhIntl("unsupported", formatters => {
      expect(formatters.shortDate("invalid")).toBe("—");
      const range = {
        start: "2026-09-01T00:00:00.000Z",
        endExclusive: "2026-10-01T00:00:00.000Z",
      };
      expect(formatters.dateRange(range, "invalid/timezone")).toBe("—");
      expect(formatters.dateRange({ ...range, start: "invalid" }, "UTC")).toBe(
        "—"
      );
      expect(
        formatters.dateRange({ ...range, endExclusive: range.start }, "UTC")
      ).toBe("—");
      expect(
        formatters.dateRange(
          { ...range, endExclusive: "2026-10-01T00:00:00.001Z" },
          "UTC"
        )
      ).toBe("2026 ж. 1 қыр., 0:00 – 2026 ж. 1 қаз., 0:00");
    });
  });
});
