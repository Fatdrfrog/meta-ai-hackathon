import type { DateRange } from "@/components/ui/date-range-control";
import type { DashboardManagerOption } from "@/types/dashboard";
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

type DashboardPreset = {
  name: string;
  channels: string[];
  categories: string[];
  internalLabels?: string[];
  managerIds?: string[];
};

export const dashboardFiltersAtom = atom<{
  dateRange: DateRange;
  selectedChannels: string[];
  selectedCategories: string[];
  selectedInternalLabels: string[];
  selectedManagerIds: string[];
  availableChannels: string[];
  availableCategories: string[];
  availableInternalLabels: string[];
  availableManagers: DashboardManagerOption[];
}>({
  dateRange: { preset: "30d", from: null, to: null },
  selectedChannels: [],
  selectedCategories: [],
  selectedInternalLabels: [],
  selectedManagerIds: [],
  availableChannels: [],
  availableCategories: [],
  availableInternalLabels: [],
  availableManagers: [],
});

const dashboardPresetsAtomCache = new Map<
  string,
  ReturnType<typeof atomWithStorage<DashboardPreset[]>>
>();

export const createDashboardPresetsAtom = (workspaceId: string) => {
  if (!dashboardPresetsAtomCache.has(workspaceId)) {
    dashboardPresetsAtomCache.set(
      workspaceId,
      atomWithStorage<DashboardPreset[]>(`dashboard-presets-${workspaceId}`, [])
    );
  }
  return dashboardPresetsAtomCache.get(workspaceId)!;
};
