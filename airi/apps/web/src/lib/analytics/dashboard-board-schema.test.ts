import {
  dashboardBoardStateSchema,
  normalizeStoredDashboardBoard,
} from "./dashboard-board-schema";

const stored = {
  version: 1,
  activeViewId: "growth",
  views: [
    {
      id: "overview",
      name: "Overview",
      templateId: "starter",
      cards: [
        { id: "total", width: 1, height: 1 },
        { id: "volume", width: 2, height: 2 },
      ],
    },
    {
      id: "growth",
      name: "Growth",
      templateId: "sales",
      cards: [{ id: "campaigns", width: 2, height: 2 }],
    },
  ],
  outcomes: { cards: [{ id: "delivery", width: 2, height: 1 }] },
};

describe("normalizeStoredDashboardBoard", () => {
  it("returns a valid stored board unchanged", () => {
    expect(normalizeStoredDashboardBoard(stored)).toEqual(stored);
  });

  it("drops an unknown card id but keeps the rest of the view", () => {
    const raw = structuredClone(stored);
    raw.views[0].cards.splice(1, 0, { id: "revenue", width: 2, height: 1 });
    expect(dashboardBoardStateSchema.safeParse(raw).success).toBe(false);
    expect(normalizeStoredDashboardBoard(raw)).toEqual(stored);
  });

  it("drops extra fields on the board, views and cards", () => {
    const raw = {
      ...structuredClone(stored),
      filters: { channel: "whatsapp" },
      views: stored.views.map(view => ({
        ...view,
        pinned: true,
        cards: view.cards.map(card => ({ ...card, color: "rose" })),
      })),
    };
    expect(dashboardBoardStateSchema.safeParse(raw).success).toBe(false);
    expect(normalizeStoredDashboardBoard(raw)).toEqual(stored);
  });

  it("reads a document written by a newer release after a rollback", () => {
    // Shape a future v1 writer could leave: new template, card, report and field.
    const raw = {
      version: 1,
      activeViewId: "funnel",
      layoutDensity: "compact",
      views: [
        {
          id: "funnel",
          name: "Funnel",
          templateId: "ecommerce",
          cards: [
            { id: "orders", width: 2, height: 2 },
            { id: "total", width: 6, height: 4 },
            { id: "total", width: 1, height: 1 },
            { id: "new", width: 1.5, height: 1 },
          ],
        },
        { id: "funnel", name: "Duplicate", templateId: "starter", cards: [] },
        { id: "", name: "No id", templateId: "starter", cards: [] },
      ],
      outcomes: {
        cards: [
          { id: "attribution", width: 4, height: 1 },
          { id: "flows", width: 4, height: 1 },
        ],
        compact: true,
      },
    };
    expect(normalizeStoredDashboardBoard(raw)).toEqual({
      version: 1,
      activeViewId: "funnel",
      views: [
        {
          id: "funnel",
          name: "Funnel",
          templateId: "starter",
          cards: [{ id: "total", width: 4, height: 3 }],
        },
      ],
      outcomes: { cards: [{ id: "flows", width: 4, height: 1 }] },
    });
  });

  it("falls back to the first readable view when the active one is gone", () => {
    const raw = structuredClone(stored);
    raw.activeViewId = "deleted";
    expect(normalizeStoredDashboardBoard(raw)?.activeViewId).toBe("overview");
  });

  it.each([
    null,
    "board",
    [],
    { ...stored, version: 2 },
    { ...stored, version: undefined },
    { ...stored, views: [] },
    { ...stored, views: [{ id: "x", name: " ", templateId: "starter" }] },
  ])("reads %j as unavailable instead of guessing", raw => {
    expect(normalizeStoredDashboardBoard(raw)).toBeNull();
  });

  it("keeps the strict write contract unchanged", () => {
    expect(
      dashboardBoardStateSchema.safeParse({
        ...stored,
        views: [
          {
            ...stored.views[0],
            cards: [{ id: "revenue", width: 1, height: 1 }],
          },
        ],
      }).success
    ).toBe(false);
  });
});
