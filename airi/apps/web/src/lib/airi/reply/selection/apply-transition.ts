import { extractQuotedPrice } from "@/lib/airi/grounding/pricing-quote-extract";
import { normalizeComparableText } from "@/lib/airi/reply/thread/reply-text-utils";
import { trimSelectionLabelText } from "@/lib/airi/reply/selection/selection-text";
import {
  normalizeAiriActiveSelection,
  normalizeAiriSelectionTransition,
  parseGroundedReplyOptionPayload,
  type AiriActiveSelection,
  type AiriSelectionTransition,
} from "@/lib/airi/reply/selection/types";

type SelectionMessage = {
  id: string;
  text: string;
  direction: "inbound" | "outbound";
};

type GroundingLike =
  | {
      sourceKind: "snippet" | "kb" | "mixed" | "none";
      sourceIds: string[];
      intentAnchor: string | null;
    }
  | null
  | undefined;

function buildSelectionFromTransition(params: {
  transition: AiriSelectionTransition;
  lastGrounding: GroundingLike;
  messages: SelectionMessage[];
  quickReplyPayload?: string | null;
}): AiriActiveSelection {
  const explicitOption = parseGroundedReplyOptionPayload(
    params.quickReplyPayload
  );
  if (explicitOption) {
    return {
      kind: explicitOption.selectionKind || "product",
      label: explicitOption.label,
      normalizedLabel: normalizeComparableText(explicitOption.label),
      sourceKind: explicitOption.sourceKind,
      sourceIds: explicitOption.sourceIds.slice(0, 8),
      quotedPriceText: explicitOption.quotedPriceText || null,
      quotedPriceAmount: explicitOption.quotedPriceAmount ?? null,
      quotedPriceCurrency: explicitOption.quotedPriceCurrency || null,
      updatedAt: new Date(),
    };
  }

  const selectionLabel = trimSelectionLabelText(
    params.transition.selectionLabel || ""
  );
  if (!selectionLabel) return null;

  const normalizedLabel = normalizeComparableText(selectionLabel);
  if (!normalizedLabel) return null;

  const sourceKind =
    params.lastGrounding?.sourceKind === "snippet" ||
    params.lastGrounding?.sourceKind === "kb" ||
    params.lastGrounding?.sourceKind === "mixed"
      ? params.lastGrounding.sourceKind
      : "kb";
  const sourceIds = Array.from(
    new Set(
      (params.lastGrounding?.sourceIds || [])
        .map(item => String(item || "").trim())
        .filter(Boolean)
    )
  ).slice(0, 8);

  if (sourceIds.length === 0) {
    return null;
  }

  const priorAssistantText =
    [...params.messages]
      .reverse()
      .find(message => message.direction === "outbound")?.text || "";
  const price = extractQuotedPrice(priorAssistantText);

  return {
    kind: "product",
    label: selectionLabel,
    normalizedLabel,
    sourceKind,
    sourceIds,
    quotedPriceText: price?.text || null,
    quotedPriceAmount: price?.amount ?? null,
    quotedPriceCurrency: price?.currency || null,
    updatedAt: new Date(),
  };
}

function labelsConflict(left: string, right: string): boolean {
  if (!left || !right) return false;
  return left !== right && !left.includes(right) && !right.includes(left);
}

export function applyAiriSelectionTransition(params: {
  transition?: Partial<AiriSelectionTransition> | null;
  existingSelection?: AiriActiveSelection;
  lastGrounding?: GroundingLike;
  messages: SelectionMessage[];
  quickReplyPayload?: string | null;
}): AiriActiveSelection {
  const transition = normalizeAiriSelectionTransition(params.transition);
  const existingSelection = normalizeAiriActiveSelection(
    params.existingSelection
  );
  const explicitOption = parseGroundedReplyOptionPayload(
    params.quickReplyPayload
  );

  if (
    !explicitOption &&
    (transition.action === "none" || transition.action === "keep_existing")
  ) {
    return existingSelection;
  }

  if (transition.action === "clear_selection") {
    return null;
  }

  const nextSelection = buildSelectionFromTransition({
    transition,
    lastGrounding: params.lastGrounding,
    messages: params.messages,
    quickReplyPayload: params.quickReplyPayload,
  });

  if (!nextSelection) {
    return transition.action === "select_offer" ? existingSelection : null;
  }

  if (
    existingSelection &&
    !labelsConflict(
      nextSelection.normalizedLabel,
      existingSelection.normalizedLabel
    )
  ) {
    return {
      ...existingSelection,
      ...nextSelection,
      updatedAt: new Date(),
    };
  }

  return nextSelection;
}
