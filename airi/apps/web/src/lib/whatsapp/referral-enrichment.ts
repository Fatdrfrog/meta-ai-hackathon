import { Conversation } from "@/models/conversation";
import type { ConversationDocument } from "@/types/models";
import { mergeWhatsAppReferral } from "@icecore/airi-runtime/whatsapp-message-recovery";
import {
  isConfirmedCampaignLabelStatus,
  resolveMetaAdMetadataForWorkspace,
  type MetaAdMetadata,
  type MetaCampaignLabel,
  type MetaCampaignLabelStatus,
} from "@/lib/meta-ads/meta-ad-metadata";
import {
  resolveWhatsAppReferralSourcePlatform,
  type WhatsAppReferralFields,
} from "@icecore/whatsapp/referralFields";
import type { WhatsAppReferral } from "@icecore/shared/lib/whatsapp/webhook-payload";
import { asRecord, readNonEmptyString } from "@icecore/shared/lib/value-utils";

export type NormalizedWhatsAppReferral = {
  sourceType: string | null;
  sourceId: string | null;
  sourceUrl: string | null;
  campaignId: string | null;
  campaignName: string | null;
  adSetId: string | null;
  adSetName: string | null;
  headline: string | null;
  body: string | null;
  mediaType: string | null;
  imageUrl: string | null;
  videoUrl: string | null;
  thumbnailUrl: string | null;
  ctwaClid: string | null;
  ref: string | null;
  welcomeMessageText: string | null;
  adAccountId: string | null;
  campaignLabels: MetaCampaignLabel[];
  campaignLabelStatus: MetaCampaignLabelStatus | null;
};

export type WhatsAppReferralMetadataResolver = (params: {
  workspaceId: string;
  adId: string;
}) => Promise<MetaAdMetadata | null>;

function readFirstString(
  record: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = readNonEmptyString(record[key]);
    if (value) return value;
  }
  return null;
}

export function normalizeWhatsAppWebhookReferral(
  referral: WhatsAppReferral | undefined
): NormalizedWhatsAppReferral | null {
  if (!referral || typeof referral !== "object") return null;
  const record = asRecord(referral);
  const welcomeMessage = asRecord(record.welcome_message);

  const normalized: NormalizedWhatsAppReferral = {
    sourceType: readFirstString(record, ["source_type", "sourceType"]),
    sourceId: readFirstString(record, ["source_id", "sourceId"]),
    sourceUrl: readFirstString(record, ["source_url", "sourceUrl"]),
    campaignId: readFirstString(record, ["campaign_id", "campaignId"]),
    campaignName: readFirstString(record, ["campaign_name", "campaignName"]),
    adSetId: readFirstString(record, ["adset_id", "ad_set_id", "adSetId"]),
    adSetName: readFirstString(record, [
      "adset_name",
      "ad_set_name",
      "adSetName",
    ]),
    headline: readFirstString(record, ["headline"]),
    body: readFirstString(record, ["body"]),
    mediaType: readFirstString(record, ["media_type", "mediaType"]),
    imageUrl: readFirstString(record, ["image_url", "imageUrl"]),
    videoUrl: readFirstString(record, ["video_url", "videoUrl"]),
    thumbnailUrl: readFirstString(record, ["thumbnail_url", "thumbnailUrl"]),
    ctwaClid: readFirstString(record, ["ctwa_clid", "ctwaClid"]),
    ref: readFirstString(record, ["ref"]),
    welcomeMessageText: readFirstString(welcomeMessage, ["text"]),
    adAccountId: null,
    campaignLabels: [],
    campaignLabelStatus: null,
  };

  const hasAnyValue = [
    normalized.sourceType,
    normalized.sourceId,
    normalized.sourceUrl,
    normalized.campaignId,
    normalized.campaignName,
    normalized.adSetId,
    normalized.adSetName,
    normalized.headline,
    normalized.body,
    normalized.mediaType,
    normalized.imageUrl,
    normalized.videoUrl,
    normalized.thumbnailUrl,
    normalized.ctwaClid,
    normalized.ref,
    normalized.welcomeMessageText,
  ].some(value => value !== null);
  return hasAnyValue ? normalized : null;
}

export async function enrichWhatsAppReferralWithMetaAdMetadata(params: {
  workspaceId: string;
  referral: NormalizedWhatsAppReferral | null;
  resolveMetaAdMetadata?: WhatsAppReferralMetadataResolver;
  defer?: boolean;
}): Promise<NormalizedWhatsAppReferral | null> {
  const referral = params.referral;
  if (params.defer) return referral;
  if (!referral?.sourceId) return referral;

  const sourceType = referral.sourceType?.toLowerCase() || "";
  if (sourceType && sourceType !== "ad") return referral;
  if (
    isConfirmedCampaignLabelStatus(referral.campaignLabelStatus ?? undefined) &&
    referral.campaignId &&
    referral.campaignName &&
    referral.adSetId
  ) {
    return referral;
  }

  const resolveMetaAdMetadata =
    params.resolveMetaAdMetadata || resolveMetaAdMetadataForWorkspace;
  const metadata = await resolveMetaAdMetadata({
    workspaceId: params.workspaceId,
    adId: referral.sourceId,
  }).catch(() => null);
  if (!metadata) {
    return {
      ...referral,
      campaignLabelStatus: referral.campaignLabelStatus ?? "unavailable",
    };
  }

  const confirmed = isConfirmedCampaignLabelStatus(
    metadata.campaignLabelStatus
  );
  return {
    ...referral,
    campaignId: referral.campaignId || metadata.campaignId || null,
    campaignName: referral.campaignName || metadata.campaignName || null,
    adSetId: referral.adSetId || metadata.adSetId || null,
    adSetName: referral.adSetName || metadata.adSetName || null,
    adAccountId: confirmed
      ? metadata.adAccountId || referral.adAccountId
      : referral.adAccountId,
    campaignLabels: confirmed
      ? metadata.campaignLabels
      : referral.campaignLabels,
    campaignLabelStatus: confirmed
      ? metadata.campaignLabelStatus
      : isConfirmedCampaignLabelStatus(
            referral.campaignLabelStatus ?? undefined
          )
        ? referral.campaignLabelStatus
        : "unavailable",
  };
}

export function buildWhatsAppReferralRagContext(
  referral:
    | NormalizedWhatsAppReferral
    | Partial<WhatsAppReferralFields>
    | null
    | undefined
): string | undefined {
  if (!referral) return undefined;
  const sourceUrl = readNonEmptyString(referral.sourceUrl) || "";
  const explicitSourcePlatform =
    "sourcePlatform" in referral
      ? readNonEmptyString(referral.sourcePlatform)
      : "";
  const sourcePlatform =
    explicitSourcePlatform || resolveWhatsAppReferralSourcePlatform(sourceUrl);

  const details = [
    readNonEmptyString(referral.sourceType)
      ? `source_type=${readNonEmptyString(referral.sourceType)}`
      : null,
    sourcePlatform ? `source_platform=${sourcePlatform}` : null,
    readNonEmptyString(referral.sourceId)
      ? `ad_id=${readNonEmptyString(referral.sourceId)}`
      : null,
    readNonEmptyString(referral.campaignId)
      ? `campaign_id=${readNonEmptyString(referral.campaignId)}`
      : null,
    readNonEmptyString(
      "campaignName" in referral ? referral.campaignName : undefined
    )
      ? `campaign=${readNonEmptyString(
          "campaignName" in referral ? referral.campaignName : undefined
        )}`
      : null,
    readNonEmptyString(referral.adSetId)
      ? `adset_id=${readNonEmptyString(referral.adSetId)}`
      : null,
    readNonEmptyString("adSetName" in referral ? referral.adSetName : undefined)
      ? `adset=${readNonEmptyString(
          "adSetName" in referral ? referral.adSetName : undefined
        )}`
      : null,
    readNonEmptyString(referral.headline)
      ? `headline=${readNonEmptyString(referral.headline)}`
      : null,
    readNonEmptyString(referral.body)
      ? `body=${readNonEmptyString(referral.body)}`
      : null,
    sourceUrl ? `source_url=${sourceUrl}` : null,
    readNonEmptyString(referral.ctwaClid)
      ? `ctwa_clid=${readNonEmptyString(referral.ctwaClid)}`
      : null,
    readNonEmptyString(referral.ref)
      ? `ref=${readNonEmptyString(referral.ref)}`
      : null,
  ].filter(Boolean);

  return details.length
    ? `WhatsApp referral context: ${details.join("; ")}`
    : undefined;
}

export function buildWhatsAppReferralPromptContext(
  referral:
    | NormalizedWhatsAppReferral
    | Partial<WhatsAppReferralFields>
    | null
    | undefined
): string | undefined {
  const context = buildWhatsAppReferralRagContext(referral);
  if (!context) return undefined;

  return [
    "CHANNEL ATTRIBUTION CONTEXT (trusted Meta/WhatsApp metadata, not customer-authored):",
    context,
    "Use only these listed attribution facts. Do not infer campaign goals, offer terms, targeting, or ad performance from missing fields.",
  ].join("\n");
}

export async function persistWhatsAppConversationReferral(
  initial: ConversationDocument,
  referral: NormalizedWhatsAppReferral,
  capturedAt: Date,
): Promise<ConversationDocument> {
  const conversation = initial;
  for (let attempt = 0; attempt < 3; attempt++) {
    // Compare the stored shape: hydrated defaults may not exist in legacy rows.
    const snapshot = await Conversation.findById(initial._id)
      .select("whatsappReferral")
      .lean<{ whatsappReferral?: unknown } | null>();
    if (!snapshot)
      throw new Error("WhatsApp referral conversation disappeared");
    const previous = snapshot.whatsappReferral ?? null;
    const merged = mergeWhatsAppReferral(previous, { ...referral, capturedAt });
    if (JSON.stringify(previous) === JSON.stringify(merged))
      return conversation;
    const updated = await Conversation.findOneAndUpdate(
      {
        _id: conversation._id,
        workspaceId: conversation.workspaceId,
        whatsappReferral: previous,
      },
      { $set: { whatsappReferral: merged } },
      { new: true },
    );
    if (updated) return updated as ConversationDocument;
  }
  throw new Error(
    "WhatsApp referral recovery contention; retry the durable event",
  );
}
