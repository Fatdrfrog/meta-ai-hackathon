"use client";

import { DashboardClientPage } from "@/components/dashboard/dashboard-client-page";
import {
  DashboardBoardController,
  type DashboardBoardPresentation,
} from "./dashboard-board-controller";
import { buildDashboardCsv } from "@/components/dashboard/dashboard-export";
import {
  createDashboardPresetsAtom,
  dashboardFiltersAtom,
} from "@/components/dashboard/dashboard-state";
import {
  DashboardToolbar,
  type DashboardToolbarPreset,
} from "@/components/dashboard/dashboard-toolbar";
import type { DashboardFilterSelection } from "@/components/dashboard/active-filters";
import type { DateRange } from "@/components/ui/date-range-control";
import { mergeDashboardFilterOptions } from "@/lib/dashboard-filter-options";
import { buildDashboardQueryPath } from "@/lib/dashboard-query";
import type { DashboardData } from "@/types/dashboard";
import { useAtom } from "jotai";
import { useLocale, useTranslations } from "next-intl";
import * as React from "react";

const areStringArraysEqual = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

function normalizePresetValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.filter(
        (item): item is string => typeof item === "string" && item.length > 0
      )
    )
  );
}

function normalizeDashboardPreset(
  value: unknown
): DashboardToolbarPreset | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || !record.name.trim()) return null;

  return {
    name: record.name.trim(),
    channels: normalizePresetValues(record.channels),
    categories: normalizePresetValues(record.categories),
    internalLabels: normalizePresetValues(record.internalLabels),
    managerIds: normalizePresetValues(record.managerIds),
  };
}

export function DashboardPageClient({
  workspaceId,
  customizable = false,
  memberId,
}: { workspaceId: string } & (
  | { customizable: true; memberId: string }
  | { customizable?: false; memberId?: never }
)) {
  const locale = useLocale();
  const t = useTranslations("DashboardPage");
  const dashboardClientT = useTranslations("DashboardClientPage");
  const metricsT = useTranslations("SectionCards");
  const [filters, setFilters] = useAtom(dashboardFiltersAtom);
  const [presets, setPresets] = useAtom(
    createDashboardPresetsAtom(workspaceId)
  );
  const [comparePreference, setComparePreference] = React.useState(true);
  const [lastData, setLastData] = React.useState<{
    data: DashboardData;
    queryPath: string;
  } | null>(null);

  const {
    dateRange,
    selectedChannels,
    selectedCategories,
    selectedInternalLabels,
    selectedManagerIds,
    availableChannels,
    availableCategories,
    availableInternalLabels,
    availableManagers,
  } = filters;

  const dashboardFilters = React.useMemo<DashboardFilterSelection>(
    () => ({
      channels: selectedChannels,
      categories: selectedCategories,
      internalLabels: selectedInternalLabels,
      managerIds: selectedManagerIds,
    }),
    [
      selectedChannels,
      selectedCategories,
      selectedInternalLabels,
      selectedManagerIds,
    ]
  );
  const filterOptions = React.useMemo(
    () => ({
      channels: availableChannels,
      categories: availableCategories,
      internalLabels: availableInternalLabels,
      managers: availableManagers,
    }),
    [
      availableChannels,
      availableCategories,
      availableInternalLabels,
      availableManagers,
    ]
  );
  const normalizedPresets = React.useMemo(() => {
    const rawPresets: unknown = presets;
    if (!Array.isArray(rawPresets)) return [];
    return rawPresets
      .map(normalizeDashboardPreset)
      .filter((preset): preset is DashboardToolbarPreset => preset !== null);
  }, [presets]);
  const comparisonAvailable = dateRange.preset !== "all";
  const comparisonEnabled = comparisonAvailable && comparePreference;
  const timeZone = React.useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    []
  );
  const currentQueryPath = React.useMemo(
    () =>
      buildDashboardQueryPath(
        workspaceId,
        dateRange,
        dashboardFilters,
        timeZone
      ),
    [workspaceId, dateRange, dashboardFilters, timeZone]
  );
  const currentData =
    lastData?.queryPath === currentQueryPath ? lastData.data : null;

  const setDateRange = React.useCallback(
    (newDateRange: DateRange) => {
      setFilters(previous => ({ ...previous, dateRange: newDateRange }));
    },
    [setFilters]
  );

  const setDashboardSelections = React.useCallback(
    (selection: DashboardFilterSelection) => {
      setFilters(previous => ({
        ...previous,
        selectedChannels: selection.channels,
        selectedCategories: selection.categories,
        selectedInternalLabels: selection.internalLabels,
        selectedManagerIds: selection.managerIds,
      }));
    },
    [setFilters]
  );

  const onExport = React.useCallback(() => {
    if (!currentData) return;
    const csv = buildDashboardCsv({
      data: currentData,
      filters: dashboardFilters,
      comparisonEnabled,
      locale,
      translate: (key, values) =>
        key.startsWith("export.")
          ? t(key, values)
          : key === "uncategorized" || key === "missingValue"
            ? dashboardClientT(key, values)
            : metricsT(key, values),
    });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `dashboard_${workspaceId}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [
    comparisonEnabled,
    currentData,
    dashboardClientT,
    dashboardFilters,
    locale,
    metricsT,
    t,
    workspaceId,
  ]);

  const onDataLoaded = React.useCallback(
    (data: DashboardData) => {
      setLastData({ data, queryPath: currentQueryPath });

      setFilters(previous => {
        const nextOptions = mergeDashboardFilterOptions({
          data,
          previous: {
            channels: previous.availableChannels,
            categories: previous.availableCategories,
            internalLabels: previous.availableInternalLabels,
            managers: previous.availableManagers,
          },
          selected: {
            channels: previous.selectedChannels,
            categories: previous.selectedCategories,
            internalLabels: previous.selectedInternalLabels,
            managers: previous.availableManagers.filter(manager =>
              previous.selectedManagerIds.includes(manager.id)
            ),
          },
        });
        const sameChannels = areStringArraysEqual(
          previous.availableChannels,
          nextOptions.channels
        );
        const sameCategories = areStringArraysEqual(
          previous.availableCategories,
          nextOptions.categories
        );
        const sameInternalLabels = areStringArraysEqual(
          previous.availableInternalLabels,
          nextOptions.internalLabels
        );
        const sameManagers =
          previous.availableManagers.length === nextOptions.managers.length &&
          previous.availableManagers.every(
            (manager, index) => manager.id === nextOptions.managers[index]?.id
          );

        if (
          sameChannels &&
          sameCategories &&
          sameInternalLabels &&
          sameManagers
        ) {
          return previous;
        }

        return {
          ...previous,
          availableChannels: nextOptions.channels,
          availableCategories: nextOptions.categories,
          availableInternalLabels: nextOptions.internalLabels,
          availableManagers: nextOptions.managers,
        };
      });
    },
    [currentQueryPath, setFilters]
  );

  const savePreset = React.useCallback(
    (name: string) => {
      const trimmedName = name.trim();
      if (!trimmedName) return;
      setPresets([
        ...normalizedPresets.filter(preset => preset.name !== trimmedName),
        {
          name: trimmedName,
          channels: [...selectedChannels],
          categories: [...selectedCategories],
          internalLabels: [...selectedInternalLabels],
          managerIds: [...selectedManagerIds],
        },
      ]);
    },
    [
      normalizedPresets,
      selectedCategories,
      selectedChannels,
      selectedInternalLabels,
      selectedManagerIds,
      setPresets,
    ]
  );

  const deletePreset = React.useCallback(
    (name: string) => {
      setPresets(normalizedPresets.filter(preset => preset.name !== name));
    },
    [normalizedPresets, setPresets]
  );

  const renderDashboard = (boardPresentation?: DashboardBoardPresentation) => (
    <div className="flex flex-col gap-4">
      <DashboardToolbar
        dateRange={dateRange}
        filters={dashboardFilters}
        options={filterOptions}
        presets={normalizedPresets}
        comparisonEnabled={comparisonEnabled}
        comparisonAvailable={comparisonAvailable}
        comparisonPeriod={currentData?.comparisonPeriod ?? null}
        exportDisabled={!currentData}
        onDateRangeChange={setDateRange}
        onComparisonChange={setComparePreference}
        onFiltersChange={setDashboardSelections}
        onSavePreset={savePreset}
        onApplyPreset={setDashboardSelections}
        onDeletePreset={deletePreset}
        onExport={onExport}
      />
      {boardPresentation ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {dashboardClientT("board.conversationScope")}
        </p>
      ) : null}
      <DashboardClientPage
        workspaceId={workspaceId}
        dateRange={dateRange}
        filters={dashboardFilters}
        comparisonEnabled={comparisonEnabled}
        onDataLoaded={onDataLoaded}
        boardPresentation={boardPresentation}
      />
    </div>
  );

  return customizable ? (
    <DashboardBoardController
      key={`${workspaceId}:${memberId}`}
      workspaceId={workspaceId}
      memberId={memberId!}
    >
      {renderDashboard}
    </DashboardBoardController>
  ) : (
    renderDashboard()
  );
}
