const LIMIT_LABELS: Record<string, string> = {
  TIER_250: "250 / 24h",
  TIER_1K: "1,000 / 24h",
  TIER_2K: "2,000 / 24h",
  TIER_10K: "10,000 / 24h",
  TIER_100K: "100,000 / 24h",
  TIER_UNLIMITED: "Unlimited",
  UNLIMITED: "Unlimited",
};

export function formatMessagingLimitTier(value?: string | null): string {
  const normalized = value?.trim().toUpperCase();
  if (!normalized) return "Unknown";

  const knownLabel = LIMIT_LABELS[normalized];
  if (knownLabel) return knownLabel;

  if (/^\d+$/.test(normalized)) {
    return `${Number(normalized).toLocaleString("en-US")} / 24h`;
  }

  return normalized.replace(/^TIER_/, "").replace(/_/g, " ");
}
