import type { WhatsAppMarketingMessagesOptimizationSpec } from "@icecore/shared/types/whatsapp";

export const WHATSAPP_MARKETING_MESSAGES_BID_STRATEGY =
  "LOWEST_COST_WITH_BID_CAP" as const;

type ValidationResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: string;
    };

function parsePositiveFiniteNumber(
  value: unknown,
  label: string
): ValidationResult<number | undefined> {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: undefined };
  }

  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { ok: false, error: `${label} must be a positive number` };
  }

  return { ok: true, value: parsed };
}

export function normalizeMarketingMessagesOptimizationSpec(
  value: unknown
): ValidationResult<WhatsAppMarketingMessagesOptimizationSpec | undefined> {
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      error: "optimization_spec must be an object",
    };
  }

  const record = value as Record<string, unknown>;
  const bidAmountResult = parsePositiveFiniteNumber(
    record.bid_amount,
    "optimization_spec.bid_amount"
  );
  if (!bidAmountResult.ok) return bidAmountResult;

  if (
    bidAmountResult.value === undefined ||
    !Number.isSafeInteger(bidAmountResult.value)
  ) {
    return {
      ok: false,
      error: "optimization_spec.bid_amount must be a positive integer",
    };
  }

  if (record.bid_strategy !== WHATSAPP_MARKETING_MESSAGES_BID_STRATEGY) {
    return {
      ok: false,
      error: "optimization_spec.bid_strategy must be LOWEST_COST_WITH_BID_CAP",
    };
  }

  return {
    ok: true,
    value: {
      bid_amount: bidAmountResult.value,
      bid_strategy: WHATSAPP_MARKETING_MESSAGES_BID_STRATEGY,
    },
  };
}

export function normalizePerMessageBidMultiplier(
  value: unknown
): ValidationResult<number | undefined> {
  return parsePositiveFiniteNumber(value, "perMessageBidMultiplier");
}
