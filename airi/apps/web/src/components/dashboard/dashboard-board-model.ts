import {
  BOARD_MAX_HEIGHT,
  BOARD_MAX_WIDTH,
  dashboardViewSchema,
  type DashboardBoardCard,
  type DashboardBoardState,
  type DashboardBoardView,
  type DashboardCardId,
  type DashboardTemplateId,
  type OutcomesBlockId,
  type OutcomesBoardCard,
  type OutcomesBoardState,
} from "@/lib/analytics/dashboard-board-schema";

// The persisted contract is owned by lib so server routes never import UI modules.
export {
  BOARD_MAX_HEIGHT,
  BOARD_MAX_WIDTH,
  DASHBOARD_CARD_IDS,
  DASHBOARD_MAX_VIEWS,
  DASHBOARD_TEMPLATE_IDS,
  OUTCOMES_BLOCK_IDS,
  dashboardBoardStateSchema,
  normalizeStoredDashboardBoard,
} from "@/lib/analytics/dashboard-board-schema";
export type {
  AnalyticsBoardCard,
  DashboardBoardCard,
  DashboardBoardState,
  DashboardBoardView,
  DashboardCardId,
  DashboardTemplateId,
  OutcomesBlockId,
  OutcomesBoardCard,
  OutcomesBoardState,
} from "@/lib/analytics/dashboard-board-schema";

export const DASHBOARD_CARD_GROUPS = [
  "conversations",
  "service",
  "sources",
  "team",
  "automation",
] as const;

type DashboardCardDefinition = {
  group: (typeof DASHBOARD_CARD_GROUPS)[number];
  scope: "conversation" | "ai" | "campaigns" | "advertising";
  width: DashboardBoardCard["width"];
  height: DashboardBoardCard["height"];
};

/**
 * Templates describe starting layouts, but do not own library groups or report scopes.
 * Keep those defaults beside the existing card IDs instead of inferring them from a template.
 * This metadata does not become part of persisted state.
 */
export const DASHBOARD_CARD_DEFINITIONS: Record<
  DashboardCardId,
  DashboardCardDefinition
> = {
  total: { group: "conversations", scope: "conversation", width: 1, height: 1 },
  new: { group: "conversations", scope: "conversation", width: 1, height: 1 },
  resolved: {
    group: "conversations",
    scope: "conversation",
    width: 1,
    height: 1,
  },
  first_response: {
    group: "service",
    scope: "conversation",
    width: 1,
    height: 1,
  },
  in_progress: {
    group: "conversations",
    scope: "conversation",
    width: 1,
    height: 1,
  },
  sla: { group: "service", scope: "conversation", width: 1, height: 1 },
  repeat: {
    group: "conversations",
    scope: "conversation",
    width: 1,
    height: 1,
  },
  csat: { group: "service", scope: "conversation", width: 1, height: 1 },
  ttr: { group: "service", scope: "conversation", width: 1, height: 1 },
  volume: {
    group: "conversations",
    scope: "conversation",
    width: 3,
    height: 2,
  },
  category_comparison: {
    group: "sources",
    scope: "conversation",
    width: 4,
    height: 2,
  },
  period_summary: {
    group: "conversations",
    scope: "conversation",
    width: 2,
    height: 2,
  },
  categories: { group: "sources", scope: "conversation", width: 1, height: 2 },
  channels: { group: "sources", scope: "conversation", width: 1, height: 2 },
  team: { group: "team", scope: "conversation", width: 2, height: 2 },
  activity: { group: "team", scope: "conversation", width: 2, height: 2 },
  advertisements: {
    group: "sources",
    scope: "advertising",
    width: 2,
    height: 2,
  },
  labels: { group: "sources", scope: "conversation", width: 2, height: 2 },
  ai_usage: { group: "automation", scope: "ai", width: 2, height: 2 },
  campaigns: { group: "automation", scope: "campaigns", width: 2, height: 2 },
};

export function createDashboardCard(
  id: DashboardCardId,
  width: DashboardBoardCard["width"] = DASHBOARD_CARD_DEFINITIONS[id].width,
  height: DashboardBoardCard["height"] = DASHBOARD_CARD_DEFINITIONS[id].height
): DashboardBoardCard {
  return { id, width, height };
}

/**
 * The grid uses sparse auto-placement at 2 and 4 columns, so every template tiles
 * completely at both widths: a row of four 1x1 metrics, then 2x2 pairs or a 4x2.
 */
export const DASHBOARD_TEMPLATES: readonly {
  id: DashboardTemplateId;
  cards: readonly DashboardBoardCard[];
}[] = [
  {
    id: "starter",
    cards: [
      createDashboardCard("total"),
      createDashboardCard("new"),
      createDashboardCard("resolved"),
      createDashboardCard("first_response"),
      createDashboardCard("volume", 2, 2),
      createDashboardCard("categories", 2, 2),
      createDashboardCard("category_comparison", 4, 2),
    ],
  },
  {
    id: "sales",
    cards: [
      createDashboardCard("total"),
      createDashboardCard("new"),
      createDashboardCard("repeat"),
      createDashboardCard("first_response"),
      createDashboardCard("volume", 2, 2),
      createDashboardCard("channels", 2, 2),
      createDashboardCard("advertisements", 2, 2),
      createDashboardCard("campaigns", 2, 2),
    ],
  },
  {
    id: "support",
    cards: [
      createDashboardCard("first_response"),
      createDashboardCard("sla"),
      createDashboardCard("csat"),
      createDashboardCard("ttr"),
      createDashboardCard("team", 2, 2),
      createDashboardCard("categories", 2, 2),
    ],
  },
  {
    id: "operations",
    cards: [
      createDashboardCard("total"),
      createDashboardCard("in_progress"),
      createDashboardCard("first_response"),
      createDashboardCard("sla"),
      createDashboardCard("team", 2, 2),
      createDashboardCard("activity", 2, 2),
      createDashboardCard("ai_usage", 4, 2),
    ],
  },
];

export function createDashboardView(
  templateId: DashboardTemplateId,
  name: string,
  id: string
): DashboardBoardView {
  const template = DASHBOARD_TEMPLATES.find(item => item.id === templateId)!;
  return dashboardViewSchema.parse({
    id,
    name,
    templateId,
    cards: template.cards.map(item => ({ ...item })),
  });
}

/** A member without a saved layout starts from one (recommended) template view. */
export function createDefaultDashboardBoard(
  templateId: DashboardTemplateId = "starter",
  name = "Overview"
): DashboardBoardState {
  return {
    version: 1,
    activeViewId: templateId,
    views: [createDashboardView(templateId, name, templateId)],
  };
}

export function createOutcomesCard(id: OutcomesBlockId): OutcomesBoardCard {
  return {
    id,
    width: id === "attention" || id === "delivery" ? 2 : 4,
    height: 1,
  };
}

export function createDefaultOutcomesBoard(): OutcomesBoardState {
  return {
    cards: [
      createOutcomesCard("acquisition"),
      createOutcomesCard("attention"),
      createOutcomesCard("delivery"),
    ],
  };
}

/** Rendered grid geometry, measured when a resize drag starts. */
export type BoardGridMetrics = {
  columns: number;
  columnWidth: number;
  columnGap: number;
  rowHeight: number;
  rowGap: number;
};
type BoardCardSize = Pick<DashboardBoardCard, "width" | "height">;

/** Columns a card spans on screen; mirrors the grid's sm/xl span classes. */
export function renderedBoardColumns(
  width: DashboardBoardCard["width"],
  columns: number
): number {
  if (columns >= BOARD_MAX_WIDTH) return width;
  if (columns <= 1) return 1;
  return width > 1 ? 2 : 1;
}

function snapSpan(pixels: number, unit: number, gap: number, max: number) {
  if (!(unit > 0)) return 1;
  return Math.min(max, Math.max(1, Math.round((pixels + gap) / (unit + gap))));
}

/**
 * Snap a pointer drag to whole grid cells (width 1-4, height 1-3). Two-column
 * screens show every wide card at two columns, so the stored desktop width only
 * changes when the drag changes how many columns the card spans there.
 */
export function snapBoardCardSize(
  card: BoardCardSize,
  delta: { x: number; y: number },
  metrics: BoardGridMetrics
): BoardCardSize {
  if (metrics.columns < 2) return { width: card.width, height: card.height };
  const startColumns = renderedBoardColumns(card.width, metrics.columns);
  const columns = snapSpan(
    startColumns * metrics.columnWidth +
      (startColumns - 1) * metrics.columnGap +
      delta.x,
    metrics.columnWidth,
    metrics.columnGap,
    Math.min(BOARD_MAX_WIDTH, metrics.columns)
  );
  const height = snapSpan(
    card.height * metrics.rowHeight +
      (card.height - 1) * metrics.rowGap +
      delta.y,
    metrics.rowHeight,
    metrics.rowGap,
    BOARD_MAX_HEIGHT
  ) as BoardCardSize["height"];
  const width =
    columns === startColumns
      ? card.width
      : metrics.columns >= BOARD_MAX_WIDTH || columns === 1
        ? (columns as BoardCardSize["width"])
        : (Math.max(2, card.width) as BoardCardSize["width"]);
  return { width, height };
}
