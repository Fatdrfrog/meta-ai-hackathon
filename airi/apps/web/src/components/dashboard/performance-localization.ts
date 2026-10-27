import { normalizeDashboardIntlLocale } from "./dashboard-localization";

export type PerformanceTranslator = (
  key: string,
  values?: Record<string, number | string>
) => string;

export function createPerformanceFormatters(
  locale: string,
  t: PerformanceTranslator
) {
  const numberFormatter = new Intl.NumberFormat(
    normalizeDashboardIntlLocale(locale),
    { maximumFractionDigits: 1 }
  );

  const normalizeZero = (value: number) => (Object.is(value, -0) ? 0 : value);
  const number = (value: number) =>
    numberFormatter.format(normalizeZero(value));

  return {
    number,
    signedNumber: (value: number) => {
      const normalizedValue = normalizeZero(value);
      return `${normalizedValue > 0 ? "+" : ""}${number(normalizedValue)}`;
    },
    percent: (value: number | null) =>
      value === null || !Number.isFinite(value)
        ? t("duration.missing")
        : t("units.percent", { value: number(value) }),
    scoreOutOfTen: (value: number) =>
      t("units.scoreOutOfTen", { value: number(value) }),
    scoreOutOfFive: (value: number) =>
      t("units.scoreOutOfFive", { value: number(value) }),
    duration: (seconds: number | null) => {
      if (seconds === null || !Number.isFinite(seconds)) {
        return t("duration.missing");
      }
      if (seconds < 60) {
        const count = Math.round(seconds);
        return t("duration.seconds", { count, value: number(count) });
      }
      if (seconds < 3_600) {
        const count = Number((seconds / 60).toFixed(1));
        return t("duration.minutes", { count, value: number(count) });
      }
      const count = Number((seconds / 3_600).toFixed(1));
      return t("duration.hours", { count, value: number(count) });
    },
  };
}

export type PerformanceFormatters = ReturnType<
  typeof createPerformanceFormatters
>;
