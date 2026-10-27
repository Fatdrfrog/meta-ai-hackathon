import {
  AnalyticsDashboardPreference,
  ensureAnalyticsDashboardPreferenceIndexes,
} from "./analytics-dashboard-preference";

const state = {
  version: 1,
  activeViewId: "one",
  views: [
    { id: "one", name: "My dashboard", templateId: "starter", cards: [] },
  ],
};

describe("AnalyticsDashboardPreference", () => {
  it("validates a personal dashboard document without a database connection", async () => {
    const document = new AnalyticsDashboardPreference({
      workspaceId: "workspace-1",
      userId: "user-1",
      state,
      revision: 1,
    });
    await expect(document.validate()).resolves.toBeUndefined();
    expect(AnalyticsDashboardPreference.schema.indexes()).toContainEqual([
      { workspaceId: 1, userId: 1 },
      {
        unique: true,
        name: "analytics_dashboard_member_unique",
        background: true,
      },
    ]);
  });

  it("validates both personal surfaces in the same scoped document and preserves legacy v1", async () => {
    const outcomes = { cards: [{ id: "flows", width: 4, height: 1 }] };
    const document = new AnalyticsDashboardPreference({
      workspaceId: "workspace-1",
      userId: "user-1",
      state: { ...state, outcomes },
      revision: 2,
    });
    await expect(document.validate()).resolves.toBeUndefined();
    expect(document.state).toEqual({ ...state, outcomes });
    expect(document.state.views).toEqual(state.views);
  });

  it.each([
    { userId: "" },
    { workspaceId: "" },
    { revision: 0 },
    { revision: 1.5 },
    { state: { ...state, activeViewId: "missing" } },
    // Reads are lenient, but every write stays strict.
    {
      state: {
        ...state,
        views: [
          {
            ...state.views[0],
            cards: [{ id: "revenue", width: 1, height: 1 }],
          },
        ],
      },
    },
    { state: { ...state, pinnedFilters: ["whatsapp"] } },
    { state: { ...state, version: 2 } },
  ])("rejects invalid persisted preference %j", async patch => {
    const document = new AnalyticsDashboardPreference({
      workspaceId: "workspace-1",
      userId: "user-1",
      state,
      revision: 1,
      ...patch,
    });
    await expect(document.validate()).rejects.toThrow();
  });

  it("requires a unique index even when production auto-indexing is disabled", async () => {
    const createIndex = jest.spyOn(
      AnalyticsDashboardPreference.collection,
      "createIndex"
    );
    createIndex.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(ensureAnalyticsDashboardPreferenceIndexes()).rejects.toThrow(
      "database unavailable"
    );
    createIndex.mockResolvedValue("analytics_dashboard_member_unique");
    await Promise.all([
      ensureAnalyticsDashboardPreferenceIndexes(),
      ensureAnalyticsDashboardPreferenceIndexes(),
    ]);
    expect(createIndex).toHaveBeenCalledTimes(2);
    expect(createIndex).toHaveBeenLastCalledWith(
      { workspaceId: 1, userId: 1 },
      { unique: true, name: "analytics_dashboard_member_unique" }
    );
    createIndex.mockRestore();
  });
});
