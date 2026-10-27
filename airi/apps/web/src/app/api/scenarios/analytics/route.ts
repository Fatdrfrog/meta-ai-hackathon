import { ensureIndexes } from "@/lib/mongo";
import {
  buildScenarioAnalyticsMatchCounts,
  buildScenarioFunnelSteps,
  buildScenarioRecommendationCards,
  computeMedian,
  computeScenarioAnalyticsRate,
  formatScenarioAnalyticsReason,
  type ScenarioAnalyticsFlowMetrics,
  type ScenarioAnalyticsScenarioMetrics,
  type ScenarioFunnelTrendPoint,
} from "@/lib/scenarios/scenario-analytics";
import { parsePositiveInt } from "@/lib/api/query-params";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import type { ScenarioTriggerLogFilterSummary } from "@/lib/scenarios/trigger-log-meta";
import { ScenarioFlowEvent } from "@/models/scenario-flow-event";
import { ScenarioTriggerDailyMetric } from "@/models/scenario-trigger-daily-metric";
import { ScenarioTriggerLog } from "@/models/scenario-trigger-log";
import { NextResponse } from "next/server";
import {
  readNonEmptyString,
  readDate as asDate,
} from "@icecore/shared/lib/value-utils";
import { requiredFieldResponse } from "@/lib/api/json-body";

type FlowEventConversationAggregate = {
  _id: {
    scenarioId?: string | null;
    scenarioName?: string | null;
    flowId?: string | null;
    conversationId?: string | null;
    customerWaId?: string | null;
  };
  events?: Array<{
    eventType?: "sent" | "read" | "submitted";
    eventAt?: Date | string;
  }>;
  lastEventAt?: Date | string | null;
};

type DailyMetricRecord = {
  day?: Date | string;
  totalCount?: number;
  matchedCount?: number;
};

type MatchCountsByDayRecord = {
  _id?: string;
  winnerCount?: number;
  noMatchingActionCount?: number;
};

type CountByLabelRecord = {
  _id?: string | null;
  count?: number;
};

type ScenarioAggregateRecord = {
  _id?: string | null;
  scenarioName?: string | null;
  evaluatedCount?: number;
  triggerMatchedCount?: number;
  winnerCount?: number;
  triggerMismatchCount?: number;
  noMatchingActionCount?: number;
  blockedCount?: number;
  blockReasons?: string[];
  filters?: ScenarioTriggerLogFilterSummary | null;
};

type BreakdownAggregateRecord = {
  _id?: string | null;
  evaluatedCount?: number;
  triggerMatchedCount?: number;
  winnerCount?: number;
};

type TriggerLogRecord = {
  conversationId?: string | null;
  scenarioId?: string | null;
  scenarioName?: string | null;
  mismatchReason?: string | null;
  evaluatedAt?: Date | string | null;
  eventKind?: string | null;
  triggerType?: string | null;
  selectedActionType?: string | null;
  meta?: {
    filters?: ScenarioTriggerLogFilterSummary | null;
  } | null;
};

type FunnelBucket = {
  sent: number;
  read: number;
  submitted: number;
};

const SCENARIO_BLOCKED_MISMATCH_REASONS = [
  "already_started_in_conversation",
  "blocked_by_once_per_conversation",
] as const;

const ACTIVE_SCENARIO_MISMATCH_REASONS = [
  "trigger_mismatch",
  "flow_no_matching_action",
  "action_channel_mismatch",
  "already_started_in_conversation",
  "blocked_by_once_per_conversation",
  "fallback_suppressed_recent_specific_session",
] as const;

function toUtcDayKey(value: Date | string | null | undefined) {
  const date = asDate(value);
  return date ? date.toISOString().slice(0, 10) : null;
}

function buildUtcDayRange(startDate: Date, endDate: Date) {
  const days: string[] = [];
  const cursor = new Date(
    Date.UTC(
      startDate.getUTCFullYear(),
      startDate.getUTCMonth(),
      startDate.getUTCDate()
    )
  );
  const end = new Date(
    Date.UTC(
      endDate.getUTCFullYear(),
      endDate.getUTCMonth(),
      endDate.getUTCDate()
    )
  );

  while (cursor.getTime() <= end.getTime()) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return days;
}

function buildTrendLabel(dayKey: string) {
  return dayKey.slice(5);
}

function sortByCountDesc<T extends { count?: number }>(left: T, right: T) {
  return (right.count ?? 0) - (left.count ?? 0);
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = (searchParams.get("workspaceId") || "").trim();
    const days = parsePositiveInt(searchParams.get("days"), 14, 1, 90);
    const scenarioId = readNonEmptyString(searchParams.get("scenarioId"));
    const triggerType = readNonEmptyString(searchParams.get("triggerType"));
    const eventKind = readNonEmptyString(searchParams.get("eventKind"));

    if (!workspaceId) return requiredFieldResponse("workspaceId");

    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) {
      return access.response;
    }

    await ensureIndexes();

    const endDate = new Date();
    const startDate = new Date();
    startDate.setUTCDate(startDate.getUTCDate() - days);
    const startOfDay = new Date(
      Date.UTC(
        startDate.getUTCFullYear(),
        startDate.getUTCMonth(),
        startDate.getUTCDate()
      )
    );

    const triggerLogMatch: Record<string, unknown> = {
      workspaceId,
      evaluatedAt: { $gte: startDate },
    };
    if (scenarioId) {
      triggerLogMatch.scenarioId = scenarioId;
    }
    if (triggerType) {
      triggerLogMatch.triggerType = triggerType;
    }
    if (eventKind) {
      triggerLogMatch.eventKind = eventKind;
    }

    const flowEventMatch: Record<string, unknown> = {
      workspaceId,
      eventAt: { $gte: startDate },
    };
    if (scenarioId) {
      flowEventMatch.scenarioId = scenarioId;
    } else {
      flowEventMatch.scenarioId = { $type: "string" };
    }

    const matchCounts = buildScenarioAnalyticsMatchCounts();
    const [
      dailyMetrics,
      logMatchCountsByDay,
      topMismatchReasonsRaw,
      scenarioAggregates,
      triggerTypeBreakdownRaw,
      eventKindBreakdownRaw,
      recentAffectedLogs,
      flowConversationGroups,
    ] = await Promise.all([
      ScenarioTriggerDailyMetric.find({
        workspaceId,
        day: { $gte: startOfDay },
        ...(scenarioId ? { scenarioId } : {}),
        ...(triggerType ? { triggerType } : {}),
        ...(eventKind ? { eventKind } : {}),
      })
        .select({
          day: 1,
          totalCount: 1,
          matchedCount: 1,
        })
        .lean<DailyMetricRecord[]>(),
      ScenarioTriggerLog.aggregate<MatchCountsByDayRecord>([
        { $match: triggerLogMatch },
        {
          $group: {
            _id: {
              $dateToString: {
                date: "$evaluatedAt",
                format: "%Y-%m-%d",
                timezone: "UTC",
              },
            },
            winnerCount: matchCounts.winnerCount,
            noMatchingActionCount: matchCounts.noMatchingActionCount,
          },
        },
        { $sort: { _id: 1 } },
      ]),
      ScenarioTriggerLog.aggregate<CountByLabelRecord>([
        {
          $match: {
            ...triggerLogMatch,
            mismatchReason: { $in: ACTIVE_SCENARIO_MISMATCH_REASONS },
          },
        },
        {
          $group: {
            _id: "$mismatchReason",
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1, _id: 1 } },
        { $limit: 10 },
      ]),
      ScenarioTriggerLog.aggregate<ScenarioAggregateRecord>([
        { $match: triggerLogMatch },
        { $sort: { evaluatedAt: -1 } },
        {
          $group: {
            _id: "$scenarioId",
            scenarioName: { $first: "$scenarioName" },
            evaluatedCount: { $sum: 1 },
            triggerMatchedCount: matchCounts.triggerMatchedCount,
            winnerCount: matchCounts.winnerCount,
            triggerMismatchCount: {
              $sum: {
                $cond: [{ $eq: ["$mismatchReason", "trigger_mismatch"] }, 1, 0],
              },
            },
            noMatchingActionCount: matchCounts.noMatchingActionCount,
            blockedCount: {
              $sum: {
                $cond: [
                  {
                    $in: ["$mismatchReason", SCENARIO_BLOCKED_MISMATCH_REASONS],
                  },
                  1,
                  0,
                ],
              },
            },
            blockReasons: {
              $push: {
                $cond: [
                  {
                    $in: ["$mismatchReason", SCENARIO_BLOCKED_MISMATCH_REASONS],
                  },
                  "$mismatchReason",
                  "$$REMOVE",
                ],
              },
            },
            filters: { $first: "$meta.filters" },
          },
        },
      ]),
      ScenarioTriggerLog.aggregate<BreakdownAggregateRecord>([
        { $match: triggerLogMatch },
        {
          $group: {
            _id: "$triggerType",
            evaluatedCount: { $sum: 1 },
            triggerMatchedCount: matchCounts.triggerMatchedCount,
            winnerCount: matchCounts.winnerCount,
          },
        },
      ]),
      ScenarioTriggerLog.aggregate<BreakdownAggregateRecord>([
        { $match: triggerLogMatch },
        {
          $group: {
            _id: "$eventKind",
            evaluatedCount: { $sum: 1 },
            triggerMatchedCount: matchCounts.triggerMatchedCount,
            winnerCount: matchCounts.winnerCount,
          },
        },
      ]),
      ScenarioTriggerLog.find({
        ...triggerLogMatch,
        mismatchReason: { $in: ACTIVE_SCENARIO_MISMATCH_REASONS },
      })
        .sort({ evaluatedAt: -1 })
        .limit(50)
        .select({
          conversationId: 1,
          scenarioId: 1,
          scenarioName: 1,
          mismatchReason: 1,
          evaluatedAt: 1,
          eventKind: 1,
          triggerType: 1,
          selectedActionType: 1,
          meta: 1,
        })
        .lean<TriggerLogRecord[]>(),
      ScenarioFlowEvent.aggregate<FlowEventConversationAggregate>([
        { $match: flowEventMatch },
        {
          $group: {
            _id: {
              scenarioId: "$scenarioId",
              scenarioName: "$scenarioName",
              flowId: "$flowId",
              conversationId: "$conversationId",
              customerWaId: "$customerWaId",
            },
            events: {
              $push: {
                eventType: "$eventType",
                eventAt: "$eventAt",
              },
            },
            lastEventAt: { $max: "$eventAt" },
          },
        },
      ]),
    ]);

    const scenarioMetrics: ScenarioAnalyticsScenarioMetrics[] =
      scenarioAggregates
        .map(item => ({
          scenarioId: String(item._id || "").trim(),
          scenarioName: String(item.scenarioName || "").trim() || "Scenario",
          evaluatedCount: Number(item.evaluatedCount || 0),
          triggerMatchedCount: Number(item.triggerMatchedCount || 0),
          winnerCount: Number(item.winnerCount || 0),
          triggerMismatchCount: Number(item.triggerMismatchCount || 0),
          noMatchingActionCount: Number(item.noMatchingActionCount || 0),
          blockedCount: Number(item.blockedCount || 0),
          blockedReasons: Array.isArray(item.blockReasons)
            ? item.blockReasons
                .map(reason => String(reason || "").trim())
                .filter(Boolean)
            : [],
          filters: item.filters || null,
        }))
        .filter(item => item.scenarioId)
        .sort((left, right) => right.evaluatedCount - left.evaluatedCount);

    const totalEvaluatedCount = scenarioMetrics.reduce(
      (sum, row) => sum + row.evaluatedCount,
      0
    );
    const totalTriggerMatchedCount = scenarioMetrics.reduce(
      (sum, row) => sum + row.triggerMatchedCount,
      0
    );
    const totalWinnerCount = scenarioMetrics.reduce(
      (sum, row) => sum + row.winnerCount,
      0
    );

    const dailyTrendMap = new Map<
      string,
      {
        evaluatedCount: number;
        triggerMatchedCount: number;
        winnerCount: number;
      }
    >();

    for (const dayKey of buildUtcDayRange(startDate, endDate)) {
      dailyTrendMap.set(dayKey, {
        evaluatedCount: 0,
        triggerMatchedCount: 0,
        winnerCount: 0,
      });
    }

    for (const metric of dailyMetrics) {
      const dayKey = toUtcDayKey(metric.day);
      if (!dayKey) continue;
      const current = dailyTrendMap.get(dayKey) || {
        evaluatedCount: 0,
        triggerMatchedCount: 0,
        winnerCount: 0,
      };
      const matchedCount = Number(metric.matchedCount || 0);
      current.evaluatedCount += Number(metric.totalCount || 0);
      current.triggerMatchedCount += matchedCount;
      dailyTrendMap.set(dayKey, current);
    }

    for (const item of logMatchCountsByDay) {
      const dayKey = readNonEmptyString(item._id);
      if (!dayKey) continue;
      const current = dailyTrendMap.get(dayKey) || {
        evaluatedCount: 0,
        triggerMatchedCount: 0,
        winnerCount: 0,
      };
      current.triggerMatchedCount += Number(item.noMatchingActionCount || 0);
      current.winnerCount += Number(item.winnerCount || 0);
      dailyTrendMap.set(dayKey, current);
    }

    const dailyTrend: ScenarioFunnelTrendPoint[] = Array.from(
      dailyTrendMap.entries()
    )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, counts]) => ({
        date,
        label: buildTrendLabel(date),
        evaluatedCount: counts.evaluatedCount,
        triggerMatchedCount: counts.triggerMatchedCount,
        winnerCount: counts.winnerCount,
        overallConversion: computeScenarioAnalyticsRate(
          counts.winnerCount,
          counts.evaluatedCount
        ),
        relativeConversion: computeScenarioAnalyticsRate(
          counts.winnerCount,
          counts.triggerMatchedCount
        ),
      }));

    const scenarioFunnelSteps = buildScenarioFunnelSteps([
      {
        key: "evaluated",
        label: "Evaluated",
        count: totalEvaluatedCount,
      },
      {
        key: "trigger_matched",
        label: "Trigger matched",
        count: totalTriggerMatchedCount,
      },
      {
        key: "winner",
        label: "Winner",
        count: totalWinnerCount,
      },
    ]);

    const scenarioConversationMap = new Map<
      string,
      {
        scenarioId: string;
        scenarioName: string;
        customerWaId: string;
        conversationId: string;
        sentAt?: string;
        readAt?: string;
        submittedAt?: string;
        lastEventAt?: string;
      }
    >();
    const scenarioFlowMap = new Map<
      string,
      FunnelBucket & {
        scenarioId: string;
        scenarioName: string;
        flowId: string;
      }
    >();

    for (const group of flowConversationGroups) {
      const groupedScenarioId = String(group._id?.scenarioId || "").trim();
      const groupedFlowId = String(group._id?.flowId || "").trim();
      const groupedConversationId = String(
        group._id?.conversationId || ""
      ).trim();
      if (!groupedScenarioId || !groupedFlowId || !groupedConversationId) {
        continue;
      }

      const scenarioName =
        String(group._id?.scenarioName || "").trim() || "Scenario";
      const customerWaId =
        String(group._id?.customerWaId || "").trim() || groupedConversationId;
      const flowKey = `${groupedScenarioId}::${groupedFlowId}`;
      const scenarioConversationKey = `${groupedScenarioId}::${groupedConversationId}`;

      let sentAt: Date | null = null;
      let readAt: Date | null = null;
      let submittedAt: Date | null = null;

      for (const event of group.events || []) {
        const eventAt = asDate(event.eventAt);
        if (!eventAt) continue;
        if (event.eventType === "sent") {
          sentAt =
            !sentAt || eventAt.getTime() < sentAt.getTime() ? eventAt : sentAt;
        } else if (event.eventType === "read") {
          readAt =
            !readAt || eventAt.getTime() < readAt.getTime() ? eventAt : readAt;
        } else if (event.eventType === "submitted") {
          submittedAt =
            !submittedAt || eventAt.getTime() < submittedAt.getTime()
              ? eventAt
              : submittedAt;
        }
      }

      const existingScenarioConversation = scenarioConversationMap.get(
        scenarioConversationKey
      ) || {
        scenarioId: groupedScenarioId,
        scenarioName,
        customerWaId,
        conversationId: groupedConversationId,
      };

      if (sentAt) {
        const sentIso = sentAt.toISOString();
        if (
          !existingScenarioConversation.sentAt ||
          sentIso < existingScenarioConversation.sentAt
        ) {
          existingScenarioConversation.sentAt = sentIso;
        }
      }
      if (readAt) {
        const readIso = readAt.toISOString();
        if (
          !existingScenarioConversation.readAt ||
          readIso < existingScenarioConversation.readAt
        ) {
          existingScenarioConversation.readAt = readIso;
        }
      }
      if (submittedAt) {
        const submittedIso = submittedAt.toISOString();
        if (
          !existingScenarioConversation.submittedAt ||
          submittedIso < existingScenarioConversation.submittedAt
        ) {
          existingScenarioConversation.submittedAt = submittedIso;
        }
      }

      const groupLastEventAt = asDate(group.lastEventAt);
      if (groupLastEventAt) {
        const lastEventIso = groupLastEventAt.toISOString();
        if (
          !existingScenarioConversation.lastEventAt ||
          lastEventIso > existingScenarioConversation.lastEventAt
        ) {
          existingScenarioConversation.lastEventAt = lastEventIso;
        }
      }

      scenarioConversationMap.set(
        scenarioConversationKey,
        existingScenarioConversation
      );

      const flowBucket = scenarioFlowMap.get(flowKey) || {
        scenarioId: groupedScenarioId,
        scenarioName,
        flowId: groupedFlowId,
        sent: 0,
        read: 0,
        submitted: 0,
      };
      if (sentAt) flowBucket.sent += 1;
      if (readAt) flowBucket.read += 1;
      if (submittedAt) flowBucket.submitted += 1;
      scenarioFlowMap.set(flowKey, flowBucket);
    }

    const scenarioBucketMap = new Map<
      string,
      FunnelBucket & {
        scenarioId: string;
        scenarioName: string;
      }
    >();
    const sentToReadMinutes: number[] = [];
    const readToSubmitMinutes: number[] = [];

    for (const row of scenarioConversationMap.values()) {
      const bucket = scenarioBucketMap.get(row.scenarioId) || {
        scenarioId: row.scenarioId,
        scenarioName: row.scenarioName,
        sent: 0,
        read: 0,
        submitted: 0,
      };
      if (row.sentAt) bucket.sent += 1;
      if (row.readAt) bucket.read += 1;
      if (row.submittedAt) bucket.submitted += 1;
      scenarioBucketMap.set(row.scenarioId, bucket);

      const sentDate = asDate(row.sentAt);
      const readDate = asDate(row.readAt);
      const submittedDate = asDate(row.submittedAt);

      if (sentDate && readDate && readDate.getTime() >= sentDate.getTime()) {
        sentToReadMinutes.push(
          (readDate.getTime() - sentDate.getTime()) / (1000 * 60)
        );
      }
      if (
        readDate &&
        submittedDate &&
        submittedDate.getTime() >= readDate.getTime()
      ) {
        readToSubmitMinutes.push(
          (submittedDate.getTime() - readDate.getTime()) / (1000 * 60)
        );
      }
    }

    const legacyScenarioRows = Array.from(scenarioBucketMap.values())
      .map(row => ({
        scenarioId: row.scenarioId,
        scenarioName: row.scenarioName,
        sent: row.sent,
        read: row.read,
        submitted: row.submitted,
        droppedAfterRead: Math.max(row.read - row.submitted, 0),
        readRate: computeScenarioAnalyticsRate(row.read, row.sent),
        submitRateFromRead: computeScenarioAnalyticsRate(
          row.submitted,
          row.read
        ),
      }))
      .sort((left, right) => right.read - left.read);

    const legacyFlowRows = Array.from(scenarioFlowMap.values())
      .map(row => ({
        ...row,
        droppedAfterRead: Math.max(row.read - row.submitted, 0),
      }))
      .sort((left, right) => right.read - left.read)
      .slice(0, 50);

    const legacyCustomerRows = Array.from(scenarioConversationMap.values())
      .map(row => ({
        scenarioId: row.scenarioId,
        scenarioName: row.scenarioName,
        customerWaId: row.customerWaId,
        conversationId: row.conversationId,
        sentAt: row.sentAt,
        readAt: row.readAt,
        submittedAt: row.submittedAt,
        submitRateHint: row.submittedAt
          ? "submitted"
          : row.readAt
            ? "dropped"
            : "pending",
      }))
      .sort((left, right) => {
        const leftTime = Date.parse(
          left.submittedAt || left.readAt || left.sentAt || ""
        );
        const rightTime = Date.parse(
          right.submittedAt || right.readAt || right.sentAt || ""
        );
        return (
          (Number.isFinite(rightTime) ? rightTime : 0) -
          (Number.isFinite(leftTime) ? leftTime : 0)
        );
      })
      .slice(0, 200);

    const flowSentCount = legacyScenarioRows.reduce(
      (sum, row) => sum + row.sent,
      0
    );
    const flowReadCount = legacyScenarioRows.reduce(
      (sum, row) => sum + row.read,
      0
    );
    const flowSubmittedCount = legacyScenarioRows.reduce(
      (sum, row) => sum + row.submitted,
      0
    );

    const flowOutcomeSteps = buildScenarioFunnelSteps([
      { key: "sent", label: "Sent", count: flowSentCount },
      { key: "read", label: "Read", count: flowReadCount },
      { key: "submitted", label: "Submitted", count: flowSubmittedCount },
    ]);

    const flowMetricsByScenarioId = new Map<
      string,
      ScenarioAnalyticsFlowMetrics
    >(
      legacyScenarioRows.map(row => [
        row.scenarioId,
        {
          scenarioId: row.scenarioId,
          scenarioName: row.scenarioName,
          readCount: row.read,
          submittedCount: row.submitted,
        },
      ])
    );

    const recommendations = buildScenarioRecommendationCards({
      scenarioMetrics,
      flowMetricsByScenarioId,
    });

    const topMismatchReasons = topMismatchReasonsRaw
      .map(item => ({
        id: readNonEmptyString(item._id) || "unknown",
        label: formatScenarioAnalyticsReason(item._id),
        count: Number(item.count || 0),
        rate: computeScenarioAnalyticsRate(
          Number(item.count || 0),
          totalEvaluatedCount
        ),
        reason: readNonEmptyString(item._id),
      }))
      .sort(sortByCountDesc);

    const topScenariosByMismatchRate = scenarioMetrics
      .filter(item => item.evaluatedCount > 0 && item.triggerMismatchCount > 0)
      .map(item => ({
        id: item.scenarioId,
        label: item.scenarioName,
        scenarioId: item.scenarioId,
        scenarioName: item.scenarioName,
        count: item.triggerMismatchCount,
        evaluatedCount: item.evaluatedCount,
        rate: computeScenarioAnalyticsRate(
          item.triggerMismatchCount,
          item.evaluatedCount
        ),
        filters: item.filters ?? null,
      }))
      .sort((left, right) => {
        const rateDiff = (right.rate ?? 0) - (left.rate ?? 0);
        if (rateDiff !== 0) return rateDiff;
        return (right.count ?? 0) - (left.count ?? 0);
      })
      .slice(0, 10);

    const topScenariosByBlockRate = scenarioMetrics
      .filter(item => item.evaluatedCount > 0 && item.blockedCount > 0)
      .map(item => ({
        id: item.scenarioId,
        label: item.scenarioName,
        scenarioId: item.scenarioId,
        scenarioName: item.scenarioName,
        count: item.blockedCount,
        evaluatedCount: item.evaluatedCount,
        rate: computeScenarioAnalyticsRate(
          item.blockedCount,
          item.evaluatedCount
        ),
        filters: item.filters ?? null,
      }))
      .sort((left, right) => {
        const rateDiff = (right.rate ?? 0) - (left.rate ?? 0);
        if (rateDiff !== 0) return rateDiff;
        return (right.count ?? 0) - (left.count ?? 0);
      })
      .slice(0, 10);

    const actionCoverageGaps = scenarioMetrics
      .filter(item => item.noMatchingActionCount > 0)
      .map(item => ({
        id: item.scenarioId,
        label: item.scenarioName,
        scenarioId: item.scenarioId,
        scenarioName: item.scenarioName,
        count: item.noMatchingActionCount,
        evaluatedCount: item.evaluatedCount,
        rate: computeScenarioAnalyticsRate(
          item.noMatchingActionCount,
          item.evaluatedCount
        ),
        filters: item.filters ?? null,
      }))
      .sort(sortByCountDesc)
      .slice(0, 10);

    const triggerTypeBreakdown = triggerTypeBreakdownRaw
      .map(item => {
        const normalizedLabel = readNonEmptyString(item._id) || "unknown";
        const evaluatedCount = Number(item.evaluatedCount || 0);
        return {
          id: normalizedLabel,
          label:
            normalizedLabel === "unknown"
              ? "Unknown trigger type"
              : normalizedLabel,
          count: evaluatedCount,
          evaluatedCount,
          rate: computeScenarioAnalyticsRate(
            Number(item.winnerCount || 0),
            evaluatedCount
          ),
          triggerType: normalizedLabel === "unknown" ? null : normalizedLabel,
        };
      })
      .sort(sortByCountDesc);

    const eventKindBreakdown = eventKindBreakdownRaw
      .map(item => {
        const normalizedLabel = readNonEmptyString(item._id) || "unknown";
        const evaluatedCount = Number(item.evaluatedCount || 0);
        return {
          id: normalizedLabel,
          label:
            normalizedLabel === "unknown"
              ? "Unknown event kind"
              : normalizedLabel,
          count: evaluatedCount,
          evaluatedCount,
          rate: computeScenarioAnalyticsRate(
            Number(item.winnerCount || 0),
            evaluatedCount
          ),
          eventKind: normalizedLabel === "unknown" ? null : normalizedLabel,
        };
      })
      .sort(sortByCountDesc);

    const recentConversations = recentAffectedLogs.map(log => ({
      conversationId: String(log.conversationId || "").trim(),
      scenarioId: String(log.scenarioId || "").trim(),
      scenarioName: String(log.scenarioName || "").trim() || "Scenario",
      reason: formatScenarioAnalyticsReason(log.mismatchReason),
      evaluatedAt:
        asDate(log.evaluatedAt)?.toISOString() || new Date().toISOString(),
      eventKind: readNonEmptyString(log.eventKind),
      triggerType: readNonEmptyString(log.triggerType),
      selectedActionType: readNonEmptyString(log.selectedActionType),
      filters: log.meta?.filters || null,
    }));

    const availableScenariosMap = new Map<
      string,
      { id: string; name: string }
    >();
    for (const row of scenarioMetrics) {
      availableScenariosMap.set(row.scenarioId, {
        id: row.scenarioId,
        name: row.scenarioName,
      });
    }
    for (const row of legacyScenarioRows) {
      if (!availableScenariosMap.has(row.scenarioId)) {
        availableScenariosMap.set(row.scenarioId, {
          id: row.scenarioId,
          name: row.scenarioName,
        });
      }
    }

    return NextResponse.json({
      days,
      generatedAt: new Date().toISOString(),
      window: {
        days,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      },
      filters: {
        applied: {
          scenarioId,
          triggerType,
          eventKind,
        },
        availableScenarios: Array.from(availableScenariosMap.values()).sort(
          (left, right) => left.name.localeCompare(right.name)
        ),
        triggerTypes: triggerTypeBreakdown
          .map(item => item.triggerType)
          .filter((value): value is string => Boolean(value)),
        eventKinds: eventKindBreakdown
          .map(item => item.eventKind)
          .filter((value): value is string => Boolean(value)),
      },
      scenarioFunnel: {
        evaluatedCount: totalEvaluatedCount,
        triggerMatchedCount: totalTriggerMatchedCount,
        winnerCount: totalWinnerCount,
        overallConversion: scenarioFunnelSteps.overallConversion,
        relativeConversion: scenarioFunnelSteps.relativeConversion,
        dailyTrend,
      },
      flowOutcomeFunnel: {
        sentCount: flowSentCount,
        readCount: flowReadCount,
        submittedCount: flowSubmittedCount,
        readRate: computeScenarioAnalyticsRate(flowReadCount, flowSentCount),
        submitRateFromRead: computeScenarioAnalyticsRate(
          flowSubmittedCount,
          flowReadCount
        ),
        submitRateFromSent: computeScenarioAnalyticsRate(
          flowSubmittedCount,
          flowSentCount
        ),
        medianMinutesSentToRead: computeMedian(sentToReadMinutes),
        medianMinutesReadToSubmit: computeMedian(readToSubmitMinutes),
        overallConversion: flowOutcomeSteps.overallConversion,
        relativeConversion: flowOutcomeSteps.relativeConversion,
      },
      diagnostics: {
        topMismatchReasons,
        topScenariosByMismatchRate,
        topScenariosByBlockRate,
        actionCoverageGaps,
        triggerTypeBreakdown,
        eventKindBreakdown,
      },
      recommendations,
      recentConversations,
      totals: {
        sent: flowSentCount,
        read: flowReadCount,
        submitted: flowSubmittedCount,
      },
      scenarios: legacyScenarioRows,
      flows: legacyFlowRows,
      customers: legacyCustomerRows,
      note: "Flow close/cancel is not emitted as an explicit webhook event. Drop-off is computed as read-without-submit for official WhatsApp webhook-supported events.",
    });
  } catch (error) {
    console.error("[Scenario Analytics API] GET error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
