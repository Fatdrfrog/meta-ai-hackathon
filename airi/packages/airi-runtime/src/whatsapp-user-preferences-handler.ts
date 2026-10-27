import {
  buildWhatsAppCanonicalIdFromBsuid,
  buildWhatsAppCanonicalIdFromPhone,
  normalizeWhatsAppBsuid,
  normalizeWhatsAppPhone,
} from "@icecore/shared/lib/whatsapp/contact-identities";
import type {
  WhatsAppWebhookBody,
  WhatsAppWebhookChange,
} from "@icecore/shared/lib/whatsapp/webhook-payload";
import { coerceCompactString } from "@icecore/shared/lib/value-utils";
import type {
  WhatsAppMarketingConsentUpsertParams,
  WhatsAppMarketingConsentUpsertResult,
} from "@icecore/whatsapp/marketingConsent";

type UserPreferenceRecord = {
  wa_id?: unknown;
  user_id?: unknown;
  parent_user_id?: unknown;
  detail?: unknown;
  category?: unknown;
  value?: unknown;
  timestamp?: unknown;
  signup_id?: unknown;
  signupId?: unknown;
  messaging_customer_base_id?: unknown;
  messagingCustomerBaseId?: unknown;
  product_line?: unknown;
  productLine?: unknown;
  shop?: unknown;
  campaign?: unknown;
  landing_page?: unknown;
  landingPage?: unknown;
  ad?: unknown;
  checkout_flow?: unknown;
  checkoutFlow?: unknown;
};

type UserPreferencesValue = {
  metadata?: {
    phone_number_id?: unknown;
    cs_id?: unknown;
    display_phone_number?: unknown;
  };
  contacts?: Array<{
    wa_id?: unknown;
    user_id?: unknown;
    parent_user_id?: unknown;
  }>;
  user_preferences?: UserPreferenceRecord[];
};

type UserPreferenceContact = NonNullable<
  UserPreferencesValue["contacts"]
>[number];

type WhatsAppUserPreferencesRequestLogger = {
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (
    message: string,
    errorOrContext?: unknown,
    context?: Record<string, unknown>,
  ) => void;
};

type WhatsAppSourceLike = {
  id: string;
  workspace_id?: string | null;
};

export type WhatsAppUserPreferencesWebhookHandlerDependencies = {
  resolveWhatsAppSourceByAccountIdentifiers: (params: {
    wabaId?: string;
    messagingAccountId?: string;
    phoneNumberId?: string;
    csId?: string;
  }) => Promise<WhatsAppSourceLike | null | undefined>;
  upsertWhatsAppMarketingConsent: (
    params: WhatsAppMarketingConsentUpsertParams,
  ) => Promise<WhatsAppMarketingConsentUpsertResult>;
};

function asUserPreferencesValue(value: unknown): UserPreferencesValue {
  return value && typeof value === "object"
    ? (value as UserPreferencesValue)
    : {};
}

function parsePreferenceTimestamp(value: unknown): Date {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000);
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return new Date(numeric * 1000);
    }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date();
}

function normalizePreferenceStatus(value: unknown): boolean | null {
  const normalized = coerceCompactString(value)?.toLowerCase();
  if (!normalized) return null;

  if (
    ["resume", "start", "allow", "opt_in", "opt-in", "subscribed"].includes(
      normalized,
    )
  ) {
    return true;
  }

  if (
    [
      "stop",
      "pause",
      "opt_out",
      "opt-out",
      "unsubscribe",
      "unsubscribed",
    ].includes(normalized)
  ) {
    return false;
  }

  return null;
}

function buildPreferenceEventKey(params: {
  phoneNumberId: string | null;
  preference: UserPreferenceRecord;
  parentUserId: string | null;
  status: boolean;
  userId: string | null;
  waId: string | null;
  workspaceId: string;
}): string {
  const timestamp =
    coerceCompactString(params.preference.timestamp) ||
    Math.floor(
      parsePreferenceTimestamp(params.preference.timestamp).getTime() / 1000,
    ).toString();
  const value =
    coerceCompactString(params.preference.value) ||
    (params.status ? "resume" : "stop");
  const identity =
    params.waId ||
    (params.userId ? `user:${params.userId}` : null) ||
    (params.parentUserId ? `parent:${params.parentUserId}` : null) ||
    "unknown-user";
  return [
    params.workspaceId,
    params.phoneNumberId || "unknown-phone",
    identity,
    timestamp,
    value,
  ].join(":");
}

function resolvePreferenceIdentity(params: {
  preference: UserPreferenceRecord;
  fallbackContact?: UserPreferenceContact | null;
}) {
  const waId = normalizeWhatsAppPhone(
    params.preference.wa_id || params.fallbackContact?.wa_id,
  );
  const userId = normalizeWhatsAppBsuid(
    params.preference.user_id || params.fallbackContact?.user_id,
  );
  const parentUserId = normalizeWhatsAppBsuid(
    params.preference.parent_user_id || params.fallbackContact?.parent_user_id,
  );

  return { waId, userId, parentUserId };
}

function hasConversationIdentity(params: {
  parentUserId?: string | null;
  userId?: string | null;
  waId?: string | null;
}): boolean {
  return Boolean(
    (params.waId && buildWhatsAppCanonicalIdFromPhone(params.waId)) ||
      (params.userId && buildWhatsAppCanonicalIdFromBsuid(params.userId)) ||
      (params.parentUserId &&
        buildWhatsAppCanonicalIdFromBsuid(params.parentUserId)),
  );
}

export function createWhatsAppUserPreferencesWebhookHandler(
  deps: WhatsAppUserPreferencesWebhookHandlerDependencies,
) {
  return async function tryHandleWhatsAppUserPreferencesWebhook(params: {
    body: WhatsAppWebhookBody;
    change: WhatsAppWebhookChange;
    requestLogger: WhatsAppUserPreferencesRequestLogger;
  }): Promise<Response | null> {
    const { body, change, requestLogger } = params;
    if (change.field !== "user_preferences") return null;

    const value = asUserPreferencesValue(change.value);
    const wabaId = coerceCompactString(body.entry?.[0]?.id);
    const phoneNumberId = coerceCompactString(
      value.metadata?.phone_number_id || value.metadata?.cs_id,
    );
    const preferences = Array.isArray(value.user_preferences)
      ? value.user_preferences
      : [];

    const source = await deps.resolveWhatsAppSourceByAccountIdentifiers({
      wabaId: wabaId || undefined,
      messagingAccountId: wabaId || undefined,
      phoneNumberId: phoneNumberId || undefined,
      csId: coerceCompactString(value.metadata?.cs_id) || undefined,
    });

    if (!source?.workspace_id) {
      requestLogger.warn(
        "WhatsApp user_preferences skipped: source not found",
        {
          wabaId,
          phoneNumberId,
          preferenceCount: preferences.length,
        },
      );
      return Response.json({
        status: "ok",
        message: "user_preferences source not found",
      });
    }

    let updatedConversations = 0;
    let skippedPreferences = 0;

    for (const preference of preferences) {
      const status = normalizePreferenceStatus(preference.value);
      const category = coerceCompactString(preference.category);
      if (status === null || (category && category !== "marketing_messages")) {
        skippedPreferences += 1;
        continue;
      }

      const fallbackContact =
        value.contacts?.find((contact) => {
          const prefWaId = normalizeWhatsAppPhone(preference.wa_id);
          const contactWaId = normalizeWhatsAppPhone(contact.wa_id);
          return Boolean(prefWaId && contactWaId && prefWaId === contactWaId);
        }) ||
        value.contacts?.[0] ||
        null;
      const { waId, userId, parentUserId } = resolvePreferenceIdentity({
        preference,
        fallbackContact,
      });

      if (!hasConversationIdentity({ parentUserId, userId, waId })) {
        skippedPreferences += 1;
        requestLogger.warn("WhatsApp user_preferences skipped: no identity", {
          workspaceId: source.workspace_id,
          sourceId: source.id,
          wabaId,
          phoneNumberId,
          value: coerceCompactString(preference.value),
        });
        continue;
      }

      const eventAt = parsePreferenceTimestamp(preference.timestamp);
      const metaSignupId =
        coerceCompactString(preference.signup_id) ||
        coerceCompactString(preference.signupId) ||
        null;
      const messagingCustomerBaseId =
        coerceCompactString(preference.messaging_customer_base_id) ||
        coerceCompactString(preference.messagingCustomerBaseId) ||
        null;
      const productLine =
        coerceCompactString(preference.product_line) ||
        coerceCompactString(preference.productLine) ||
        null;
      const shop = coerceCompactString(preference.shop) || null;
      const campaign = coerceCompactString(preference.campaign) || null;
      const landingPage =
        coerceCompactString(preference.landing_page) ||
        coerceCompactString(preference.landingPage) ||
        null;
      const ad = coerceCompactString(preference.ad) || null;
      const checkoutFlow =
        coerceCompactString(preference.checkout_flow) ||
        coerceCompactString(preference.checkoutFlow) ||
        null;
      try {
        const result = await deps.upsertWhatsAppMarketingConsent({
          category,
          detail: coerceCompactString(preference.detail) || null,
          eventAt,
          eventKey: buildPreferenceEventKey({
            parentUserId: parentUserId || null,
            phoneNumberId,
            preference,
            status,
            userId: userId || null,
            waId: waId || null,
            workspaceId: source.workspace_id,
          }),
          messagingCustomerBaseId,
          phoneNumberId,
          preferenceValue: coerceCompactString(preference.value) || null,
          sourceId: source.id,
          source: "whatsapp_user_preferences",
          status,
          wabaId,
          waId: waId || null,
          workspaceId: source.workspace_id,
          userId: userId || null,
          parentUserId: parentUserId || null,
          metaSignupId,
          productLine,
          shop,
          campaign,
          landingPage,
          ad,
          checkoutFlow,
          payload: preference as Record<string, unknown>,
        });
        updatedConversations += result.modifiedConversations;
        requestLogger.info("WhatsApp user_preferences processed", {
          workspaceId: source.workspace_id,
          sourceId: source.id,
          wabaId,
          phoneNumberId,
          waId: waId || null,
          userId: userId || null,
          parentUserId: parentUserId || null,
          category: category || null,
          preferenceValue: coerceCompactString(preference.value),
          optedIn: status,
          matched: result.matchedConversations,
          modified: result.modifiedConversations,
        });
      } catch (auditError) {
        requestLogger.error("WhatsApp opt-in audit write failed", {
          workspaceId: source.workspace_id,
          sourceId: source.id,
          wabaId,
          phoneNumberId,
          waId: waId || null,
          userId: userId || null,
          parentUserId: parentUserId || null,
          error:
            auditError instanceof Error
              ? auditError.message
              : String(auditError),
        });
      }
    }

    return Response.json({
      status: "ok",
      message: "user_preferences processed",
      updatedConversations,
      skippedPreferences,
    });
  };
}
