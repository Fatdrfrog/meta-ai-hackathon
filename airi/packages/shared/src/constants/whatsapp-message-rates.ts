/**
 * Legacy WhatsApp Cloud API reference rates (USD), retained for compatibility.
 * These are not current tariff coverage. New estimates require an explicitly
 * verified market, currency, tier, category and effective-date card below.
 *
 * @see https://developers.facebook.com/docs/whatsapp/pricing/
 */
export const WHATSAPP_MESSAGE_RATES_VERSION = "2026-kz-docs";

/** USD per delivered billable template message (KZ defaults). */
export const WHATSAPP_MESSAGE_RATES_USD = {
  marketing: 0.0604,
  utility: 0.018,
  authentication: 0.025,
} as const;

const FREE_PRICING_TYPES = new Set([
  "free_customer_service",
  "free_entry_point",
  "free_tier",
]);

export function normalizeWhatsAppPricingCategory(
  category: unknown,
): string | null {
  if (typeof category !== "string") return null;
  const normalized = category.trim().toLowerCase().replace(/_/g, "-");
  return normalized || null;
}

export function resolveWhatsAppMessageRateUsd(
  category: unknown,
): number | null {
  const normalized = normalizeWhatsAppPricingCategory(category);
  if (!normalized) return null;

  if (normalized === "marketing" || normalized === "marketing-lite") {
    return WHATSAPP_MESSAGE_RATES_USD.marketing;
  }
  if (normalized === "utility") {
    return WHATSAPP_MESSAGE_RATES_USD.utility;
  }
  if (
    normalized === "authentication" ||
    normalized === "authentication-international"
  ) {
    return WHATSAPP_MESSAGE_RATES_USD.authentication;
  }
  return null;
}

export function isWhatsAppPricingBillable(params: {
  pricingType?: string | null;
  pricingBillable?: boolean | null;
}): boolean {
  const type =
    typeof params.pricingType === "string"
      ? params.pricingType.trim().toLowerCase()
      : "";
  if (type && FREE_PRICING_TYPES.has(type)) {
    return false;
  }
  if (type === "regular") {
    return true;
  }
  if (params.pricingBillable === false) {
    return false;
  }
  if (params.pricingBillable === true) {
    return true;
  }
  return false;
}

/** Unknown/conflicting provider receipts must never be presented as free. */
export function classifyWhatsAppPricing(params: {
  pricingType?: string | null;
  pricingBillable?: boolean | null;
}): "billable" | "free" | "unknown" {
  const type = params.pricingType?.trim().toLowerCase() || "";
  const inferred = FREE_PRICING_TYPES.has(type)
    ? false
    : type === "regular"
      ? true
      : null;
  if (
    inferred !== null &&
    typeof params.pricingBillable === "boolean" &&
    inferred !== params.pricingBillable
  )
    return "unknown";
  const billable = params.pricingBillable ?? inferred;
  return billable === true
    ? "billable"
    : billable === false
      ? "free"
      : "unknown";
}

/** Shared callback/replay patch. No recipient-market or current-tariff inference. */
export function buildWhatsAppCampaignPricingReceiptPatch(
  pricing: unknown,
  eventAt: Date,
): Record<string, unknown> | undefined {
  if (
    !pricing ||
    typeof pricing !== "object" ||
    Array.isArray(pricing) ||
    !Number.isFinite(eventAt.getTime())
  )
    return undefined;
  const value = pricing as Record<string, unknown>;
  const pricingType = typeof value.type === "string" ? value.type : null;
  const pricingBillable =
    typeof value.billable === "boolean" ? value.billable : null;
  const category = typeof value.category === "string" ? value.category : null;
  if (pricingType === null && pricingBillable === null && category === null)
    return undefined;
  const state = classifyWhatsAppPricing({ pricingType, pricingBillable });
  return {
    estimated_cost_usd: state === "free" ? 0 : null,
    cost_coverage: state === "free" ? "provider_free" : "unknown",
    pricing_type: pricingType,
    pricing_billable: pricingBillable,
    pricing_category: category,
    pricing_event_at: eventAt.toISOString(),
  };
}

/** Legacy SQL amounts have no verifiable receipt/rate coverage marker. */
export function resolveWhatsAppCampaignReportedCost(campaign: {
  channel?: string | null;
  estimated_cost?: number | null;
  cost_coverage_started_at?: string | null;
  unknown_cost_count?: number | null;
}): number | null {
  if (
    campaign.channel === "whatsapp" &&
    (!campaign.cost_coverage_started_at ||
      !Number.isFinite(Date.parse(campaign.cost_coverage_started_at)) ||
      campaign.unknown_cost_count !== 0)
  )
    return null;
  return typeof campaign.estimated_cost === "number" &&
    Number.isFinite(campaign.estimated_cost) &&
    campaign.estimated_cost >= 0
    ? campaign.estimated_cost
    : null;
}

/**
 * Why a WhatsApp campaign shows no cost: delivered messages without a verified
 * price (`not_priced`), or a campaign sent before cost tracking (`not_tracked`).
 */
export type WhatsAppCampaignCostStatus =
  | "reported"
  | "not_priced"
  | "not_tracked";

export function resolveWhatsAppCampaignCostStatus(
  campaign: Parameters<typeof resolveWhatsAppCampaignReportedCost>[0],
): {
  status: WhatsAppCampaignCostStatus;
  amount: number | null;
  unpricedCount: number | null;
} {
  const amount = resolveWhatsAppCampaignReportedCost(campaign);
  if (amount !== null) return { status: "reported", amount, unpricedCount: 0 };
  if (
    campaign.channel === "whatsapp" &&
    !Number.isFinite(Date.parse(campaign.cost_coverage_started_at || ""))
  )
    return { status: "not_tracked", amount: null, unpricedCount: null };
  const count = Number(campaign.unknown_cost_count);
  return {
    status: "not_priced",
    amount: null,
    unpricedCount: Number.isSafeInteger(count) && count > 0 ? count : null,
  };
}

/** Mongo counterpart used by every aggregate that classifies provider receipts. */
export function buildWhatsAppPricingStateExpr(params: {
  typeExpr: unknown;
  billableExpr: unknown;
}): Record<string, unknown> {
  const type = {
    $toLower: { $trim: { input: { $ifNull: [params.typeExpr, ""] } } },
  };
  const freeType = { $in: [type, Array.from(FREE_PRICING_TYPES)] };
  const regular = { $eq: [type, "regular"] };
  return {
    $switch: {
      branches: [
        {
          case: {
            $or: [
              { $and: [regular, { $eq: [params.billableExpr, false] }] },
              { $and: [freeType, { $eq: [params.billableExpr, true] }] },
            ],
          },
          then: "unknown",
        },
        {
          case: { $or: [regular, { $eq: [params.billableExpr, true] }] },
          then: "billable",
        },
        {
          case: { $or: [freeType, { $eq: [params.billableExpr, false] }] },
          then: "free",
        },
      ],
      default: "unknown",
    },
  };
}

export type WhatsAppTariff = {
  market: string;
  currency: string;
  category: string;
  tier: string;
  effectiveFrom: string;
  effectiveUntil: string;
  rate: number;
  version: string;
};

/** Estimates require an explicitly verified tariff; never guess market from +7. */
export function resolveWhatsAppTariffEstimate(params: {
  category: unknown;
  market: string;
  currency: string;
  tier: string;
  at: string | Date;
  tariffs: readonly WhatsAppTariff[];
}): { amount: number; currency: string; version: string } | null {
  const category = normalizeWhatsAppPricingCategory(params.category);
  if (
    !category ||
    !params.market.trim() ||
    !params.currency.trim() ||
    !params.tier.trim()
  )
    return null;
  const timestamp = new Date(params.at).getTime();
  if (!Number.isFinite(timestamp)) return null;
  const candidates = params.tariffs.filter(
    (tariff) =>
      tariff.market.toUpperCase() === params.market.toUpperCase() &&
      tariff.currency.toUpperCase() === params.currency.toUpperCase() &&
      normalizeWhatsAppPricingCategory(tariff.category) === category &&
      tariff.tier === params.tier &&
      timestamp >= new Date(tariff.effectiveFrom).getTime() &&
      timestamp < new Date(tariff.effectiveUntil).getTime() &&
      Number.isFinite(tariff.rate) &&
      tariff.rate >= 0,
  );
  const candidate = candidates[0];
  if (candidates.length !== 1 || !candidate || !candidate.version.trim())
    return null;
  return {
    amount: candidate.rate,
    currency: candidate.currency,
    version: candidate.version,
  };
}
