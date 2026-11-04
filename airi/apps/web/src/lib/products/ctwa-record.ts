import { adsManagerAdUrl } from "@/lib/meta-ads/ctwa";
import type {
  ProductAdCtwaRecord,
  ProductAdCtwaStep,
} from "@/lib/products/types";
import type { ProductAdStoredCtwa } from "@/models/product-ad";

// The ad's Click-to-WhatsApp ad as the page reads it: the stored state
// without the Marketing API ids, the lease or the request id, plus the link to
// the ad in Ads Manager once it exists. Pure, so the ad's record (ads.ts) and
// the ctwa routes share it.

const toIso = (value: unknown): string | null => {
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string" && value) {
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
  }
  return null;
};

/** Where a failed attempt stopped: its first step without a stored id; null once all were made. */
function failedStepOf(
  stored: Partial<ProductAdStoredCtwa>
): ProductAdCtwaStep | null {
  if (stored.state !== "failed") return null;
  if (!(stored.asset === "video" ? stored.videoId : stored.imageHash))
    return "video";
  if (!stored.campaignId) return "campaign";
  if (!stored.adSetId) return "adset";
  if (!stored.creativeId) return "creative";
  if (!stored.adId) return "ad";
  return null;
}

/** The stored Click-to-WhatsApp ad as the page reads it; null when none was asked for. */
export function toCtwaRecord(
  stored: Partial<ProductAdStoredCtwa> | null | undefined
): ProductAdCtwaRecord | null {
  if (!stored?.state || !stored.asset) return null;
  return {
    attempt:
      typeof stored.attempt === "number" && stored.attempt >= 1
        ? stored.attempt
        : 1,
    asset: stored.asset,
    state: stored.state,
    effectiveStatus: stored.effectiveStatus ?? null,
    adsManagerUrl:
      stored.adId && stored.adAccountId
        ? adsManagerAdUrl(stored.adAccountId, stored.adId)
        : null,
    dailyBudgetCents: stored.dailyBudgetCents ?? null,
    endsAt: toIso(stored.endsAt),
    errorCode: stored.errorCode ?? null,
    errorMessage: stored.errorMessage ?? null,
    failedStep: failedStepOf(stored),
  };
}
