"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDashboardCategory } from "@/components/dashboard/dashboard-localization";
import type { DashboardManagerOption } from "@/types/dashboard";
import { useTranslations } from "next-intl";
import * as React from "react";

export type DashboardFilterDimension =
  | "channels"
  | "categories"
  | "internalLabels"
  | "managerIds";

export interface DashboardFilterSelection {
  channels: string[];
  categories: string[];
  internalLabels: string[];
  managerIds: string[];
}

export interface ActiveFiltersProps {
  filters: DashboardFilterSelection;
  managers: DashboardManagerOption[];
  onRemove: (dimension: DashboardFilterDimension, value: string) => void;
  onClearAll: () => void;
}

interface FilterChip {
  dimension: DashboardFilterDimension;
  value: string;
  label: string;
}

export function ActiveFilters({
  filters,
  managers,
  onRemove,
  onClearAll,
}: ActiveFiltersProps) {
  const t = useTranslations("DashboardClientPage");
  const managerNames = React.useMemo(
    () => new Map(managers.map(manager => [manager.id, manager.name])),
    [managers]
  );
  const chips = React.useMemo<FilterChip[]>(
    () => [
      ...filters.channels.map(value => ({
        dimension: "channels" as const,
        value,
        label: value,
      })),
      ...filters.categories.map(value => ({
        dimension: "categories" as const,
        value,
        label: formatDashboardCategory(value, (key, values) => t(key, values)),
      })),
      ...filters.internalLabels.map(value => ({
        dimension: "internalLabels" as const,
        value,
        label: value,
      })),
      ...filters.managerIds.map(value => ({
        dimension: "managerIds" as const,
        value,
        label: managerNames.get(value) ?? value,
      })),
    ],
    [filters, managerNames, t]
  );

  if (chips.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="text-sm text-muted-foreground">
        {t("activeFilters.label")}
      </span>
      {chips.map(chip => (
        <Badge
          key={`${chip.dimension}:${chip.value}`}
          variant="secondary"
          className="max-w-full shrink"
          title={chip.label}
        >
          <span className="min-w-0 truncate">{chip.label}</span>
          <Button
            variant="ghost"
            size="sm"
            className="-mr-1 h-auto shrink-0 px-1 py-0.5 text-xs"
            aria-label={t("activeFilters.remove", { value: chip.label })}
            onClick={() => onRemove(chip.dimension, chip.value)}
          >
            {t("activeFilters.removeAction")}
          </Button>
        </Badge>
      ))}
      <Button variant="ghost" size="sm" onClick={onClearAll}>
        {t("activeFilters.clearAll")}
      </Button>
    </div>
  );
}
