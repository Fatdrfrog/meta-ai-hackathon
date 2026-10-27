import {
  hasStoredWhatsAppServiceMessage,
  resolveStoredWhatsAppServiceMessagePreview,
} from "@icecore/shared/lib/whatsapp/service-message-preview";
import type { StoredWhatsAppServiceMessagePreview } from "@icecore/shared/types/message-preview";
import { readStringOrEmpty } from "@icecore/shared/lib/value-utils";
import { normalizeMediaMimeType } from "@/lib/whatsapp/media-types";

const MAX_COACH_MESSAGE_TEXT = 1_200;
const MAX_COACH_MEDIA_TEXT = 700;
const MAX_COACH_STRUCTURED_TEXT = 500;
const MAX_PROFILE_TEXT = 700;

export const COACH_MESSAGE_SELECT =
  "text direction date imageUrl imageAnalysis audioAnalysis videoAnalysis mediaType mimeType fileName attachments whatsappLocation whatsappContacts whatsappProductInquiry whatsappOrder whatsappReferral whatsappFlow whatsappFlowReply whatsappServiceMessage whatsappTemplate delivery";

export const COACH_CUSTOMER_SELECT =
  "_id displayName status currentFunnelStage lastInteractionAt profileSummary behavioralProfile.status behavioralProfile.summary behavioralProfile.communicationStyle behavioralProfile.decisionStyle behavioralProfile.motivations behavioralProfile.objections behavioralProfile.trustSignals behavioralProfile.urgency behavioralProfile.channelAffinity behavioralProfile.responseCadence behavioralProfile.recommendedApproach";

type CoachAttachment = {
  url?: string | null;
  contentType?: string | null;
  filename?: string | null;
  fileName?: string | null;
};

export type CoachConversationMessage = {
  _id?: unknown;
  text?: string | null;
  direction?: string | null;
  date?: Date | string | null;
  imageUrl?: string | null;
  imageAnalysis?: string | null;
  audioAnalysis?: string | null;
  videoAnalysis?: string | null;
  mediaType?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  attachments?: CoachAttachment[] | null;
  whatsappLocation?: Record<string, unknown> | null;
  whatsappContacts?: Record<string, unknown>[] | null;
  whatsappProductInquiry?: Record<string, unknown> | null;
  whatsappOrder?: Record<string, unknown> | null;
  whatsappReferral?: Record<string, unknown> | null;
  whatsappFlow?: Record<string, unknown> | null;
  whatsappFlowReply?: Record<string, unknown> | null;
  whatsappServiceMessage?: StoredWhatsAppServiceMessagePreview | null;
  whatsappTemplate?: Record<string, unknown> | null;
  delivery?: Record<string, unknown> | null;
};

export type CoachConversationProfile = {
  channel?: string | null;
  status?: string | null;
  preferred_language?: string | null;
  quick_note?: string | null;
  internal_labels?: string[] | null;
  classification?: {
    category?: string | null;
    priority?: string | null;
    sentiment?: string | null;
    summary?: string | null;
    action?: string | null;
    tags?: string[] | null;
  } | null;
};

export type CoachCustomerProfile = {
  displayName?: string | null;
  status?: string | null;
  currentFunnelStage?: string | null;
  lastInteractionAt?: Date | string | null;
  profileSummary?: {
    channels?: string[] | null;
    languages?: string[] | null;
    tags?: string[] | null;
    lastSentiment?: string | null;
    churnRiskLevel?: string | null;
    conversationCount?: number | null;
  } | null;
  behavioralProfile?: {
    status?: string | null;
    summary?: string | null;
    communicationStyle?: string | null;
    decisionStyle?: string | null;
    motivations?: string[] | null;
    objections?: string[] | null;
    trustSignals?: string[] | null;
    urgency?: string | null;
    channelAffinity?: string[] | null;
    responseCadence?: string | null;
    recommendedApproach?: string[] | null;
  } | null;
};

const cleanText = (value: unknown) =>
  readStringOrEmpty(value, { normalizeWhitespace: true });

function truncateText(value: string, maxLength: number): string {
  const normalized = cleanText(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trim()}...`;
}

function cleanNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : "";
}

function cleanStringArray(value: unknown, limit = 5): string[] {
  return Array.isArray(value)
    ? value.map(cleanText).filter(Boolean).slice(0, limit)
    : [];
}

function compactParts(parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join("; ");
}

function pushBlock(parts: string[], label: string, body: string) {
  const normalized = truncateText(body, MAX_COACH_STRUCTURED_TEXT);
  if (normalized) parts.push(`[${label}: ${normalized}]`);
}

function getAttachmentLabel(message: CoachConversationMessage): string {
  const attachment = Array.isArray(message.attachments)
    ? message.attachments.find(
        item => item?.url || item?.filename || item?.fileName
      )
    : null;
  return (
    cleanText(message.fileName) ||
    cleanText(attachment?.filename) ||
    cleanText(attachment?.fileName) ||
    "attachment"
  );
}

function hasImageAttachment(message: CoachConversationMessage): boolean {
  if (message.imageUrl || message.imageAnalysis) return true;

  const mediaType = cleanText(message.mediaType).toLowerCase();
  if (mediaType === "image" || mediaType === "sticker") return true;

  const mimeType = normalizeMediaMimeType(message.mimeType);
  if (mimeType.startsWith("image/")) return true;

  return Boolean(
    message.attachments?.some(attachment => {
      const attachmentMime = normalizeMediaMimeType(attachment?.contentType);
      return (
        attachmentMime.startsWith("image/") ||
        /\.(png|jpe?g|gif|webp)(\?|$)/i.test(attachment?.url || "")
      );
    })
  );
}

function hasVideoAttachment(message: CoachConversationMessage): boolean {
  const mediaType = cleanText(message.mediaType).toLowerCase();
  const mimeType = normalizeMediaMimeType(message.mimeType);
  return mediaType === "video" || mimeType.startsWith("video/");
}

function hasAudioAttachment(message: CoachConversationMessage): boolean {
  const mediaType = cleanText(message.mediaType).toLowerCase();
  const mimeType = normalizeMediaMimeType(message.mimeType);
  return (
    mediaType === "audio" ||
    mediaType === "voice" ||
    mimeType.startsWith("audio/")
  );
}

function buildMediaContext(message: CoachConversationMessage): string[] {
  const parts: string[] = [];
  const imageAnalysis = truncateText(
    cleanText(message.imageAnalysis),
    MAX_COACH_MEDIA_TEXT
  );
  const audioAnalysis = truncateText(
    cleanText(message.audioAnalysis),
    MAX_COACH_MEDIA_TEXT
  );
  const videoAnalysis = truncateText(
    cleanText(message.videoAnalysis),
    MAX_COACH_MEDIA_TEXT
  );

  if (imageAnalysis) {
    parts.push(`[Image content: ${imageAnalysis}]`);
  } else if (hasImageAttachment(message)) {
    parts.push(
      `[Image attached: ${getAttachmentLabel(message)}; analysis pending]`
    );
  }

  if (audioAnalysis) {
    parts.push(`[Audio transcript/intent: ${audioAnalysis}]`);
  } else if (hasAudioAttachment(message)) {
    parts.push(`[Audio attached: ${getAttachmentLabel(message)}]`);
  }

  if (videoAnalysis) {
    parts.push(`[Video summary: ${videoAnalysis}]`);
  } else if (hasVideoAttachment(message)) {
    parts.push(`[Video attached: ${getAttachmentLabel(message)}]`);
  }

  return parts;
}

function formatJsonFields(value: unknown, limit = 6): string[] {
  if (!value) return [];

  const parsed =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return null;
          }
        })()
      : value;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  return Object.entries(parsed as Record<string, unknown>)
    .filter(([key]) => key !== "flow_token")
    .flatMap(([key, raw]) => {
      const valueText =
        typeof raw === "string" || typeof raw === "number"
          ? String(raw).trim()
          : "";
      return valueText ? [`${key}=${valueText}`] : [];
    })
    .slice(0, limit);
}

function formatContactName(contact: Record<string, unknown>): string {
  const name = contact.name;
  if (name && typeof name === "object" && !Array.isArray(name)) {
    const record = name as Record<string, unknown>;
    return (
      cleanText(record.formatted_name) ||
      compactParts([cleanText(record.first_name), cleanText(record.last_name)])
    );
  }

  return cleanText(
    contact.profile && (contact.profile as Record<string, unknown>).name
  );
}

function buildStructuredContext(message: CoachConversationMessage): string[] {
  const parts: string[] = [];
  const hasCanonicalServiceMessage = hasStoredWhatsAppServiceMessage(
    message.whatsappServiceMessage
  );

  if (hasCanonicalServiceMessage) {
    const serviceMessage = resolveStoredWhatsAppServiceMessagePreview(
      message.whatsappServiceMessage
    );
    pushBlock(
      parts,
      "Service message",
      compactParts([serviceMessage.kind, ...serviceMessage.textParts])
    );
  } else {
    const location = message.whatsappLocation;
    if (location && typeof location === "object") {
      pushBlock(
        parts,
        "Location",
        compactParts([
          cleanText(location.name),
          cleanText(location.address),
          cleanNumber(location.latitude) && cleanNumber(location.longitude)
            ? `coords ${cleanNumber(location.latitude)},${cleanNumber(location.longitude)}`
            : "",
        ])
      );
    }

    const contacts = Array.isArray(message.whatsappContacts)
      ? message.whatsappContacts
      : [];
    if (contacts.length) {
      pushBlock(
        parts,
        "Shared contacts",
        contacts
          .slice(0, 3)
          .map(contact => {
            const phoneCount = Array.isArray(contact.phones)
              ? contact.phones.length
              : 0;
            const emailCount = Array.isArray(contact.emails)
              ? contact.emails.length
              : 0;
            return compactParts([
              formatContactName(contact) || "contact",
              phoneCount ? `${phoneCount} phone(s)` : "",
              emailCount ? `${emailCount} email(s)` : "",
            ]);
          })
          .join("; ")
      );
    }
  }

  const productInquiry = message.whatsappProductInquiry;
  if (productInquiry && typeof productInquiry === "object") {
    pushBlock(
      parts,
      "Product inquiry",
      compactParts([
        cleanText(productInquiry.productRetailerId),
        cleanText(productInquiry.catalogId)
          ? `catalog ${cleanText(productInquiry.catalogId)}`
          : "",
      ])
    );
  }

  const order = message.whatsappOrder;
  if (order && typeof order === "object") {
    const productItems = Array.isArray(order.productItems)
      ? order.productItems
      : [];
    pushBlock(
      parts,
      "WhatsApp order",
      compactParts([
        cleanNumber(order.totalQuantity)
          ? `${cleanNumber(order.totalQuantity)} item(s)`
          : "",
        cleanNumber(order.totalAmount)
          ? `total ${cleanNumber(order.totalAmount)} ${cleanText(order.currency)}`
          : "",
        cleanText(order.text),
        productItems.length
          ? `products ${productItems
              .slice(0, 4)
              .map(item =>
                item && typeof item === "object"
                  ? cleanText(
                      (item as Record<string, unknown>).productRetailerId
                    )
                  : ""
              )
              .filter(Boolean)
              .join(", ")}`
          : "",
      ])
    );
  }

  const flowReply = message.whatsappFlowReply;
  if (flowReply && typeof flowReply === "object") {
    pushBlock(
      parts,
      "Flow reply",
      compactParts([
        cleanText(flowReply.body),
        ...formatJsonFields(flowReply.responseJson),
      ])
    );
  }

  const flowSend = message.whatsappFlow;
  if (!hasCanonicalServiceMessage && flowSend && typeof flowSend === "object") {
    pushBlock(
      parts,
      "Flow sent",
      compactParts([
        cleanText(flowSend.bodyText),
        cleanText(flowSend.flowCta),
        cleanText(flowSend.flowId) ? `id ${cleanText(flowSend.flowId)}` : "",
      ])
    );
  }

  const template = message.whatsappTemplate;
  if (!hasCanonicalServiceMessage && template && typeof template === "object") {
    pushBlock(
      parts,
      "Template",
      compactParts([
        cleanText(template.name),
        cleanText(template.category)
          ? `category ${cleanText(template.category)}`
          : "",
        cleanText(template.language)
          ? `language ${cleanText(template.language)}`
          : "",
      ])
    );
  }

  const referral = message.whatsappReferral;
  if (referral && typeof referral === "object") {
    pushBlock(
      parts,
      "Referral",
      compactParts([
        cleanText(referral.sourceType),
        cleanText(referral.campaignName),
        cleanText(referral.adSetName),
        cleanText(referral.headline),
        cleanText(referral.body),
      ])
    );
  }

  const delivery = message.delivery;
  if (delivery && typeof delivery === "object") {
    const status = cleanText(delivery.status);
    const error = cleanText(delivery.errorMessage || delivery.error);
    if (status || error) {
      pushBlock(parts, "Delivery", compactParts([status, error]));
    }
  }

  return parts;
}

export function getCoachMessageContent(
  message: CoachConversationMessage
): string {
  return [
    truncateText(cleanText(message.text), MAX_COACH_MESSAGE_TEXT),
    ...buildMediaContext(message),
    ...buildStructuredContext(message),
  ]
    .filter(Boolean)
    .join(" ");
}

export function formatCoachConversationMessage(
  message: CoachConversationMessage
): string {
  const role = message.direction === "outbound" ? "AGENT" : "CUSTOMER";
  const ts = message.date ? new Date(message.date).toISOString() : "";
  return `${ts} [${role}] ${getCoachMessageContent(message)}`.trim();
}

export function buildCoachConversationWindow(
  messages: CoachConversationMessage[]
): string {
  return messages.map(formatCoachConversationMessage).join("\n");
}

function pushProfileLine(lines: string[], label: string, body: string) {
  const normalized = truncateText(body, MAX_PROFILE_TEXT);
  if (normalized) lines.push(`- ${label}: ${normalized}`);
}

export function buildCoachProfileContextBlock(params: {
  conversation?: CoachConversationProfile | null;
  customer?: CoachCustomerProfile | null;
}): string {
  const lines: string[] = [];
  const conversation = params.conversation;
  const customer = params.customer;

  if (conversation) {
    pushProfileLine(
      lines,
      "Conversation",
      compactParts([
        cleanText(conversation.channel) &&
          `channel ${cleanText(conversation.channel)}`,
        cleanText(conversation.status) &&
          `status ${cleanText(conversation.status)}`,
        cleanText(conversation.preferred_language) &&
          `language ${cleanText(conversation.preferred_language)}`,
      ])
    );

    const classification = conversation.classification;
    if (classification) {
      pushProfileLine(
        lines,
        "Classification",
        compactParts([
          cleanText(classification.category) &&
            `category ${cleanText(classification.category)}`,
          cleanText(classification.priority) &&
            `priority ${cleanText(classification.priority)}`,
          cleanText(classification.sentiment) &&
            `sentiment ${cleanText(classification.sentiment)}`,
          cleanStringArray(classification.tags).length
            ? `tags ${cleanStringArray(classification.tags).join(", ")}`
            : "",
          cleanText(classification.summary),
          cleanText(classification.action)
            ? `next ${cleanText(classification.action)}`
            : "",
        ])
      );
    }

    const labels = cleanStringArray(conversation.internal_labels, 8);
    if (labels.length) {
      pushProfileLine(lines, "Internal labels", labels.join(", "));
    }

    if (cleanText(conversation.quick_note)) {
      pushProfileLine(
        lines,
        "Manager note",
        cleanText(conversation.quick_note)
      );
    }
  }

  if (customer) {
    const profile = customer.profileSummary;
    pushProfileLine(
      lines,
      "Customer",
      compactParts([
        cleanText(customer.displayName),
        cleanText(customer.status) && `status ${cleanText(customer.status)}`,
        cleanText(customer.currentFunnelStage) &&
          `stage ${cleanText(customer.currentFunnelStage)}`,
        typeof profile?.conversationCount === "number"
          ? `${profile.conversationCount} conversation(s)`
          : "",
        cleanStringArray(profile?.channels).length
          ? `channels ${cleanStringArray(profile?.channels).join(", ")}`
          : "",
        cleanStringArray(profile?.languages).length
          ? `languages ${cleanStringArray(profile?.languages).join(", ")}`
          : "",
        cleanStringArray(profile?.tags).length
          ? `tags ${cleanStringArray(profile?.tags).join(", ")}`
          : "",
        cleanText(profile?.lastSentiment) &&
          `last sentiment ${cleanText(profile?.lastSentiment)}`,
        cleanText(profile?.churnRiskLevel) &&
          `churn risk ${cleanText(profile?.churnRiskLevel)}`,
      ])
    );

    const behavior = customer.behavioralProfile;
    if (behavior) {
      pushProfileLine(
        lines,
        "Customer behavior",
        compactParts([
          cleanText(behavior.summary),
          cleanText(behavior.communicationStyle) &&
            `communication ${cleanText(behavior.communicationStyle)}`,
          cleanText(behavior.decisionStyle) &&
            `decision ${cleanText(behavior.decisionStyle)}`,
          cleanText(behavior.urgency) &&
            `urgency ${cleanText(behavior.urgency)}`,
          cleanText(behavior.responseCadence) &&
            `cadence ${cleanText(behavior.responseCadence)}`,
          cleanStringArray(behavior.recommendedApproach).length
            ? `approach ${cleanStringArray(behavior.recommendedApproach).join(", ")}`
            : "",
          cleanStringArray(behavior.objections).length
            ? `objections ${cleanStringArray(behavior.objections).join(", ")}`
            : "",
          cleanStringArray(behavior.motivations).length
            ? `motivations ${cleanStringArray(behavior.motivations).join(", ")}`
            : "",
        ])
      );
    }
  }

  return lines.length
    ? `Conversation/customer context:\n${lines.join("\n")}`
    : "";
}
