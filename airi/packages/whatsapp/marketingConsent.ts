import { coerceCompactString } from "@icecore/shared/lib/value-utils";

export const WHATSAPP_MARKETING_CONSENT_SOURCES = [
  "whatsapp_user_preferences",
  "airi_signup_link",
  "checkout_checkbox",
  "public_template_checkbox",
  "manual_import_with_proof",
  "ctwa_opt_in_disclosure",
] as const;

export type WhatsAppMarketingConsentSource =
  (typeof WHATSAPP_MARKETING_CONSENT_SOURCES)[number];

export const POSITIVE_WHATSAPP_MARKETING_CONSENT_SOURCES = [
  ...WHATSAPP_MARKETING_CONSENT_SOURCES,
] as const;

export type WhatsAppMarketingConsentUpsertParams = {
  ad?: string | null;
  campaign?: string | null;
  category?: string | null;
  checkoutFlow?: string | null;
  conversationId?: string | null;
  detail?: string | null;
  eventAt?: Date;
  eventKey?: string | null;
  landingPage?: string | null;
  messagingCustomerBaseId?: string | null;
  metaSignupId?: string | null;
  parentUserId?: string | null;
  phoneNumberId?: string | null;
  preferenceValue?: string | null;
  productLine?: string | null;
  payload?: Record<string, unknown>;
  shop?: string | null;
  signupLinkId?: string | null;
  source: WhatsAppMarketingConsentSource;
  sourceId: string;
  status: boolean;
  userId?: string | null;
  waId?: string | null;
  wabaId?: string | null;
  workspaceId: string;
};

export type WhatsAppMarketingConsentUpsertResult = {
  eventKey: string;
  matchedConversations: number;
  modifiedConversations: number;
};

export function buildWhatsAppMarketingConsentEventKey(params: {
  eventAt: Date;
  messageId?: string | null;
  parentUserId?: string | null;
  phoneNumberId?: string | null;
  source: WhatsAppMarketingConsentSource;
  status: boolean;
  userId?: string | null;
  waId?: string | null;
  workspaceId: string;
}) {
  const identity =
    coerceCompactString(params.waId) ||
    (coerceCompactString(params.userId)
      ? `user:${coerceCompactString(params.userId)}`
      : null) ||
    (coerceCompactString(params.parentUserId)
      ? `parent:${coerceCompactString(params.parentUserId)}`
      : null) ||
    "unknown-user";
  const eventStamp =
    coerceCompactString(params.messageId) ||
    Math.floor(params.eventAt.getTime() / 1000).toString();

  return [
    params.workspaceId,
    params.phoneNumberId || "unknown-phone",
    identity,
    params.source,
    eventStamp,
    params.status ? "resume" : "stop",
  ].join(":");
}
