import type { WheelEvent } from "react";
import { toast } from "sonner";
import type { TranslateFn } from "../../types";

export function buildBranchHandleSignature<T>(
  options: T[],
  mapper: (option: T) => string
): string {
  return options.map(mapper).join("|");
}

/**
 * An error toast titled with the localized fallback. The server's message
 * becomes its description only with `showReason`, where WhatsApp's own reason
 * helps the merchant fix the request.
 */
export function showScenarioErrorToast(
  fallback: string,
  error?: unknown,
  options?: { showReason?: boolean }
): void {
  const reason =
    options?.showReason && error instanceof Error ? error.message.trim() : "";
  if (reason && reason !== fallback) {
    toast.error(fallback, { description: reason });
    return;
  }
  toast.error(fallback);
}

export function uniqueStrings(
  values: Array<string | null | undefined>
): string[] {
  return Array.from(
    new Set(
      values.filter((value): value is string => typeof value === "string")
    )
  );
}

export function appendUniqueString(
  values: Array<string | null | undefined>,
  value: string
): string[] {
  return uniqueStrings([...values, value]);
}

/** A label within a carousel card, as "Card 2 · Buy". */
export function prefixCardLabel(
  cardIndex: number | undefined,
  label: string,
  t: TranslateFn
): string {
  return cardIndex === undefined
    ? label
    : `${t("whatsappTemplateBindingCard", { index: cardIndex + 1 })} · ${label}`;
}

export const COMPACT_ACTION_NODE_MIN_ACTIONS = 8;

export function stopScenarioWheelPropagation(event: WheelEvent<HTMLElement>) {
  event.stopPropagation();
}
