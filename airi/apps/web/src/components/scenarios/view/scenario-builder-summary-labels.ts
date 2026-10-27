"use client";

import { projectActiveClientMessageFilters } from "@/lib/scenarios/client-message-trigger-criteria";
import type {
  ScenarioSummary,
  ScenarioTriggerConfig,
  TranslateFn,
} from "../types";
import { buildClientMessageTriggerPresentation } from "./client-message-trigger-presentation";

export function buildScenarioTriggerSummaryChips(
  triggerConfig: ScenarioTriggerConfig | null | undefined,
  t: TranslateFn
): string[] {
  if (triggerConfig?.entryPointType === "business_event") {
    const event = triggerConfig.businessEvent;
    const filters = event?.filters ?? [];
    return [
      event?.eventName || event?.eventId || t("businessEventChooseEvent"),
      event?.integrationName ||
        event?.integrationId ||
        t("businessEventChooseIntegration"),
      ...filters
        .slice(0, 2)
        .map(
          filter =>
            `${filter.field} ${t(filter.operator === "not_equals" ? "businessEventNotEquals" : "businessEventEquals")} ${filter.value || t("businessEventChooseValue")}`
        ),
      ...(filters.length > 2
        ? [t("triggerMoreFilters", { count: filters.length - 2 })]
        : []),
    ];
  }
  if (triggerConfig?.entryPointType === "customer_behavior")
    return [t("presetTriggerCustomerBehavior")];
  // QR readiness lives outside the graph, so the trigger config cannot tell it.
  if (triggerConfig?.entryPointType === "whatsapp_qr")
    return [t("presetTriggerWhatsAppQr")];

  const criteria = projectActiveClientMessageFilters(triggerConfig);
  return [...buildClientMessageTriggerPresentation(criteria, t).summaryChips];
}

/** A selected QR renders its own picker, so only its placement name is shown. */
export function buildWhatsAppQrCompactChips(
  summary: { placementName: string } | null | undefined,
  t: TranslateFn
): string[] {
  if (!summary) {
    return [t("whatsappQrNoPlacement"), t("whatsappQrNeedsCode")];
  }
  return [summary.placementName || t("whatsappQrNoPlacement")];
}

export function buildScenarioSummaryChips(
  scenario: ScenarioSummary,
  t: TranslateFn
): string[] {
  const summary = scenario.builderSummary;
  if (!summary) return [];

  const chips: string[] = [];
  const triggerSummaries = Array.isArray(summary.triggers)
    ? summary.triggers
    : [];
  if (triggerSummaries.length > 1) {
    chips.push(t("scenarioTriggerCount", { count: triggerSummaries.length }));
  }
  const primaryTrigger = triggerSummaries[0];
  const triggerConfig = primaryTrigger?.triggerConfig || {};
  chips.push(...buildScenarioTriggerSummaryChips(triggerConfig, t));

  switch (summary.primaryActionType) {
    case "reply":
      chips.push(t("presetActionReply"));
      break;
    case "assign_human":
      chips.push(t("presetActionAssignHuman"));
      break;
    case "whatsapp_template":
      chips.push(t("presetActionWhatsAppTemplate"));
      break;
    default:
      break;
  }

  return chips.slice(0, 4);
}
