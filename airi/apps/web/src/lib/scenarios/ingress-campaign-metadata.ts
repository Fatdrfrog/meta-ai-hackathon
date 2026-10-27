import type { MetaAdMetadata } from "@/lib/meta-ads/meta-ad-metadata";
import type { CampaignLabelStatus } from "@/lib/scenarios/campaign-product-routing";

function isConfirmedCampaignLabelStatus(
  status: string | null | undefined
): boolean {
  return status === "present" || status === "absent";
}

export type IngressCampaignLabelCarrier = {
  sourceId?: string | null;
  sourceType?: string | null;
  campaignId?: string | null;
  campaignName?: string | null;
  adSetId?: string | null;
  adSetName?: string | null;
  adAccountId?: string | null;
  campaignLabels?: ReadonlyArray<{
    id?: string | null;
    name?: string | null;
  }> | null;
  campaignLabelStatus?: CampaignLabelStatus | null;
  productCampaignName?: string | null;
};

type MetadataResolver = (params: {
  workspaceId: string;
  adId: string;
}) => Promise<MetaAdMetadata | null>;

type CampaignLabelFacts = {
  campaignId?: string | null;
  campaignName?: string | null;
  productCampaignName?: string | null;
  adSetId?: string | null;
  adSetName?: string | null;
  adAccountId?: string | null;
  campaignLabels?: ReadonlyArray<{
    id?: string | null;
    name?: string | null;
  }> | null;
  campaignLabelStatus?: CampaignLabelStatus | null;
};

function adIdForLookup(
  referral: IngressCampaignLabelCarrier | null | undefined
) {
  const adId = referral?.sourceId?.trim() || "";
  if (!adId) return "";
  const sourceType = referral?.sourceType?.trim().toLowerCase() || "";
  if (sourceType && sourceType !== "ad") return "";
  return adId;
}

function applyMetadata<T extends IngressCampaignLabelCarrier>(
  referral: T,
  metadata: MetaAdMetadata | null,
  options: { fillKeywordCampaignName: boolean }
): T & CampaignLabelFacts {
  if (
    !metadata ||
    !isConfirmedCampaignLabelStatus(metadata.campaignLabelStatus)
  ) {
    return {
      ...referral,
      campaignLabelStatus: "unavailable",
    } as T & CampaignLabelFacts;
  }
  const keywordCampaignName = options.fillKeywordCampaignName
    ? referral.campaignName || metadata.campaignName || referral.campaignName
    : referral.campaignName;
  return {
    ...referral,
    campaignId:
      referral.campaignId || metadata.campaignId || referral.campaignId,
    campaignName: keywordCampaignName,
    productCampaignName:
      referral.productCampaignName ||
      metadata.campaignName ||
      referral.campaignName,
    adSetId: referral.adSetId || metadata.adSetId || referral.adSetId,
    adSetName: referral.adSetName || metadata.adSetName || referral.adSetName,
    adAccountId: metadata.adAccountId || referral.adAccountId,
    campaignLabels: metadata.campaignLabels,
    campaignLabelStatus: metadata.campaignLabelStatus,
  } as T & CampaignLabelFacts;
}

export async function enrichIngressReferralPair<
  WhatsAppReferral extends IngressCampaignLabelCarrier,
  MetaReferral extends IngressCampaignLabelCarrier,
>(params: {
  workspaceId: string;
  whatsappReferral?: WhatsAppReferral | null;
  metaReferral?: MetaReferral | null;
  resolveMetaAdMetadata?: MetadataResolver;
  allowLiveLookup?: boolean;
}): Promise<{
  whatsappReferral: (WhatsAppReferral & CampaignLabelFacts) | null;
  metaReferral: (MetaReferral & CampaignLabelFacts) | null;
}> {
  const whatsappReferral = params.whatsappReferral ?? null;
  const metaReferral = params.metaReferral ?? null;
  if (params.allowLiveLookup === false) {
    return {
      whatsappReferral: whatsappReferral as
        | (WhatsAppReferral & CampaignLabelFacts)
        | null,
      metaReferral: metaReferral as (MetaReferral & CampaignLabelFacts) | null,
    };
  }

  const resolve =
    params.resolveMetaAdMetadata ||
    (async request => {
      // Live Graph client pulls server-only Supabase. Keep it off the import
      // path so unit tests can inject a resolver without credentials.
      const { resolveMetaAdMetadataForWorkspace } = await import(
        "@/lib/meta-ads/meta-ad-metadata"
      );
      return resolveMetaAdMetadataForWorkspace(request);
    });
  const adIds = new Set<string>();
  for (const referral of [whatsappReferral, metaReferral]) {
    const adId = adIdForLookup(referral);
    if (!adId) continue;
    if (
      isConfirmedCampaignLabelStatus(referral?.campaignLabelStatus ?? undefined)
    ) {
      continue;
    }
    adIds.add(adId);
  }

  const metadataByAdId = new Map<string, MetaAdMetadata | null>();
  await Promise.all(
    [...adIds].map(async adId => {
      const metadata = await resolve({
        workspaceId: params.workspaceId,
        adId,
      }).catch(() => null);
      metadataByAdId.set(adId, metadata);
    })
  );

  const merge = <T extends IngressCampaignLabelCarrier>(
    referral: T | null,
    options: { fillKeywordCampaignName: boolean }
  ): (T & CampaignLabelFacts) | null => {
    if (!referral) return null;
    const adId = adIdForLookup(referral);
    // A lookup requested by the other carrier must not overwrite confirmed
    // event facts, especially when that lookup fails or returns different labels.
    if (
      !adId ||
      isConfirmedCampaignLabelStatus(referral.campaignLabelStatus) ||
      !metadataByAdId.has(adId)
    ) {
      return referral as T & CampaignLabelFacts;
    }
    return applyMetadata(referral, metadataByAdId.get(adId) ?? null, options);
  };

  return {
    whatsappReferral: merge(whatsappReferral, {
      fillKeywordCampaignName: true,
    }),
    metaReferral: merge(metaReferral, { fillKeywordCampaignName: false }),
  };
}

type CampaignLabelLookupTrigger = {
  metaCampaignLabels?: readonly unknown[] | null;
  metaCampaignNameFallbacks?: readonly unknown[] | null;
  [field: string]: unknown;
};

export function triggerNeedsCampaignLabelFacts(
  trigger: CampaignLabelLookupTrigger | null | undefined
): boolean {
  return (
    (Array.isArray(trigger?.metaCampaignLabels) &&
      trigger.metaCampaignLabels.length > 0) ||
    (Array.isArray(trigger?.metaCampaignNameFallbacks) &&
      trigger.metaCampaignNameFallbacks.length > 0)
  );
}

export function campaignLabelLookupRequired(params: {
  skipTriggerMatch?: boolean;
  triggers: ReadonlyArray<Parameters<typeof triggerNeedsCampaignLabelFacts>[0]>;
}): boolean {
  if (params.skipTriggerMatch) return false;
  return params.triggers.some(trigger =>
    triggerNeedsCampaignLabelFacts(trigger)
  );
}

export async function enrichIngressReferralPairWhenRequired<
  WhatsAppReferral extends IngressCampaignLabelCarrier,
  MetaReferral extends IngressCampaignLabelCarrier,
>(
  params: {
    required: boolean;
  } & Parameters<
    typeof enrichIngressReferralPair<WhatsAppReferral, MetaReferral>
  >[0]
): Promise<{
  whatsappReferral: (WhatsAppReferral & CampaignLabelFacts) | null;
  metaReferral: (MetaReferral & CampaignLabelFacts) | null;
}> {
  if (!params.required) {
    return {
      whatsappReferral: (params.whatsappReferral ?? null) as
        | (WhatsAppReferral & CampaignLabelFacts)
        | null,
      metaReferral: (params.metaReferral ?? null) as
        | (MetaReferral & CampaignLabelFacts)
        | null,
    };
  }
  return enrichIngressReferralPair(params);
}
