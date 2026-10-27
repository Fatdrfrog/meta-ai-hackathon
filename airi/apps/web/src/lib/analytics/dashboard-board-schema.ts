import { z } from "zod";
import { isRecord } from "@icecore/shared/lib/value-utils";

/**
 * Persisted personal analytics board contract. It lives in lib so the API route,
 * the Mongoose model and the client controller share one server-safe owner.
 */
export const DASHBOARD_CARD_IDS = [
  "total",
  "new",
  "resolved",
  "first_response",
  "in_progress",
  "sla",
  "repeat",
  "csat",
  "ttr",
  "volume",
  "category_comparison",
  "period_summary",
  "categories",
  "channels",
  "team",
  "activity",
  "advertisements",
  "labels",
  "ai_usage",
  "campaigns",
] as const;

export type DashboardCardId = (typeof DASHBOARD_CARD_IDS)[number];
export type AnalyticsBoardCard<CardId extends string> = {
  id: CardId;
  width: 1 | 2 | 3 | 4;
  height: 1 | 2 | 3;
};
export type DashboardBoardCard = AnalyticsBoardCard<DashboardCardId>;
export const OUTCOMES_BLOCK_IDS = [
  "acquisition",
  "attention",
  "delivery",
  "templates",
  "health",
  "flows",
  "retention",
] as const;
export type OutcomesBlockId = (typeof OUTCOMES_BLOCK_IDS)[number];
export type OutcomesBoardCard = AnalyticsBoardCard<OutcomesBlockId>;
export type OutcomesBoardState = { cards: OutcomesBoardCard[] };
export const DASHBOARD_TEMPLATE_IDS = [
  "starter",
  "sales",
  "support",
  "operations",
] as const;
export type DashboardTemplateId = (typeof DASHBOARD_TEMPLATE_IDS)[number];
export type DashboardBoardView = {
  id: string;
  name: string;
  templateId: DashboardTemplateId;
  cards: DashboardBoardCard[];
};
export type DashboardBoardState = {
  version: 1;
  activeViewId: string;
  views: DashboardBoardView[];
  /** Optional so saved v1 dashboard preferences remain valid without migration. */
  outcomes?: OutcomesBoardState;
};

export const DASHBOARD_MAX_VIEWS = 12;
export const BOARD_MAX_WIDTH = 4;
export const BOARD_MAX_HEIGHT = 3;

const dashboardCardSchema = z
  .object({
    id: z.enum(DASHBOARD_CARD_IDS),
    width: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    height: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  })
  .strict();

export const outcomesBoardStateSchema = z
  .object({
    cards: z
      .array(dashboardCardSchema.extend({ id: z.enum(OUTCOMES_BLOCK_IDS) }))
      .max(OUTCOMES_BLOCK_IDS.length),
  })
  .strict()
  .superRefine((state, context) => {
    if (new Set(state.cards.map(card => card.id)).size !== state.cards.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cards"],
        message: "Outcomes report IDs must be unique",
      });
    }
  });

export const dashboardViewSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(80),
    templateId: z.enum(DASHBOARD_TEMPLATE_IDS),
    cards: z.array(dashboardCardSchema).max(DASHBOARD_CARD_IDS.length),
  })
  .strict()
  .superRefine((view, context) => {
    if (new Set(view.cards.map(card => card.id)).size !== view.cards.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cards"],
        message: "Card IDs must be unique",
      });
    }
  });

/** Strict contract for every write: API body, Mongoose validator and client save. */
export const dashboardBoardStateSchema = z
  .object({
    version: z.literal(1),
    activeViewId: z.string().trim().min(1).max(80),
    views: z.array(dashboardViewSchema).min(1).max(DASHBOARD_MAX_VIEWS),
    outcomes: outcomesBoardStateSchema.optional(),
  })
  .strict()
  .superRefine((state, context) => {
    if (new Set(state.views.map(view => view.id)).size !== state.views.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["views"],
        message: "View IDs must be unique",
      });
    }
    if (!state.views.some(view => view.id === state.activeViewId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeViewId"],
        message: "Active view must exist",
      });
    }
  });

function boundedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= 80 ? text : null;
}

function boundedSpan<Span extends number>(
  value: unknown,
  max: number
): Span | null {
  return typeof value === "number" && Number.isInteger(value)
    ? (Math.min(max, Math.max(1, value)) as Span)
    : null;
}

function readCards<CardId extends string>(
  value: unknown,
  ids: readonly CardId[]
): AnalyticsBoardCard<CardId>[] {
  if (!Array.isArray(value)) return [];
  const cards: AnalyticsBoardCard<CardId>[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = ids.find(candidate => candidate === item.id);
    const width = boundedSpan<1 | 2 | 3 | 4>(item.width, BOARD_MAX_WIDTH);
    const height = boundedSpan<1 | 2 | 3>(item.height, BOARD_MAX_HEIGHT);
    // Unknown ids and extra fields come from other releases: drop them only.
    if (!id || !width || !height || cards.some(card => card.id === id))
      continue;
    cards.push({ id, width, height });
  }
  return cards;
}

function readVersionOne(
  raw: Record<string, unknown>
): DashboardBoardState | null {
  const views: DashboardBoardView[] = [];
  for (const item of Array.isArray(raw.views) ? raw.views : []) {
    if (!isRecord(item) || views.length >= DASHBOARD_MAX_VIEWS) continue;
    const id = boundedText(item.id);
    const name = boundedText(item.name);
    if (!id || !name || views.some(view => view.id === id)) continue;
    views.push({
      id,
      name,
      // A template added by a newer release only labels the starting point.
      templateId:
        DASHBOARD_TEMPLATE_IDS.find(template => template === item.templateId) ??
        "starter",
      cards: readCards(item.cards, DASHBOARD_CARD_IDS),
    });
  }
  if (!views.length) return null;
  const activeViewId = boundedText(raw.activeViewId);
  const state: DashboardBoardState = {
    version: 1,
    activeViewId:
      views.find(view => view.id === activeViewId)?.id ?? views[0].id,
    views,
  };
  if (isRecord(raw.outcomes) && Array.isArray(raw.outcomes.cards))
    state.outcomes = {
      cards: readCards(raw.outcomes.cards, OUTCOMES_BLOCK_IDS),
    };
  return state;
}

/**
 * Lenient read of a stored board. Writes stay strict, but a document written by
 * another release (rollback, preview build, renamed card) must not lock a member
 * out: unknown cards and fields are dropped and invalid views skipped. Returns
 * null when nothing usable remains; callers then show defaults, and the next save
 * replaces the stored document through the normal revision compare-and-swap.
 */
export function normalizeStoredDashboardBoard(
  raw: unknown
): DashboardBoardState | null {
  const strict = dashboardBoardStateSchema.safeParse(raw);
  if (strict.success) return strict.data;
  if (!isRecord(raw)) return null;
  switch (raw.version) {
    case 1: {
      const state = readVersionOne(raw);
      return state && dashboardBoardStateSchema.safeParse(state).success
        ? state
        : null;
    }
    // Migrate future versions here. An unknown version cannot be interpreted
    // safely, so it reads as unavailable instead of being guessed.
    default:
      return null;
  }
}
