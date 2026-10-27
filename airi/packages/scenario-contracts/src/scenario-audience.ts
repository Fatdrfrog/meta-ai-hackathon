export type ScenarioAudienceCustomer = {
  id: string;
  label: string;
  channel?: string;
  category?: string;
  segmentKey?: string | null;
  hasPurchaseHistory?: boolean;
  internalLabels?: string[];
  lastMessageAt?: string | null;
};

export type ScenarioMetaReferralAdOption = {
  id: string;
  label: string;
  sourceId: string;
  sourceType?: string;
  sourcePlatform?: string;
  channel?: string;
  campaignId?: string;
  campaignName?: string;
  adSetId?: string;
  adSetName?: string;
  headline?: string;
  body?: string;
  sourceUrl?: string;
  mediaUrl?: string;
  lastSeenAt?: string | null;
  conversationCount?: number;
};

export type ScenarioMetaReferralCampaignOption = {
  id: string;
  label: string;
  campaignId: string;
  campaignName?: string;
  lastSeenAt?: string | null;
  adCount?: number;
  conversationCount?: number;
};

export type ScenarioMetaCampaignLabelOption = {
  id: string;
  labelId: string;
  name: string;
  adAccountId: string;
  adAccountName?: string;
};

export type ScenarioMetaReferralAdSetOption = {
  id: string;
  label: string;
  adSetId: string;
  adSetName?: string;
  campaignId?: string;
  campaignName?: string;
  lastSeenAt?: string | null;
  adCount?: number;
  conversationCount?: number;
};

export type ScenarioMetaAdsDataStatus = {
  state: "complete" | "partial" | "unavailable";
  reasons: Array<
    "not_connected" | "access_unavailable" | "provider_error" | "limit_reached"
  >;
};

export type ScenarioAudienceOptions = {
  channels: string[];
  classificationCategories: string[];
  funnelStages: string[];
  internalLabels: string[];
  customers: ScenarioAudienceCustomer[];
  metaReferralAds: ScenarioMetaReferralAdOption[];
  metaReferralCampaigns: ScenarioMetaReferralCampaignOption[];
  metaReferralAdSets: ScenarioMetaReferralAdSetOption[];
  metaCampaignLabels: ScenarioMetaCampaignLabelOption[];
  metaAdsDataStatus?: ScenarioMetaAdsDataStatus;
};
