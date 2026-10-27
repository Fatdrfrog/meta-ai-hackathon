import { buildDashboardCacheKey } from "./dashboard-cache-key";

type DimensionValues = readonly (string | number)[];

function buildIdentity(
  overrides: Partial<Record<string, DimensionValues>> = {}
) {
  return buildDashboardCacheKey([
    ["workspace", overrides.workspace ?? ["workspace-1"]],
    ["period", overrides.period ?? ["30d", "UTC", 42]],
    ["channels", overrides.channels ?? []],
    ["categories", overrides.categories ?? []],
    ["internalLabels", overrides.internalLabels ?? []],
    ["managerIds", overrides.managerIds ?? []],
  ]);
}

describe("buildDashboardCacheKey", () => {
  it("keeps empty filter dimensions tagged in the real cache key", () => {
    const key = buildIdentity();

    expect(key).toBe(
      "icecore:dashboard:workspace=%5B%22workspace-1%22%5D:" +
        "period=%5B%2230d%22%2C%22UTC%22%2C42%5D:" +
        "channels=%5B%5D:categories=%5B%5D:" +
        "internalLabels=%5B%5D:managerIds=%5B%5D"
    );
  });

  it.each([
    [
      "comma-delimited value",
      { channels: ["sales,priority"] },
      { channels: ["sales", "priority"] },
    ],
    [
      "colon-delimited value",
      { channels: ["sales:priority"] },
      { channels: ["sales", "priority"] },
    ],
    ["whitespace", { channels: ["Sales Box"] }, { channels: ["Sales_Box"] }],
    [
      "dimension position",
      { channels: ["priority"] },
      { categories: ["priority"] },
    ],
  ] as const)("does not collide for %s", (_name, left, right) => {
    expect(buildIdentity(left)).not.toBe(buildIdentity(right));
  });
});
