"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { CalendarClock, Cake } from "lucide-react";

export type BirthdayCampaignPreview = {
  total?: number;
  eligibleTotal?: number;
  marketingOptInWarningCount?: number;
  birthdayAudience?: {
    storedTotal?: number;
    scanCapped?: boolean;
  };
};

export type BirthdayCampaignControlLabels = {
  regular: string;
  birthdays: string;
  time: string;
  timezone: string;
  stored?: string;
  eligibleToday?: string;
  skippedOptIn?: string;
  disabledReason?: string;
};

export type BirthdayCampaignControlMetric = {
  label: string;
  value: string | number;
};

type BirthdayCampaignControlProps = {
  enabled: boolean;
  disabled?: boolean;
  onEnabledChange: (enabled: boolean) => void;
  time: string;
  timezone: string;
  onTimeChange: (time: string) => void;
  onTimezoneChange: (timezone: string) => void;
  onTimeBlur?: () => void;
  onTimezoneBlur?: () => void;
  preview?: BirthdayCampaignPreview | null;
  previewLoading?: boolean;
  metrics?: BirthdayCampaignControlMetric[];
  labels: BirthdayCampaignControlLabels;
  className?: string;
};

function formatNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString()
    : "0";
}

export function BirthdayCampaignControl({
  enabled,
  disabled,
  onEnabledChange,
  time,
  timezone,
  onTimeChange,
  onTimezoneChange,
  onTimeBlur,
  onTimezoneBlur,
  preview,
  previewLoading,
  metrics,
  labels,
  className,
}: BirthdayCampaignControlProps) {
  const displayedMetrics =
    metrics && metrics.length > 0
      ? metrics
      : labels.stored && labels.eligibleToday && labels.skippedOptIn
        ? [
            {
              label: labels.stored,
              value: formatNumber(preview?.birthdayAudience?.storedTotal),
            },
            {
              label: labels.eligibleToday,
              value: formatNumber(preview?.eligibleTotal),
            },
            {
              label: labels.skippedOptIn,
              value: formatNumber(preview?.marketingOptInWarningCount),
            },
          ]
        : [];

  return (
    <div
      className={cn("space-y-2 rounded-md border bg-muted/10 p-2", className)}
    >
      <div className="grid grid-cols-2 gap-1">
        <Button
          type="button"
          size="sm"
          variant={!enabled ? "default" : "outline"}
          aria-pressed={!enabled}
          className="h-7 justify-start px-2 text-[11px]"
          onClick={() => onEnabledChange(false)}
        >
          {labels.regular}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={enabled ? "default" : "outline"}
          aria-pressed={enabled}
          disabled={disabled}
          className="h-7 justify-start px-2 text-[11px]"
          onClick={() => onEnabledChange(true)}
        >
          <Cake className="mr-1.5 h-3.5 w-3.5" />
          {labels.birthdays}
        </Button>
      </div>

      {disabled && labels.disabledReason ? (
        <div className="text-[11px] leading-snug text-muted-foreground">
          {labels.disabledReason}
        </div>
      ) : null}

      {enabled ? (
        <div className="space-y-2">
          <div className="grid grid-cols-[96px_1fr] gap-2">
            <label className="space-y-1">
              <span className="flex items-center gap-1 text-[10px] uppercase text-muted-foreground">
                <CalendarClock className="h-3 w-3" />
                {labels.time}
              </span>
              <Input
                type="time"
                value={time}
                onChange={event => onTimeChange(event.target.value)}
                onBlur={onTimeBlur}
                className="h-8 text-xs"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[10px] uppercase text-muted-foreground">
                {labels.timezone}
              </span>
              <Input
                value={timezone}
                onChange={event => onTimezoneChange(event.target.value)}
                onBlur={onTimezoneBlur}
                className="h-8 text-xs"
              />
            </label>
          </div>

          {displayedMetrics.length > 0 ? (
            <div className="grid grid-cols-3 gap-1 text-[10px]">
              {displayedMetrics.map(metric => (
                <div
                  key={metric.label}
                  className="rounded bg-background px-1.5 py-1"
                >
                  <div className="truncate text-muted-foreground">
                    {metric.label}
                  </div>
                  <div className="font-medium">
                    {previewLoading && !metrics ? "..." : metric.value}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
