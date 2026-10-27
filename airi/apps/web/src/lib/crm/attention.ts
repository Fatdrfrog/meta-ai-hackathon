import type { CrmFollowUpKind } from "./follow-up";
import { CRM_UNASSIGNED_STAGE_KEY } from "./stages";

/** Same 3-day window as request-list SLA (`SLA_WINDOW_MS` in derive.ts). */
export const CRM_ATTENTION_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export const CRM_ATTENTION_SCAN_LIMIT = 200;

export const CRM_TERMINAL_STAGE_KEYS = new Set(["won", "lost"]);

export const CRM_NOISE_CATEGORIES = new Set(["Support", "Spam"]);

export const CRM_ATTENTION_FILTERS = [
  "all",
  "attention",
  "needs_reply",
  "ghosted",
  "stalled",
] as const;

export type CrmAttentionFilter = (typeof CRM_ATTENTION_FILTERS)[number];

export const CRM_ATTENTION_CHIP_ORDER: CrmAttentionFilter[] = [
  "attention",
  "needs_reply",
  "ghosted",
  "stalled",
  "all",
];

export type CrmAttentionKind = "needs_reply" | "ghosted" | "stalled";

export type CrmAttentionInput = {
  stageKey: string;
  now: Date;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  isUnread: boolean;
  conversationStatus: string | null;
  stageEnteredAt: Date | null;
  ghostedAfterMs?: number;
  stalledAfterMs?: number;
};

export function parseCrmAttentionFilter(
  value: string | null | undefined
): CrmAttentionFilter {
  switch (value) {
    case "all":
    case "attention":
    case "needs_reply":
    case "ghosted":
    case "stalled":
      return value;
    case null:
    case undefined:
    case "":
      return "attention";
    default:
      return "attention";
  }
}

export function isTerminalCrmStage(stageKey: string): boolean {
  return CRM_TERMINAL_STAGE_KEYS.has(stageKey);
}

export function isCrmNoiseCategory(category: string | null): boolean {
  return Boolean(category && CRM_NOISE_CATEGORIES.has(category));
}

function isClosedStatus(status: string | null): boolean {
  return status === "closed";
}

function customerIsWaitingForReply(input: {
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  isUnread: boolean;
}): boolean {
  if (input.lastInboundAt && input.lastOutboundAt) {
    return input.lastInboundAt.getTime() > input.lastOutboundAt.getTime();
  }
  if (input.lastInboundAt && !input.lastOutboundAt) {
    return true;
  }
  return input.isUnread;
}

function isOlderThanWindow(
  value: Date | null,
  now: Date,
  windowMs: number
): boolean {
  if (!value) return false;
  return now.getTime() - value.getTime() >= windowMs;
}

export function deriveCrmCardAttention(
  input: CrmAttentionInput
): CrmAttentionKind[] {
  if (isTerminalCrmStage(input.stageKey)) {
    return [];
  }

  const ghostedAfterMs = input.ghostedAfterMs ?? CRM_ATTENTION_WINDOW_MS;
  const stalledAfterMs = input.stalledAfterMs ?? CRM_ATTENTION_WINDOW_MS;
  const attention: CrmAttentionKind[] = [];
  const needsReply =
    !isClosedStatus(input.conversationStatus) &&
    customerIsWaitingForReply(input);

  if (needsReply) {
    attention.push("needs_reply");
  } else if (isOlderThanWindow(input.lastInboundAt, input.now, ghostedAfterMs)) {
    attention.push("ghosted");
  }

  const stalled =
    input.stageKey !== CRM_UNASSIGNED_STAGE_KEY &&
    isOlderThanWindow(input.stageEnteredAt, input.now, stalledAfterMs);
  if (stalled) {
    attention.push("stalled");
  }

  return attention;
}

export function cardMatchesAttentionFilter(
  attention: readonly CrmAttentionKind[],
  category: string | null,
  filter: CrmAttentionFilter,
  salesOnly: boolean,
  hideSupportSpam = false,
  followUpKind: CrmFollowUpKind | null = null
): boolean {
  if (salesOnly && category !== "Sales") {
    return false;
  }
  if (hideSupportSpam && isCrmNoiseCategory(category)) {
    return false;
  }

  switch (filter) {
    case "all":
      return true;
    case "attention":
      return attention.length > 0 || followUpKind === "review_quote";
    case "needs_reply":
      return attention.includes("needs_reply");
    case "ghosted":
      return attention.includes("ghosted");
    case "stalled":
      return attention.includes("stalled");
    default: {
      const exhaustive: never = filter;
      return exhaustive;
    }
  }
}

export function compareCrmAttentionCards(
  left: {
    attention: readonly CrmAttentionKind[];
    slaDueAt: Date | null;
    lastInboundAt: Date | null;
  },
  right: {
    attention: readonly CrmAttentionKind[];
    slaDueAt: Date | null;
    lastInboundAt: Date | null;
  }
): number {
  const rank = (kinds: readonly CrmAttentionKind[]) => {
    if (kinds.includes("needs_reply")) return 0;
    if (kinds.includes("ghosted")) return 1;
    if (kinds.includes("stalled")) return 2;
    return 3;
  };

  const rankDiff = rank(left.attention) - rank(right.attention);
  if (rankDiff !== 0) return rankDiff;

  const leftSla = left.slaDueAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const rightSla = right.slaDueAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (leftSla !== rightSla) return leftSla - rightSla;

  const leftInbound = left.lastInboundAt?.getTime() ?? 0;
  const rightInbound = right.lastInboundAt?.getTime() ?? 0;
  return rightInbound - leftInbound;
}
