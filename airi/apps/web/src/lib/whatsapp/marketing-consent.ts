// Canonical consent persistence shared by worker webhooks and website handoffs.
import * as MongooseModule from "@/lib/mongoose";
import * as SupabaseAdminModule from "@/lib/supabase/admin";
import * as ConversationModel from "@/models/conversation";
import {
  buildWhatsAppCanonicalIdFromBsuid,
  buildWhatsAppCanonicalIdFromPhone,
  normalizeWhatsAppBsuid,
  normalizeWhatsAppPhone,
} from "@icecore/shared/lib/whatsapp/contact-identities";
import { coerceCompactString } from "@icecore/shared/lib/value-utils";
import {
  buildWhatsAppMarketingConsentEventKey,
  type WhatsAppMarketingConsentUpsertParams,
  type WhatsAppMarketingConsentUpsertResult,
} from "@icecore/whatsapp/marketingConsent";

type SupabaseUpsertResult = { error?: { message?: string } | null };

type WhatsAppMarketingConsentPersistenceDependencies = {
  connectDB: () => Promise<unknown>;
  conversationModel: {
    updateMany: (
      query: Record<string, unknown>,
      update: Record<string, unknown>,
    ) => Promise<{ matchedCount?: number; modifiedCount?: number }>;
  };
  supabaseAdmin: {
    from: (table: string) => {
      upsert: (
        values: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => PromiseLike<SupabaseUpsertResult>;
    };
  };
};

function resolveConversationModel(moduleNamespace: unknown) {
  const record =
    moduleNamespace && typeof moduleNamespace === "object"
      ? (moduleNamespace as Record<string, unknown>)
      : {};
  const defaultRecord =
    record.default && typeof record.default === "object"
      ? (record.default as Record<string, unknown>)
      : {};
  return (record.Conversation ||
    defaultRecord.Conversation ||
    defaultRecord.default ||
    record.default ||
    moduleNamespace) as WhatsAppMarketingConsentPersistenceDependencies["conversationModel"];
}

function resolveConnectDB(moduleNamespace: unknown) {
  const record =
    moduleNamespace && typeof moduleNamespace === "object"
      ? (moduleNamespace as Record<string, unknown>)
      : {};
  const defaultRecord =
    record.default && typeof record.default === "object"
      ? (record.default as Record<string, unknown>)
      : {};
  const candidate =
    record.connectDB ||
    defaultRecord.connectDB ||
    defaultRecord.default ||
    record.default ||
    moduleNamespace;
  if (typeof candidate !== "function") {
    throw new Error("connectDB runtime dependency is not callable");
  }
  return candidate as () => Promise<unknown>;
}

function resolveSupabaseAdmin(moduleNamespace: unknown) {
  const record =
    moduleNamespace && typeof moduleNamespace === "object"
      ? (moduleNamespace as Record<string, unknown>)
      : {};
  const defaultRecord =
    record.default && typeof record.default === "object"
      ? (record.default as Record<string, unknown>)
      : {};
  return (record.supabaseAdmin ||
    defaultRecord.supabaseAdmin ||
    defaultRecord.default ||
    record.default ||
    moduleNamespace) as WhatsAppMarketingConsentPersistenceDependencies["supabaseAdmin"];
}

function compact(value: unknown): string | null {
  return coerceCompactString(value);
}

function buildMarketingConsentIdentityFilters(params: {
  parentUserId?: string | null;
  userId?: string | null;
  waId?: string | null;
}) {
  const waId = normalizeWhatsAppPhone(params.waId);
  const userId = normalizeWhatsAppBsuid(params.userId);
  const parentUserId = normalizeWhatsAppBsuid(params.parentUserId);
  const canonicalIds = [
    waId ? buildWhatsAppCanonicalIdFromPhone(waId) : null,
    userId ? buildWhatsAppCanonicalIdFromBsuid(userId) : null,
    parentUserId ? buildWhatsAppCanonicalIdFromBsuid(parentUserId) : null,
  ].filter((value): value is string => Boolean(value));
  const participantIds = [waId, userId, parentUserId].filter(
    (value): value is string => Boolean(value),
  );

  const filters: Record<string, unknown>[] = [];
  if (canonicalIds.length > 0) {
    filters.push({ chat: { $in: canonicalIds } });
    filters.push({ user: { $in: canonicalIds } });
  }
  if (participantIds.length > 0) {
    filters.push({ "participants.from": { $in: participantIds } });
    filters.push({ "participants.to": { $in: participantIds } });
  }

  return { filters, parentUserId, userId, waId };
}

export function createWhatsAppMarketingConsentUpserter(
  deps: WhatsAppMarketingConsentPersistenceDependencies,
) {
  return async function upsertWhatsAppMarketingConsent(
    params: WhatsAppMarketingConsentUpsertParams,
  ): Promise<WhatsAppMarketingConsentUpsertResult> {
    const eventAt = params.eventAt || new Date();
    const { filters, parentUserId, userId, waId } =
      buildMarketingConsentIdentityFilters(params);
    const eventKey =
      compact(params.eventKey) ||
      buildWhatsAppMarketingConsentEventKey({
        eventAt,
        messageId:
          typeof params.payload?.messageId === "string"
            ? params.payload.messageId
            : null,
        parentUserId,
        phoneNumberId: compact(params.phoneNumberId),
        source: params.source,
        status: params.status,
        userId,
        waId,
        workspaceId: params.workspaceId,
      });

    const { error } = await deps.supabaseAdmin
      .from("whatsapp_opt_in_events")
      .upsert(
        {
          event_key: eventKey,
          workspace_id: params.workspaceId,
          source_id: params.sourceId,
          signup_link_id: compact(params.signupLinkId),
          conversation_id: compact(params.conversationId),
          waba_id: compact(params.wabaId),
          phone_number_id: compact(params.phoneNumberId),
          wa_id: waId || null,
          user_id: userId || null,
          parent_user_id: parentUserId || null,
          status: params.status,
          category: compact(params.category),
          preference_value: compact(params.preferenceValue),
          detail: compact(params.detail),
          source: params.source,
          meta_signup_id: compact(params.metaSignupId),
          messaging_customer_base_id: compact(params.messagingCustomerBaseId),
          product_line: compact(params.productLine),
          shop: compact(params.shop),
          campaign: compact(params.campaign),
          landing_page: compact(params.landingPage),
          ad: compact(params.ad),
          checkout_flow: compact(params.checkoutFlow),
          payload: params.payload || {},
          event_at: eventAt.toISOString(),
        },
        { ignoreDuplicates: true, onConflict: "event_key" },
      );
    if (error) {
      throw new Error(
        error.message || "WhatsApp marketing consent upsert failed",
      );
    }

    if (filters.length === 0 && !params.conversationId) {
      return {
        eventKey,
        matchedConversations: 0,
        modifiedConversations: 0,
      };
    }

    const updatePatch: Record<string, unknown> = {
      "whatsapp_opt_in.status": params.status,
      "whatsapp_opt_in.updatedAt": eventAt,
      "whatsapp_opt_in.source": params.source,
    };
    if (params.signupLinkId) {
      updatePatch["whatsapp_opt_in.signupLinkId"] = params.signupLinkId;
    }
    if (params.metaSignupId) {
      updatePatch["whatsapp_opt_in.metaSignupId"] = params.metaSignupId;
    }
    if (params.messagingCustomerBaseId) {
      updatePatch["whatsapp_opt_in.messagingCustomerBaseId"] =
        params.messagingCustomerBaseId;
    }
    if (params.productLine) {
      updatePatch["whatsapp_opt_in.productLine"] = params.productLine;
    }
    if (params.shop) updatePatch["whatsapp_opt_in.shop"] = params.shop;
    if (params.campaign) {
      updatePatch["whatsapp_opt_in.campaign"] = params.campaign;
    }
    if (params.landingPage) {
      updatePatch["whatsapp_opt_in.landingPage"] = params.landingPage;
    }
    if (params.ad) updatePatch["whatsapp_opt_in.ad"] = params.ad;
    if (params.checkoutFlow) {
      updatePatch["whatsapp_opt_in.checkoutFlow"] = params.checkoutFlow;
    }

    await deps.connectDB();
    const query =
      params.conversationId && filters.length === 0
        ? {
            _id: params.conversationId,
            workspaceId: params.workspaceId,
            channel: "whatsapp",
          }
        : {
            workspaceId: params.workspaceId,
            channel: "whatsapp",
            $or: filters,
          };
    const result = await deps.conversationModel.updateMany({
      ...query,
      $and: [{ $or: [
        { "whatsapp_opt_in.updatedAt": { $lt: eventAt } },
        { "whatsapp_opt_in.updatedAt": { $exists: false } },
        { "whatsapp_opt_in.updatedAt": null },
        // At an equal timestamp opt-out wins over opt-in.
        ...(params.status ? [] : [{ "whatsapp_opt_in.updatedAt": eventAt }]),
      ] }],
    }, {
      $set: updatePatch,
    });

    return {
      eventKey,
      matchedConversations: result.matchedCount || 0,
      modifiedConversations: result.modifiedCount || 0,
    };
  };
}

export const upsertWhatsAppMarketingConsent =
  createWhatsAppMarketingConsentUpserter({
    connectDB: resolveConnectDB(MongooseModule),
    conversationModel: resolveConversationModel(ConversationModel),
    supabaseAdmin: resolveSupabaseAdmin(SupabaseAdminModule),
  });
