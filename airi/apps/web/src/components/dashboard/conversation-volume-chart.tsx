"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import type { ChartConfig } from "@/components/ui/chart";
import type {
  DailyCount,
  DashboardComparisonPeriod,
  DashboardTimeRange,
} from "@/types/dashboard";
import { useLocale, useTranslations } from "next-intl";
import { useId, useMemo } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { buildDashboardCountComparison } from "@/lib/dashboard-comparison";
import { createDashboardFormatters } from "./dashboard-formatters";
import {
  formatDashboardStatComparison,
  type DashboardTranslator,
} from "./dashboard-localization";

export type ConversationVolumeChartProps = {
  current: DailyCount[];
  previous: DailyCount[];
  comparisonPeriod: DashboardComparisonPeriod;
  comparisonEnabled: boolean;
  currentLabel: string;
  previousLabel: string;
};

type ConversationVolumeDatum = {
  ordinal: number;
  axisDate: string;
  currentDate?: string;
  current?: number;
  previousDate?: string;
  previous?: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const calendarDateFormatters = new Map<string, Intl.DateTimeFormat>();

function getCalendarDateFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = calendarDateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      calendar: "iso8601",
      numberingSystem: "latn",
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    calendarDateFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function formatCalendarDateKey(date: Date, timeZone: string): string | null {
  const parts = Object.fromEntries(
    getCalendarDateFormatter(timeZone)
      .formatToParts(date)
      .filter(part => part.type !== "literal")
      .map(part => [part.type, part.value])
  );
  if (!parts.year || !parts.month || !parts.day) return null;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function parseCalendarDateKey(value: string): number | null {
  const match = CALENDAR_DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
    ? timestamp
    : null;
}

function enumerateIntersectingCalendarDays(
  range: DashboardTimeRange,
  timeZone: string
): string[] {
  const start = new Date(range.start);
  const endExclusive = new Date(range.endExclusive);
  const startTimestamp = start.getTime();
  const endTimestamp = endExclusive.getTime();
  if (
    !Number.isFinite(startTimestamp) ||
    !Number.isFinite(endTimestamp) ||
    endTimestamp <= startTimestamp
  ) {
    return [];
  }

  const firstKey = formatCalendarDateKey(start, timeZone);
  const lastKey = formatCalendarDateKey(new Date(endTimestamp - 1), timeZone);
  const firstDay = firstKey ? parseCalendarDateKey(firstKey) : null;
  const lastDay = lastKey ? parseCalendarDateKey(lastKey) : null;
  if (firstDay === null || lastDay === null || lastDay < firstDay) return [];

  const length = Math.floor((lastDay - firstDay) / DAY_MS) + 1;
  return Array.from({ length }, (_, index) =>
    new Date(firstDay + index * DAY_MS).toISOString().slice(0, 10)
  );
}

function densifyDailyCounts(
  counts: DailyCount[],
  range: DashboardTimeRange,
  timeZone: string
): DailyCount[] {
  const totals = new Map<string, number>();
  for (const count of counts) {
    if (!CALENDAR_DATE_PATTERN.test(count.date)) continue;
    totals.set(count.date, (totals.get(count.date) ?? 0) + count.total);
  }

  return enumerateIntersectingCalendarDays(range, timeZone).map(date => ({
    date,
    total: totals.get(date) ?? 0,
  }));
}

export function ConversationVolumeChart({
  current,
  previous,
  comparisonPeriod,
  comparisonEnabled,
  currentLabel,
  previousLabel,
}: ConversationVolumeChartProps) {
  const locale = useLocale();
  const t = useTranslations("DashboardClientPage");
  const metricsT = useTranslations("SectionCards");
  const summaryId = useId();
  const titleId = useId();
  const formatters = createDashboardFormatters(locale);
  const timeZone = comparisonPeriod.timeZone;
  const currentStart = comparisonPeriod.current.start;
  const currentEndExclusive = comparisonPeriod.current.endExclusive;
  const previousStart = comparisonPeriod.previous?.start;
  const previousEndExclusive = comparisonPeriod.previous?.endExclusive;
  const showPrevious =
    comparisonEnabled &&
    previousStart !== undefined &&
    previousEndExclusive !== undefined;
  const currentDays = useMemo(
    () =>
      densifyDailyCounts(
        current,
        { start: currentStart, endExclusive: currentEndExclusive },
        timeZone
      ),
    [current, currentEndExclusive, currentStart, timeZone]
  );
  const previousDays = useMemo(
    () =>
      showPrevious && previousStart && previousEndExclusive
        ? densifyDailyCounts(
            previous,
            { start: previousStart, endExclusive: previousEndExclusive },
            timeZone
          )
        : [],
    [previous, previousEndExclusive, previousStart, showPrevious, timeZone]
  );
  const chartData = useMemo<ConversationVolumeDatum[]>(() => {
    const length = showPrevious
      ? Math.max(currentDays.length, previousDays.length)
      : currentDays.length;

    return Array.from({ length }, (_, index) => {
      const currentDay = currentDays[index];
      const previousDay = showPrevious ? previousDays[index] : undefined;

      return {
        ordinal: index + 1,
        axisDate: currentDay?.date ?? previousDay?.date ?? "",
        ...(currentDay
          ? {
              currentDate: currentDay.date,
              current: currentDay.total,
            }
          : {}),
        ...(previousDay
          ? {
              previousDate: previousDay.date,
              previous: previousDay.total,
            }
          : {}),
      };
    });
  }, [currentDays, previousDays, showPrevious]);
  const currentTotal = currentDays.reduce((total, day) => total + day.total, 0);
  const previousTotal = previousDays.reduce(
    (total, day) => total + day.total,
    0
  );
  const totalComparison = showPrevious
    ? formatDashboardStatComparison(
        "total",
        buildDashboardCountComparison(currentTotal, previousTotal),
        locale,
        metricsT as unknown as DashboardTranslator
      )
    : null;
  const chartConfig = {
    current: {
      label: currentLabel,
      color: "var(--chart-1)",
    },
    ...(showPrevious
      ? {
          previous: {
            label: previousLabel,
            color: "var(--muted-foreground)",
          },
        }
      : {}),
  } satisfies ChartConfig;

  if (current.length === 0) return null;

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle id={titleId}>{t("conversationVolume.title")}</CardTitle>
        <CardDescription>{t("conversationVolume.description")}</CardDescription>
      </CardHeader>
      <CardContent className="min-w-0">
        <p id={summaryId} className="sr-only">
          {`${currentLabel}: ${formatters.integer(currentTotal)}.${
            showPrevious
              ? ` ${previousLabel}: ${formatters.integer(previousTotal)}.`
              : ""
          }`}
        </p>
        {/* Visual twin of the summary above, which screen readers already get. */}
        <div
          aria-hidden="true"
          data-testid="conversation-volume-totals"
          className="mb-4 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1"
        >
          <span className="text-2xl font-semibold leading-tight tracking-tight tabular-nums">
            {formatters.integer(currentTotal)}
          </span>
          {totalComparison ? (
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground tabular-nums">
                {totalComparison.change}
              </span>
              <span className="tabular-nums">
                {t("comparison.previousValue", {
                  value: totalComparison.previous,
                })}
              </span>
            </span>
          ) : null}
        </div>
        <ChartContainer
          config={chartConfig}
          className="aspect-auto h-[250px] min-w-0 w-full"
          role="img"
          aria-labelledby={titleId}
          aria-describedby={summaryId}
        >
          <AreaChart
            data={chartData}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            accessibilityLayer
          >
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="axisDate"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={24}
              tickFormatter={value => formatters.shortDate(String(value))}
            />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  indicator="dot"
                  labelFormatter={(_label, payload) => {
                    const datum = payload[0]?.payload as
                      | ConversationVolumeDatum
                      | undefined;
                    const currentDate = datum?.currentDate
                      ? formatters.shortDate(datum.currentDate)
                      : null;
                    const previousDate = datum?.previousDate
                      ? formatters.shortDate(datum.previousDate)
                      : null;

                    if (currentDate && showPrevious && previousDate) {
                      return `${currentLabel}: ${currentDate} · ${previousLabel}: ${previousDate}`;
                    }
                    if (currentDate) return currentDate;
                    if (showPrevious && previousDate) {
                      return `${previousLabel}: ${previousDate}`;
                    }
                    return formatters.shortDate(datum?.axisDate);
                  }}
                  formatter={(value, name) => (
                    <div className="flex w-full items-center justify-between gap-3">
                      <span className="text-muted-foreground">
                        {name === "previous" ? previousLabel : currentLabel}
                      </span>
                      <span className="font-mono font-medium tabular-nums">
                        {formatters.integer(Number(value))}
                      </span>
                    </div>
                  )}
                />
              }
            />
            <ChartLegend content={<ChartLegendContent />} />
            <Area
              dataKey="current"
              type="natural"
              fill="var(--color-current)"
              fillOpacity={0.24}
              stroke="var(--color-current)"
            />
            {showPrevious ? (
              <Area
                dataKey="previous"
                type="natural"
                fill="var(--color-previous)"
                fillOpacity={0}
                stroke="var(--color-previous)"
                strokeDasharray="4 4"
              />
            ) : null}
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
