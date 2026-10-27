export const SCENARIO_BEHAVIOR_PRESETS = [
  "abandoned_cart",
  "abandoned_checkout",
  "purchase_completed",
  "replenishment",
  "second_purchase",
  "win_back",
  "upcoming_renewal",
  "overdue_service",
] as const;
export type ScenarioBehaviorPreset = (typeof SCENARIO_BEHAVIOR_PRESETS)[number];
export type CustomerBehaviorEventType =
  | "cart_updated"
  | "checkout_started"
  | "purchase_completed"
  | "renewal_scheduled"
  | "service_scheduled"
  | "checkout_closed"
  | "renewal_completed"
  | "service_completed";

export type PurchaseSegment = {
  minPurchases?: number;
  maxPurchases?: number;
  minDaysSincePurchase?: number;
  maxDaysSincePurchase?: number;
  currency?: string;
  minNetSpend?: number;
  maxNetSpend?: number;
};
export type ScenarioBehaviorConfig = {
  preset: ScenarioBehaviorPreset;
  delayMinutes: number;
  purchaseSegment?: PurchaseSegment;
};
export type CustomerPurchaseFacts = {
  purchaseCount: number;
  lastPurchaseAt: string | null;
  netSpend: Record<string, number>;
};

export const DEFAULT_CONTACT_POLICY = {
  minIntervalHours: 24,
  maxPerWeek: 3,
} as const;
export type CustomerContactPolicy = {
  minIntervalHours: number;
  maxPerWeek: number;
};

export function isCustomerContactPolicy(
  value: unknown,
): value is CustomerContactPolicy {
  if (!value || typeof value !== "object") return false;
  const v = value as CustomerContactPolicy;
  return (
    Number.isInteger(v.minIntervalHours) &&
    v.minIntervalHours >= 1 &&
    v.minIntervalHours <= 720 &&
    Number.isInteger(v.maxPerWeek) &&
    v.maxPerWeek >= 1 &&
    v.maxPerWeek <= 100
  );
}

export function isPurchaseSegment(value: unknown): value is PurchaseSegment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (key) =>
        ![
          "minPurchases",
          "maxPurchases",
          "minDaysSincePurchase",
          "maxDaysSincePurchase",
          "currency",
          "minNetSpend",
          "maxNetSpend",
        ].includes(key),
    )
  )
    return false;
  for (const key of [
    "minPurchases",
    "maxPurchases",
    "minDaysSincePurchase",
    "maxDaysSincePurchase",
    "minNetSpend",
    "maxNetSpend",
  ]) {
    if (
      v[key] !== undefined &&
      (typeof v[key] !== "number" ||
        !Number.isFinite(v[key]) ||
        Number(v[key]) < 0)
    )
      return false;
    if (
      (key.includes("Purchases") || key.includes("Days")) &&
      v[key] !== undefined &&
      !Number.isInteger(v[key])
    )
      return false;
  }
  for (const [min, max] of [
    ["minPurchases", "maxPurchases"],
    ["minDaysSincePurchase", "maxDaysSincePurchase"],
    ["minNetSpend", "maxNetSpend"],
  ]) {
    if (
      v[min!] !== undefined &&
      v[max!] !== undefined &&
      Number(v[min!]) > Number(v[max!])
    )
      return false;
  }
  if (
    v.currency !== undefined &&
    (typeof v.currency !== "string" || !/^[A-Z]{3}$/.test(v.currency))
  )
    return false;
  return (
    (v.minNetSpend === undefined && v.maxNetSpend === undefined) ||
    typeof v.currency === "string"
  );
}

export function isScenarioBehaviorConfig(
  value: unknown,
): value is ScenarioBehaviorConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as ScenarioBehaviorConfig;
  return (
    SCENARIO_BEHAVIOR_PRESETS.includes(v.preset) &&
    Number.isInteger(v.delayMinutes) &&
    v.delayMinutes >= 0 &&
    v.delayMinutes <= (v.preset === "abandoned_cart" || v.preset === "abandoned_checkout" ? 30 : 730) * 1440 &&
    (v.purchaseSegment === undefined || isPurchaseSegment(v.purchaseSegment))
  );
}

export function behaviorPresetEventType(
  preset: ScenarioBehaviorPreset,
): CustomerBehaviorEventType {
  if (preset === "abandoned_cart") return "cart_updated";
  if (preset === "abandoned_checkout") return "checkout_started";
  if (preset === "upcoming_renewal") return "renewal_scheduled";
  if (preset === "overdue_service") return "service_scheduled";
  return "purchase_completed";
}

export function behaviorDueAt(
  config: ScenarioBehaviorConfig,
  occurredAt: string,
  dueAt?: string,
): Date | null {
  if (!isScenarioBehaviorConfig(config)) return null;
  const scheduled =
    config.preset === "upcoming_renewal" || config.preset === "overdue_service";
  const anchor = Date.parse((scheduled ? dueAt : occurredAt) || "");
  if (!Number.isFinite(anchor)) return null;
  return new Date(
    anchor +
      config.delayMinutes *
        60_000 *
        (config.preset === "upcoming_renewal" ? -1 : 1),
  );
}

export function matchesPurchaseSegment(
  segment: PurchaseSegment,
  facts: CustomerPurchaseFacts,
  now: Date,
): boolean {
  if (!isPurchaseSegment(segment)) return false;
  if (
    segment.minPurchases !== undefined &&
    facts.purchaseCount < segment.minPurchases
  )
    return false;
  if (
    segment.maxPurchases !== undefined &&
    facts.purchaseCount > segment.maxPurchases
  )
    return false;
  if (
    segment.minDaysSincePurchase !== undefined ||
    segment.maxDaysSincePurchase !== undefined
  ) {
    const age =
      (now.getTime() - Date.parse(facts.lastPurchaseAt || "")) / 86_400_000;
    if (!Number.isFinite(age) || age < 0) return false;
    if (
      segment.minDaysSincePurchase !== undefined &&
      age < segment.minDaysSincePurchase
    )
      return false;
    if (
      segment.maxDaysSincePurchase !== undefined &&
      age > segment.maxDaysSincePurchase
    )
      return false;
  }
  const spend = facts.netSpend[segment.currency || ""] ?? 0;
  return (
    (segment.minNetSpend === undefined || spend >= segment.minNetSpend) &&
    (segment.maxNetSpend === undefined || spend <= segment.maxNetSpend)
  );
}
