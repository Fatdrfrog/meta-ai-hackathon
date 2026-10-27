import "server-only";

import {
  hasStoredWhatsAppServiceMessage,
  resolveStoredWhatsAppServiceMessagePreview,
} from "@icecore/shared/lib/whatsapp/service-message-preview";
import type { ConversationPreferredLanguage } from "@icecore/shared/types/conversation";
import type { StoredWhatsAppServiceMessagePreview } from "@icecore/shared/types/message-preview";

import {
  normalizeAiriLanguage,
  type AiriLanguage,
} from "@/lib/airi/shared/language-policy";
import type { ConversationClassificationBusinessContext } from "@/lib/classifier/conversation-analysis-types";
import { createConversationClassificationError } from "@/lib/classifier/conversation-classification-errors";
import { PAYMENT_EVIDENCE_TEXT_LIMIT } from "@/lib/classifier/conversation-payment-evidence";
import {
  readTrimmedString as trimString,
  readDate,
} from "@icecore/shared/lib/value-utils";

export const CLASSIFICATION_MESSAGE_SELECT = [
  "_id",
  "author",
  "text",
  "subject",
  "date",
  "direction",
  "channel",
  "imageUrl",
  "imageAnalysis",
  "audioAnalysis",
  "videoAnalysis",
  "mediaAnalysis",
  "mediaType",
  "mimeType",
  "fileName",
  "fileSize",
  "attachments",
  "ragContext",
  "origin",
  "whatsappFlowReply",
  "whatsappOrder",
  "whatsappProductInquiry",
  "whatsappServiceMessage",
  "whatsappTemplate",
  "whatsappReferral",
  "whatsappLocation",
].join(" ");

const MAX_INLINE_TEXT = 320;
const MAX_CONTEXT_TEXT = 240;
const MAX_JSON_FIELDS = 5;

type MaybeChat = { sourceId?: unknown } | null;
type ClassificationMessageAuthor = {
  firstName?: string | null;
  isBot?: boolean | null;
} | null;
type KeyValueRecord = Record<string, unknown>;

export type ClassificationMessageLike = {
  text?: string | null;
  subject?: string | null;
  direction?: "inbound" | "outbound" | string | null;
  author?: ClassificationMessageAuthor;
  imageUrl?: string | null;
  imageAnalysis?: string | null;
  audioAnalysis?: string | null;
  videoAnalysis?: string | null;
  mediaAnalysis?: {
    status?: string | null;
    provider?: string | null;
    requestId?: string | null;
    operationName?: string | null;
    submittedAt?: Date | string | null;
    completedAt?: Date | string | null;
    updatedAt?: Date | string | null;
    error?: string | null;
  } | null;
  ragContext?: string | null;
  origin?: {
    kind?: string | null;
    templateName?: string | null;
    templateCategory?: string | null;
    executionSource?: string | null;
  } | null;
  whatsappFlowReply?: {
    body?: string | null;
    responseJson?: string | null;
  } | null;
  whatsappOrder?: {
    totalQuantity?: number | null;
    totalAmount?: number | null;
    currency?: string | null;
    productItems?: Array<KeyValueRecord> | null;
  } | null;
  whatsappProductInquiry?: {
    productRetailerId?: string | null;
    product_retailer_id?: string | null;
    catalogId?: string | null;
  } | null;
  whatsappServiceMessage?: StoredWhatsAppServiceMessagePreview | null;
  whatsappTemplate?: {
    name?: string | null;
    category?: string | null;
    languageCode?: string | null;
  } | null;
  whatsappReferral?: {
    sourceType?: string | null;
    headline?: string | null;
    body?: string | null;
    welcomeMessageText?: string | null;
  } | null;
  whatsappLocation?: {
    name?: string | null;
    address?: string | null;
    url?: string | null;
  } | null;
};

export type ClassificationConversationContext = {
  sourceId?: string | null;
  chat?: MaybeChat;
  channel?: string | null;
  subject?: string | null;
  page_url?: string | null;
  preferred_language?: string | null;
  last_inbound_at?: Date | string | null;
  last_outbound_at?: Date | string | null;
  engagement_metrics?: {
    score?: number | null;
    messageCount?: number | null;
    inboundCount?: number | null;
    outboundCount?: number | null;
    customerQuestionCount?: number | null;
    hasTwoWayConversation?: boolean | null;
    flowSubmitCount?: number | null;
    campaignReplyCount?: number | null;
  } | null;
  whatsappReferral?: {
    sourceType?: string | null;
    headline?: string | null;
    body?: string | null;
    welcomeMessageText?: string | null;
  } | null;
  external_thread?: {
    provider?: string | null;
    type?: string | null;
    permalink?: string | null;
    referral?: {
      source?: string | null;
      type?: string | null;
      title?: string | null;
      body?: string | null;
      adId?: string | null;
      productRetailerId?: string | null;
    } | null;
  } | null;
};

type BusinessContextInput =
  | string
  | { sourceId?: string | null; workspaceId?: string | null };

function normalizeBusinessContextInput(input: BusinessContextInput): {
  sourceId: string;
  workspaceId: string;
} {
  if (typeof input === "string") {
    return { sourceId: input.trim(), workspaceId: "" };
  }
  return {
    sourceId: (input.sourceId || "").trim(),
    workspaceId: (input.workspaceId || "").trim(),
  };
}

async function getSupabaseAdminClient() {
  return (await import("@/lib/supabase/admin")).supabaseAdmin;
}

export async function getBusinessContext(input: BusinessContextInput): Promise<{
  businessContext: string;
  airiLanguage: AiriLanguage;
  workspaceId: string;
}> {
  const { sourceId, workspaceId } = normalizeBusinessContextInput(input);
  const defaults = {
    businessContext: "customer support",
    airiLanguage: "en" as AiriLanguage,
    workspaceId: workspaceId || "default",
  };

  let supabaseAdmin: Awaited<ReturnType<typeof getSupabaseAdminClient>>;
  try {
    supabaseAdmin = await getSupabaseAdminClient();
  } catch {
    return defaults;
  }

  if (sourceId) {
    try {
      const { data, error } = await supabaseAdmin
        .from("sources")
        .select("companies(business_context, airi_language), workspace_id")
        .eq("id", sourceId)
        .limit(1)
        .single();
      if (error) throw error;
      const company = Array.isArray(data.companies)
        ? data.companies[0]
        : (data.companies as {
            business_context?: string;
            airi_language?: AiriLanguage;
          } | null);
      return {
        businessContext: company?.business_context || defaults.businessContext,
        airiLanguage: normalizeAiriLanguage(
          company?.airi_language,
          defaults.airiLanguage
        ),
        workspaceId: data?.workspace_id || defaults.workspaceId,
      };
    } catch {
      // Preserve the existing fail-soft workspace fallback for non-classifier callers.
    }
  }

  if (workspaceId) {
    try {
      const { data, error } = await supabaseAdmin
        .from("workspaces")
        .select("companies!inner(business_context, airi_language)")
        .eq("id", workspaceId)
        .limit(1)
        .single();
      if (error) throw error;
      const company = Array.isArray(data.companies)
        ? data.companies[0]
        : (data.companies as {
            business_context?: string;
            airi_language?: AiriLanguage;
          } | null);
      return {
        businessContext: company?.business_context || defaults.businessContext,
        airiLanguage: normalizeAiriLanguage(
          company?.airi_language,
          defaults.airiLanguage
        ),
        workspaceId,
      };
    } catch {
      return defaults;
    }
  }
  return defaults;
}

type WorkspaceRow = { id?: unknown; company_id?: unknown };
type CompanyRow = {
  id?: unknown;
  business_context?: unknown;
  airi_language?: unknown;
};
type SourceRow = {
  id?: unknown;
  workspace_id?: unknown;
  company_id?: unknown;
  type?: unknown;
};

export async function resolveConversationClassificationBusinessContextStrict(
  input: { workspaceId: string; sourceId: string | null }
): Promise<ConversationClassificationBusinessContext> {
  const workspaceId = trimString(input.workspaceId);
  let workspaceResult: { data: WorkspaceRow | null; error: unknown };
  try {
    const supabaseAdmin = await getSupabaseAdminClient();
    workspaceResult = (await supabaseAdmin
      .from("workspaces")
      .select("id, company_id")
      .eq("id", workspaceId)
      .maybeSingle()) as typeof workspaceResult;
  } catch (error) {
    throw createConversationClassificationError(
      "business_context_read_failed",
      error
    );
  }
  if (workspaceResult.error) {
    throw createConversationClassificationError(
      "business_context_read_failed",
      workspaceResult.error
    );
  }
  if (!workspaceResult.data || trimString(workspaceResult.data.id) !== workspaceId) {
    throw createConversationClassificationError("workspace_not_found");
  }
  const companyId = trimString(workspaceResult.data.company_id);
  if (!companyId) {
    throw createConversationClassificationError("workspace_company_missing");
  }

  let companyResult: { data: CompanyRow | null; error: unknown };
  try {
    const supabaseAdmin = await getSupabaseAdminClient();
    companyResult = (await supabaseAdmin
      .from("companies")
      .select("id, business_context, airi_language")
      .eq("id", companyId)
      .maybeSingle()) as typeof companyResult;
  } catch (error) {
    throw createConversationClassificationError(
      "business_context_read_failed",
      error
    );
  }
  if (companyResult.error) {
    throw createConversationClassificationError(
      "business_context_read_failed",
      companyResult.error
    );
  }
  if (!companyResult.data || trimString(companyResult.data.id) !== companyId) {
    throw createConversationClassificationError("company_not_found");
  }

  let source: ConversationClassificationBusinessContext["source"] = null;
  const sourceId = input.sourceId === null ? "" : trimString(input.sourceId);
  if (input.sourceId !== null && !sourceId) {
    throw createConversationClassificationError("source_read_failed");
  }
  if (sourceId) {
    let sourceResult: { data: SourceRow | null; error: unknown };
    try {
      const supabaseAdmin = await getSupabaseAdminClient();
      sourceResult = (await supabaseAdmin
        .from("sources")
        .select("id, workspace_id, company_id, type")
        .eq("id", sourceId)
        .maybeSingle()) as typeof sourceResult;
    } catch (error) {
      throw createConversationClassificationError("source_read_failed", error);
    }
    if (sourceResult.error) {
      throw createConversationClassificationError(
        "source_read_failed",
        sourceResult.error
      );
    }
    if (!sourceResult.data || trimString(sourceResult.data.id) !== sourceId) {
      throw createConversationClassificationError("source_not_found");
    }
    if (trimString(sourceResult.data.workspace_id) !== workspaceId) {
      throw createConversationClassificationError(
        "source_workspace_mismatch"
      );
    }
    if (trimString(sourceResult.data.company_id) !== companyId) {
      throw createConversationClassificationError("source_company_mismatch");
    }
    const sourceType = trimString(sourceResult.data.type);
    if (!sourceType) {
      throw createConversationClassificationError("source_read_failed");
    }
    source = { id: sourceId, type: sourceType };
  }

  return {
    workspaceId,
    companyId,
    businessContext:
      trimString(companyResult.data.business_context) || "customer support",
    airiLanguage: normalizeAiriLanguage(
      companyResult.data.airi_language,
      "en" satisfies ConversationPreferredLanguage
    ),
    source,
  };
}

function truncateText(value: unknown, maxLength: number): string {
  const text = trimString(value).replace(/\s+/g, " ");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function pushPart(parts: string[], value: unknown, maxLength = MAX_CONTEXT_TEXT) {
  const text = truncateText(value, maxLength);
  if (text) parts.push(text);
}

function tryParseJsonObject(raw: string | null | undefined): KeyValueRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as KeyValueRecord)
      : null;
  } catch {
    return null;
  }
}

function formatJsonFields(raw: string | null | undefined): string[] {
  const parsed = tryParseJsonObject(raw);
  if (!parsed) return [];
  return Object.entries(parsed)
    .map(([key, value]) => {
      if (value === null || value === undefined || typeof value === "object") {
        return "";
      }
      return `${key}=${truncateText(String(value), 80)}`;
    })
    .filter(Boolean)
    .slice(0, MAX_JSON_FIELDS);
}

function formatProductItems(items: Array<KeyValueRecord> | null | undefined) {
  if (!Array.isArray(items)) return "";
  return items
    .map(item =>
      trimString(
        item.product_retailer_id ||
          item.productRetailerId ||
          item.name ||
          item.title
      )
    )
    .filter(Boolean)
    .slice(0, 4)
    .join(", ");
}

function formatInlineBlock(
  label: string,
  parts: string[],
  maxLength = MAX_CONTEXT_TEXT
): string {
  return `[${label}: ${parts
    .map(part => truncateText(part, maxLength))
    .join("; ")}]`;
}

export function resolveClassificationSourceId(
  conversation: Pick<ClassificationConversationContext, "sourceId" | "chat">
): string {
  const directSourceId = trimString(conversation.sourceId);
  if (directSourceId) return directSourceId;
  return conversation.chat && typeof conversation.chat === "object"
    ? trimString(conversation.chat.sourceId)
    : "";
}

export function formatClassificationMessage(
  msg: ClassificationMessageLike,
  options: { preservePaymentEvidence?: boolean } = {}
): string {
  const isBot = msg.author?.isBot ?? false;
  const isOutbound = msg.direction === "outbound";
  const participantType = isBot ? "[Bot]" : "[Human]";
  const authorLabel = isBot
    ? trimString(msg.author?.firstName) || "AI Agent"
    : isOutbound
      ? trimString(msg.author?.firstName) || "Business Account"
      : trimString(msg.author?.firstName) || "Customer";
  const inlineContext: string[] = [];
  const evidenceContextLimit = options.preservePaymentEvidence
    ? PAYMENT_EVIDENCE_TEXT_LIMIT
    : MAX_CONTEXT_TEXT;

  const subject = truncateText(msg.subject, MAX_CONTEXT_TEXT);
  if (subject) inlineContext.push(formatInlineBlock("Subject", [subject]));
  const pageContext = truncateText(msg.ragContext, MAX_CONTEXT_TEXT);
  if (pageContext) {
    inlineContext.push(formatInlineBlock("Page Context", [pageContext]));
  }
  if (msg.imageAnalysis) {
    inlineContext.push(
      formatInlineBlock("Image Content", [msg.imageAnalysis], evidenceContextLimit)
    );
  }
  if (msg.audioAnalysis) {
    inlineContext.push(
      formatInlineBlock(
        "Audio Transcript/Intent",
        [msg.audioAnalysis],
        evidenceContextLimit
      )
    );
  }
  if (msg.videoAnalysis) {
    inlineContext.push(formatInlineBlock("Video Summary", [msg.videoAnalysis]));
  }

  const originParts: string[] = [];
  pushPart(originParts, msg.origin?.kind);
  pushPart(originParts, msg.origin?.templateName);
  pushPart(originParts, msg.origin?.templateCategory);
  pushPart(originParts, msg.origin?.executionSource);
  if (originParts.length) {
    inlineContext.push(formatInlineBlock("Origin", originParts));
  }

  const flowParts: string[] = [];
  pushPart(flowParts, msg.whatsappFlowReply?.body);
  flowParts.push(...formatJsonFields(msg.whatsappFlowReply?.responseJson));
  if (flowParts.length) {
    inlineContext.push(formatInlineBlock("Flow Reply", flowParts));
  }

  const hasCanonicalServiceMessage = hasStoredWhatsAppServiceMessage(
    msg.whatsappServiceMessage
  );
  if (hasCanonicalServiceMessage) {
    const serviceMessage = resolveStoredWhatsAppServiceMessagePreview(
      msg.whatsappServiceMessage
    );
    const serviceParts = [serviceMessage.kind, ...serviceMessage.textParts]
      .map(part => truncateText(part, MAX_CONTEXT_TEXT))
      .filter(Boolean);
    if (serviceParts.length) {
      inlineContext.push(formatInlineBlock("Service Message", serviceParts));
    }
  }

  const orderParts: string[] = [];
  if (typeof msg.whatsappOrder?.totalQuantity === "number") {
    orderParts.push(`quantity ${msg.whatsappOrder.totalQuantity}`);
  }
  if (typeof msg.whatsappOrder?.totalAmount === "number") {
    const currency = trimString(msg.whatsappOrder.currency);
    orderParts.push(
      `total ${msg.whatsappOrder.totalAmount}${currency ? ` ${currency}` : ""}`
    );
  }
  const productItems = formatProductItems(msg.whatsappOrder?.productItems);
  if (productItems) orderParts.push(`products ${productItems}`);
  if (orderParts.length) {
    inlineContext.push(formatInlineBlock("WhatsApp Order", orderParts));
  }

  const inquiryParts: string[] = [];
  pushPart(
    inquiryParts,
    msg.whatsappProductInquiry?.productRetailerId ||
      msg.whatsappProductInquiry?.product_retailer_id
  );
  pushPart(inquiryParts, msg.whatsappProductInquiry?.catalogId);
  if (inquiryParts.length) {
    inlineContext.push(
      formatInlineBlock("Product Inquiry", [
        `retailer ${inquiryParts[0]}`,
        ...inquiryParts.slice(1),
      ])
    );
  }

  if (!hasCanonicalServiceMessage) {
    const templateParts: string[] = [];
    pushPart(templateParts, msg.whatsappTemplate?.name);
    if (msg.whatsappTemplate?.category) {
      templateParts.push(`category ${msg.whatsappTemplate.category}`);
    }
    pushPart(templateParts, msg.whatsappTemplate?.languageCode);
    if (templateParts.length) {
      inlineContext.push(formatInlineBlock("Template Context", templateParts));
    }
  }

  const referralParts: string[] = [];
  pushPart(referralParts, msg.whatsappReferral?.sourceType);
  pushPart(referralParts, msg.whatsappReferral?.headline);
  pushPart(referralParts, msg.whatsappReferral?.body);
  pushPart(referralParts, msg.whatsappReferral?.welcomeMessageText);
  if (referralParts.length) {
    inlineContext.push(formatInlineBlock("WhatsApp Referral", referralParts));
  }

  const locationParts: string[] = [];
  pushPart(locationParts, msg.whatsappLocation?.name);
  pushPart(locationParts, msg.whatsappLocation?.address);
  pushPart(locationParts, msg.whatsappLocation?.url);
  if (locationParts.length) {
    inlineContext.push(formatInlineBlock("Location", locationParts));
  }

  const content = truncateText(
    msg.text,
    options.preservePaymentEvidence ? PAYMENT_EVIDENCE_TEXT_LIMIT : MAX_INLINE_TEXT
  );
  return `${participantType} ${authorLabel}: ${[content, ...inlineContext]
    .filter(Boolean)
    .join(" ")}`.trimEnd();
}

function formatDate(value: Date | string | null | undefined): string {
  return readDate(value)?.toISOString() ?? "";
}

export function buildConversationMetadataContext(
  conversation: ClassificationConversationContext
): string {
  const lines: string[] = [];
  const channel = trimString(conversation.channel);
  if (channel) lines.push(`Channel: ${channel}`);
  const sourceId = resolveClassificationSourceId(conversation);
  if (sourceId) lines.push(`Source ID: ${sourceId}`);
  const subject = truncateText(conversation.subject, MAX_CONTEXT_TEXT);
  if (subject) lines.push(`Subject: ${subject}`);
  const pageUrl = truncateText(conversation.page_url, MAX_CONTEXT_TEXT);
  if (pageUrl) lines.push(`Widget page: ${pageUrl}`);
  const preferredLanguage = trimString(conversation.preferred_language);
  if (preferredLanguage) {
    lines.push(`Customer preferred language: ${preferredLanguage}`);
  }
  const lastInboundAt = formatDate(conversation.last_inbound_at);
  if (lastInboundAt) lines.push(`Last inbound at: ${lastInboundAt}`);
  const lastOutboundAt = formatDate(conversation.last_outbound_at);
  if (lastOutboundAt) lines.push(`Last outbound at: ${lastOutboundAt}`);

  const engagement = conversation.engagement_metrics;
  if (engagement) {
    const parts: string[] = [];
    if (typeof engagement.score === "number") parts.push(`score ${engagement.score}`);
    if (typeof engagement.messageCount === "number") {
      parts.push(`messages ${engagement.messageCount}`);
    }
    if (typeof engagement.inboundCount === "number") {
      parts.push(`inbound ${engagement.inboundCount}`);
    }
    if (typeof engagement.outboundCount === "number") {
      parts.push(`outbound ${engagement.outboundCount}`);
    }
    if (typeof engagement.customerQuestionCount === "number") {
      parts.push(`customer questions ${engagement.customerQuestionCount}`);
    }
    if (typeof engagement.flowSubmitCount === "number") {
      parts.push(`flow submissions ${engagement.flowSubmitCount}`);
    }
    if (typeof engagement.campaignReplyCount === "number") {
      parts.push(`campaign replies ${engagement.campaignReplyCount}`);
    }
    if (engagement.hasTwoWayConversation === true) {
      parts.push("two-way conversation");
    }
    if (parts.length) lines.push(`Conversation engagement: ${parts.join("; ")}`);
  }

  const referralParts: string[] = [];
  pushPart(referralParts, conversation.whatsappReferral?.sourceType);
  pushPart(referralParts, conversation.whatsappReferral?.headline);
  pushPart(referralParts, conversation.whatsappReferral?.body);
  pushPart(referralParts, conversation.whatsappReferral?.welcomeMessageText);
  if (referralParts.length) {
    lines.push(`WhatsApp referral: ${referralParts.join("; ")}`);
  }

  const externalThreadParts: string[] = [];
  pushPart(externalThreadParts, conversation.external_thread?.provider);
  pushPart(externalThreadParts, conversation.external_thread?.type);
  pushPart(externalThreadParts, conversation.external_thread?.permalink);
  if (externalThreadParts.length) {
    lines.push(`External thread: ${externalThreadParts.join("; ")}`);
  }
  const externalReferralParts: string[] = [];
  pushPart(externalReferralParts, conversation.external_thread?.referral?.source);
  pushPart(externalReferralParts, conversation.external_thread?.referral?.type);
  pushPart(externalReferralParts, conversation.external_thread?.referral?.title);
  pushPart(externalReferralParts, conversation.external_thread?.referral?.body);
  pushPart(externalReferralParts, conversation.external_thread?.referral?.adId);
  pushPart(
    externalReferralParts,
    conversation.external_thread?.referral?.productRetailerId
  );
  if (externalReferralParts.length) {
    lines.push(`External referral: ${externalReferralParts.join("; ")}`);
  }
  return lines.join("\n");
}
