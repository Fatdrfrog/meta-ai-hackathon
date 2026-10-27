"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { ConversationActivityByTime } from "@/types/dashboard";

import { useTranslations } from "next-intl";
import { useMemo } from "react";

const DISPLAY_DAYS = [2, 3, 4, 5, 6, 7, 1] as const;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const LEGEND_STEPS = [0.18, 0.34, 0.52, 0.7, 0.9];

const DAY_LABEL_KEYS: Record<number, string> = {
  1: "conversationActivityDaySun",
  2: "conversationActivityDayMon",
  3: "conversationActivityDayTue",
  4: "conversationActivityDayWed",
  5: "conversationActivityDayThu",
  6: "conversationActivityDayFri",
  7: "conversationActivityDaySat",
};

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function formatHourRange(hour: number): string {
  return `${formatHour(hour)}-${formatHour((hour + 1) % 24)}`;
}

function getCellKey(dayOfWeek: number, hour: number): string {
  return `${dayOfWeek}:${hour}`;
}

function getActivityColor(count: number, maxCount: number): string | undefined {
  if (count <= 0 || maxCount <= 0) return undefined;
  const intensity = Math.min(count / maxCount, 1);
  const alpha = 0.18 + intensity * 0.72;
  return `rgba(16, 185, 129, ${alpha.toFixed(2)})`;
}

export function ConversationActivityHeatmap({
  data,
  timeZone,
}: {
  data: ConversationActivityByTime[];
  timeZone: string;
}) {
  const t = useTranslations("DashboardClientPage");

  const { countBySlot, maxCount, totalCount, peak } = useMemo(() => {
    const countBySlot = new Map<string, number>();
    let maxCount = 0;
    let totalCount = 0;
    let peak: ConversationActivityByTime | null = null;

    for (const row of data || []) {
      if (
        !Number.isInteger(row.dayOfWeek) ||
        row.dayOfWeek < 1 ||
        row.dayOfWeek > 7 ||
        !Number.isInteger(row.hour) ||
        row.hour < 0 ||
        row.hour > 23 ||
        !Number.isFinite(row.count) ||
        row.count <= 0
      ) {
        continue;
      }

      const key = getCellKey(row.dayOfWeek, row.hour);
      const nextCount = (countBySlot.get(key) ?? 0) + row.count;
      countBySlot.set(key, nextCount);
      totalCount += row.count;

      if (nextCount > maxCount) {
        maxCount = nextCount;
        peak = {
          dayOfWeek: row.dayOfWeek,
          hour: row.hour,
          count: nextCount,
        };
      }
    }

    return { countBySlot, maxCount, totalCount, peak };
  }, [data]);

  const dayLabel = (dayOfWeek: number) =>
    t(DAY_LABEL_KEYS[dayOfWeek] || "conversationActivityDaySun");

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          {t("conversationActivityTitle")}
        </CardTitle>
        <CardDescription>
          {t("conversationActivityDescription", { timeZone })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {totalCount > 0 && peak ? (
          <div className="flex flex-col gap-2 rounded-lg bg-muted/25 px-3 py-2 text-sm shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <div>
              <span className="text-muted-foreground">
                {t("conversationActivityPeakLabel")}
              </span>{" "}
              <span className="font-medium">
                {t("conversationActivityPeakValue", {
                  day: dayLabel(peak.dayOfWeek),
                  hour: formatHourRange(peak.hour),
                  count: peak.count,
                })}
              </span>
            </div>
            <div className="font-mono text-xs text-muted-foreground">
              {t("conversationActivityTotal", { count: totalCount })}
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground shadow-none">
            {t("conversationActivityEmpty")}
          </div>
        )}

        <div className="-mx-2 overflow-x-auto px-2 pb-1">
          <div
            className="min-w-[760px] space-y-2"
            role="grid"
            aria-label={t("conversationActivityGridLabel")}
          >
            <div className="grid grid-cols-[4.5rem_repeat(24,minmax(0,1fr))] gap-1 text-[10px] font-medium text-muted-foreground">
              <div />
              {HOURS.map(hour => (
                <div key={hour} className="text-center tabular-nums">
                  {hour % 3 === 0 ? String(hour).padStart(2, "0") : ""}
                </div>
              ))}
            </div>

            {DISPLAY_DAYS.map(dayOfWeek => (
              <div
                key={dayOfWeek}
                className="grid grid-cols-[4.5rem_repeat(24,minmax(0,1fr))] items-center gap-1"
                role="row"
              >
                <div
                  className="truncate pr-2 text-right text-xs font-medium text-muted-foreground"
                  role="rowheader"
                  title={dayLabel(dayOfWeek)}
                >
                  {dayLabel(dayOfWeek)}
                </div>
                {HOURS.map(hour => {
                  const count =
                    countBySlot.get(getCellKey(dayOfWeek, hour)) ?? 0;
                  const label = t("conversationActivityCellLabel", {
                    day: dayLabel(dayOfWeek),
                    hour: formatHourRange(hour),
                    count,
                  });

                  return (
                    <div
                      key={hour}
                      aria-label={label}
                      className="h-5 rounded-[3px] border border-border/40 bg-muted/45 transition-colors hover:ring-1 hover:ring-primary/60"
                      role="gridcell"
                      style={{
                        backgroundColor: getActivityColor(count, maxCount),
                      }}
                      title={label}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <span>{t("conversationActivityLegendLow")}</span>
          <div className="flex gap-1" aria-hidden="true">
            {LEGEND_STEPS.map(alpha => (
              <span
                key={alpha}
                className="h-3 w-5 rounded-[3px] border border-border/40"
                style={{ backgroundColor: `rgba(16, 185, 129, ${alpha})` }}
              />
            ))}
          </div>
          <span>{t("conversationActivityLegendHigh")}</span>
        </div>
      </CardContent>
    </Card>
  );
}
