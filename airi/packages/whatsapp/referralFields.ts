import { readStringField } from "@icecore/shared/lib/value-utils";

export type WhatsAppReferralFields = {
  sourceType: string;
  sourceId: string;
  sourceUrl: string;
  sourcePlatform: string;
  campaignId: string;
  campaignName: string;
  adSetId: string;
  adSetName: string;
  headline: string;
  body: string;
  mediaType: string;
  imageUrl: string;
  videoUrl: string;
  thumbnailUrl: string;
  ctwaClid: string;
  ref: string;
  welcomeMessageText: string;
  hasReferral: boolean;
};

const EMPTY_WHATSAPP_REFERRAL_FIELDS: WhatsAppReferralFields = {
  sourceType: "",
  sourceId: "",
  sourceUrl: "",
  sourcePlatform: "",
  campaignId: "",
  campaignName: "",
  adSetId: "",
  adSetName: "",
  headline: "",
  body: "",
  mediaType: "",
  imageUrl: "",
  videoUrl: "",
  thumbnailUrl: "",
  ctwaClid: "",
  ref: "",
  welcomeMessageText: "",
  hasReferral: false,
};

export function resolveWhatsAppReferralSourcePlatform(
  sourceUrl: string,
): string {
  const value = sourceUrl.trim();
  if (!value) return "";

  try {
    const hostname = new URL(value).hostname.toLowerCase();
    if (hostname === "instagram.com" || hostname.endsWith(".instagram.com")) {
      return "instagram";
    }
    if (
      hostname === "facebook.com" ||
      hostname.endsWith(".facebook.com") ||
      hostname === "fb.com" ||
      hostname.endsWith(".fb.com") ||
      hostname === "fb.me" ||
      hostname.endsWith(".fb.me")
    ) {
      return "facebook";
    }
  } catch {
    const lower = value.toLowerCase();
    if (lower.includes("instagram.com")) return "instagram";
    if (
      lower.includes("facebook.com") ||
      lower.includes("fb.com") ||
      lower.includes("fb.me")
    ) {
      return "facebook";
    }
  }

  return "";
}

export function normalizeWhatsAppReferralFields(
  value: unknown,
): WhatsAppReferralFields {
  if (!value || typeof value !== "object") {
    return EMPTY_WHATSAPP_REFERRAL_FIELDS;
  }

  const record = value as Record<string, unknown>;
  const sourceUrl = readStringField(record, "sourceUrl", { trim: true });
  const normalized: WhatsAppReferralFields = {
    sourceType: readStringField(record, "sourceType", { trim: true }),
    sourceId: readStringField(record, "sourceId", { trim: true }),
    sourceUrl,
    sourcePlatform: resolveWhatsAppReferralSourcePlatform(sourceUrl),
    campaignId: readStringField(record, "campaignId", { trim: true }),
    campaignName: readStringField(record, "campaignName", { trim: true }),
    adSetId: readStringField(record, "adSetId", { trim: true }),
    adSetName: readStringField(record, "adSetName", { trim: true }),
    headline: readStringField(record, "headline", { trim: true }),
    body: readStringField(record, "body", { trim: true }),
    mediaType: readStringField(record, "mediaType", { trim: true }),
    imageUrl: readStringField(record, "imageUrl", { trim: true }),
    videoUrl: readStringField(record, "videoUrl", { trim: true }),
    thumbnailUrl: readStringField(record, "thumbnailUrl", { trim: true }),
    ctwaClid: readStringField(record, "ctwaClid", { trim: true }),
    ref: readStringField(record, "ref", { trim: true }),
    welcomeMessageText: readStringField(record, "welcomeMessageText", {
      trim: true,
    }),
    hasReferral: false,
  };
  normalized.hasReferral = Boolean(
    normalized.sourceType ||
      normalized.sourceId ||
      normalized.sourceUrl ||
      normalized.campaignId ||
      normalized.campaignName ||
      normalized.adSetId ||
      normalized.adSetName ||
      normalized.headline ||
      normalized.body ||
      normalized.ctwaClid ||
      normalized.ref,
  );

  return normalized;
}

export function pickWhatsAppReferralFields(params: {
  triggerMessage?: unknown;
  conversation?: unknown;
}): WhatsAppReferralFields {
  const triggerMessage =
    params.triggerMessage && typeof params.triggerMessage === "object"
      ? (params.triggerMessage as Record<string, unknown>)
      : null;
  const triggerReferral = normalizeWhatsAppReferralFields(
    triggerMessage?.whatsappReferral,
  );
  if (triggerReferral.hasReferral) {
    return triggerReferral;
  }

  const conversation =
    params.conversation && typeof params.conversation === "object"
      ? (params.conversation as Record<string, unknown>)
      : null;
  return normalizeWhatsAppReferralFields(conversation?.whatsappReferral);
}

export function buildWhatsAppReferralTemplateAliases(
  referral: WhatsAppReferralFields,
): Record<string, string> {
  return {
    whatsapp_referral_source_type: referral.sourceType,
    whatsapp_referral_source_id: referral.sourceId,
    whatsapp_referral_source_url: referral.sourceUrl,
    whatsapp_referral_source_platform: referral.sourcePlatform,
    whatsapp_referral_campaign_id: referral.campaignId,
    whatsapp_referral_campaign_name: referral.campaignName,
    whatsapp_referral_ad_set_id: referral.adSetId,
    whatsapp_referral_ad_set_name: referral.adSetName,
    whatsapp_referral_headline: referral.headline,
    whatsapp_referral_body: referral.body,
    whatsapp_referral_media_type: referral.mediaType,
    whatsapp_referral_image_url: referral.imageUrl,
    whatsapp_referral_video_url: referral.videoUrl,
    whatsapp_referral_thumbnail_url: referral.thumbnailUrl,
    whatsapp_referral_ctwa_clid: referral.ctwaClid,
    whatsapp_referral_ref: referral.ref,
    whatsapp_referral_welcome_message_text: referral.welcomeMessageText,
    meta_ad_source_type: referral.sourceType,
    meta_ad_source_id: referral.sourceId,
    meta_ad_source_url: referral.sourceUrl,
    meta_ad_source_platform: referral.sourcePlatform,
    meta_ad_campaign_id: referral.campaignId,
    meta_ad_campaign_name: referral.campaignName,
    meta_ad_ad_set_id: referral.adSetId,
    meta_ad_ad_set_name: referral.adSetName,
    meta_ad_headline: referral.headline,
    meta_ad_body: referral.body,
    ctwa_clid: referral.ctwaClid,
    ctwa_ref: referral.ref,
  };
}
