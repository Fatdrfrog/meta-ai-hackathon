import { buildDashboardQueryPath } from "./dashboard-query";

describe("buildDashboardQueryPath", () => {
  it("includes normalized manager filters in dashboard API requests", () => {
    const path = buildDashboardQueryPath(
      "workspace-1",
      { preset: "30d", from: null, to: null },
      {
        managerIds: ["manager-b", "manager-a", "manager-a", " "],
      }
    );

    expect(path).toBe(
      "/api/dashboard?workspaceId=workspace-1&period=30&managerIds=manager-a&managerIds=manager-b"
    );
  });

  it("includes the dashboard timezone when provided", () => {
    const path = buildDashboardQueryPath(
      "workspace-1",
      { preset: "7d", from: null, to: null },
      {},
      "Asia/Qyzylorda"
    );

    expect(path).toBe(
      "/api/dashboard?workspaceId=workspace-1&timezone=Asia%2FQyzylorda&period=7"
    );
  });

  it("emits this-week and last-12-month presets with the existing wire values", () => {
    expect(
      buildDashboardQueryPath("workspace-1", {
        preset: "this_week",
        from: null,
        to: null,
      })
    ).toBe("/api/dashboard?workspaceId=workspace-1&period=this_week");
    expect(
      buildDashboardQueryPath("workspace-1", {
        preset: "all",
        from: null,
        to: null,
      })
    ).toBe("/api/dashboard?workspaceId=workspace-1&period=all");
  });

  it("serializes custom calendar dates and preserves repeated filters", () => {
    const path = buildDashboardQueryPath(
      "workspace-1",
      {
        preset: "custom",
        from: new Date(2026, 4, 1),
        to: new Date(2026, 4, 7),
      },
      {
        channels: ["whatsapp", "telegram"],
        categories: ["Sales", "Refunds"],
        internalLabels: ["vip", "priority"],
        managerIds: ["manager-b", "manager-a"],
      },
      "Asia/Qyzylorda"
    );

    expect(path).toBe(
      "/api/dashboard?workspaceId=workspace-1&timezone=Asia%2FQyzylorda&from=2026-05-01&to=2026-05-07&channels=telegram&channels=whatsapp&categories=Refunds&categories=Sales&internalLabels=priority&internalLabels=vip&managerIds=manager-a&managerIds=manager-b"
    );
    expect(path).not.toContain("comparison");
    expect(path).not.toContain("T00%3A00%3A00");
  });
});
