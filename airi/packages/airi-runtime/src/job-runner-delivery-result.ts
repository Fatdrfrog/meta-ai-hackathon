import type { AiriConversationOutboundDeliveryResult } from "@icecore/temporal";

export type TemporalDispatchState =
  | "reserved"
  | "dispatching"
  | "sent"
  | "not_attempted"
  | "outcome_unknown";

type DeliveryClassification = NonNullable<
  AiriConversationOutboundDeliveryResult["classification"]
>;

export function classifyAiriTemporalDispatch(
  state: TemporalDispatchState,
): DeliveryClassification {
  if (state === "sent") return "sent";
  if (state === "not_attempted") return "not_attempted";
  return "outcome_unknown";
}

export function shouldApplyAiriPostDeliveryEffects(
  result: AiriConversationOutboundDeliveryResult,
): boolean {
  return result.classification
    ? result.classification === "sent"
    : !result.skipped;
}

export function resolveAiriOutboundDate(
  classification: DeliveryClassification,
  sentDate: string | null,
): string | null {
  return classification === "sent" ? sentDate : null;
}

export function isAiriDeliveryCompatiblySkipped(
  classification: DeliveryClassification,
): boolean {
  return classification !== "sent";
}
