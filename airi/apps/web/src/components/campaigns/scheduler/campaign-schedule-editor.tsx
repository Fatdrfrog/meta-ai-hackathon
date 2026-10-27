"use client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  buildCampaignScheduleSummary,
  normalizeCampaignScheduleConfig,
} from "@/lib/campaign/campaign-schedule-config";
import type {
  CampaignScheduleConfig,
  CampaignScheduleOrdinal,
  CampaignScheduleRecurrence,
  CampaignScheduleWeekday,
} from "@icecore/scenario-contracts";
import { CalendarClock } from "lucide-react";
import { useTranslations } from "next-intl";

type CampaignScheduleMode = CampaignScheduleConfig["mode"];
type RecurringCampaignScheduleConfig = Extract<
  CampaignScheduleConfig,
  { mode: "recurring" }
>;

type CampaignScheduleEditorProps = {
  value: CampaignScheduleConfig;
  onChange: (value: CampaignScheduleConfig) => void;
  timezone: string;
  allowedModes?: CampaignScheduleMode[];
  recurringDisabledReason?: string | null;
  idPrefix?: string;
  compact?: boolean;
};

const WEEKDAYS: CampaignScheduleWeekday[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

const ORDINALS: CampaignScheduleOrdinal[] = [1, 2, 3, 4, -1];

function titleCase(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDateTimeLocal(date: Date): string {
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(
    date.getDate()
  )}T${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}`;
}

function defaultOneTimeStartAt(): string {
  return new Date(Date.now() + 15 * 60 * 1000).toISOString();
}

function toDateTimeLocal(value: string | null | undefined): string {
  const date = value ? new Date(value) : new Date(defaultOneTimeStartAt());
  return Number.isFinite(date.getTime()) ? formatDateTimeLocal(date) : "";
}

function fromDateTimeLocal(value: string): string | null {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function defaultRecurringConfig(
  timezone: string
): RecurringCampaignScheduleConfig {
  const config = normalizeCampaignScheduleConfig({
    timezone,
    config: {
      version: 2,
      mode: "recurring",
      timezone,
      recurrence: {
        kind: "weekly",
        weekdays: ["monday"],
        time: "09:00",
      },
    },
  });
  return config.mode === "recurring"
    ? config
    : {
        version: 2,
        mode: "recurring",
        timezone,
        recurrence: {
          kind: "weekly",
          weekdays: ["monday"],
          time: "09:00",
        },
      };
}

function defaultOnceConfig(timezone: string): CampaignScheduleConfig {
  return normalizeCampaignScheduleConfig({
    timezone,
    config: {
      version: 2,
      mode: "once",
      timezone,
      startAt: defaultOneTimeStartAt(),
    },
  });
}

function withTimezone(
  config: CampaignScheduleConfig,
  timezone: string
): CampaignScheduleConfig {
  return {
    ...config,
    timezone,
  };
}

function setRecurrence(
  config: CampaignScheduleConfig,
  recurrence: CampaignScheduleRecurrence
): CampaignScheduleConfig {
  return {
    ...config,
    mode: "recurring",
    recurrence,
  };
}

export function CampaignScheduleEditor({
  value,
  onChange,
  timezone,
  allowedModes = ["once", "recurring"],
  recurringDisabledReason = null,
  idPrefix = "campaign-schedule",
  compact = false,
}: CampaignScheduleEditorProps) {
  const t = useTranslations("CampaignScheduleEditor");
  const current = withTimezone(value, timezone);
  const mode = current.mode;
  const canUseOnce = allowedModes.includes("once");
  const canUseRecurring =
    allowedModes.includes("recurring") && !recurringDisabledReason;
  const recurring =
    current.mode === "recurring"
      ? current.recurrence
      : defaultRecurringConfig(timezone).recurrence;
  const summary = buildCampaignScheduleSummary(current);

  const setMode = (nextMode: CampaignScheduleMode) => {
    if (nextMode === "recurring") {
      if (!canUseRecurring) return;
      onChange(defaultRecurringConfig(timezone));
      return;
    }

    if (!canUseOnce) return;
    onChange(defaultOnceConfig(timezone));
  };

  const updateRecurrence = (recurrence: CampaignScheduleRecurrence) => {
    onChange(setRecurrence(current, recurrence));
  };

  const updateTime = (time: string) => {
    if (recurring.kind === "interval") return;
    updateRecurrence({ ...recurring, time });
  };

  return (
    <div className="grid gap-3 rounded-md border bg-muted/10 p-3">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <CalendarClock className="h-3.5 w-3.5" />
        {t("schedule")}
      </div>

      {allowedModes.length > 1 ? (
        <div className="grid grid-cols-2 gap-1">
          <Button
            type="button"
            size="sm"
            variant={mode === "once" ? "default" : "outline"}
            className="h-8 text-xs"
            disabled={!canUseOnce}
            onClick={() => setMode("once")}
          >
            {t("oneTime")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "recurring" ? "default" : "outline"}
            className="h-8 text-xs"
            disabled={!canUseRecurring}
            onClick={() => setMode("recurring")}
          >
            {t("recurring")}
          </Button>
        </div>
      ) : null}

      {mode === "once" ? (
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-once`} className="text-xs">
            {t("sendAt")}
          </Label>
          <Input
            id={`${idPrefix}-once`}
            type="datetime-local"
            value={toDateTimeLocal(current.startAt)}
            min={formatDateTimeLocal(new Date())}
            onChange={event =>
              onChange({
                ...current,
                mode: "once",
                startAt: fromDateTimeLocal(event.target.value),
              })
            }
            className="h-8 text-xs"
          />
        </div>
      ) : (
        <div className="grid gap-3">
          <div className={compact ? "grid gap-2" : "grid grid-cols-2 gap-3"}>
            <div className="grid gap-2">
              <Label className="text-xs">{t("repeats")}</Label>
              <Select
                value={recurring.kind}
                onValueChange={kind => {
                  if (kind === "interval") {
                    updateRecurrence({
                      kind: "interval",
                      every: 24,
                      unit: "hours",
                    });
                  } else if (kind === "daily") {
                    updateRecurrence({ kind: "daily", time: "09:00" });
                  } else if (kind === "weekly") {
                    updateRecurrence({
                      kind: "weekly",
                      weekdays: ["monday"],
                      time: "09:00",
                    });
                  } else if (kind === "monthly_day") {
                    updateRecurrence({
                      kind: "monthly_day",
                      dayOfMonth: 1,
                      time: "09:00",
                    });
                  } else {
                    updateRecurrence({
                      kind: "monthly_weekday",
                      ordinal: 1,
                      weekday: "tuesday",
                      time: "09:00",
                    });
                  }
                }}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="interval">
                    {t("repeatInterval")}
                  </SelectItem>
                  <SelectItem value="daily">{t("repeatDaily")}</SelectItem>
                  <SelectItem value="weekly">{t("repeatWeekly")}</SelectItem>
                  <SelectItem value="monthly_day">
                    {t("repeatMonthlyDay")}
                  </SelectItem>
                  <SelectItem value="monthly_weekday">
                    {t("repeatMonthlyWeekday")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {recurring.kind !== "interval" ? (
              <div className="grid gap-2">
                <Label className="text-xs">{t("time")}</Label>
                <Input
                  type="time"
                  value={recurring.time}
                  onChange={event => updateTime(event.target.value)}
                  className="h-8 text-xs"
                />
              </div>
            ) : null}
          </div>

          {recurring.kind === "interval" ? (
            <div className="grid grid-cols-[1fr_120px] gap-3">
              <div className="grid gap-2">
                <Label className="text-xs">{t("every")}</Label>
                <Input
                  type="number"
                  min={1}
                  value={recurring.every}
                  onChange={event =>
                    updateRecurrence({
                      ...recurring,
                      every: Math.max(
                        1,
                        Number.parseInt(event.target.value || "1", 10) || 1
                      ),
                    })
                  }
                  className="h-8 text-xs"
                />
              </div>
              <div className="grid gap-2">
                <Label className="text-xs">{t("unit")}</Label>
                <Select
                  value={
                    recurring.unit === "minutes" ? "hours" : recurring.unit
                  }
                  onValueChange={unit =>
                    updateRecurrence({
                      ...recurring,
                      unit: unit === "days" ? "days" : "hours",
                    })
                  }
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="hours">{t("hours")}</SelectItem>
                    <SelectItem value="days">{t("days")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : null}

          {recurring.kind === "weekly" ? (
            <div className="flex flex-wrap gap-2">
              {WEEKDAYS.map(weekday => {
                const checked = recurring.weekdays.includes(weekday);
                return (
                  <label
                    key={weekday}
                    className="flex items-center gap-1.5 rounded border px-2 py-1 text-xs"
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={nextChecked => {
                        const nextWeekdays = nextChecked
                          ? [...recurring.weekdays, weekday]
                          : recurring.weekdays.filter(item => item !== weekday);
                        updateRecurrence({
                          ...recurring,
                          weekdays:
                            nextWeekdays.length > 0
                              ? (Array.from(
                                  new Set(nextWeekdays)
                                ) as CampaignScheduleWeekday[])
                              : [weekday],
                        });
                      }}
                    />
                    {titleCase(weekday).slice(0, 3)}
                  </label>
                );
              })}
            </div>
          ) : null}

          {recurring.kind === "monthly_day" ? (
            <div className="grid gap-2">
              <Label className="text-xs">{t("dayOfMonth")}</Label>
              <Input
                type="number"
                min={1}
                max={31}
                value={recurring.dayOfMonth}
                onChange={event =>
                  updateRecurrence({
                    ...recurring,
                    dayOfMonth: Math.min(
                      31,
                      Math.max(
                        1,
                        Number.parseInt(event.target.value || "1", 10) || 1
                      )
                    ),
                  })
                }
                className="h-8 text-xs"
              />
            </div>
          ) : null}

          {recurring.kind === "monthly_weekday" ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label className="text-xs">{t("ordinal")}</Label>
                <Select
                  value={String(recurring.ordinal)}
                  onValueChange={ordinal =>
                    updateRecurrence({
                      ...recurring,
                      ordinal: Number(ordinal) as CampaignScheduleOrdinal,
                    })
                  }
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ORDINALS.map(ordinal => (
                      <SelectItem key={ordinal} value={String(ordinal)}>
                        {t(`ordinals.${ordinal}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label className="text-xs">{t("weekday")}</Label>
                <Select
                  value={recurring.weekday}
                  onValueChange={weekday =>
                    updateRecurrence({
                      ...recurring,
                      weekday: weekday as CampaignScheduleWeekday,
                    })
                  }
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WEEKDAYS.map(weekday => (
                      <SelectItem key={weekday} value={weekday}>
                        {titleCase(weekday)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : null}
        </div>
      )}

      <div className="rounded bg-background/70 px-2 py-1.5 text-[11px] text-muted-foreground">
        {summary}
      </div>
      {recurringDisabledReason ? (
        <div className="text-[11px] text-muted-foreground">
          {recurringDisabledReason}
        </div>
      ) : null}
    </div>
  );
}
