import { buildCurrentConversationClassificationFilter } from "@icecore/shared/lib/conversation-classification-freshness";
import type { CompanyConversationVisibilityGate } from "@/lib/limits/company-limits";
import dayjs from "dayjs";
import mongoose, { type PipelineStage } from "mongoose";

/**
 * Query builders shared by the customer API v1 reads and the Airi MCP
 * endpoint. They only build filters and pipelines; callers own the queries
 * (and their time limits), so both surfaces count the same conversations.
 */

/** Deepest conversation offset a customer read may page to. */
export const CUSTOMER_CONVERSATION_MAX_OFFSET = 10_000;

/** Category breakdown rows the v1 analytics API returns. */
export const CUSTOMER_ANALYTICS_CATEGORY_LIMIT = 20;

/** Restricts a conversation filter to the ids the company plan shows. */
export function applyCustomerConversationVisibility(
  filter: Record<string, unknown>,
  gate: Pick<CompanyConversationVisibilityGate, "visibleConversationIds">
): Record<string, unknown> {
  if (gate.visibleConversationIds === null) return filter;
  return {
    ...filter,
    _id: {
      $in: gate.visibleConversationIds.map(
        id => new mongoose.Types.ObjectId(id)
      ),
    },
  };
}

/** The analytics window: `days` back from `now`, open-ended at the top. */
export function resolveCustomerAnalyticsWindow(days: number, now?: Date) {
  const end = now ? dayjs(now) : dayjs();
  return { start: end.subtract(days, "day"), end };
}

export function buildCustomerAnalyticsStatusPipeline(
  match: Record<string, unknown>
): PipelineStage[] {
  return [
    { $match: match },
    { $group: { _id: "$status", count: { $sum: 1 } } },
    { $project: { status: "$_id", count: 1, _id: 0 } },
  ];
}

export function buildCustomerAnalyticsChannelPipeline(
  match: Record<string, unknown>
): PipelineStage[] {
  return [
    { $match: match },
    { $group: { _id: "$channel", count: { $sum: 1 } } },
    { $project: { channel: "$_id", count: 1, _id: 0 } },
  ];
}

/** Counts only current classifications, largest categories first. */
export function buildCustomerAnalyticsCategoryPipeline(
  match: Record<string, unknown>,
  limit = CUSTOMER_ANALYTICS_CATEGORY_LIMIT
): PipelineStage[] {
  return [
    {
      $match: {
        ...match,
        ...buildCurrentConversationClassificationFilter(),
      },
    },
    { $group: { _id: "$classification.category", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: limit },
    { $project: { category: "$_id", count: 1, _id: 0 } },
  ];
}
