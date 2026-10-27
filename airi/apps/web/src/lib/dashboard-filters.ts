import type { DashboardData } from "@/types/dashboard";

/**
 * Filters dashboard data by selected channels and categories.
 * Shared between DashboardPageClient (export CSV) and DashboardClientPage (display).
 */
export function filterDashboardData(
  d: DashboardData,
  channels: string[],
  categories: string[]
): DashboardData {
  const channelSet = new Set(channels);
  const categorySet = new Set(categories);
  const filterChannel = channels.length > 0;
  const filterCategory = categories.length > 0;
  return {
    ...d,
    topCategories: (d.topCategories || []).filter(
      c => !filterCategory || categorySet.has(c.name)
    ),
    categoriesByChannel: (d.categoriesByChannel || []).filter(
      r =>
        (!filterChannel || channelSet.has(r.channel)) &&
        (!filterCategory || categorySet.has(r.category))
    ),
    categoryComparisons: (d.categoryComparisons || []).filter(
      row => !filterCategory || categorySet.has(row.category)
    ),
  };
}
