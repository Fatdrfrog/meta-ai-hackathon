import type { DateRange } from "@/components/ui/date-range-control";
import { readUniqueStringArray } from "@icecore/shared/lib/value-utils";

type DashboardQueryFilters = {
  channels?: string[];
  categories?: string[];
  internalLabels?: string[];
  managerIds?: string[];
};

function normalizeFilterValues(values: string[] | undefined): string[] {
  return readUniqueStringArray(values).sort((left, right) =>
    left.localeCompare(right)
  );
}

function formatCalendarDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getPresetPeriod(dateRange: DateRange): string {
  if (dateRange.preset === "all") return "all";
  if (dateRange.preset === "this_week") return "this_week";
  if (
    dateRange.preset === "7d" ||
    dateRange.preset === "30d" ||
    dateRange.preset === "90d"
  ) {
    return dateRange.preset.replace("d", "");
  }
  return "30";
}

export function buildDashboardQueryPath(
  workspaceId: string,
  dateRange: DateRange,
  filters: DashboardQueryFilters = {},
  timeZone?: string
): string {
  const qp = new URLSearchParams();
  qp.set("workspaceId", workspaceId);
  if (timeZone) {
    qp.set("timezone", timeZone);
  }

  if (dateRange.preset === "custom" && dateRange.from && dateRange.to) {
    const fromTime = dateRange.from.getTime();
    const toTime = dateRange.to.getTime();
    const rangeStart = fromTime <= toTime ? dateRange.from : dateRange.to;
    const rangeEnd = fromTime <= toTime ? dateRange.to : dateRange.from;
    qp.set("from", formatCalendarDate(rangeStart));
    qp.set("to", formatCalendarDate(rangeEnd));
  } else {
    qp.set("period", getPresetPeriod(dateRange));
  }

  for (const channel of normalizeFilterValues(filters.channels)) {
    qp.append("channels", channel);
  }
  for (const category of normalizeFilterValues(filters.categories)) {
    qp.append("categories", category);
  }
  for (const label of normalizeFilterValues(filters.internalLabels)) {
    qp.append("internalLabels", label);
  }
  for (const managerId of normalizeFilterValues(filters.managerIds)) {
    qp.append("managerIds", managerId);
  }

  return `/api/dashboard?${qp.toString()}`;
}
