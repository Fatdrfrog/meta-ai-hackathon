import type { DashboardData, DashboardManagerOption } from "@/types/dashboard";

type DashboardFilterOptionLists = {
  channels: string[];
  categories: string[];
  internalLabels: string[];
  managers: DashboardManagerOption[];
};

type MergeDashboardFilterOptionsParams = {
  data: DashboardData;
  previous: DashboardFilterOptionLists;
  selected: DashboardFilterOptionLists;
};

function mergeSorted(...lists: string[][]): string[] {
  return Array.from(
    new Set(
      lists
        .flat()
        .map(value => value.trim())
        .filter(Boolean)
    )
  ).sort((left, right) => left.localeCompare(right));
}

function mergeManagers(...lists: DashboardManagerOption[][]) {
  const byId = new Map<string, DashboardManagerOption>();

  for (const manager of lists.flat()) {
    const id = manager.id?.trim();
    if (!id || byId.has(id)) continue;
    byId.set(id, { ...manager, id });
  }

  return Array.from(byId.values()).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
}

export function mergeDashboardFilterOptions({
  data,
  previous,
  selected,
}: MergeDashboardFilterOptionsParams): DashboardFilterOptionLists {
  const dataChannels = (data.categoriesByChannel || [])
    .map(row => row.channel)
    .filter(Boolean);
  const dataCategories = [
    ...(data.categoryComparisons || []).map(row => row.category),
    ...(data.topCategories || []).map(category => category.name),
    ...(data.categoriesByChannel || []).map(row => row.category),
  ].filter(Boolean);
  const dataInternalLabels = data.internalLabels?.availableLabels || [];
  const selectedManagers = previous.managers.filter(manager =>
    selected.managers.some(selectedManager => selectedManager.id === manager.id)
  );

  return {
    channels: mergeSorted(previous.channels, selected.channels, dataChannels),
    categories: mergeSorted(
      previous.categories,
      selected.categories,
      dataCategories
    ),
    internalLabels: mergeSorted(
      previous.internalLabels,
      selected.internalLabels,
      dataInternalLabels
    ),
    managers: mergeManagers(
      data.managerOptions || [],
      previous.managers,
      selectedManagers
    ),
  };
}
