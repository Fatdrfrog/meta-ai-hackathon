"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Calendar, getCalendarDateLocale } from "@/components/ui/calendar";
import { CalendarIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLocale, useTranslations } from "next-intl";

type PresetKey = "7d" | "30d" | "90d" | "this_week" | "all" | "custom";

export type DateRange = {
  from: Date | null;
  to: Date | null;
  preset: PresetKey;
};

const PRESETS: {
  key: PresetKey;
  labelKey:
    | "last7Days"
    | "last30Days"
    | "last90Days"
    | "thisWeek"
    | "last12Months";
}[] = [
  { key: "7d", labelKey: "last7Days" },
  { key: "30d", labelKey: "last30Days" },
  { key: "90d", labelKey: "last90Days" },
  { key: "this_week", labelKey: "thisWeek" },
  { key: "all", labelKey: "last12Months" },
];

export function DateRangeControl({
  value,
  onChange,
  iconFree = false,
}: {
  value: DateRange;
  onChange: (next: DateRange) => void;
  iconFree?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const locale = useLocale();
  const t = useTranslations("DateRangeControl");
  const dateLocale = getCalendarDateLocale(locale);
  const dateFormatter = React.useMemo(
    () =>
      new Intl.DateTimeFormat(locale === "kz" ? "kk" : locale, {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
    [locale]
  );

  const label = (() => {
    if (value.preset === "all") return t("last12Months");
    if (value.preset !== "custom")
      return t(PRESETS.find(p => p.key === value.preset)?.labelKey ?? "select");
    if (value.from && value.to)
      return `${dateFormatter.format(value.from)} – ${dateFormatter.format(value.to)}`;
    return t("customRange");
  })();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn("w-full justify-start gap-2 text-left sm:w-[260px]")}
        >
          {!iconFree && <CalendarIcon data-icon="inline-start" />}
          <span className="truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] p-0 sm:w-auto"
      >
        <div className="flex max-w-full flex-col gap-2 p-3 sm:flex-row">
          <div className="flex w-full flex-col gap-1 sm:w-40">
            {PRESETS.map(p => (
              <Button
                key={p.key}
                variant={value.preset === p.key ? "default" : "ghost"}
                className="justify-start"
                onClick={() => {
                  onChange({ preset: p.key, from: null, to: null });
                  setOpen(false);
                }}
              >
                {t(p.labelKey)}
              </Button>
            ))}
          </div>
          <div className="border-t sm:border-l sm:border-t-0" />
          <div className="max-w-full overflow-x-auto p-1">
            <Calendar
              iconFree={iconFree}
              mode="range"
              selected={
                value.from && value.to
                  ? { from: value.from, to: value.to }
                  : undefined
              }
              onSelect={(range: { from?: Date; to?: Date } | undefined) => {
                if (range && range.from && range.to) {
                  onChange({
                    preset: "custom",
                    from: range.from,
                    to: range.to,
                  });
                  setOpen(false);
                }
              }}
              defaultMonth={value.from ?? undefined}
              locale={dateLocale}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
