import type { DashboardData } from "@/types/dashboard";
import { filterDashboardData } from "./dashboard-filters";

function buildData(): DashboardData {
  return {
    topCategories: [
      { name: "Accounting", value: 8 },
      { name: "Other", value: 3 },
    ],
    categoriesByChannel: [
      { category: "Accounting", channel: "telegram", count: 8 },
      { category: "Other", channel: "whatsapp", count: 3 },
    ],
    categoryComparisons: [
      {
        category: "Accounting",
        current: 8,
        previous: 4,
        delta: 4,
        percentChange: 100,
        kind: "increase",
      },
      {
        category: "Other",
        current: 0,
        previous: 3,
        delta: -3,
        percentChange: -100,
        kind: "no_longer_active",
      },
    ],
  } as DashboardData;
}

describe("filterDashboardData", () => {
  it("filters the canonical comparison union with the same category selection", () => {
    const source = buildData();
    const result = filterDashboardData(source, ["whatsapp"], ["Other"]);

    expect(result.topCategories).toEqual([{ name: "Other", value: 3 }]);
    expect(result.categoriesByChannel).toEqual([
      { category: "Other", channel: "whatsapp", count: 3 },
    ]);
    expect(result.categoryComparisons).toEqual([
      expect.objectContaining({
        category: "Other",
        current: 0,
        previous: 3,
        kind: "no_longer_active",
      }),
    ]);
    expect(result).not.toHaveProperty("topGrowingCategories");
    expect(result).not.toHaveProperty("topDecliningCategories");
    expect(source.categoryComparisons).toHaveLength(2);
  });

  it("preserves all canonical comparison rows when no category is selected", () => {
    const result = filterDashboardData(buildData(), [], []);
    expect(result.categoryComparisons.map(row => row.category)).toEqual([
      "Accounting",
      "Other",
    ]);
  });
});
