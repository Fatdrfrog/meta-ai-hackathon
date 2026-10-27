import type {
  AdvertisementAnalytics,
  InternalLabelAnalytics,
} from "@/types/dashboard";

export function hasAdvertisementData(
  data?: AdvertisementAnalytics | null
): boolean {
  const metaInsights = data?.metaInsights;
  return Boolean(
    data &&
      (data.totalConversations > 0 ||
        (data.conversionAttribution?.rows.length ?? 0) > 0 ||
        (data.conversionAttribution?.recentDeliveries.length ?? 0) > 0 ||
        data.conversionAttributionError ||
        (metaInsights &&
          ((metaInsights.totalResults ?? 0) > 0 ||
            (metaInsights.totalSpend ?? 0) > 0 ||
            (metaInsights.accounts?.length ?? 0) > 0 ||
            metaInsights.error)))
  );
}

export function hasInternalLabelData(
  data?: InternalLabelAnalytics | null
): boolean {
  return Boolean(data && data.taggedConversations > 0);
}
