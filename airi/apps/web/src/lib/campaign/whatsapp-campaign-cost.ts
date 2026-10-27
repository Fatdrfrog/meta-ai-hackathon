import {
  buildWhatsAppPricingStateExpr,
  normalizeWhatsAppPricingCategory,
  type WhatsAppTariff,
} from "@icecore/shared/constants/whatsapp-message-rates";

export function roundUsd(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export { resolveWhatsAppCampaignReportedCost } from "@icecore/shared/constants/whatsapp-message-rates";

/** Cost per reply; null when cost missing or no replies. */
export function finalizeCostPerReplyValue(
  cost: number | null | undefined,
  replied: number
): number | null {
  if (
    typeof cost !== "number" ||
    !Number.isFinite(cost) ||
    !Number.isFinite(replied) ||
    replied <= 0
  ) {
    return null;
  }
  return cost / replied;
}

/**
 * Mongo expression for per-message USD cost from denormalized
 * `delivery.pricingCategory` / `delivery.pricingType` on Message docs.
 * Only counts when `$wasDelivered` is true and pricing looks billable.
 */
export function buildWhatsAppMessageCostUsdExpr(
  tariffs: readonly WhatsAppTariff[] = []
): Record<string, unknown> {
  const state = buildWhatsAppPricingStateExpr({
    typeExpr: {
      $ifNull: ["$pricingReceipt.pricingType", "$delivery.pricingType"],
    },
    billableExpr: "$pricingReceipt.pricingBillable",
  });
  const validTariffs = tariffs.filter(
    tariff =>
      tariff.currency.toUpperCase() === "USD" &&
      tariff.market.trim() !== "" &&
      tariff.tier.trim() !== "" &&
      tariff.version.trim() !== "" &&
      normalizeWhatsAppPricingCategory(tariff.category) !== null &&
      Number.isFinite(tariff.rate) &&
      tariff.rate >= 0 &&
      Number.isFinite(Date.parse(tariff.effectiveFrom)) &&
      Number.isFinite(Date.parse(tariff.effectiveUntil)) &&
      Date.parse(tariff.effectiveUntil) > Date.parse(tariff.effectiveFrom)
  );
  const coveredRates = validTariffs.map(tariff => ({
    $cond: [
      {
        $and: [
          {
            $eq: [
              { $toUpper: { $ifNull: ["$recipientMarket", ""] } },
              tariff.market.toUpperCase(),
            ],
          },
          {
            $eq: [
              { $toUpper: { $ifNull: ["$pricingCurrency", ""] } },
              tariff.currency.toUpperCase(),
            ],
          },
          { $eq: ["$pricingTier", tariff.tier] },
          {
            $eq: [
              {
                $replaceAll: {
                  input: {
                    $toLower: {
                      $trim: {
                        input: {
                          $ifNull: [
                            "$pricingReceipt.pricingCategory",
                            "$delivery.pricingCategory",
                          ],
                        },
                      },
                    },
                  },
                  find: "_",
                  replacement: "-",
                },
              },
              normalizeWhatsAppPricingCategory(tariff.category),
            ],
          },
          {
            $gte: [
              {
                $ifNull: [
                  "$delivery.deliveredAt",
                  "$delivery.readAt",
                  "$pricingReceipt.eventAt",
                  "$date",
                ],
              },
              new Date(tariff.effectiveFrom),
            ],
          },
          {
            $lt: [
              {
                $ifNull: [
                  "$delivery.deliveredAt",
                  "$delivery.readAt",
                  "$pricingReceipt.eventAt",
                  "$date",
                ],
              },
              new Date(tariff.effectiveUntil),
            ],
          },
        ],
      },
      tariff.rate,
      null,
    ],
  }));
  // Overlapping cards are ambiguous, even when they happen to have the same rate.
  const coveredRate = validTariffs.length
    ? {
        $let: {
          vars: {
            rates: {
              $filter: {
                input: coveredRates,
                as: "rate",
                cond: { $ne: ["$$rate", null] },
              },
            },
          },
          in: {
            $cond: [
              { $eq: [{ $size: "$$rates" }, 1] },
              { $arrayElemAt: ["$$rates", 0] },
              null,
            ],
          },
        },
      }
    : null;
  return {
    $cond: [
      "$wasDelivered",
      {
        $switch: {
          branches: [
            { case: { $eq: [state, "free"] }, then: 0 },
            { case: { $eq: [state, "billable"] }, then: coveredRate },
          ],
          default: null,
        },
      },
      0,
    ],
  };
}
