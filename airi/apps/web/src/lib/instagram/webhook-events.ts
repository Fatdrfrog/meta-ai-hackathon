import { toArray } from "@icecore/shared/lib/value-utils";

export const INSTAGRAM_BUSINESS_LOGIN_WEBHOOK_FIELDS = [
  "messages",
  "messaging_optins",
  "messaging_postbacks",
  "messaging_reactions",
  "messaging_referrals",
  "messaging_seen",
  "comments",
  "live_comments",
] as const;

export const INSTAGRAM_FACEBOOK_LOGIN_PAGE_WEBHOOK_FIELDS = [
  "messages",
  "message_deliveries",
  "message_reads",
  "message_reactions",
  "messaging_postbacks",
  "messaging_referrals",
  "messaging_seen",
  "messaging_optins",
] as const;

export const INSTAGRAM_FACEBOOK_LOGIN_COMMENT_WEBHOOK_FIELDS = [
  "comments",
  "live_comments",
] as const;

export type InstagramReferralContext = {
  source?: string;
  type?: string;
  ref?: string;
  adId?: string;
  campaignId?: string;
  campaignName?: string;
  adSetId?: string;
  adSetName?: string;
  productId?: string;
  productRetailerId?: string;
  title?: string;
  body?: string;
  mediaUrl?: string;
  sourceUrl?: string;
  adAccountId?: string;
  campaignLabels?: Array<{ id: string; name: string }>;
  campaignLabelStatus?: "present" | "absent" | "unavailable";
};

export type InstagramMessagingEvent = {
  sender?: {
    id?: string;
    username?: string;
    name?: string;
    profile_pic?: string;
    profile_picture_url?: string;
  };
  recipient?: { id?: string };
  timestamp?: number;
  standby?: boolean;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    is_deleted?: boolean;
    is_unsupported?: boolean;
    quick_reply?: { payload?: string };
    attachments?: Array<{
      type?: string;
      payload?: { url?: string; [key: string]: unknown };
    }>;
    referral?: unknown;
  };
  reaction?: {
    mid?: string;
    action?: string;
    reaction?: string;
    emoji?: string;
  };
  postback?: {
    mid?: string;
    title?: string;
    payload?: string;
  };
  delivery?: {
    mids?: string[];
    watermark?: number;
    seq?: number;
  };
  read?: {
    mid?: string;
    watermark?: number;
    seq?: number;
  };
  referral?: unknown;
  optin?: {
    payload?: string;
    [key: string]: unknown;
  };
};

export type InstagramMessagingEventKind =
  | "message"
  | "message_echo"
  | "reaction"
  | "postback"
  | "delivery"
  | "read"
  | "referral"
  | "optin"
  | "standby"
  | "ignored";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function toStringValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function toMessagingEvent(value: unknown): InstagramMessagingEvent | null {
  const record = asRecord(value);
  if (!record) return null;
  return record as InstagramMessagingEvent;
}

function hashDedupValue(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function formatDedupValue(value: string): string {
  const encoded = encodeURIComponent(value);
  if (encoded.length <= 72) return encoded;
  return `${encoded.slice(0, 36)}~${hashDedupValue(encoded)}`;
}

function buildInstagramReferralDedupPart(referral: unknown): string {
  const context = readInstagramReferralContext(referral);
  if (!context) return "unknown";

  const fields = [
    context.ref ? `ref=${formatDedupValue(context.ref)}` : null,
    context.adId ? `ad=${formatDedupValue(context.adId)}` : null,
    context.productId ? `product=${formatDedupValue(context.productId)}` : null,
    context.productRetailerId
      ? `retailer=${formatDedupValue(context.productRetailerId)}`
      : null,
    context.source ? `source=${formatDedupValue(context.source)}` : null,
    context.type ? `type=${formatDedupValue(context.type)}` : null,
  ].filter(Boolean);

  return fields.length > 0 ? fields.join("|") : "unknown";
}

export function extractInstagramMessagingEvents(
  entry: Record<string, unknown>
): InstagramMessagingEvent[] {
  const events: InstagramMessagingEvent[] = [];

  for (const item of toArray(entry.messaging)) {
    const event = toMessagingEvent(item);
    if (event) events.push(event);
  }

  for (const change of toArray(entry.changes)) {
    const changeRecord = asRecord(change);
    const valueRecord = asRecord(changeRecord?.value);
    for (const item of toArray(valueRecord?.messaging)) {
      const event = toMessagingEvent(item);
      if (event) events.push(event);
    }
  }

  const pushStandby = (value: unknown) => {
    for (const item of toArray(value)) {
      const event = toMessagingEvent(item);
      if (event) events.push({ ...event, standby: true });
    }
  };

  pushStandby(entry.standby);
  for (const change of toArray(entry.changes)) {
    const changeRecord = asRecord(change);
    const valueRecord = asRecord(changeRecord?.value);
    pushStandby(valueRecord?.standby);
  }

  return events;
}

export function extractInstagramCommentEvents(
  entry: Record<string, unknown>
): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];

  const pushValue = (value: unknown) => {
    for (const item of toArray(value)) {
      const record = asRecord(item);
      if (record) events.push(record);
    }
  };

  const directField = toStringValue(entry.field) || "";
  if (
    (directField === "comments" || directField === "live_comments") &&
    "value" in entry
  ) {
    pushValue(entry.value);
  }

  for (const change of toArray(entry.changes)) {
    const changeRecord = asRecord(change);
    const field = toStringValue(changeRecord?.field) || "";
    if (field !== "comments" && field !== "live_comments") continue;
    pushValue(changeRecord?.value);
  }

  return events;
}

export function classifyInstagramMessagingEvent(
  event: InstagramMessagingEvent
): InstagramMessagingEventKind {
  if (event.standby) return "standby";
  if (event.message?.is_echo) return "message_echo";
  if (event.message) return "message";
  if (event.reaction) return "reaction";
  if (event.postback) return "postback";
  if (event.delivery) return "delivery";
  if (event.read) return "read";
  if (event.referral) return "referral";
  if (event.optin) return "optin";
  return "ignored";
}

export function normalizeInstagramMessagingEvent(
  event: InstagramMessagingEvent
): InstagramMessagingEvent {
  const sender = asRecord(event.sender) || {};
  const recipient = asRecord(event.recipient) || {};

  return {
    ...event,
    sender: {
      ...sender,
      id: String(sender.id || ""),
    },
    recipient: {
      ...recipient,
      id: String(recipient.id || ""),
    },
  } as InstagramMessagingEvent;
}

export function buildInstagramMessagingDedupKey(
  event: InstagramMessagingEvent
): string {
  const senderId = String(event.sender?.id || "");
  const recipientId = String(event.recipient?.id || "");
  const timestamp = String(event.timestamp || "");

  const messageMid = String(event.message?.mid || "");
  if (messageMid) {
    return `message:${messageMid}:${senderId}:${recipientId}`;
  }

  const postbackMid = String(event.postback?.mid || "");
  if (postbackMid) {
    return `postback:${postbackMid}:${senderId}:${recipientId}`;
  }

  const reactionMid = String(event.reaction?.mid || "");
  const reactionAction = String(event.reaction?.action || "");
  if (reactionMid) {
    return `reaction:${reactionMid}:${reactionAction}:${senderId}:${recipientId}`;
  }

  if (event.delivery) {
    const mids = Array.isArray(event.delivery.mids)
      ? event.delivery.mids
          .map(mid => String(mid || "").trim())
          .filter(Boolean)
          .sort()
      : [];
    const deliveryId =
      mids.length > 0
        ? mids.join(",")
        : String(event.delivery.watermark || timestamp || "");
    return `delivery:${deliveryId}:${senderId}:${recipientId}:${String(
      event.delivery.watermark || ""
    )}`;
  }

  const readMid = String(event.read?.mid || "");
  if (readMid) {
    return `read:${readMid}:${senderId}:${recipientId}`;
  }
  if (event.read?.watermark) {
    return `read:${event.read.watermark}:${senderId}:${recipientId}`;
  }

  if (event.referral) {
    return `referral:${senderId}:${recipientId}:${timestamp}:${buildInstagramReferralDedupPart(
      event.referral
    )}`;
  }

  const optinPayload = String(event.optin?.payload || "");
  if (event.optin) {
    return `optin:${senderId}:${recipientId}:${timestamp}:${optinPayload}`;
  }

  if (event.standby) {
    return `standby:${senderId}:${recipientId}:${timestamp}`;
  }

  const messageText = String(event.message?.text || "");
  const postbackPayload = String(event.postback?.payload || "");
  return `fallback:${senderId}:${recipientId}:${timestamp}:${messageText}:${postbackPayload}`;
}

export function readInstagramReferralContext(
  value: unknown
): InstagramReferralContext | null {
  const referral = asRecord(value);
  if (!referral) return null;
  const product = asRecord(referral.product);
  const adsContext = asRecord(referral.ads_context_data);

  const context: InstagramReferralContext = {
    source: toStringValue(referral.source),
    type: toStringValue(referral.type),
    ref: toStringValue(referral.ref),
    adId: toStringValue(referral.ad_id),
    campaignId: toStringValue(referral.campaign_id),
    campaignName: toStringValue(referral.campaign_name),
    adSetId: toStringValue(referral.adset_id || referral.ad_set_id),
    adSetName: toStringValue(referral.adset_name || referral.ad_set_name),
    productId: toStringValue(product?.id),
    productRetailerId: toStringValue(product?.retailer_id),
    title: toStringValue(adsContext?.ad_title),
    body: toStringValue(adsContext?.post_body),
    mediaUrl:
      toStringValue(adsContext?.photo_url) ||
      toStringValue(adsContext?.video_url),
    sourceUrl: toStringValue(referral.source_url),
  };

  return Object.values(context).some(Boolean) ? context : null;
}

export function buildInstagramReferralRagContext(
  referral: InstagramReferralContext | null | undefined
): string | undefined {
  if (!referral) return undefined;

  const details = [
    referral.source ? `source=${referral.source}` : null,
    referral.type ? `type=${referral.type}` : null,
    referral.ref ? `ref=${referral.ref}` : null,
    referral.adId ? `ad_id=${referral.adId}` : null,
    referral.campaignId ? `campaign_id=${referral.campaignId}` : null,
    referral.campaignName ? `campaign=${referral.campaignName}` : null,
    referral.adSetId ? `adset_id=${referral.adSetId}` : null,
    referral.adSetName ? `adset=${referral.adSetName}` : null,
    referral.productId ? `product_id=${referral.productId}` : null,
    referral.productRetailerId
      ? `product_retailer_id=${referral.productRetailerId}`
      : null,
    referral.title ? `title=${referral.title}` : null,
  ].filter(Boolean);

  return details.length
    ? `Instagram referral context: ${details.join("; ")}`
    : undefined;
}
