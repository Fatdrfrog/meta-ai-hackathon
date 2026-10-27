import type {
  ScenarioAudienceCustomer,
  ScenarioContextItem,
  ScenarioNodeData,
  TranslateFn,
} from "../types";

export const NONE_OPTION_VALUE = "__none__";

export function getAudienceModeLabel(
  mode: NonNullable<ScenarioNodeData["audienceMode"]>,
  t: TranslateFn
): string {
  if (mode === "classification") return t("byClassification");
  if (mode === "internalLabel") return t("byInternalLabel");
  if (mode === "specificCustomers") return t("specificCustomers");
  if (mode === "has_purchase_history") return t("hasPurchaseHistory");
  if (mode === "funnel_stage") return t("byFunnelStage");
  if (mode === "last_seen_greater_than_x_days" || mode === "last_seen_days") {
    return t("lastSeenGreaterThanXDays");
  }
  return t("allCustomers");
}

export function filterScenarioContextItems(
  items: ScenarioContextItem[],
  query: string
): ScenarioContextItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return items;

  return items.filter(item => {
    const haystack = [item.label, item.description, item.meta]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  });
}

export function filterScenarioAudienceCustomers(
  customers: ScenarioAudienceCustomer[],
  query: string
): ScenarioAudienceCustomer[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return customers.slice(0, 120);

  return customers
    .filter(customer => {
      const haystack = [
        customer.label,
        customer.channel,
        customer.category,
        ...(customer.internalLabels || []),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    })
    .slice(0, 120);
}

export function resolveSafeScenarioOptionValue(
  stored: string | undefined | null,
  options: string[]
): string {
  if (!stored) return NONE_OPTION_VALUE;
  return options.includes(stored) ? stored : NONE_OPTION_VALUE;
}

export function resolveScenarioSingleSelectValue(
  value: string
): string | undefined {
  return value === NONE_OPTION_VALUE ? undefined : value;
}
