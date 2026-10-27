import type { ScenarioWhatsAppFlowOption } from "../../types";

const FLOW_STATUS_BADGE_KEYS: Record<string, string> = {
  DRAFT: "flowStatusDraft",
  BLOCKED: "flowStatusBlocked",
  THROTTLED: "flowStatusThrottled",
  DEPRECATED: "flowStatusDeprecated",
};

/** The badge key for a form status; published is the normal state and has none. */
export function getFlowStatusBadgeKey(
  status: string | null | undefined
): string | null {
  return FLOW_STATUS_BADGE_KEYS[(status || "").trim().toUpperCase()] ?? null;
}

export function getExistingFlowOptionKey(
  flow: ScenarioWhatsAppFlowOption
): string {
  return `${flow.sourceId?.trim() || "unscoped"}\u0000${flow.id.trim()}`;
}
