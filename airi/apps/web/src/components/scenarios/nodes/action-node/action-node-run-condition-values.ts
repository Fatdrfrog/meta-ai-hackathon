import type { ScenarioActionRunCondition } from "@icecore/scenario-contracts";
import type { ScenarioAudienceOptions } from "../../types";

export type ActionRunConditionType = ScenarioActionRunCondition["type"];
export type PendingConditionType = Exclude<
  ActionRunConditionType,
  "has_purchase_history" | "last_seen_days"
>;

export function selectOptionsFor(
  type: PendingConditionType,
  audienceOptions: ScenarioAudienceOptions
): string[] {
  if (type === "classification")
    return audienceOptions.classificationCategories;
  if (type === "internal_label") return audienceOptions.internalLabels;
  if (type === "funnel_stage") return audienceOptions.funnelStages;
  return [];
}

/**
 * A saved value that is no longer offered. While an option list is empty it
 * may still be loading, so nothing counts as removed.
 */
export function isRunConditionValueRemoved(value: string, options: string[]) {
  return value.length > 0 && options.length > 0 && !options.includes(value);
}

function savedRunConditionOption(
  condition: ScenarioActionRunCondition
): { type: PendingConditionType; value: string } | null {
  if (condition.type === "classification")
    return { type: condition.type, value: condition.category };
  if (condition.type === "internal_label")
    return { type: condition.type, value: condition.label };
  if (condition.type === "funnel_stage")
    return { type: condition.type, value: condition.stage };
  return null;
}

/** Conditions whose saved option was removed; each shows its own error. */
export function countRemovedRunConditionValues(
  conditions: readonly ScenarioActionRunCondition[],
  audienceOptions: ScenarioAudienceOptions
): number {
  return conditions.filter(condition => {
    const saved = savedRunConditionOption(condition);
    return saved
      ? isRunConditionValueRemoved(
          saved.value,
          selectOptionsFor(saved.type, audienceOptions)
        )
      : false;
  }).length;
}
