import { normalizeCurrency } from "@/lib/airi/grounding/pricing-quote-extract";
import { trimSelectionLabelText } from "@/lib/airi/reply/selection/selection-text";
import { normalizeComparableText } from "@/lib/airi/reply/thread/reply-text-utils";
import type { GroundedReplyOption } from "@icecore/shared/types/message-preview";

export type AiriActiveSelection = {
  kind: "offer" | "program" | "payment" | "product";
  label: string;
  normalizedLabel: string;
  sourceKind: "snippet" | "kb" | "mixed";
  sourceIds: string[];
  quotedPriceText: string | null;
  quotedPriceAmount: number | null;
  quotedPriceCurrency: string | null;
  updatedAt?: Date | string | null;
} | null;

export type AiriSelectionTransitionAction =
  | "none"
  | "keep_existing"
  | "select_offer"
  | "switch_selection"
  | "clear_selection";

export type AiriSelectionTransition = {
  action: AiriSelectionTransitionAction;
  selectionLabel?: string | null;
};

export type AiriGroundedReplyOptionPayload = GroundedReplyOption & {
  kind: "grounded_option";
};

function normalizeSelectionKind(
  value: unknown
): NonNullable<AiriActiveSelection>["kind"] | null {
  return value === "offer" ||
    value === "program" ||
    value === "payment" ||
    value === "product"
    ? value
    : null;
}

export function normalizeAiriSelectionTransition(
  value: Partial<AiriSelectionTransition> | null | undefined
): AiriSelectionTransition {
  const rawAction = String(value?.action || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  let action: AiriSelectionTransitionAction = "none";
  if (
    rawAction === "none" ||
    rawAction === "keep_existing" ||
    rawAction === "select_offer" ||
    rawAction === "switch_selection" ||
    rawAction === "clear_selection"
  ) {
    action = rawAction;
  } else if (rawAction === "keep") {
    action = "keep_existing";
  } else if (rawAction === "select") {
    action = "select_offer";
  } else if (rawAction === "switch") {
    action = "switch_selection";
  } else if (rawAction === "clear") {
    action = "clear_selection";
  }

  const selectionLabel =
    typeof value?.selectionLabel === "string" && value.selectionLabel.trim()
      ? trimSelectionLabelText(value.selectionLabel)
      : null;

  return {
    action,
    selectionLabel,
  };
}

export function normalizeGroundedReplyOption(
  value: Partial<GroundedReplyOption> | null | undefined
): GroundedReplyOption | null {
  if (!value) return null;

  const id = String(value.id || "").trim();
  const callbackKey =
    typeof value.callbackKey === "string" && value.callbackKey.trim()
      ? value.callbackKey.trim()
      : null;
  const label = trimSelectionLabelText(String(value.label || ""));
  const sourceKind =
    value.sourceKind === "snippet" ||
    value.sourceKind === "kb" ||
    value.sourceKind === "mixed"
      ? value.sourceKind
      : null;
  const sourceIds = Array.from(
    new Set(
      (Array.isArray(value.sourceIds) ? value.sourceIds : [])
        .map(item => String(item || "").trim())
        .filter(Boolean)
    )
  ).slice(0, 8);

  if (!id || !label || !sourceKind || sourceIds.length === 0) {
    return null;
  }

  return {
    id,
    callbackKey,
    label,
    description:
      typeof value.description === "string" && value.description.trim()
        ? value.description.trim()
        : null,
    selectionKind: normalizeSelectionKind(value.selectionKind),
    sourceKind,
    sourceIds,
    sourceRecordId:
      typeof value.sourceRecordId === "string" && value.sourceRecordId.trim()
        ? value.sourceRecordId.trim()
        : null,
    sourceDocumentId:
      typeof value.sourceDocumentId === "string" &&
      value.sourceDocumentId.trim()
        ? value.sourceDocumentId.trim()
        : null,
    quotedPriceText:
      typeof value.quotedPriceText === "string" && value.quotedPriceText.trim()
        ? value.quotedPriceText.trim()
        : null,
    quotedPriceAmount:
      typeof value.quotedPriceAmount === "number"
        ? value.quotedPriceAmount
        : null,
    quotedPriceCurrency: normalizeCurrency(value.quotedPriceCurrency),
  };
}

export function buildGroundedReplyOptionPayload(
  option: Partial<GroundedReplyOption> | null | undefined
): string | null {
  const normalized = normalizeGroundedReplyOption(option);
  if (!normalized) return null;

  return JSON.stringify({
    kind: "grounded_option",
    ...normalized,
  } satisfies AiriGroundedReplyOptionPayload);
}

export function parseGroundedReplyOptionPayload(
  value: unknown
): AiriGroundedReplyOptionPayload | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<AiriGroundedReplyOptionPayload>;
    if (parsed.kind !== "grounded_option") {
      return null;
    }
    const normalized = normalizeGroundedReplyOption(parsed);
    if (!normalized) {
      return null;
    }
    return {
      kind: "grounded_option",
      ...normalized,
    };
  } catch {
    return null;
  }
}

export function normalizeAiriActiveSelection(
  value: Partial<NonNullable<AiriActiveSelection>> | null | undefined
): AiriActiveSelection {
  if (!value) return null;
  const label = trimSelectionLabelText(String(value.label || ""));
  const normalizedLabel =
    String(value.normalizedLabel || "").trim() ||
    normalizeComparableText(label);
  const sourceKind =
    value.sourceKind === "snippet" ||
    value.sourceKind === "kb" ||
    value.sourceKind === "mixed"
      ? value.sourceKind
      : "kb";
  const sourceIds = Array.from(
    new Set(
      (Array.isArray(value.sourceIds) ? value.sourceIds : [])
        .map(item => String(item || "").trim())
        .filter(Boolean)
    )
  ).slice(0, 8);

  if (!label || !normalizedLabel || sourceIds.length === 0) {
    return null;
  }

  return {
    kind: normalizeSelectionKind(value.kind) || "product",
    label,
    normalizedLabel,
    sourceKind,
    sourceIds,
    quotedPriceText:
      typeof value.quotedPriceText === "string" && value.quotedPriceText.trim()
        ? value.quotedPriceText.trim()
        : null,
    quotedPriceAmount:
      typeof value.quotedPriceAmount === "number"
        ? value.quotedPriceAmount
        : null,
    quotedPriceCurrency: normalizeCurrency(value.quotedPriceCurrency),
    updatedAt: value.updatedAt || null,
  };
}
