import {
  normalizeAiriActiveSelection,
  type AiriActiveSelection,
} from "@/lib/airi/reply/selection/types";

export function buildActiveSelectionPromptBlock(
  selection?: AiriActiveSelection
): string | undefined {
  const normalizedSelection = normalizeAiriActiveSelection(selection);
  if (!normalizedSelection) return undefined;

  const lines = [
    "LOCKED CUSTOMER SELECTION:",
    `- Selected ${normalizedSelection.kind}: ${normalizedSelection.label}`,
    "- Keep the reply anchored to this selection until the customer explicitly changes it.",
    "- Do not list alternative packages, tiers, or unrelated SKUs unless the customer explicitly asks to compare or switch.",
    "- If the customer is confirming or moving to payment, give only the next step for THIS selection—no full catalog or menu of options.",
    "- Avoid re-reading long KB excerpts or repeating the same article title in every sentence; one clear reference is enough.",
  ];

  if (normalizedSelection.quotedPriceText) {
    lines.push(
      `- Locked quoted price: ${normalizedSelection.quotedPriceText} (${normalizedSelection.quotedPriceCurrency || "unknown currency"})`
    );
    lines.push(
      "- Do not switch to a different price, package, or payment amount unless the customer explicitly changes the selection."
    );
  }

  return lines.join("\n");
}
