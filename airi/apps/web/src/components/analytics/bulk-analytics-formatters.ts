"use client";

import { useLocale, useTranslations } from "next-intl";
import { useMemo } from "react";

export function useBulkAnalyticsFormatters() {
  const locale = useLocale();
  const t = useTranslations("BulkAnalytics");
  const intlLocale = locale === "kz" ? "kk-KZ" : locale;

  return useMemo(() => {
    const integerFormatter = new Intl.NumberFormat(intlLocale);
    const decimalFormatter = new Intl.NumberFormat(intlLocale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    const percentFormatter = new Intl.NumberFormat(intlLocale, {
      style: "percent",
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    const currencyFormatter = new Intl.NumberFormat(intlLocale, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
    const dateTimeFormatter = new Intl.DateTimeFormat(intlLocale, {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const dateFormatter = new Intl.DateTimeFormat(intlLocale, {
      month: "short",
      day: "2-digit",
    });
    const datePickerFormatter = new Intl.DateTimeFormat(intlLocale, {
      month: "short",
      day: "2-digit",
      year: "numeric",
    });

    const formatInteger = (value: number | null | undefined): string =>
      integerFormatter.format(Math.max(0, Number(value || 0)));
    const formatPercent = (value: number | null | undefined): string =>
      percentFormatter.format(Number(value || 0) || 0);
    const formatUsd = (value: number | null | undefined): string =>
      typeof value === "number" && Number.isFinite(value)
        ? currencyFormatter.format(value)
        : t("units.notAvailable");
    const formatMinutes = (value: number | null | undefined): string => {
      if (value === null || value === undefined || !Number.isFinite(value)) {
        return t("units.notAvailable");
      }
      if (value < 1) return t("units.lessThanMinute");
      if (value < 60) return t("units.minutes", { count: Math.round(value) });
      return t("units.hours", { count: Number((value / 60).toFixed(1)) });
    };
    const formatDateTime = (value: string | null | undefined): string => {
      if (!value) return t("units.notAvailable");
      const date = new Date(value);
      return Number.isFinite(date.getTime())
        ? dateTimeFormatter.format(date)
        : t("units.notAvailable");
    };
    const formatDate = (value: string | null | undefined): string => {
      if (!value) return t("units.notAvailable");
      const date = new Date(value);
      return Number.isFinite(date.getTime())
        ? dateFormatter.format(date)
        : value;
    };
    const formatScore = (value: number | null | undefined): string => {
      if (value === null || value === undefined || !Number.isFinite(value)) {
        return t("units.notAvailable");
      }
      return integerFormatter.format(Math.round(value));
    };
    const formatDailyLabel = (value: string): string => {
      const [year, month, day] = value.split("-").map(part => Number(part));
      if (!year || !month || !day) return value;
      return dateFormatter.format(new Date(year, month - 1, day));
    };
    const formatDatePickerLabel = (
      fromDate: Date | undefined,
      toDate: Date | undefined
    ): string => {
      if (fromDate && toDate) {
        return `${datePickerFormatter.format(fromDate)} - ${datePickerFormatter.format(toDate)}`;
      }
      if (fromDate) {
        return t("period.pickEnd", {
          from: datePickerFormatter.format(fromDate),
        });
      }
      return t("period.pickDateRange");
    };
    const formatSignedDelta = (
      current: number | null | undefined,
      previous: number | null | undefined,
      options: { percent?: boolean; currency?: boolean } = {}
    ): string | null => {
      if (
        typeof current !== "number" ||
        typeof previous !== "number" ||
        !Number.isFinite(current) ||
        !Number.isFinite(previous)
      ) {
        return null;
      }
      const rawDelta = current - previous;
      const delta = Math.abs(rawDelta) < 1e-9 ? 0 : rawDelta;
      const sign = delta > 0 ? "+" : "";
      if (options.percent) {
        return t("units.percentagePoints", {
          value: `${sign}${decimalFormatter.format(delta * 100)}`,
        });
      }
      if (options.currency) return `${sign}${formatUsd(delta)}`;
      return `${sign}${integerFormatter.format(delta)}`;
    };
    const formatWindow = (
      start: string | null | undefined,
      end: string | null | undefined
    ): string => `${formatDateTime(start)} - ${formatDateTime(end)}`;

    return {
      formatDate,
      formatDatePickerLabel,
      formatDateTime,
      formatDailyLabel,
      formatInteger,
      formatMinutes,
      formatPercent,
      formatScore,
      formatSignedDelta,
      formatUsd,
      formatWindow,
    };
  }, [intlLocale, t]);
}
