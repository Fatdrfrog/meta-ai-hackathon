import type { PipelineStage } from "mongoose";
import { awaitWithCancellation } from "@/lib/ai/cancellation";
import Message from "@/models/message";
import CustomerEvent from "@/models/customer-event";
import { ScenarioFlowEvent } from "@/models/scenario-flow-event";
import {
  AnalyticsAcquisitionEntry as Entry,
  AnalyticsAcquisitionCheckpoint as Checkpoint,
  AnalyticsConversionFact as Conversion,
  AnalyticsCustomerPurchaseObservation as PurchaseObservation,
} from "@/models/analytics-acquisition";
import { getAnalyticsPolicy } from "./analytics-policy";
import { readCustomerStageCoverage } from "./customer-stage-consumer";
import {
  confirmedRefundLookup,
  verifiedAmount,
} from "./confirmed-outcome-stages";
import type {
  AcquisitionReport,
  AcquisitionCohortRow,
} from "./acquisition-contract";

/**
 * The Temporal collector visits one workspace at a time and comes back to
 * each about every 45-50 minutes in production (measured 2026-10-04), so a
 * caught-up workspace's live streams are normally up to one round old. Stale
 * means the collector missed more than two rounds.
 */
export const ACQUISITION_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

export function buildAcquisitionStages(input: {
  workspaceId: string;
  start: Date;
  end: Date;
  now: Date;
  observationDays: 7 | 30;
  sourceId?: string | null;
  qualifiedStageKeys: string[];
}): PipelineStage[] {
  const {
    workspaceId,
    start,
    end,
    now,
    observationDays,
    sourceId,
    qualifiedStageKeys,
  } = input;
  return [
    {
      $match: {
        workspaceId,
        supersededBy: null,
        capturedAt: { $gte: start, $lt: end },
        ...(sourceId ? { sourceId } : {}),
      },
    },
    {
      $lookup: {
        from: Entry.collection.name,
        let: {
          conversation: "$conversationId",
          at: "$capturedAt",
          order: "$entryOrder",
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$workspaceId", workspaceId] },
                  { $eq: ["$conversationId", "$$conversation"] },
                  { $eq: [{ $ifNull: ["$supersededBy", null] }, null] },
                  {
                    $or: [
                      { $gt: ["$capturedAt", "$$at"] },
                      {
                        $and: [
                          { $eq: ["$capturedAt", "$$at"] },
                          { $gt: ["$entryOrder", "$$order"] },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          },
          { $sort: { capturedAt: 1, entryOrder: 1 } },
          { $limit: 1 },
          { $project: { capturedAt: 1 } },
        ],
        as: "nextEntry",
      },
    },
    {
      $set: {
        cutoff: {
          $min: [
            {
              $dateAdd: {
                startDate: "$capturedAt",
                unit: "day",
                amount: observationDays,
              },
            },
            {
              $ifNull: [
                { $first: "$nextEntry.capturedAt" },
                {
                  $dateAdd: {
                    startDate: "$capturedAt",
                    unit: "day",
                    amount: observationDays,
                  },
                },
              ],
            },
          ],
        },
      },
    },
    {
      $set: {
        observedEnd: { $min: ["$cutoff", now] },
        pending: { $cond: [{ $gt: ["$cutoff", now] }, 1, 0] },
      },
    },
    {
      $lookup: {
        from: Message.collection.name,
        let: {
          conversation: {
            $convert: {
              input: "$conversationId",
              to: "objectId",
              onError: null,
              onNull: null,
            },
          },
          at: "$capturedAt",
          end: "$observedEnd",
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$workspaceId", workspaceId] },
                  { $eq: ["$conversation", "$$conversation"] },
                  { $gte: ["$date", "$$at"] },
                  { $lt: ["$date", "$$end"] },
                ],
              },
            },
          },
          {
            $group: {
              _id: null,
              inbound: {
                $sum: { $cond: [{ $eq: ["$direction", "inbound"] }, 1, 0] },
              },
              outbound: {
                $sum: { $cond: [{ $eq: ["$direction", "outbound"] }, 1, 0] },
              },
            },
          },
        ],
        as: "engagement",
      },
    },
    {
      $lookup: {
        from: CustomerEvent.collection.name,
        let: {
          conversation: {
            $convert: {
              input: "$conversationId",
              to: "objectId",
              onError: null,
              onNull: null,
            },
          },
          at: "$capturedAt",
          end: "$observedEnd",
        },
        pipeline: [
          {
            $match: {
              workspaceId,
              type: { $in: ["stage_changed", "stage_snapshot"] },
              "payload.stage": { $in: qualifiedStageKeys },
              $expr: {
                $and: [
                  { $eq: ["$conversationId", "$$conversation"] },
                  { $gte: ["$occurredAt", "$$at"] },
                  { $lt: ["$occurredAt", "$$end"] },
                ],
              },
            },
          },
          { $sort: { occurredAt: 1, _id: 1 } },
          { $limit: 1 },
          { $project: { occurredAt: 1 } },
        ],
        as: "qualification",
      },
    },
    {
      $lookup: {
        from: Conversion.collection.name,
        let: {
          conversation: "$conversationId",
          at: "$capturedAt",
          end: "$observedEnd",
          qualifiedAt: { $first: "$qualification.occurredAt" },
        },
        pipeline: [
          {
            $match: {
              workspaceId,
              conversionType: { $in: ["sale", "booking"] },
              $expr: {
                $and: [
                  { $eq: ["$conversationId", "$$conversation"] },
                  { $gte: ["$occurredAt", "$$at"] },
                  { $lt: ["$occurredAt", "$$end"] },
                ],
              },
            },
          },
          // A refund follows its exact original transaction, including after the observation horizon.
          confirmedRefundLookup(workspaceId, now, Conversion.collection.name),
          {
            $group: {
              _id: { $ifNull: ["$currency", ""] },
              sales: {
                $sum: { $cond: [{ $eq: ["$conversionType", "sale"] }, 1, 0] },
              },
              qualifiedSales: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ["$conversionType", "sale"] },
                        { $ne: [{ $ifNull: ["$$qualifiedAt", null] }, null] },
                        { $gte: ["$occurredAt", "$$qualifiedAt"] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              bookings: {
                $sum: {
                  $cond: [{ $eq: ["$conversionType", "booking"] }, 1, 0],
                },
              },
              grossRevenue: {
                $sum: {
                  $cond: [
                    { $eq: ["$conversionType", "sale"] },
                    { $cond: [verifiedAmount("$value"), "$value", 0] },
                    0,
                  ],
                },
              },
              unknownValues: {
                $sum: {
                  $add: [
                    {
                      $cond: [
                        {
                          $and: [
                            { $eq: ["$conversionType", "sale"] },
                            { $not: [verifiedAmount("$value")] },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                    { $ifNull: [{ $first: "$refunds.unknownValues" }, 0] },
                  ],
                },
              },
              refundedRevenue: {
                $sum: { $ifNull: [{ $first: "$refunds.value" }, 0] },
              },
              refunds: { $sum: { $ifNull: [{ $first: "$refunds.count" }, 0] } },
            },
          },
          {
            $project: {
              _id: 0,
              currency: "$_id",
              sales: 1,
              qualifiedSales: 1,
              bookings: 1,
              grossRevenue: 1,
              refundedRevenue: 1,
              unknownValues: 1,
              refunds: 1,
            },
          },
          { $limit: 201 },
        ],
        as: "outcomes",
      },
    },
    {
      $set: {
        engaged: {
          $cond: [
            {
              $and: [
                {
                  $gt: [{ $ifNull: [{ $first: "$engagement.inbound" }, 0] }, 0],
                },
                {
                  $gt: [
                    { $ifNull: [{ $first: "$engagement.outbound" }, 0] },
                    0,
                  ],
                },
              ],
            },
            1,
            0,
          ],
        },
        qualified: { $cond: [{ $gt: [{ $size: "$qualification" }, 0] }, 1, 0] },
        paid: { $cond: [{ $gt: [{ $sum: "$outcomes.sales" }, 0] }, 1, 0] },
        qualifiedPaid: {
          $cond: [{ $gt: [{ $sum: "$outcomes.qualifiedSales" }, 0] }, 1, 0],
        },
        booked: { $cond: [{ $gt: [{ $sum: "$outcomes.bookings" }, 0] }, 1, 0] },
      },
    },
    {
      $facet: {
        stages: [
          {
            $group: {
              _id: { kind: "$kind", sourceId: "$sourceId", adId: "$adId" },
              entries: { $sum: 1 },
              engaged: { $sum: "$engaged" },
              qualified: { $sum: "$qualified" },
              paid: { $sum: "$paid" },
              qualifiedPaid: { $sum: "$qualifiedPaid" },
              booked: { $sum: "$booked" },
              pendingObservation: { $sum: "$pending" },
            },
          },
          { $sort: { entries: -1, "_id.adId": 1 } },
          { $limit: 201 },
        ],
        currencies: [
          { $unwind: "$outcomes" },
          {
            $group: {
              _id: {
                kind: "$kind",
                sourceId: "$sourceId",
                adId: "$adId",
                currency: "$outcomes.currency",
              },
              unknownValues: { $sum: "$outcomes.unknownValues" },
              sales: { $sum: "$outcomes.sales" },
              refunds: { $sum: "$outcomes.refunds" },
              grossRevenue: { $sum: "$outcomes.grossRevenue" },
              refundedRevenue: { $sum: "$outcomes.refundedRevenue" },
            },
          },
          { $sort: { "_id.currency": 1 } },
          { $limit: 2001 },
        ],
        identity: [
          {
            $match: {
              kind: "ad",
              $or: [
                { identityCoverage: "message" },
                { adId: null },
                { sourceId: null },
              ],
            },
          },
          { $count: "count" },
        ],
      },
    },
  ];
}

export async function getAcquisitionReport(input: {
  workspaceId: string;
  start: Date;
  end: Date;
  observationDays: 7 | 30;
  sourceId?: string | null;
  now?: Date;
  signal?: AbortSignal;
  queryMaxTimeMS?: number;
  /** IANA zone of the calendar window; retention months follow it. */
  timeZone?: string;
}): Promise<AcquisitionReport> {
  input.signal?.throwIfAborted();
  const maxTimeMS =
    input.queryMaxTimeMS !== undefined && Number.isFinite(input.queryMaxTimeMS)
      ? Math.max(1, Math.min(25_000, Math.floor(input.queryMaxTimeMS)))
      : 25_000;
  const queryOptions = {
    maxTimeMS,
    ...(input.signal ? { signal: input.signal } : {}),
  };
  const read = <T>(work: () => PromiseLike<T>): Promise<T> => {
    input.signal?.throwIfAborted();
    return awaitWithCancellation(work(), input.signal);
  };
  const now = input.now || new Date();
  const policy = await read(() => getAnalyticsPolicy(input.workspaceId));
  const qualificationHistory = await read(() =>
    readCustomerStageCoverage(input.workspaceId)
  );
  const readCheckpoints = () =>
    read(() =>
      Checkpoint.find({ workspaceId: input.workspaceId })
        .select("stream fence through lastError incomplete reconcileThrough")
        .setOptions(queryOptions)
        .lean<
          Array<{
            stream: string;
            fence?: number;
            through: Date | null;
            lastError?: string | null;
            incomplete?: boolean;
            reconcileThrough?: Date | null;
          }>
        >()
    );
  const checkpoints = await readCheckpoints();
  const sourceThrough = ["messages", "conversations"].map(
    stream =>
      checkpoints.find((c: { stream: string }) => c.stream === stream)?.through
  );
  const conversionThrough =
    checkpoints.find((c: { stream: string }) => c.stream === "conversions")
      ?.through || null;
  const projectedThrough = sourceThrough.every(Boolean)
    ? new Date(Math.min(...sourceThrough.map(d => new Date(d!).getTime())))
    : null;
  const reconciled = [
    "messages_reconciliation",
    "conversations_reconciliation",
    "conversions_reconciliation",
  ].map(stream => checkpoints.find(c => c.stream === stream)?.reconcileThrough);
  const reconciliationThrough = reconciled.every(Boolean)
    ? new Date(Math.min(...reconciled.map(at => new Date(at!).getTime())))
    : null;
  let status: AcquisitionReport["coverage"]["status"] =
    !projectedThrough ||
    !conversionThrough ||
    !reconciliationThrough ||
    checkpoints.some(c => c.incomplete)
      ? "backfilling"
      : checkpoints.some(c => c.lastError)
        ? "unavailable"
        : Math.min(
              projectedThrough.getTime(),
              new Date(conversionThrough).getTime()
            ) <
            now.getTime() - ACQUISITION_STALE_AFTER_MS
          ? "stale"
          : "ready";
  const [result] = await read(() =>
    Entry.aggregate(
      buildAcquisitionStages({
        ...input,
        now,
        qualifiedStageKeys: policy.qualifiedStageKeys,
      })
    )
      .allowDiskUse(true)
      .option(queryOptions)
  );
  const stages = result?.stages || [];
  const currencies = result?.currencies || [];
  const cohorts: AcquisitionCohortRow[] = stages.slice(0, 200).map(
    (row: {
      _id: {
        kind: "ad" | "organic";
        sourceId: string | null;
        adId: string | null;
      };
      entries: number;
      engaged: number;
      qualified: number;
      qualifiedPaid: number;
      paid: number;
      booked: number;
      pendingObservation: number;
    }) => ({
      ...row._id,
      entries: row.entries,
      engaged: row.engaged,
      qualified: row.qualified,
      qualifiedPaid: row.qualifiedPaid,
      paid: row.paid,
      booked: row.booked,
      pendingObservation: row.pendingObservation,
      currencies: currencies
        .filter(
          (r: { _id: { kind: string; sourceId: string; adId: string } }) =>
            r._id.kind === row._id.kind &&
            r._id.sourceId === row._id.sourceId &&
            r._id.adId === row._id.adId
        )
        .map(
          (r: {
            _id: { currency: string };
            sales: number;
            refunds: number;
            grossRevenue: number;
            refundedRevenue: number;
            unknownValues: number;
          }) => ({
            currency: r._id.currency,
            sales: r.sales,
            refunds: r.refunds,
            unknownValues: r.unknownValues,
            grossRevenue: r.unknownValues ? null : r.grossRevenue,
            refundedRevenue: r.unknownValues ? null : r.refundedRevenue,
            netRevenue: r.unknownValues
              ? null
              : r.grossRevenue - r.refundedRevenue,
          })
        ),
    })
  );
  const retention = await read(() =>
    PurchaseObservation.aggregate([
      {
        $match: {
          workspaceId: input.workspaceId,
          scope: input.sourceId ? "source" : "workspace",
          sourceId: input.sourceId || null,
          firstPurchase: { $gte: input.start, $lt: input.end },
        },
      },
      {
        $set: {
          _id: {
            customer: "$customerId",
            currency: { $ifNull: ["$currency", ""] },
          },
          pending: {
            $cond: [
              {
                $gt: [
                  {
                    $dateAdd: {
                      startDate: "$firstPurchase",
                      unit: "day",
                      amount: input.observationDays,
                    },
                  },
                  now,
                ],
              },
              1,
              0,
            ],
          },
        },
      },
      {
        $lookup: {
          from: Conversion.collection.name,
          let: {
            customer: "$_id.customer",
            currency: "$_id.currency",
            at: "$firstPurchase",
          },
          pipeline: [
            {
              $match: {
                workspaceId: input.workspaceId,
                ...(input.sourceId ? { sourceId: input.sourceId } : {}),
                conversionType: "sale",
                $expr: {
                  $and: [
                    { $eq: ["$customerId", "$$customer"] },
                    { $eq: [{ $ifNull: ["$currency", ""] }, "$$currency"] },
                    { $gte: ["$occurredAt", "$$at"] },
                    {
                      $lt: [
                        "$occurredAt",
                        {
                          $min: [
                            now,
                            {
                              $dateAdd: {
                                startDate: "$$at",
                                unit: "day",
                                amount: input.observationDays,
                              },
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            },
            confirmedRefundLookup(
              input.workspaceId,
              now,
              Conversion.collection.name
            ),
            {
              $group: {
                _id: null,
                sales: {
                  $sum: { $cond: [{ $eq: ["$conversionType", "sale"] }, 1, 0] },
                },
                gross: {
                  $sum: {
                    $cond: [
                      { $eq: ["$conversionType", "sale"] },
                      { $cond: [verifiedAmount("$value"), "$value", 0] },
                      0,
                    ],
                  },
                },
                unknownValues: {
                  $sum: {
                    $add: [
                      { $cond: [verifiedAmount("$value"), 0, 1] },
                      { $ifNull: [{ $first: "$refunds.unknownValues" }, 0] },
                    ],
                  },
                },
                refunded: {
                  $sum: { $ifNull: [{ $first: "$refunds.value" }, 0] },
                },
              },
            },
          ],
          as: "value",
        },
      },
      {
        $group: {
          _id: {
            cohortMonth: {
              $dateToString: {
                date: "$firstPurchase",
                format: "%Y-%m",
                timezone: input.timeZone || "UTC",
              },
            },
            currency: "$_id.currency",
          },
          customers: { $sum: 1 },
          pendingCustomers: { $sum: "$pending" },
          repeatCustomers: {
            $sum: {
              $cond: [
                { $gt: [{ $ifNull: [{ $first: "$value.sales" }, 0] }, 1] },
                1,
                0,
              ],
            },
          },
          sales: { $sum: { $ifNull: [{ $first: "$value.sales" }, 0] } },
          unknownValues: {
            $sum: { $ifNull: [{ $first: "$value.unknownValues" }, 0] },
          },
          grossRevenue: { $sum: { $ifNull: [{ $first: "$value.gross" }, 0] } },
          refundedRevenue: {
            $sum: { $ifNull: [{ $first: "$value.refunded" }, 0] },
          },
        },
      },
      { $sort: { "_id.cohortMonth": 1 } },
      { $limit: 201 },
      {
        $project: {
          _id: 0,
          cohortMonth: "$_id.cohortMonth",
          currency: "$_id.currency",
          customers: 1,
          repeatCustomers: 1,
          pendingCustomers: 1,
          sales: 1,
          unknownValues: 1,
          grossRevenue: {
            $cond: [{ $gt: ["$unknownValues", 0] }, null, "$grossRevenue"],
          },
          refundedRevenue: {
            $cond: [{ $gt: ["$unknownValues", 0] }, null, "$refundedRevenue"],
          },
          netRevenue: {
            $cond: [
              { $gt: ["$unknownValues", 0] },
              null,
              { $subtract: ["$grossRevenue", "$refundedRevenue"] },
            ],
          },
        },
      },
    ])
      .allowDiskUse(true)
      .option(queryOptions)
  );
  const retentionMissingIdentity = await read(() =>
    Conversion.countDocuments({
      workspaceId: input.workspaceId,
      conversionType: "sale",
      occurredAt: { $gte: input.start, $lt: input.end },
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      $or: [{ customerId: null }, { customerId: "" }],
    })
      .setOptions(queryOptions)
      .maxTimeMS(maxTimeMS)
  );
  const flows = await read(() =>
    ScenarioFlowEvent.aggregate([
      {
        $match: {
          workspaceId: input.workspaceId,
          eventType: "sent",
          eventAt: { $gte: input.start, $lt: input.end },
          ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        },
      },
      {
        $group: {
          _id: {
            message: "$outboundMessageId",
            conversation: "$conversationId",
            flow: "$flowId",
            token: "$flowToken",
          },
          sentAt: { $min: "$eventAt" },
        },
      },
      {
        $lookup: {
          from: ScenarioFlowEvent.collection.name,
          let: {
            conversation: "$_id.conversation",
            token: "$_id.token",
            message: "$_id.message",
            at: "$sentAt",
          },
          pipeline: [
            {
              $match: {
                workspaceId: input.workspaceId,
                eventType: "sent",
                $expr: {
                  $and: [
                    { $ne: ["$$token", null] },
                    { $eq: ["$conversationId", "$$conversation"] },
                    { $eq: ["$flowToken", "$$token"] },
                    {
                      $or: [
                        { $gt: ["$eventAt", "$$at"] },
                        {
                          $and: [
                            { $eq: ["$eventAt", "$$at"] },
                            { $gt: ["$outboundMessageId", "$$message"] },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            },
            { $sort: { eventAt: 1, outboundMessageId: 1 } },
            { $limit: 1 },
            { $project: { eventAt: 1 } },
          ],
          as: "nextTokenSend",
        },
      },
      {
        $set: {
          tokenEnd: {
            $ifNull: [
              { $first: "$nextTokenSend.eventAt" },
              {
                $dateAdd: {
                  startDate: "$sentAt",
                  unit: "day",
                  amount: input.observationDays,
                },
              },
            ],
          },
        },
      },
      {
        $lookup: {
          from: ScenarioFlowEvent.collection.name,
          let: {
            message: "$_id.message",
            conversation: "$_id.conversation",
            token: "$_id.token",
            at: "$sentAt",
            tokenEnd: "$tokenEnd",
            sentSecond: { $dateTrunc: { date: "$sentAt", unit: "second" } },
          },
          pipeline: [
            {
              $match: {
                workspaceId: input.workspaceId,
                $expr: {
                  $and: [
                    { $eq: ["$conversationId", "$$conversation"] },
                    {
                      $gte: [
                        "$eventAt",
                        {
                          $cond: [
                            {
                              $ne: [
                                { $ifNull: ["$outboundMessageId", null] },
                                null,
                              ],
                            },
                            "$$sentSecond",
                            "$$at",
                          ],
                        },
                      ],
                    },
                    {
                      $lt: [
                        "$eventAt",
                        {
                          $min: [
                            now,
                            {
                              $dateAdd: {
                                startDate: "$$at",
                                unit: "day",
                                amount: input.observationDays,
                              },
                            },
                          ],
                        },
                      ],
                    },
                    {
                      $cond: [
                        {
                          $ne: [
                            { $ifNull: ["$outboundMessageId", null] },
                            null,
                          ],
                        },
                        {
                          $and: [
                            { $ne: ["$$message", null] },
                            { $eq: ["$outboundMessageId", "$$message"] },
                          ],
                        },
                        {
                          $and: [
                            { $ne: ["$$token", null] },
                            { $eq: ["$flowToken", "$$token"] },
                            { $lt: ["$eventAt", "$$tokenEnd"] },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            },
            {
              $group: {
                _id: null,
                read: {
                  $max: { $cond: [{ $eq: ["$eventType", "read"] }, 1, 0] },
                },
                submitted: {
                  $max: { $cond: [{ $eq: ["$eventType", "submitted"] }, 1, 0] },
                },
                submittedAt: {
                  $min: {
                    $cond: [
                      { $eq: ["$eventType", "submitted"] },
                      "$eventAt",
                      null,
                    ],
                  },
                },
              },
            },
          ],
          as: "outcomes",
        },
      },
      {
        $set: {
          submittedAt: {
            $cond: [
              { $gt: [{ $ifNull: [{ $first: "$outcomes.submitted" }, 0] }, 0] },
              { $max: ["$sentAt", { $first: "$outcomes.submittedAt" }] },
              null,
            ],
          },
        },
      },
      {
        $lookup: {
          from: ScenarioFlowEvent.collection.name,
          let: {
            conversation: "$_id.conversation",
            token: "$_id.token",
            message: "$_id.message",
            at: "$submittedAt",
            order: { $ifNull: ["$_id.message", "$_id.token"] },
            tokenEnd: "$tokenEnd",
            atSecond: { $dateTrunc: { date: "$submittedAt", unit: "second" } },
          },
          pipeline: [
            {
              $match: {
                workspaceId: input.workspaceId,
                eventType: "submitted",
                $expr: {
                  $and: [
                    { $ne: ["$$at", null] },
                    { $eq: ["$conversationId", "$$conversation"] },
                    {
                      $or: [
                        { $gt: ["$eventAt", "$$at"] },
                        {
                          $and: [
                            { $eq: ["$eventAt", "$$atSecond"] },
                            {
                              $gt: [
                                {
                                  $ifNull: ["$outboundMessageId", "$flowToken"],
                                },
                                "$$order",
                              ],
                            },
                          ],
                        },
                      ],
                    },
                    {
                      $not: [
                        {
                          $cond: [
                            {
                              $ne: [
                                { $ifNull: ["$outboundMessageId", null] },
                                null,
                              ],
                            },
                            { $eq: ["$outboundMessageId", "$$message"] },
                            {
                              $and: [
                                { $ne: ["$$token", null] },
                                { $eq: ["$flowToken", "$$token"] },
                                { $lt: ["$eventAt", "$$tokenEnd"] },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            },
            { $sort: { eventAt: 1, _id: 1 } },
            { $limit: 1 },
            { $project: { eventAt: 1 } },
          ],
          as: "nextSubmission",
        },
      },
      {
        $set: {
          outcomeEnd: {
            $min: [
              now,
              { $first: "$nextSubmission.eventAt" },
              {
                $dateAdd: {
                  startDate: "$submittedAt",
                  unit: "day",
                  amount: input.observationDays,
                },
              },
            ],
          },
        },
      },
      // Equality joins let both lookups use their workspace indexes; the $expr
      // forms scanned the workspace's messages and stage events per flow send.
      {
        $lookup: {
          from: Message.collection.name,
          localField: "_id.message",
          foreignField: "messageId",
          pipeline: [
            {
              $match: {
                workspaceId: input.workspaceId,
                channel: "whatsapp",
                direction: "outbound",
                // A send without a provider id must not match messages without one.
                messageId: { $type: "string" },
              },
            },
            { $limit: 1 },
            {
              $project: {
                delivered: {
                  $cond: [
                    {
                      $in: [
                        "$delivery.status",
                        ["delivered", "read", "played"],
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          ],
          as: "delivery",
        },
      },
      {
        $set: {
          conversationObjectId: {
            $convert: {
              input: "$_id.conversation",
              to: "objectId",
              onError: null,
              onNull: null,
            },
          },
        },
      },
      {
        $lookup: {
          from: CustomerEvent.collection.name,
          localField: "conversationObjectId",
          foreignField: "conversationId",
          let: { at: "$submittedAt", end: "$outcomeEnd" },
          pipeline: [
            {
              $match: {
                workspaceId: input.workspaceId,
                conversationId: { $type: "objectId" },
                type: { $in: ["stage_changed", "stage_snapshot"] },
                "payload.stage": { $in: policy.qualifiedStageKeys },
                $expr: {
                  $and: [
                    { $gte: ["$occurredAt", "$$at"] },
                    { $ne: ["$$at", null] },
                    { $lt: ["$occurredAt", "$$end"] },
                  ],
                },
              },
            },
            { $limit: 1 },
          ],
          as: "qualification",
        },
      },
      {
        $lookup: {
          from: Conversion.collection.name,
          let: {
            conversation: "$_id.conversation",
            at: "$submittedAt",
            end: "$outcomeEnd",
          },
          pipeline: [
            {
              $match: {
                workspaceId: input.workspaceId,
                conversionType: "sale",
                $expr: {
                  $and: [
                    { $eq: ["$conversationId", "$$conversation"] },
                    { $gte: ["$occurredAt", "$$at"] },
                    { $ne: ["$$at", null] },
                    { $lt: ["$occurredAt", "$$end"] },
                  ],
                },
              },
            },
            { $limit: 1 },
          ],
          as: "payment",
        },
      },
      {
        $group: {
          _id: "$_id.flow",
          sent: { $sum: 1 },
          delivered: {
            $sum: { $ifNull: [{ $first: "$delivery.delivered" }, 0] },
          },
          read: { $sum: { $ifNull: [{ $first: "$outcomes.read" }, 0] } },
          submitted: {
            $sum: { $ifNull: [{ $first: "$outcomes.submitted" }, 0] },
          },
          qualified: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $gt: [{ $size: "$qualification" }, 0] },
                    {
                      $gt: [
                        { $ifNull: [{ $first: "$outcomes.submitted" }, 0] },
                        0,
                      ],
                    },
                  ],
                },
                1,
                0,
              ],
            },
          },
          paid: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $gt: [{ $size: "$payment" }, 0] },
                    {
                      $gt: [
                        { $ifNull: [{ $first: "$outcomes.submitted" }, 0] },
                        0,
                      ],
                    },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
      { $sort: { sent: -1 } },
      { $limit: 201 },
      {
        $project: {
          _id: 0,
          flowId: "$_id",
          sent: 1,
          delivered: 1,
          read: 1,
          submitted: 1,
          qualified: 1,
          paid: 1,
        },
      },
    ])
      .allowDiskUse(true)
      .option(queryOptions)
  );
  // A repair can complete between the report's pipelines. Its page fence still
  // changed, so withhold comparisons that could contain partially visible writes.
  const completedCheckpoints = await readCheckpoints();
  if (completedCheckpoints.some(checkpoint => checkpoint.lastError)) {
    status = "unavailable";
  } else if (
    completedCheckpoints.some(checkpoint => checkpoint.incomplete) ||
    completedCheckpoints.length !== checkpoints.length ||
    checkpoints.some(checkpoint =>
      completedCheckpoints.every(
        completed =>
          completed.stream !== checkpoint.stream ||
          completed.fence !== checkpoint.fence
      )
    )
  ) {
    status = "backfilling";
  }
  return {
    window: {
      start: input.start.toISOString(),
      end: input.end.toISOString(),
      observationDays: input.observationDays,
      asOf: now.toISOString(),
    },
    policy,
    coverage: {
      status,
      projectedThrough: projectedThrough?.toISOString() || null,
      reconciliationThrough: reconciliationThrough?.toISOString() || null,
      conversionThrough: conversionThrough
        ? new Date(conversionThrough).toISOString()
        : null,
      identityMissing: result?.identity?.[0]?.count || 0,
      qualification: "recorded_events",
      qualificationHistory,
      truncated:
        stages.length > 200 ||
        currencies.length > 2000 ||
        retention.length > 200 ||
        flows.length > 200,
    },
    cohorts,
    flows: flows.slice(0, 200),
    retention: retention.slice(0, 200),
    retentionMissingIdentity,
  };
}
