import {
  createDashboardView,
  createDefaultDashboardBoard,
  createDefaultOutcomesBoard,
  OUTCOMES_BLOCK_IDS,
  dashboardBoardStateSchema,
  DASHBOARD_CARD_IDS,
  DASHBOARD_CARD_DEFINITIONS,
  DASHBOARD_TEMPLATES,
  renderedBoardColumns,
  snapBoardCardSize,
  type BoardGridMetrics,
  type DashboardBoardCard,
} from "./dashboard-board-model";

/**
 * CSS grid row-flow sparse auto-placement (the board does not use grid-flow-dense):
 * the cursor only moves forward, so an item that does not fit leaves cells behind.
 * Returns the empty cells before the last placed item's start cell.
 */
function interiorHoles(cards: readonly DashboardBoardCard[], columns: number) {
  const occupied = new Set<string>();
  const cell = (row: number, column: number) => `${row}:${column}`;
  let row = 0;
  let column = 0;
  let last = { row: 0, column: 0 };
  for (const card of cards) {
    const width = renderedBoardColumns(card.width, columns);
    const height = columns === 1 ? 1 : card.height;
    const fits = (top: number, left: number) => {
      if (left + width > columns) return false;
      for (let y = 0; y < height; y += 1)
        for (let x = 0; x < width; x += 1)
          if (occupied.has(cell(top + y, left + x))) return false;
      return true;
    };
    while (!fits(row, column)) {
      column += 1;
      if (column + width > columns) {
        row += 1;
        column = 0;
      }
    }
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1)
        occupied.add(cell(row + y, column + x));
    last = { row, column };
    column += width;
  }
  const holes: string[] = [];
  for (let y = 0; y <= last.row; y += 1)
    for (let x = 0; x < columns; x += 1)
      if ((y < last.row || x < last.column) && !occupied.has(cell(y, x)))
        holes.push(cell(y, x));
  return holes;
}

function board() {
  return {
    version: 1,
    activeViewId: "one",
    views: [
      { id: "one", name: "My dashboard", templateId: "starter", cards: [] },
    ],
  };
}

describe("dashboard board contract", () => {
  it("starts support with four service metrics followed by team and topics", () => {
    expect(createDashboardView("support", "Support", "support").cards).toEqual([
      { id: "first_response", width: 1, height: 1 },
      { id: "sla", width: 1, height: 1 },
      { id: "csat", width: 1, height: 1 },
      { id: "ttr", width: 1, height: 1 },
      { id: "team", width: 2, height: 2 },
      { id: "categories", width: 2, height: 2 },
    ]);
  });
  it.each(DASHBOARD_TEMPLATES.map(template => [template.id, template]))(
    "tiles the %s template without holes at two and four columns",
    (_id, template) => {
      for (const columns of [2, 4])
        expect(interiorHoles(template.cards, columns)).toEqual([]);
    }
  );
  it("detects the sparse-placement holes the previous starter layout left", () => {
    const previousStarter: DashboardBoardCard[] = [
      { id: "total", width: 1, height: 1 },
      { id: "new", width: 1, height: 1 },
      { id: "resolved", width: 1, height: 1 },
      { id: "first_response", width: 1, height: 1 },
      { id: "volume", width: 3, height: 2 },
      { id: "categories", width: 1, height: 2 },
      { id: "category_comparison", width: 4, height: 2 },
    ];
    expect(interiorHoles(previousStarter, 4)).toEqual([]);
    expect(interiorHoles(previousStarter, 2)).toEqual(["4:1", "5:1"]);
  });
  it("provides one canonical library definition for every persisted card", () => {
    expect(Object.keys(DASHBOARD_CARD_DEFINITIONS)).toEqual([
      ...DASHBOARD_CARD_IDS,
    ]);
    expect(DASHBOARD_CARD_DEFINITIONS.ai_usage).toMatchObject({
      group: "automation",
      scope: "ai",
      width: 2,
      height: 2,
    });
    expect(DASHBOARD_CARD_DEFINITIONS.campaigns.scope).toBe("campaigns");
    expect(DASHBOARD_CARD_DEFINITIONS.advertisements.scope).toBe("advertising");
    expect(DASHBOARD_CARD_DEFINITIONS.labels).toMatchObject({
      width: 2,
      height: 2,
      scope: "conversation",
    });
  });
  it("accepts an intentionally empty board", () => {
    expect(dashboardBoardStateSchema.parse(board())).toEqual(board());
  });

  it("retains a separately ordered Outcomes workspace in a legacy v1 board", () => {
    const state = {
      ...board(),
      outcomes: {
        cards: [
          { id: "delivery", width: 2, height: 1 },
          { id: "acquisition", width: 4, height: 2 },
        ],
      },
    };
    expect(dashboardBoardStateSchema.parse(state)).toEqual(state);
    expect(dashboardBoardStateSchema.parse(board())).toEqual(board());
  });

  it("creates an independent default Outcomes layout without modifying dashboard defaults", () => {
    const defaults = createDefaultOutcomesBoard();
    expect(defaults.cards).toEqual([
      { id: "acquisition", width: 4, height: 1 },
      { id: "attention", width: 2, height: 1 },
      { id: "delivery", width: 2, height: 1 },
    ]);
    defaults.cards.splice(0, 1);
    expect(createDefaultOutcomesBoard().cards).toHaveLength(3);
    expect(createDefaultDashboardBoard()).not.toHaveProperty("outcomes");
  });

  it("accepts all seven Outcomes reports or an intentionally empty workspace", () => {
    for (const cards of [
      [],
      OUTCOMES_BLOCK_IDS.map(id => ({ id, width: 4, height: 3 })),
    ]) {
      const state = { ...board(), outcomes: { cards } };
      expect(dashboardBoardStateSchema.parse(state)).toEqual(state);
    }
  });

  it.each([
    null,
    { cards: [{ id: "total", width: 1, height: 1 }] },
    { cards: [{ id: "acquisition", width: 5, height: 1 }] },
    { cards: [{ id: "acquisition", width: 4, height: 0 }] },
    { cards: [{ id: "acquisition", width: 4, height: 1, hidden: true }] },
    { cards: [], userId: "another-member" },
    {
      cards: [
        { id: "health", width: 4, height: 1 },
        { id: "health", width: 2, height: 2 },
      ],
    },
  ])("rejects malformed or duplicate Outcomes layouts %j", outcomes => {
    expect(
      dashboardBoardStateSchema.safeParse({ ...board(), outcomes }).success
    ).toBe(false);
  });

  it.each([
    { version: 2 },
    { activeViewId: "missing" },
    { views: [] },
    { userId: "another-member" },
  ])("rejects unsupported or inconsistent board state %j", patch => {
    expect(
      dashboardBoardStateSchema.safeParse({ ...board(), ...patch }).success
    ).toBe(false);
  });

  it.each([
    { id: "" },
    { name: "   " },
    { name: "a".repeat(81) },
    { templateId: "unknown" },
    { cards: [{ id: "revenue", width: 1, height: 1 }] },
    { cards: [{ id: "total", width: 5, height: 1 }] },
    { cards: [{ id: "total", width: 1, height: 4 }] },
    { cards: [{ id: "total", width: 1.5, height: 1 }] },
    { cards: [{ id: "total", width: 1, height: 1, hidden: true }] },
    { unknown: true },
  ])("rejects invalid view/card data %j", patch => {
    const state = board();
    expect(
      dashboardBoardStateSchema.safeParse({
        ...state,
        views: [{ ...state.views[0], ...patch }],
      }).success
    ).toBe(false);
  });

  it("rejects duplicate view and card identities", () => {
    const state = board();
    expect(
      dashboardBoardStateSchema.safeParse({
        ...state,
        views: [state.views[0], state.views[0]],
      }).success
    ).toBe(false);
    expect(
      dashboardBoardStateSchema.safeParse({
        ...state,
        views: [
          {
            ...state.views[0],
            cards: [
              { id: "total", width: 1, height: 1 },
              { id: "total", width: 2, height: 2 },
            ],
          },
        ],
      }).success
    ).toBe(false);
  });

  it("accepts the maximum bounded dashboard configuration", () => {
    const cards = DASHBOARD_CARD_IDS.map(id => ({ id, width: 4, height: 3 }));
    const views = Array.from({ length: 12 }, (_, index) => ({
      id: `view-${index}`,
      name: `View ${index}`,
      templateId: "starter",
      cards,
    }));
    expect(
      dashboardBoardStateSchema.safeParse({
        version: 1,
        activeViewId: "view-0",
        views,
      }).success
    ).toBe(true);
    expect(
      dashboardBoardStateSchema.safeParse({
        version: 1,
        activeViewId: "view-0",
        views: [...views, { ...views[0], id: "too-many" }],
      }).success
    ).toBe(false);
    expect(
      dashboardBoardStateSchema.safeParse({
        ...board(),
        views: [{ ...board().views[0], cards: [...cards, cards[0]] }],
      }).success
    ).toBe(false);
  });

  it("creates valid independent editable views from every starter", () => {
    for (const template of DASHBOARD_TEMPLATES) {
      const view = createDashboardView(
        template.id,
        "Custom dashboard",
        "custom"
      );
      expect(
        dashboardBoardStateSchema.safeParse({
          version: 1,
          activeViewId: "custom",
          views: [view],
        }).success
      ).toBe(true);
      const originalWidth = template.cards[0].width;
      view.cards[0].width = originalWidth === 4 ? 1 : 4;
      expect(template.cards[0].width).toBe(originalWidth);
    }
  });

  it("initializes a stable starter view with real conversation cards", () => {
    const state = createDefaultDashboardBoard();
    expect(state.activeViewId).toBe("starter");
    expect(state.views[0]).toMatchObject({
      id: "starter",
      name: "Overview",
      templateId: "starter",
    });
    expect(state.views[0].cards).toEqual([
      { id: "total", width: 1, height: 1 },
      { id: "new", width: 1, height: 1 },
      { id: "resolved", width: 1, height: 1 },
      { id: "first_response", width: 1, height: 1 },
      { id: "volume", width: 2, height: 2 },
      { id: "categories", width: 2, height: 2 },
      { id: "category_comparison", width: 4, height: 2 },
    ]);
    state.views[0].cards.splice(0, 1);
    expect(createDefaultDashboardBoard().views[0].cards).toHaveLength(7);
  });

  it("starts a member without a saved layout on the recommended template", () => {
    const state = createDefaultDashboardBoard("operations", "Team operations");
    expect(state).toMatchObject({
      activeViewId: "operations",
      views: [
        { id: "operations", name: "Team operations", templateId: "operations" },
      ],
    });
    expect(dashboardBoardStateSchema.safeParse(state).success).toBe(true);
  });
});

describe("drag-to-resize snapping", () => {
  const desktop: BoardGridMetrics = {
    columns: 4,
    columnWidth: 200,
    columnGap: 12,
    rowHeight: 145,
    rowGap: 12,
  };
  const tablet: BoardGridMetrics = { ...desktop, columns: 2, columnWidth: 300 };

  it("snaps to the nearest whole column and row on wide screens", () => {
    const card = { width: 1, height: 1 } as const;
    expect(snapBoardCardSize(card, { x: 0, y: 0 }, desktop)).toEqual(card);
    expect(snapBoardCardSize(card, { x: 100, y: 70 }, desktop)).toEqual({
      width: 1,
      height: 1,
    });
    expect(snapBoardCardSize(card, { x: 110, y: 80 }, desktop)).toEqual({
      width: 2,
      height: 2,
    });
    expect(snapBoardCardSize(card, { x: 424, y: 157 }, desktop)).toEqual({
      width: 3,
      height: 2,
    });
  });

  it("clamps to one to four columns and one to three rows", () => {
    const card = { width: 2, height: 2 } as const;
    expect(snapBoardCardSize(card, { x: 5000, y: 5000 }, desktop)).toEqual({
      width: 4,
      height: 3,
    });
    expect(snapBoardCardSize(card, { x: -5000, y: -5000 }, desktop)).toEqual({
      width: 1,
      height: 1,
    });
  });

  it("keeps the desktop width on two columns unless the span there changes", () => {
    const wide = { width: 4, height: 2 } as const;
    expect(snapBoardCardSize(wide, { x: 40, y: 160 }, tablet)).toEqual({
      width: 4,
      height: 3,
    });
    expect(snapBoardCardSize(wide, { x: -200, y: 0 }, tablet)).toEqual({
      width: 1,
      height: 2,
    });
    expect(
      snapBoardCardSize({ width: 1, height: 1 }, { x: 200, y: 0 }, tablet)
    ).toEqual({ width: 2, height: 1 });
    expect(
      snapBoardCardSize({ width: 3, height: 1 }, { x: 0, y: 0 }, tablet)
    ).toEqual({ width: 3, height: 1 });
  });

  it("does not resize on a single-column layout", () => {
    expect(
      snapBoardCardSize(
        { width: 2, height: 2 },
        { x: 500, y: 500 },
        { ...desktop, columns: 1 }
      )
    ).toEqual({ width: 2, height: 2 });
  });

  it("maps stored widths to the columns rendered at each breakpoint", () => {
    const widths = [1, 2, 3, 4] as const;
    expect(widths.map(width => renderedBoardColumns(width, 4))).toEqual([
      1, 2, 3, 4,
    ]);
    expect(widths.map(width => renderedBoardColumns(width, 2))).toEqual([
      1, 2, 2, 2,
    ]);
    expect(renderedBoardColumns(4, 1)).toBe(1);
  });
});
