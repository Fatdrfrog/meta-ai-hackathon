import { buildCacheKey } from "@/lib/cache";

type DashboardCacheDimensionValue = string | number;
type DashboardCacheDimension = readonly [
  name: string,
  values: readonly DashboardCacheDimensionValue[],
];

export function buildDashboardCacheKey(
  dimensions: readonly DashboardCacheDimension[]
): string {
  return buildCacheKey(
    "dashboard",
    dimensions.map(
      ([name, values]) =>
        `${encodeURIComponent(name)}=${encodeURIComponent(JSON.stringify(values))}`
    )
  );
}
