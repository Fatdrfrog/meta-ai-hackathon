import { resolveCustomerAnalyticsWindow } from "@/lib/customer-api/conversation-reads";
import { z } from "zod";
import type { AiriMcpAnalyticsWindowCounts } from "../types";
import {
  describeVisibilityCoverage,
  VISIBILITY_COVERAGE_PROPERTIES,
} from "./coverage";
import {
  arraySchema,
  BOOLEAN_SCHEMA,
  COUNT_SCHEMA,
  DATE_TIME_SCHEMA,
  defineAiriMcpTool,
  enumSchema,
  NULLABLE_STRING_SCHEMA,
  objectSchema,
  type JsonSchema,
} from "./define";

export const ANALYTICS_PERIODS = ["7d", "30d", "90d"] as const;
type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number];

const PERIOD_DAYS: Record<AnalyticsPeriod, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

export const analyticsSummaryArgs = z
  .object({ period: z.enum(ANALYTICS_PERIODS).default("30d") })
  .strict();

const windowSchema = objectSchema({
  start: DATE_TIME_SCHEMA,
  end: DATE_TIME_SCHEMA,
});

function countRowsSchema(key: string): JsonSchema {
  return arraySchema(
    objectSchema({ [key]: NULLABLE_STRING_SCHEMA, count: COUNT_SCHEMA })
  );
}

const windowCountsSchema = objectSchema({
  total: COUNT_SCHEMA,
  by_status: countRowsSchema("status"),
  by_channel: countRowsSchema("channel"),
  by_category: countRowsSchema("category"),
  categories_truncated: BOOLEAN_SCHEMA,
});

function serializeWindowCounts(counts: AiriMcpAnalyticsWindowCounts) {
  return {
    total: counts.total,
    by_status: counts.byStatus,
    by_channel: counts.byChannel,
    by_category: counts.byCategory,
    categories_truncated: counts.categoriesTruncated,
  };
}

export const getAnalyticsSummaryTool = defineAiriMcpTool({
  name: "get_analytics_summary",
  title: "Conversation analytics summary",
  description:
    "Conversation counts for this workspace over the last 7, 30 or 90 days and for the previous period of the same length: total, by status, by channel and by AI category. Counts follow the company plan's visibility limits, and category counts include only conversations with a current AI classification. Reads stored data only.",
  scope: "analytics",
  inputSchema: objectSchema(
    {
      period: {
        ...enumSchema(ANALYTICS_PERIODS),
        default: "30d",
        description: "Length of the current window, which ends now.",
      },
    },
    []
  ),
  outputSchema: objectSchema({
    period: enumSchema(ANALYTICS_PERIODS),
    days: COUNT_SCHEMA,
    current_window: windowSchema,
    previous_window: windowSchema,
    current: windowCountsSchema,
    previous: windowCountsSchema,
    coverage: objectSchema({
      ...VISIBILITY_COVERAGE_PROPERTIES,
      category_counts_current_classification_only: BOOLEAN_SCHEMA,
    }),
  }),
  args: analyticsSummaryArgs,
  async run({ period }, { auth, data, now }) {
    const days = PERIOD_DAYS[period];
    // Same window as GET /api/v1/analytics; the previous one ends where it starts.
    const current = resolveCustomerAnalyticsWindow(days, now);
    const previousStart = current.start.subtract(days, "day");
    const counts = await data.getAnalyticsCounts({
      workspaceId: auth.workspaceId,
      currentStart: current.start.toDate(),
      previousStart: previousStart.toDate(),
    });

    const coverage = describeVisibilityCoverage(counts.visibility);
    if (
      counts.current.categoriesTruncated ||
      counts.previous.categoriesTruncated
    ) {
      coverage.notes.push(
        "Category breakdowns list only the largest categories; smaller ones are omitted."
      );
    }
    const visibilityNote = counts.visibility.limited
      ? " Plan visibility limits apply."
      : "";

    return {
      summary: `Last ${days} days: ${counts.current.total} conversation(s); previous ${days} days: ${counts.previous.total}.${visibilityNote}`,
      structured: {
        period,
        days,
        current_window: {
          start: current.start.toISOString(),
          end: current.end.toISOString(),
        },
        previous_window: {
          start: previousStart.toISOString(),
          end: current.start.toISOString(),
        },
        current: serializeWindowCounts(counts.current),
        previous: serializeWindowCounts(counts.previous),
        coverage: {
          ...coverage,
          category_counts_current_classification_only: true,
        },
      },
      itemCount:
        counts.current.byStatus.length +
        counts.current.byChannel.length +
        counts.current.byCategory.length,
    };
  },
});
