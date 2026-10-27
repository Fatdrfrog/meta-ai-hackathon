import "server-only";
import connectDB from "@/lib/mongoose";
import { AnalyticsServiceLifecycleFact } from "@/models/analytics-service-lifecycle";
import {
  readServiceLifecycleCoverage,
  type ServiceLifecycleCoverage,
} from "./service-lifecycle-consumer";
import type { PipelineStage } from "mongoose";

type Observed = {
  events: number;
  resolvedEvents: number;
  measuredResolutions: number;
  unknownClosures: number;
  timeoutClosures: number;
  reopened: number;
  handoffStarted: number;
  handoffEnded: number;
  measuredHandoffs: number;
  averageResolutionSeconds: number | null;
  averageHandoffSeconds: number | null;
  snapshotEvents: number;
  streamEvents: number;
};
export type ServiceLifecycleReport = {
  window: { start: string; endExclusive: string };
  coverage: ServiceLifecycleCoverage;
  observed: Observed;
  groupLimit: 50;
  sourceGroupsTotal: number;
  groupsTruncated: boolean;
  bySource: (Observed & { sourceId: string | null; channel: string | null })[];
};
const emptyObserved = (): Observed => ({
  events: 0,
  resolvedEvents: 0,
  measuredResolutions: 0,
  unknownClosures: 0,
  timeoutClosures: 0,
  reopened: 0,
  handoffStarted: 0,
  handoffEnded: 0,
  measuredHandoffs: 0,
  averageResolutionSeconds: null,
  averageHandoffSeconds: null,
  snapshotEvents: 0,
  streamEvents: 0,
});
const kindCount = (kind: string) => ({
  $sum: { $cond: [{ $in: [kind, "$kinds"] }, 1, 0] },
});
const aggregationFields = {
  events: { $sum: 1 },
  resolvedEvents: kindCount("resolved"),
  measuredResolutions: {
    $sum: { $cond: [{ $ne: ["$resolutionSeconds", null] }, 1, 0] },
  },
  unknownClosures: kindCount("closed_unknown"),
  timeoutClosures: kindCount("timeout_closed"),
  reopened: kindCount("reopened"),
  handoffStarted: kindCount("handoff_started"),
  handoffEnded: kindCount("handoff_ended"),
  measuredHandoffs: {
    $sum: { $cond: [{ $ne: ["$handoffSeconds", null] }, 1, 0] },
  },
  averageResolutionSeconds: { $avg: "$resolutionSeconds" },
  averageHandoffSeconds: { $avg: "$handoffSeconds" },
  snapshotEvents: {
    $sum: { $cond: [{ $eq: ["$evidence", "snapshot_recovery"] }, 1, 0] },
  },
  streamEvents: {
    $sum: { $cond: [{ $eq: ["$evidence", "change_stream"] }, 1, 0] },
  },
};

export async function getServiceLifecycleReport(
  workspaceId: string,
  start: Date,
  endExclusive: Date,
  sourceId?: string
): Promise<ServiceLifecycleReport> {
  const duration = endExclusive.getTime() - start.getTime();
  if (!Number.isFinite(duration) || duration <= 0 || duration > 90 * 86400000)
    throw new Error("Lifecycle window must be positive and at most 90 days");
  await connectDB();
  const pipeline: PipelineStage[] = [
    {
      $match: {
        workspaceId,
        ...(sourceId ? { sourceId } : {}),
        occurredAt: { $gte: start, $lt: endExclusive },
      },
    },
    {
      $set: {
        resolutionSeconds: {
          $cond: [
            {
              $and: [
                { $in: ["resolved", "$kinds"] },
                {
                  $in: [
                    "$envelope.resolutionKind",
                    ["manager", "customer_csat"],
                  ],
                },
                { $eq: [{ $type: "$envelope.episodeStartedAt" }, "date"] },
                { $eq: [{ $type: "$envelope.resolvedAt" }, "date"] },
                {
                  $gte: ["$envelope.resolvedAt", "$envelope.episodeStartedAt"],
                },
              ],
            },
            {
              $divide: [
                {
                  $subtract: [
                    "$envelope.resolvedAt",
                    "$envelope.episodeStartedAt",
                  ],
                },
                1000,
              ],
            },
            null,
          ],
        },
        handoffSeconds: {
          $cond: [
            {
              $and: [
                { $in: ["handoff_ended", "$kinds"] },
                { $eq: [{ $type: "$envelope.handoffStartedAt" }, "date"] },
                { $gte: ["$occurredAt", "$envelope.handoffStartedAt"] },
              ],
            },
            {
              $divide: [
                { $subtract: ["$occurredAt", "$envelope.handoffStartedAt"] },
                1000,
              ],
            },
            null,
          ],
        },
      },
    },
    {
      $facet: {
        totals: [{ $group: { _id: null, ...aggregationFields } }],
        bySource: [
          {
            $group: {
              _id: { sourceId: "$sourceId", channel: "$channel" },
              ...aggregationFields,
            },
          },
          { $sort: { events: -1, "_id.sourceId": 1, "_id.channel": 1 } },
          { $limit: 50 },
        ],
        sourceCount: [
          { $group: { _id: { sourceId: "$sourceId", channel: "$channel" } } },
          { $count: "count" },
        ],
      },
    },
  ];
  const [rows, coverage] = await Promise.all([
    AnalyticsServiceLifecycleFact.aggregate<{
      totals: Partial<Observed>[];
      bySource: (Partial<Observed> & {
        _id: { sourceId?: string | null; channel?: string | null };
      })[];
      sourceCount?: { count: number }[];
    }>(pipeline).allowDiskUse(true),
    readServiceLifecycleCoverage(workspaceId),
  ]);
  const result = rows[0];
  const sourceGroupsTotal =
    result?.sourceCount?.[0]?.count ?? result?.bySource?.length ?? 0;
  return {
    window: {
      start: start.toISOString(),
      endExclusive: endExclusive.toISOString(),
    },
    coverage,
    observed: { ...emptyObserved(), ...result?.totals?.[0] },
    groupLimit: 50,
    sourceGroupsTotal,
    groupsTruncated: sourceGroupsTotal > 50,
    bySource: (result?.bySource ?? []).map(({ _id, ...values }) => ({
      ...emptyObserved(),
      ...values,
      sourceId: _id.sourceId ?? null,
      channel: _id.channel ?? null,
    })),
  };
}
