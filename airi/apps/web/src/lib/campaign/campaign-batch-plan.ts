import { getPhoneNumberDetails } from "@/lib/whatsapp/qr-code-service";
import { getWABASendingReadiness } from "@/lib/whatsapp/waba-service";
import {
  isBulkCampaignReadiness,
  type BulkCampaignReadiness,
} from "@icecore/scenario-contracts";
import { MAX_BULK_CAMPAIGN_RECIPIENTS } from "./bulk-campaign-contracts";
import type { BulkCampaignDispatchBatchPlan } from "@icecore/temporal";

type Channel = "whatsapp" | "telegram" | "email";

export type CampaignBatchPlanPreview = {
  channel: Channel;
  batchPlan: BulkCampaignDispatchBatchPlan;
  recipientLimit: CampaignRecipientLimit;
  readiness?: BulkCampaignReadiness;
  whatsappMeta?: {
    phoneNumberId: string;
    displayPhoneNumber?: string | null;
    verifiedName?: string | null;
    qualityRating?: string | null;
    throughputLevel?: string | null;
    detailsSource: "meta_phone_details" | "meta_lookup_failed";
    warning?: string | null;
  };
};

export type CampaignRecipientLimit = {
  maxRecipients: number | null;
  rawLimit?: string | null;
  source: "live_meta" | "cached_meta" | "channel_default" | "unavailable";
  warning?: string | null;
  error?: string | null;
  unlimited?: boolean;
};

/** Apply only to new work; immutable admitted campaigns recover before live gates. */
export function assertCampaignPlanSendingReadiness(
  preview: CampaignBatchPlanPreview
): void {
  if (preview.channel !== "whatsapp") return;
  const readiness = preview.readiness;
  if (
    !isBulkCampaignReadiness(readiness) ||
    readiness.state === "unavailable"
  ) {
    throw new Error(
      "WhatsApp campaign sending readiness is unavailable. Retry after the Meta connection can be checked."
    );
  }
  if (readiness.state !== "ready") {
    throw new Error(
      "WhatsApp campaign sending is blocked by Meta. Resolve the account restriction before starting new work."
    );
  }
}

const DEFAULT_RECIPIENT_LIMIT = 1000;
const META_PHONE_DETAILS_FALLBACK_WARNING =
  "Meta phone number details are unavailable. Using the default WhatsApp dispatch plan.";

const DEFAULT_BATCH_PLANS: Record<Channel, BulkCampaignDispatchBatchPlan> = {
  whatsapp: {
    batchSize: 20,
    delayMs: 250,
    ratePerSecond: 80,
    rateSource: "meta_default_throughput",
    throughputLevel: "STANDARD",
  },
  telegram: {
    batchSize: 30,
    delayMs: 1000,
    ratePerSecond: 30,
    rateSource: "telegram_free_broadcast_limit",
    throughputLevel: null,
  },
  email: {
    batchSize: 20,
    delayMs: 334,
    ratePerSecond: 60,
    rateSource: "channel_default",
    throughputLevel: null,
  },
};

const HIGH_THROUGHPUT_PLAN: BulkCampaignDispatchBatchPlan = {
  batchSize: 100,
  delayMs: 100,
  ratePerSecond: 1000,
  rateSource: "meta_phone_throughput",
  throughputLevel: "HIGH",
};

const CHANNEL_DEFAULT_RECIPIENT_LIMIT: CampaignRecipientLimit = {
  maxRecipients: DEFAULT_RECIPIENT_LIMIT,
  rawLimit: String(DEFAULT_RECIPIENT_LIMIT),
  source: "channel_default",
};

function resolveChannelDefaultRecipientLimit(params?: {
  warning?: string | null;
}): CampaignRecipientLimit {
  return {
    ...CHANNEL_DEFAULT_RECIPIENT_LIMIT,
    warning: params?.warning || null,
  };
}

function normalizeString(value: unknown): string {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function resolveThroughputLevel(value: unknown): string | null {
  if (!value) return null;

  if (typeof value === "string") {
    return normalizeString(value) || null;
  }

  if (typeof value === "object" && value !== null && "level" in value) {
    return normalizeString((value as { level?: unknown }).level) || null;
  }

  return null;
}

function resolveBatchPlanForThroughputLevel(
  throughputLevel: string | null
): BulkCampaignDispatchBatchPlan {
  if (throughputLevel === "HIGH" || throughputLevel === "1000") {
    return {
      ...HIGH_THROUGHPUT_PLAN,
      throughputLevel,
    };
  }

  if (throughputLevel) {
    return {
      ...DEFAULT_BATCH_PLANS.whatsapp,
      throughputLevel,
      rateSource: "meta_phone_throughput",
    };
  }

  return DEFAULT_BATCH_PLANS.whatsapp;
}

function normalizeLimitString(value: unknown): string {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function capWhatsAppRecipientLimit(maxRecipients: number): number {
  return Math.min(maxRecipients, MAX_BULK_CAMPAIGN_RECIPIENTS);
}

export function parseWhatsAppMessagingLimit(value: unknown): {
  maxRecipients: number;
  rawLimit: string;
  unlimited?: boolean;
} | null {
  const rawLimit = normalizeLimitString(value);
  if (!rawLimit) return null;

  const numericMatch = rawLimit.match(/^(\d+)(?:\s*)$/);
  if (numericMatch) {
    const maxRecipients = Number.parseInt(numericMatch[1], 10);
    return Number.isFinite(maxRecipients) && maxRecipients > 0
      ? { maxRecipients: capWhatsAppRecipientLimit(maxRecipients), rawLimit }
      : null;
  }

  const tierNumericMatch = rawLimit.match(/^TIER_(\d+)$/);
  if (tierNumericMatch) {
    const maxRecipients = Number.parseInt(tierNumericMatch[1], 10);
    return Number.isFinite(maxRecipients) && maxRecipients > 0
      ? { maxRecipients: capWhatsAppRecipientLimit(maxRecipients), rawLimit }
      : null;
  }

  const compactMatch = rawLimit.match(/(\d+)\s*K/);
  if (compactMatch) {
    const valueInThousands = Number.parseInt(compactMatch[1], 10);
    return Number.isFinite(valueInThousands) && valueInThousands > 0
      ? {
          maxRecipients: capWhatsAppRecipientLimit(valueInThousands * 1000),
          rawLimit,
        }
      : null;
  }

  if (rawLimit.includes("UNLIMITED")) {
    return {
      maxRecipients: MAX_BULK_CAMPAIGN_RECIPIENTS,
      rawLimit,
    };
  }

  return null;
}

function resolveRecipientLimitFromRaw(params: {
  rawLimit: unknown;
  source: "live_meta" | "cached_meta";
  warning?: string | null;
}): CampaignRecipientLimit | null {
  const parsed = parseWhatsAppMessagingLimit(params.rawLimit);
  if (!parsed) return null;
  return {
    maxRecipients: parsed.maxRecipients,
    rawLimit: parsed.rawLimit,
    source: params.source,
    warning: params.warning || null,
    unlimited: parsed.unlimited,
  };
}

function resolveUnavailableRecipientLimit(
  error?: unknown
): CampaignRecipientLimit {
  return {
    maxRecipients: null,
    source: "unavailable",
    error:
      error instanceof Error ? error.message : error ? String(error) : null,
  };
}

export async function resolveCampaignBatchPlanPreview(params: {
  channel: Channel;
  wabaId?: string | null;
  phoneNumberId?: string | null;
  accessToken?: string | null;
  cachedMessagingLimit?: unknown;
}): Promise<CampaignBatchPlanPreview> {
  if (
    params.channel !== "whatsapp" ||
    !params.phoneNumberId ||
    !params.accessToken
  ) {
    return {
      channel: params.channel,
      batchPlan: DEFAULT_BATCH_PLANS[params.channel],
      recipientLimit: CHANNEL_DEFAULT_RECIPIENT_LIMIT,
      ...(params.channel === "whatsapp"
        ? { readiness: await getWABASendingReadiness({}) }
        : {}),
    };
  }

  try {
    const [details, businessReadiness] = await Promise.all([
      getPhoneNumberDetails(params.phoneNumberId, params.accessToken),
      getWABASendingReadiness({
        wabaId: params.wabaId,
        accessToken: params.accessToken,
      }),
    ]);
    const readiness: BulkCampaignReadiness =
      details?.status && details.status !== "CONNECTED"
        ? {
            ...businessReadiness,
            state: "blocked",
            reasons: [
              ...businessReadiness.reasons,
              { code: "meta_disconnected" },
            ],
          }
        : businessReadiness;
    const throughputLevel = resolveThroughputLevel(details?.throughput);
    const batchPlan = resolveBatchPlanForThroughputLevel(throughputLevel);
    const liveRecipientLimit = resolveRecipientLimitFromRaw({
      rawLimit: details?.whatsapp_business_manager_messaging_limit,
      source: "live_meta",
    });
    const cachedRecipientLimit = resolveRecipientLimitFromRaw({
      rawLimit: params.cachedMessagingLimit,
      source: "cached_meta",
    });

    return {
      channel: "whatsapp",
      batchPlan,
      readiness,
      recipientLimit:
        liveRecipientLimit ||
        cachedRecipientLimit ||
        resolveUnavailableRecipientLimit("Missing WhatsApp messaging limit."),
      whatsappMeta: {
        phoneNumberId: params.phoneNumberId,
        displayPhoneNumber: details?.display_phone_number || null,
        verifiedName: details?.verified_name || null,
        qualityRating: details?.quality_rating || null,
        throughputLevel: batchPlan.throughputLevel || null,
        detailsSource: "meta_phone_details",
      },
    };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn("[Campaign] Falling back to default batch plan", {
      channel: params.channel,
      phoneNumberId: params.phoneNumberId,
      error: error instanceof Error ? error.message : String(error),
    });

    const cachedRecipientLimit = resolveRecipientLimitFromRaw({
      rawLimit: params.cachedMessagingLimit,
      source: "cached_meta",
      warning: META_PHONE_DETAILS_FALLBACK_WARNING,
    });

    return {
      channel: "whatsapp",
      batchPlan: DEFAULT_BATCH_PLANS.whatsapp,
      readiness: {
        state: "unavailable",
        checkedAt: new Date().toISOString(),
        remainingCapacity: null,
        reasons: [{ code: "meta_check_unavailable" }],
      },
      recipientLimit:
        cachedRecipientLimit ||
        resolveChannelDefaultRecipientLimit({
          warning: META_PHONE_DETAILS_FALLBACK_WARNING,
        }),
      whatsappMeta: {
        phoneNumberId: params.phoneNumberId,
        throughputLevel: DEFAULT_BATCH_PLANS.whatsapp.throughputLevel || null,
        detailsSource: "meta_lookup_failed",
        warning: META_PHONE_DETAILS_FALLBACK_WARNING,
      },
    };
  }
}

export async function resolveCampaignBatchPlan(params: {
  channel: Channel;
  wabaId?: string | null;
  phoneNumberId?: string | null;
  accessToken?: string | null;
}): Promise<BulkCampaignDispatchBatchPlan> {
  const preview = await resolveCampaignBatchPlanPreview(params);
  return preview.batchPlan;
}
