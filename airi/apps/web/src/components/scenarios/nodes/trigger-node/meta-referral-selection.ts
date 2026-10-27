import type { ScenarioTriggerConfig } from "@/components/scenarios/types";
import { readTrimmedString as normalizeId } from "@icecore/shared/lib/value-utils";

export type MetaReferralSelection =
  | { kind: "any_message" }
  | { kind: "any_instagram_ad" }
  | { kind: "campaign"; id: string }
  | { kind: "ad_set"; id: string }
  | { kind: "ad"; id: string };

const ANY_MESSAGE_VALUE = "any_message";
const ANY_INSTAGRAM_AD_VALUE = "any_instagram_ad";
const ID_KINDS = ["campaign", "ad_set", "ad"] as const;

export function resolveMetaReferralSelection(
  config: ScenarioTriggerConfig
): MetaReferralSelection {
  const campaignId = normalizeId(config.metaReferralCampaignIds?.[0]);
  if (campaignId) return { kind: "campaign", id: campaignId };

  const adSetId = normalizeId(config.metaReferralAdSetIds?.[0]);
  if (adSetId) return { kind: "ad_set", id: adSetId };

  const adId = normalizeId(config.metaReferralSourceIds?.[0]);
  if (adId) return { kind: "ad", id: adId };

  const sourceTypes = new Set(
    config.whatsappReferralSourceTypes?.map(normalizeId).filter(Boolean)
  );
  const sourcePlatforms = new Set(
    config.whatsappReferralSourcePlatforms?.map(normalizeId).filter(Boolean)
  );
  if (sourceTypes.has("ad") && sourcePlatforms.has("instagram")) {
    return { kind: "any_instagram_ad" };
  }

  return { kind: "any_message" };
}

export function metaReferralSelectionToSelectValue(
  selection: MetaReferralSelection
): string {
  if (selection.kind === "any_message") return ANY_MESSAGE_VALUE;
  if (selection.kind === "any_instagram_ad") return ANY_INSTAGRAM_AD_VALUE;
  return `${selection.kind}:${encodeURIComponent(selection.id)}`;
}

export function selectValueToMetaReferralSelection(
  value: string
): MetaReferralSelection | null {
  if (value === ANY_MESSAGE_VALUE) return { kind: "any_message" };
  if (value === ANY_INSTAGRAM_AD_VALUE) {
    return { kind: "any_instagram_ad" };
  }

  const separatorIndex = value.indexOf(":");
  if (separatorIndex <= 0) return null;
  const kind = value.slice(0, separatorIndex);
  if (!ID_KINDS.includes(kind as (typeof ID_KINDS)[number])) return null;

  try {
    const id = decodeURIComponent(value.slice(separatorIndex + 1)).trim();
    return id
      ? {
          kind: kind as "campaign" | "ad_set" | "ad",
          id,
        }
      : null;
  } catch {
    return null;
  }
}

export function metaReferralSelectionToConfigDelta(
  selection: MetaReferralSelection
): Partial<ScenarioTriggerConfig> {
  return {
    metaReferralCampaignIds:
      selection.kind === "campaign" ? [selection.id] : [],
    metaReferralAdSetIds: selection.kind === "ad_set" ? [selection.id] : [],
    metaReferralSourceIds: selection.kind === "ad" ? [selection.id] : [],
    whatsappReferralSourceTypes:
      selection.kind === "any_instagram_ad" ? ["ad"] : [],
    whatsappReferralSourcePlatforms:
      selection.kind === "any_instagram_ad" ? ["instagram"] : [],
  };
}
