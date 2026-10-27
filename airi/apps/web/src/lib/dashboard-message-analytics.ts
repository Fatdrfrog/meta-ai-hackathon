import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import {
  DASHBOARD_UNCATEGORIZED_CATEGORY,
  type DashboardComparisonPeriod,
  type DashboardMessageAnalytics,
} from "@/types/dashboard";
import type { PipelineStage } from "mongoose";

export type DashboardMessageAnalyticsFilters = {
  channels?: string[];
  categories?: string[];
  internalLabels?: string[];
  managerIds?: string[];
};

type PeriodKey = "current" | "previous";

type DashboardMessageAnalyticsAggregation = {
  totals?: Array<{ _id?: PeriodKey; count?: number }>;
  periodCategories?: Array<{
    _id?: { period?: PeriodKey; category?: string };
    count?: number;
  }>;
  dailyConversations?: Array<{
    _id?: { period?: PeriodKey; date?: string };
    count?: number;
  }>;
  categoriesByChannel?: Array<{
    _id?: { channel?: string; category?: string };
    count?: number;
  }>;
};

export function hasDashboardFilterValues(
  values: string[] | undefined
): values is string[] {
  return Array.isArray(values) && values.length > 0;
}

export function buildDashboardCategoryQueryMatch(
  field: string,
  categories: string[] | undefined
): Record<string, unknown> {
  if (!hasDashboardFilterValues(categories)) return {};

  const storedCategories = categories.filter(
    category => category !== DASHBOARD_UNCATEGORIZED_CATEGORY
  );
  if (!categories.includes(DASHBOARD_UNCATEGORIZED_CATEGORY)) {
    return { [field]: { $in: storedCategories } };
  }

  return {
    $or: [
      ...(storedCategories.length > 0
        ? [{ [field]: { $in: storedCategories } }]
        : []),
      { [field]: { $exists: false } },
      { [field]: null },
      { [field]: "" },
      { [field]: "Other" },
    ],
  };
}

function buildConversationOwnedFilterMatch(
  filters: DashboardMessageAnalyticsFilters | undefined
): Record<string, unknown> {
  return {
    ...buildDashboardCategoryQueryMatch(
      "dashboardConversation.classification.category",
      filters?.categories
    ),
    ...(hasDashboardFilterValues(filters?.internalLabels)
      ? {
          "dashboardConversation.internal_labels": {
            $in: filters.internalLabels,
          },
        }
      : {}),
    ...(hasDashboardFilterValues(filters?.managerIds)
      ? {
          "dashboardConversation.handled_by_agent_id": {
            $in: filters.managerIds,
          },
        }
      : {}),
  };
}

function buildNormalizedCategoryExpression() {
  const category = "$dashboardConversation.classification.category";
  return {
    $cond: [
      {
        $and: [
          { $eq: [{ $type: category }, "string"] },
          { $ne: [category, ""] },
          { $ne: [category, "Other"] },
        ],
      },
      category,
      DASHBOARD_UNCATEGORIZED_CATEGORY,
    ],
  };
}

function buildDashboardMessageAnalyticsPipeline({
  workspaceId,
  comparisonPeriod,
  filters,
}: {
  workspaceId: string;
  comparisonPeriod: DashboardComparisonPeriod;
  filters?: DashboardMessageAnalyticsFilters;
}): PipelineStage[] {
  const currentStart = new Date(comparisonPeriod.current.start);
  const currentEndExclusive = new Date(comparisonPeriod.current.endExclusive);
  const previousStart = comparisonPeriod.previous
    ? new Date(comparisonPeriod.previous.start)
    : currentStart;
  const previousEndExclusive = comparisonPeriod.previous
    ? new Date(comparisonPeriod.previous.endExclusive)
    : null;
  const conversationFilterMatch = buildConversationOwnedFilterMatch(filters);

  return [
    {
      $match: {
        workspaceId,
        date: { $gte: previousStart, $lt: currentEndExclusive },
      },
    },
    {
      $match: {
        direction: "inbound",
        ...(hasDashboardFilterValues(filters?.channels)
          ? { channel: { $in: filters.channels } }
          : {}),
      },
    },
    {
      $set: {
        dashboardPeriod: {
          $switch: {
            branches: [
              {
                case: {
                  $and: [
                    { $gte: ["$date", currentStart] },
                    { $lt: ["$date", currentEndExclusive] },
                  ],
                },
                then: "current",
              },
              ...(previousEndExclusive
                ? [
                    {
                      case: {
                        $and: [
                          { $gte: ["$date", previousStart] },
                          { $lt: ["$date", previousEndExclusive] },
                        ],
                      },
                      then: "previous",
                    },
                  ]
                : []),
            ],
            default: null,
          },
        },
      },
    },
    {
      $match: { dashboardPeriod: { $ne: null } },
    },
    {
      $group: {
        _id: {
          period: "$dashboardPeriod",
          conversation: "$conversation",
        },
        firstInboundAt: { $min: "$date" },
      },
    },
    {
      $lookup: {
        from: Conversation.collection.name,
        let: { conversationId: "$_id.conversation" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$_id", "$$conversationId"] },
                  { $eq: ["$workspaceId", workspaceId] },
                ],
              },
            },
          },
          {
            $project: {
              workspaceId: 1,
              channel: 1,
              "classification.category": 1,
              internal_labels: 1,
              handled_by_agent_id: 1,
            },
          },
        ],
        as: "dashboardConversation",
      },
    },
    { $unwind: "$dashboardConversation" },
    ...(Object.keys(conversationFilterMatch).length > 0
      ? [{ $match: conversationFilterMatch }]
      : []),
    {
      $set: {
        normalizedCategory: buildNormalizedCategoryExpression(),
      },
    },
    {
      $facet: {
        totals: [
          { $group: { _id: "$_id.period", count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ],
        periodCategories: [
          {
            $group: {
              _id: {
                period: "$_id.period",
                category: "$normalizedCategory",
              },
              count: { $sum: 1 },
            },
          },
          { $sort: { "_id.period": 1, "_id.category": 1 } },
        ],
        dailyConversations: [
          {
            $group: {
              _id: {
                period: "$_id.period",
                date: {
                  $dateToString: {
                    date: "$firstInboundAt",
                    format: "%Y-%m-%d",
                    timezone: comparisonPeriod.timeZone,
                  },
                },
              },
              count: { $sum: 1 },
            },
          },
          { $sort: { "_id.period": 1, "_id.date": 1 } },
        ],
        categoriesByChannel: [
          { $match: { "_id.period": "current" } },
          {
            $group: {
              _id: {
                channel: {
                  $ifNull: ["$dashboardConversation.channel", "unknown"],
                },
                category: "$normalizedCategory",
              },
              count: { $sum: 1 },
            },
          },
          { $sort: { "_id.category": 1, "_id.channel": 1 } },
        ],
      },
    },
  ] as PipelineStage[];
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function fetchDashboardMessageAnalytics({
  workspaceId,
  comparisonPeriod,
  filters,
}: {
  workspaceId: string;
  comparisonPeriod: DashboardComparisonPeriod;
  filters?: DashboardMessageAnalyticsFilters;
}): Promise<DashboardMessageAnalytics> {
  const rows = await Message.aggregate<DashboardMessageAnalyticsAggregation>(
    buildDashboardMessageAnalyticsPipeline({
      workspaceId,
      comparisonPeriod,
      filters,
    })
  ).allowDiskUse(true);
  const aggregation = rows[0] ?? {};
  const result: DashboardMessageAnalytics = {
    totals: { current: 0, previous: 0 },
    categories: { current: {}, previous: {} },
    dailySeries: { current: [], previous: [] },
    categoriesByChannel: [],
  };

  for (const row of aggregation.totals ?? []) {
    if (row._id === "current" || row._id === "previous") {
      result.totals[row._id] = readCount(row.count);
    }
  }
  for (const row of aggregation.periodCategories ?? []) {
    const period = row._id?.period;
    const category = row._id?.category;
    if ((period === "current" || period === "previous") && category) {
      result.categories[period][category] = readCount(row.count);
    }
  }
  for (const row of aggregation.dailyConversations ?? []) {
    const period = row._id?.period;
    const date = row._id?.date;
    if ((period === "current" || period === "previous") && date) {
      result.dailySeries[period].push({ date, total: readCount(row.count) });
    }
  }
  result.categoriesByChannel = (aggregation.categoriesByChannel ?? [])
    .filter(row => row._id?.channel && row._id?.category)
    .map(row => ({
      channel: row._id?.channel ?? "unknown",
      category: row._id?.category ?? DASHBOARD_UNCATEGORIZED_CATEGORY,
      count: readCount(row.count),
    }));

  return result;
}
