import { buildWhatsAppDeliveryReconciliationStages } from "./whatsapp-delivery-reconciliation";
import { buildWhatsAppPricingStateExpr } from "@icecore/shared/constants/whatsapp-message-rates";
import type { PipelineStage } from "mongoose";
import { asRecord, readNonEmptyString } from "@icecore/shared/lib/value-utils";
import { buildDeliveryOutcomeFields } from "./bulk-analytics-audience";
import type {
  WhatsAppAnalyticsResult,
  WhatsAppPricingPoint,
  WhatsAppTemplateEffectiveness,
} from "./whatsapp-analytics-contract";

type Row = Record<string, unknown>;
const list = (value: unknown): Row[] =>
  Array.isArray(value) ? value.map(asRecord) : [];
const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
const nullableNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : null;
const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);
const sum = (field: string) => ({ $sum: { $cond: [`$${field}`, 1, 0] } });

const REPLY_WINDOW_HOURS = 168;
// Later outbound messages read per send. Stored copies of the send itself are
// dropped, then three remain to skip copies of a twin wamid of the same send.
// Production keeps at most two copies of one message.
const LATER_OUTBOUND_READ = 8;
const LATER_OUTBOUND_KEPT = 3;

/**
 * Indexed accepted-send cohort. All returned dimensions are aggregates, never chat content.
 *
 * Replies, the next outbound send and provider receipts are joined set-wise:
 * one window pass per conversation and one receipt scan. Correlated per-send
 * lookups (about 50k on the largest workspace) took longer than the 25 s
 * budget. Reply attribution follows buildEnrichmentStages: the first inbound
 * message after the send, before the next outbound send, within 168 hours.
 */
export function buildWhatsAppAnalyticsPipeline(params: {
  workspaceId: string;
  start: Date;
  end: Date;
  sourceId?: string;
  sourceIds?: readonly string[];
  /** IANA zone for the daily buckets; defaults to UTC. */
  timeZone?: string;
}): PipelineStage[] {
  const statusPresent = (statuses: string[]) => ({
    $in: [{ $ifNull: ["$delivery.status", ""] }, statuses],
  });
  const selectedSources = params.sourceId
    ? [params.sourceId]
    : params.sourceIds?.slice(0, 10);
  const timezone = params.timeZone || "UTC";
  const later = { range: [1, "unbounded"], unit: "millisecond" };
  return [
    {
      $match: {
        workspaceId: params.workspaceId,
        channel: "whatsapp",
        direction: { $in: ["outbound", "inbound"] },
        date: { $gte: params.start, $lte: params.end },
      },
    },
    {
      $project: {
        date: 1,
        direction: 1,
        conversation: 1,
        messageId: 1,
        whatsappWamidFingerprint: 1,
        "origin.kind": 1,
        "origin.sourceId": 1,
        "origin.templateName": 1,
        "delivery.status": 1,
        "delivery.recipientId": 1,
        "delivery.recipientWaId": 1,
        "delivery.lastEventAt": 1,
        "delivery.sentAt": 1,
        "delivery.deliveredAt": 1,
        "delivery.readAt": 1,
        "delivery.failedAt": 1,
        "delivery.errorCode": 1,
        "whatsappGroup.phoneNumberId": 1,
        "whatsappTemplate.name": 1,
        _inboundAt: {
          $cond: [{ $eq: ["$direction", "inbound"] }, "$date", null],
        },
        _outboundRank: { $cond: [{ $eq: ["$direction", "outbound"] }, 0, 1] },
        _providerId: {
          $cond: [
            { $eq: [{ $type: "$messageId" }, "string"] },
            {
              $replaceOne: {
                input: "$messageId",
                find: "ws_",
                replacement: "",
              },
            },
            "",
          ],
        },
      },
    },
    {
      $setWindowFields: {
        partitionBy: { $ifNull: ["$conversation", null] },
        sortBy: { date: 1 },
        output: {
          _laterOutbound: {
            $topN: {
              n: LATER_OUTBOUND_READ,
              sortBy: { _outboundRank: 1, date: 1 },
              output: {
                date: "$date",
                providerId: {
                  $cond: [{ $eq: ["$_outboundRank", 0] }, "$_providerId", null],
                },
              },
            },
            window: later,
          },
          _firstReplyAt: { $min: "$_inboundAt", window: later },
        },
      },
    },
    {
      $match: {
        direction: "outbound",
        messageId: { $regex: "^(ws_)?wamid\\." },
        ...(selectedSources
          ? {
              $or: [
                { "origin.sourceId": { $in: selectedSources } },
                { "origin.sourceId": null },
              ],
            }
          : {}),
      },
    },
    {
      $set: {
        providerMessageId: "$_providerId",
        _laterOutbound: {
          $slice: [
            {
              $filter: {
                input: "$_laterOutbound",
                cond: {
                  $and: [
                    { $ne: ["$$this.providerId", null] },
                    { $ne: ["$$this.providerId", "$_providerId"] },
                  ],
                },
              },
            },
            LATER_OUTBOUND_KEPT,
          ],
        },
      },
    },
    {
      $unset: [
        "conversation",
        "direction",
        "messageId",
        "_inboundAt",
        "_outboundRank",
        "_providerId",
      ],
    },
    ...buildWhatsAppDeliveryReconciliationStages({
      workspaceId: params.workspaceId,
      startDate: params.start,
      observedAt: params.end,
    }),
    ...(selectedSources
      ? [{ $match: { analyticsSourceId: { $in: selectedSources } } }]
      : []),
    {
      $set: {
        _nextOutboundAt: {
          $let: {
            vars: {
              next: {
                $first: {
                  $filter: {
                    input: "$_laterOutbound",
                    cond: {
                      $not: [
                        { $in: ["$$this.providerId", "$providerMessageIds"] },
                      ],
                    },
                  },
                },
              },
            },
            in: { $ifNull: ["$$next.date", null] },
          },
        },
        _replyWindowEndsAt: {
          $dateAdd: {
            startDate: "$date",
            unit: "hour",
            amount: REPLY_WINDOW_HOURS,
          },
        },
      },
    },
    {
      $set: {
        replied: {
          $and: [
            { $ne: ["$_firstReplyAt", null] },
            {
              $lte: [
                "$_firstReplyAt",
                {
                  $cond: [
                    {
                      $and: [
                        { $ne: ["$_nextOutboundAt", null] },
                        { $lt: ["$_nextOutboundAt", "$_replyWindowEndsAt"] },
                      ],
                    },
                    "$_nextOutboundAt",
                    "$_replyWindowEndsAt",
                  ],
                },
              ],
            },
          ],
        },
        ...buildDeliveryOutcomeFields(),
      },
    },
    {
      $set: {
        wasFailed: { $and: ["$wasFailed", { $not: ["$wasDelivered"] }] },
        wasSent: {
          $or: [
            statusPresent(["sent", "delivered", "read", "played"]),
            { $ne: [{ $ifNull: ["$delivery.sentAt", null] }, null] },
          ],
        },
        deliverySeconds: {
          $cond: [
            {
              $and: [
                { $ne: [{ $ifNull: ["$delivery.deliveredAt", null] }, null] },
                { $gte: ["$delivery.deliveredAt", "$date"] },
              ],
            },
            {
              $divide: [
                { $subtract: ["$delivery.deliveredAt", "$date"] },
                1000,
              ],
            },
            null,
          ],
        },
        readSeconds: {
          $cond: [
            {
              $and: [
                { $ne: [{ $ifNull: ["$delivery.readAt", null] }, null] },
                { $gte: ["$delivery.readAt", "$date"] },
              ],
            },
            { $divide: [{ $subtract: ["$delivery.readAt", "$date"] }, 1000] },
            null,
          ],
        },
      },
    },
    {
      $set: {
        isPending: {
          $and: [{ $not: ["$wasDelivered"] }, { $not: ["$wasFailed"] }],
        },
        pricingState: buildWhatsAppPricingStateExpr({
          typeExpr: "$pricingReceipt.pricingType",
          billableExpr: "$pricingReceipt.pricingBillable",
        }),
      },
    },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              accepted: { $sum: 1 },
              sent: sum("wasSent"),
              delivered: sum("wasDelivered"),
              read: sum("wasRead"),
              replied: sum("replied"),
              failed: sum("wasFailed"),
              pending: sum("isPending"),
              deliveryPercentiles: {
                $percentile: {
                  input: "$deliverySeconds",
                  p: [0.5, 0.95],
                  method: "approximate",
                },
              },
              readPercentiles: {
                $percentile: {
                  input: "$readSeconds",
                  p: [0.5, 0.95],
                  method: "approximate",
                },
              },
            },
          },
        ],
        origins: [
          {
            $group: {
              _id: { $ifNull: ["$origin.kind", "unknown"] },
              accepted: { $sum: 1 },
              delivered: sum("wasDelivered"),
              read: sum("wasRead"),
              replied: sum("replied"),
              failed: sum("wasFailed"),
            },
          },
          { $sort: { accepted: -1 } },
          { $limit: 10 },
        ],
        errors: [
          { $match: { wasFailed: true } },
          {
            $group: {
              _id: { $ifNull: ["$delivery.errorCode", "unknown"] },
              count: { $sum: 1 },
            },
          },
          { $sort: { count: -1 } },
          { $limit: 20 },
        ],
        pricing: [
          { $match: { wasDelivered: true } },
          {
            $group: {
              _id: {
                category: {
                  $ifNull: ["$pricingReceipt.pricingCategory", "unknown"],
                },
                state: "$pricingState",
              },
              count: { $sum: 1 },
            },
          },
          { $sort: { count: -1 } },
          { $limit: 100 },
        ],
        daily: [
          {
            $group: {
              _id: {
                $dateToString: {
                  date: "$date",
                  format: "%Y-%m-%d",
                  timezone,
                },
              },
              accepted: { $sum: 1 },
              delivered: sum("wasDelivered"),
              read: sum("wasRead"),
              replied: sum("replied"),
              failed: sum("wasFailed"),
              pending: sum("isPending"),
            },
          },
          { $sort: { _id: 1 } },
          { $limit: 91 },
        ],
        dailyErrors: [
          { $match: { wasFailed: true } },
          {
            $group: {
              _id: {
                day: {
                  $dateToString: {
                    date: "$date",
                    format: "%Y-%m-%d",
                    timezone,
                  },
                },
                code: { $ifNull: ["$delivery.errorCode", "unknown"] },
              },
              count: { $sum: 1 },
            },
          },
          { $sort: { count: -1 } },
          { $limit: 200 },
        ],
        breakdown: [
          {
            $group: {
              _id: {
                sourceId: "$analyticsSourceId",
                phoneNumberId: "$analyticsPhoneNumberId",
                template: {
                  $ifNull: ["$whatsappTemplate.name", "$origin.templateName"],
                },
              },
              accepted: { $sum: 1 },
              delivered: sum("wasDelivered"),
              read: sum("wasRead"),
              replied: sum("replied"),
              failed: sum("wasFailed"),
              pending: sum("isPending"),
            },
          },
          { $sort: { accepted: -1 } },
          { $limit: 101 },
        ],
        sourceTotals: [
          {
            $group: {
              _id: "$analyticsSourceId",
              accepted: { $sum: 1 },
              failed: sum("wasFailed"),
              pending: sum("isPending"),
            },
          },
          { $limit: 101 },
        ],
      },
    },
  ] as PipelineStage[];
}

export function normalizeWhatsAppLocalAnalytics(
  input: unknown
): Pick<WhatsAppAnalyticsResult, "delivery" | "pricing"> {
  const raw = asRecord(input);
  const totals = list(raw.totals)[0] || {};
  const accepted = number(totals.accepted),
    delivered = number(totals.delivered),
    read = number(totals.read),
    replied = number(totals.replied);
  const deliveryPercentiles = Array.isArray(totals.deliveryPercentiles)
    ? totals.deliveryPercentiles
    : [];
  const readPercentiles = Array.isArray(totals.readPercentiles)
    ? totals.readPercentiles
    : [];
  const pricing = {
    billable: 0,
    free: 0,
    unknown: 0,
    categoryBreakdown:
      [] as WhatsAppAnalyticsResult["pricing"]["categoryBreakdown"],
    providerAccounts: [],
    estimate: {
      amount: null,
      currency: null,
      reason: "verified_tariff_required" as const,
    },
    aiCostIncluded: false as const,
  };
  const categories = new Map<
    string,
    { category: string; billable: number; free: number; unknown: number }
  >();
  for (const row of list(raw.pricing)) {
    const id = asRecord(row._id),
      category = readNonEmptyString(id.category) || "unknown",
      state =
        id.state === "billable"
          ? "billable"
          : id.state === "free"
            ? "free"
            : "unknown";
    const count = number(row.count);
    pricing[state] += count;
    const item = categories.get(category) || {
      category,
      billable: 0,
      free: 0,
      unknown: 0,
    };
    item[state] += count;
    categories.set(category, item);
  }
  pricing.categoryBreakdown = Array.from(categories.values());
  return {
    delivery: {
      accepted,
      sent: number(totals.sent),
      delivered,
      read,
      replied,
      failed: number(totals.failed),
      pending: number(totals.pending),
      deliveredRate: ratio(delivered, accepted),
      readRate: ratio(read, delivered),
      replyRate: ratio(replied, accepted),
      medianDeliverySeconds: nullableNumber(deliveryPercentiles[0]),
      p95DeliverySeconds: nullableNumber(deliveryPercentiles[1]),
      medianReadSeconds: nullableNumber(readPercentiles[0]),
      p95ReadSeconds: nullableNumber(readPercentiles[1]),
      byOrigin: list(raw.origins).map(row => ({
        origin: readNonEmptyString(row._id) || "unknown",
        accepted: number(row.accepted),
        delivered: number(row.delivered),
        read: number(row.read),
        replied: number(row.replied),
        failed: number(row.failed),
      })),
      topErrors: list(raw.errors).map(row => ({
        code: String(row._id ?? "unknown"),
        count: number(row.count),
      })),
      dailyDelivery: list(raw.daily).map(row => ({
        day: readNonEmptyString(row._id) || "",
        accepted: number(row.accepted),
        delivered: number(row.delivered),
        read: number(row.read),
        replied: number(row.replied),
        failed: number(row.failed),
        pending: number(row.pending),
        topErrors: list(raw.dailyErrors)
          .filter(error => asRecord(error._id).day === row._id)
          .slice(0, 10)
          .map(error => ({
            code: String(asRecord(error._id).code ?? "unknown"),
            count: number(error.count),
          })),
      })),
      bySourcePhoneTemplate: list(raw.breakdown)
        .slice(0, 100)
        .map(row => ({
          sourceId: readNonEmptyString(asRecord(row._id).sourceId),
          phoneNumberId: readNonEmptyString(asRecord(row._id).phoneNumberId),
          template: readNonEmptyString(asRecord(row._id).template),
          accepted: number(row.accepted),
          delivered: number(row.delivered),
          read: number(row.read),
          replied: number(row.replied),
          failed: number(row.failed),
          pending: number(row.pending),
        })),
      breakdownTruncated: list(raw.breakdown).length > 100,
    },
    pricing,
  };
}

function providerPoints(input: unknown, field: string): Row[] {
  const outer = asRecord(input);
  const body = asRecord(outer[field] ?? input);
  return list(body.data).flatMap(row => list(row.data_points));
}
export function normalizeProviderPricing(
  input: unknown,
  currency: string | null
): WhatsAppPricingPoint[] {
  return providerPoints(input, "pricing_analytics").map(row => ({
    start: number(row.start),
    end: number(row.end),
    country: readNonEmptyString(row.country),
    category: readNonEmptyString(row.pricing_category),
    type: readNonEmptyString(row.pricing_type),
    tier:
      typeof row.tier === "string"
        ? row.tier
        : row.tier
          ? JSON.stringify(row.tier)
          : null,
    volume: number(row.volume),
    cost: nullableNumber(row.cost),
    currency,
  }));
}
export function normalizeTemplateAnalytics(
  input: unknown,
  currency: string | null
): WhatsAppTemplateEffectiveness[] {
  const templates = new Map<string, WhatsAppTemplateEffectiveness>();
  const incompleteCost = new Set<string>();
  for (const row of providerPoints(input, "template_analytics")) {
    const id = readNonEmptyString(row.template_id);
    if (!id) continue;
    const item = templates.get(id) || {
      id,
      name: "",
      language: "",
      category: "",
      quality: null,
      status: "unknown",
      sent: 0,
      delivered: 0,
      read: 0,
      clicked: 0,
      uniqueClicked: 0,
      quickReplyClicked: 0,
      cost: null,
      currency,
      readRate: null,
      clickRate: null,
      costPerDelivered: null,
    };
    item.sent += number(row.sent);
    item.delivered += number(row.delivered);
    if (nullableNumber(row.read) === null) item.read = null;
    else if (item.read !== null) item.read += number(row.read);
    // An empty or partial array does not prove eligibility or zero engagement
    // for an omitted button type. Every daily contribution must be reported.
    for (const [type, field] of [
      ["url_button", "clicked"],
      ["unique_url_button", "uniqueClicked"],
      ["quick_reply_button", "quickReplyClicked"],
    ] as const) {
      const clicks = list(row.clicked).filter(click => click.type === type);
      if (!clicks.length) item[field] = null;
      for (const click of clicks) {
        const count = nullableNumber(click.count ?? click.value);
        item[field] =
          count === null || item[field] === null ? null : item[field] + count;
      }
    }
    const cost = list(row.cost).find(value => value.type === "amount_spent");
    if (!cost || nullableNumber(cost.value) === null) incompleteCost.add(id);
    if (row.currency !== undefined && row.currency !== currency) {
      incompleteCost.add(id);
      item.currency = null;
    }
    if (cost && nullableNumber(cost.value) !== null)
      item.cost = (item.cost ?? 0) + number(cost.value);
    item.readRate =
      item.read === null ? null : ratio(item.read, item.delivered);
    item.clickRate =
      item.uniqueClicked === null
        ? null
        : ratio(item.uniqueClicked, item.delivered);
    item.costPerDelivered =
      item.cost === null ? null : ratio(item.cost, item.delivered);
    templates.set(id, item);
  }
  return Array.from(templates.values()).map(item =>
    incompleteCost.has(item.id)
      ? { ...item, cost: null, costPerDelivered: null }
      : item
  );
}
