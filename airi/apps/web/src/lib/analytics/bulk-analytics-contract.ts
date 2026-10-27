export type BulkAnalyticsConversationScope =
  | "campaign_sends"
  | "all"
  | "fresh"
  | "campaign_or_fresh";

export type BulkAnalyticsMessageContainsMode = "contains" | "not_contains";

/** Delivered filters delivery proof, including read; accepted means awaiting delivery/failure proof. */
export const BULK_ANALYTICS_DELIVERY_STATUSES = [
  "all",
  "accepted",
  "delivered",
  "read",
  "failed",
  "unknown",
] as const;
export type BulkAnalyticsDeliveryStatus =
  (typeof BULK_ANALYTICS_DELIVERY_STATUSES)[number];

export type BulkAnalyticsStatus = "all" | "replied" | "not_replied";

export type BulkAnalyticsEngagement =
  | "all"
  | "high"
  | "medium"
  | "low"
  | "unscored";

export type BulkAnalyticsVariableSourceMode =
  | "auto"
  | "contact_name"
  | "recipient_phone"
  | "custom";

export type BulkAnalyticsVariableSourceConfig = {
  mode: BulkAnalyticsVariableSourceMode;
  customValue?: string;
};

export class BulkAnalyticsRecipientSearchError extends Error {
  readonly code = "RECIPIENT_SEARCH_INVALID";
  constructor() {
    super("Search by phone using 3–15 digits. Names are not supported.");
    this.name = "BulkAnalyticsRecipientSearchError";
  }
}
/** Client/server input contract. Literal phone substring only; never a regex or contact-name query. */
export function normalizeBulkAnalyticsRecipientSearch(
  value: unknown
): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new BulkAnalyticsRecipientSearchError();
  let raw = value.trim();
  if (!raw) return null;
  if (raw.length > 64) throw new BulkAnalyticsRecipientSearchError();
  raw = raw.replace(/^'/, "").replace(/^wa_/, "");
  if (!/^\+?[0-9\s().\/-]+$/.test(raw))
    throw new BulkAnalyticsRecipientSearchError();
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length < 3 || digits.length > 15)
    throw new BulkAnalyticsRecipientSearchError();
  return /^8[0-9]{10}$/.test(digits) ? `7${digits.slice(1)}` : digits;
}

export type BulkAnalyticsAudienceFilters = {
  days?: number | string;
  from?: string;
  to?: string;
  timezone?: string;
  templates?: string[];
  campaignIds?: string[];
  status?: BulkAnalyticsStatus;
  deliveryStatus?: BulkAnalyticsDeliveryStatus;
  deliveryErrorCode?: string;
  recipientSearch?: string;
  engagement?: BulkAnalyticsEngagement;
  conversationScope?: BulkAnalyticsConversationScope;
  messageContains?: string;
  messageContainsMode?: BulkAnalyticsMessageContainsMode;
  replyWindowHours?: number | string;
  excludeRecentClientMessageWithin24h?: boolean;
  /**
   * When true, restrict results to conversations that had NO outbound
   * WhatsApp template message in the selected time window. The UI disables
   * the Templates and Campaigns selects when this is ON since they become
   * mutually exclusive with it.
   */
  excludeTemplates?: boolean;
};

export type BulkAnalyticsAudienceSource = {
  type: "bulk_analytics";
  filters: BulkAnalyticsAudienceFilters;
  previewCount?: number | null;
  variableConfigs?: Record<string, BulkAnalyticsVariableSourceConfig>;
};

function asTruthyFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

/**
 * True when filters can resolve WhatsApp recipients from campaign_history (send-safe).
 * Client-safe: no Mongo/Supabase imports.
 */
export function isBulkAnalyticsAudienceResolvable(
  filters: BulkAnalyticsAudienceFilters | null | undefined
): boolean {
  const input = filters || {};
  const conversationScope =
    input.conversationScope === "all" ||
    input.conversationScope === "fresh" ||
    input.conversationScope === "campaign_or_fresh" ||
    input.conversationScope === "campaign_sends"
      ? input.conversationScope
      : "campaign_sends";

  if (conversationScope !== "campaign_sends") return false;
  if (input.deliveryStatus && input.deliveryStatus !== "all") return false;
  if (String(input.deliveryErrorCode || "").trim()) return false;
  if (String(input.recipientSearch || "").trim()) return false;
  if (asTruthyFlag(input.excludeTemplates)) return false;
  if (input.status === "replied" || input.status === "not_replied") {
    return false;
  }
  if (
    input.engagement === "high" ||
    input.engagement === "medium" ||
    input.engagement === "low" ||
    input.engagement === "unscored"
  ) {
    return false;
  }
  if (String(input.messageContains || "").trim()) return false;
  if (asTruthyFlag(input.excludeRecentClientMessageWithin24h)) return false;
  return true;
}

export function appendBulkAnalyticsAudienceFiltersToSearchParams(
  params: URLSearchParams,
  filters: BulkAnalyticsAudienceFilters
) {
  if (filters.days !== undefined) params.set("days", String(filters.days));
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.timezone) params.set("timezone", filters.timezone);
  if (filters.status && filters.status !== "all") {
    params.set("status", filters.status);
  }
  if (filters.deliveryStatus && filters.deliveryStatus !== "all")
    params.set("deliveryStatus", filters.deliveryStatus);
  if (filters.deliveryErrorCode?.trim())
    params.set("deliveryErrorCode", filters.deliveryErrorCode.trim());
  const recipientSearch = normalizeBulkAnalyticsRecipientSearch(
    filters.recipientSearch
  );
  if (recipientSearch) params.set("recipientSearch", recipientSearch);
  if (filters.engagement && filters.engagement !== "all") {
    params.set("engagement", filters.engagement);
  }
  if (
    filters.conversationScope &&
    filters.conversationScope !== "campaign_sends"
  ) {
    params.set("conversationScope", filters.conversationScope);
  }
  if (filters.messageContains?.trim()) {
    params.set("messageContains", filters.messageContains.trim());
  }
  if (
    filters.messageContainsMode &&
    (filters.messageContains?.trim() ||
      filters.messageContainsMode !== "contains")
  ) {
    params.set("messageContainsMode", filters.messageContainsMode);
  }
  if (filters.replyWindowHours !== undefined) {
    params.set("replyWindowHours", String(filters.replyWindowHours));
  }
  if (filters.excludeRecentClientMessageWithin24h) {
    params.set("excludeRecentClientMessageWithin24h", "1");
  }
  if (filters.excludeTemplates) {
    params.set("excludeTemplates", "1");
  }

  for (const template of filters.templates || []) {
    if (template.trim()) params.append("template", template.trim());
  }
  for (const campaignId of filters.campaignIds || []) {
    if (campaignId.trim()) params.append("campaignId", campaignId.trim());
  }
}
