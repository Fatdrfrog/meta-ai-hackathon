import { randomUUID } from "node:crypto";
import { withWorkspaceTextAiAction } from "@/lib/ai/workspace-ai-policy";
import { chatCompletionWithFallback, getHeavyTextModel } from "@/lib/ai";
import { extractJsonObject } from "@/lib/ai/json-object";
import connectDB from "@/lib/mongoose";
import { Conversation } from "@/models/conversation";
import Customer from "@/models/customer";
import CustomerEvent from "@/models/customer-event";
import { materializeCustomerStageEvent } from "@/lib/analytics/customer-stage-consumer";
import { decodeCustomerStageEnvelope } from "@/lib/analytics/customer-stage-transition";
import Message from "@/models/message";
import User from "@/models/user";
import mongoose from "mongoose";
import {
  CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS,
  getCurrentConversationClassification,
} from "@icecore/shared/lib/conversation-classification-freshness";
import {
  CRM_UNASSIGNED_STAGE_KEY,
  normalizeCrmStageKey,
} from "@/lib/crm/stages";
import { readUniqueStringArray } from "@icecore/shared/lib/value-utils";

import {
  buildConversationSeedKey,
  getConversationDisplayName,
  getCrmPipelineStageFromConversation,
  getConversationStage,
  mixedIdLookupValues,
  normalizeEmail,
  normalizeLooseString,
  normalizePhone,
  normalizeUsername,
  scoreCustomerSuggestion,
  toStringId,
  type CustomerSuggestionReason,
} from "./shared";
import { loadConversationContactBundles } from "./conversation-bundles";

type LeanConversationRecord = {
  _id: mongoose.Types.ObjectId;
  workspaceId: string;
  customerId?: mongoose.Types.ObjectId | string | null;
  channel?: string;
  chat?: unknown;
  user?: unknown;
  sourceId?: string | null;
  visitor_id?: string | null;
  rename?: string | null;
  preferred_language?: string | null;
  classification?: {
    category?: string | null;
    sentiment?: string | null;
    tags?: string[] | null;
  } | null;
  is_classified?: boolean | null;
  classification_revision?: number | null;
  classification_state?: {
    contractVersion?: number | null;
    status?: string | null;
    requestedRevision?: number | null;
    appliedRevision?: number | null;
  } | null;
  classification_meta?: {
    source_revision?: number | null;
    provenance_kind?: string | null;
    analysis_revision_id?: string | null;
  } | null;
  internal_labels?: string[] | null;
  churn_risk_level?: string | null;
  estimated_customer_ltv?: number | null;
  lastMessageAt?: Date | null;
  updatedAt?: Date | null;
  createdAt?: Date | null;
  page_url?: string | null;
};

type LeanUserRecord = {
  _id: unknown;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  email?: string | null;
  whatsapp?: {
    waId?: string | null;
    userId?: string | null;
    parentUserId?: string | null;
    username?: string | null;
    profileName?: string | null;
    primaryIdType?:
      | "wa_id"
      | "user_id"
      | "parent_user_id"
      | "message_from"
      | null;
  } | null;
};

type LeanChatRecord = {
  _id: unknown;
  title?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  whatsapp?: {
    waId?: string | null;
    userId?: string | null;
    parentUserId?: string | null;
    username?: string | null;
    profileName?: string | null;
    primaryIdType?:
      | "wa_id"
      | "user_id"
      | "parent_user_id"
      | "message_from"
      | null;
  } | null;
};

type ConversationBundle = {
  conversation: LeanConversationRecord;
  user: LeanUserRecord | null;
  chat: LeanChatRecord | null;
};

type CustomerActor = {
  type?: "system" | "manager" | "ai" | "backfill";
  userId?: string | null;
  label?: string | null;
};

type IdentityRecord = {
  type:
    | "seed_key"
    | "channel_user"
    | "channel_chat"
    | "visitor_id"
    | "email"
    | "phone"
    | "username"
    | "whatsapp_user_id"
    | "whatsapp_parent_user_id";
  channel?: string | null;
  sourceId?: string | null;
  value: string;
  normalizedValue: string;
  label?: string | null;
  linkedAt: Date;
  linkedBy?: string | null;
  linkMethod: "system" | "backfill" | "manual" | "suggested" | "rule";
  linkConfidence?: number | null;
};

export type CustomerSuggestion = {
  conversationId: string;
  customerId: string | null;
  displayName: string | null;
  channel: string | null;
  lastActivityAt: string | null;
  currentStage: string | null;
  score: number;
  reasons: CustomerSuggestionReason[];
};

const CUSTOMER_CONVERSATION_SELECT = [
  "_id",
  "workspaceId",
  "customerId",
  "channel",
  "chat",
  "user",
  "sourceId",
  "visitor_id",
  "rename",
  "preferred_language",
  "classification",
  "internal_labels",
  "churn_risk_level",
  "estimated_customer_ltv",
  "lastMessageAt",
  "updatedAt",
  "createdAt",
  "page_url",
  ...CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS,
].join(" ");

const CUSTOMER_SUGGESTION_CONVERSATION_SELECT = [
  "_id",
  "workspaceId",
  "customerId",
  "channel",
  "chat",
  "user",
  "sourceId",
  "visitor_id",
  "rename",
  "classification",
  "internal_labels",
  "lastMessageAt",
  "updatedAt",
  "createdAt",
  ...CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS,
].join(" ");

function toObjectId(value: unknown): mongoose.Types.ObjectId | null {
  if (value instanceof mongoose.Types.ObjectId) return value;
  const normalized = toStringId(value);
  if (!normalized || !mongoose.Types.ObjectId.isValid(normalized)) return null;
  return new mongoose.Types.ObjectId(normalized);
}

function persistableCrmFunnelStage(conversation: {
  internal_labels?: string[] | null;
}): string | null {
  const key = normalizeCrmStageKey(
    getCrmPipelineStageFromConversation(conversation) || ""
  );
  if (!key || key === CRM_UNASSIGNED_STAGE_KEY) return null;
  return key;
}

function normalizeWhatsAppBsuidValue(value: unknown): string | null {
  return normalizeLooseString(value);
}

function collectWhatsAppBsuidValues(
  ...records: Array<
    | {
        whatsapp?: {
          userId?: string | null;
          parentUserId?: string | null;
        } | null;
      }
    | null
    | undefined
  >
) {
  const userIds = readUniqueStringArray(
    records.map(record => normalizeWhatsAppBsuidValue(record?.whatsapp?.userId))
  );
  const parentUserIds = readUniqueStringArray(
    records.map(record =>
      normalizeWhatsAppBsuidValue(record?.whatsapp?.parentUserId)
    )
  );

  return { userIds, parentUserIds };
}

function compareByLatestActivity(
  a: LeanConversationRecord,
  b: LeanConversationRecord
) {
  const aTime =
    a.lastMessageAt?.getTime?.() ||
    a.updatedAt?.getTime?.() ||
    a.createdAt?.getTime?.() ||
    0;
  const bTime =
    b.lastMessageAt?.getTime?.() ||
    b.updatedAt?.getTime?.() ||
    b.createdAt?.getTime?.() ||
    0;
  return bTime - aTime;
}

async function loadConversationBundles(
  conversations: LeanConversationRecord[]
): Promise<ConversationBundle[]> {
  return loadConversationContactBundles<
    LeanConversationRecord,
    LeanUserRecord,
    LeanChatRecord
  >(conversations, {
    userSelect: "_id firstName lastName username email whatsapp",
    chatSelect: "_id title first_name last_name username whatsapp",
  });
}

async function loadConversationBundleById(
  conversationId: string
): Promise<ConversationBundle | null> {
  const objectId = toObjectId(conversationId);
  if (!objectId) return null;

  const conversation = (await Conversation.findById(objectId)
    .select(CUSTOMER_CONVERSATION_SELECT)
    .lean()) as LeanConversationRecord | null;

  if (!conversation) return null;
  const [bundle] = await loadConversationBundles([conversation]);
  return bundle;
}

function normalizeActor(actor?: CustomerActor): Required<CustomerActor> {
  return {
    type: actor?.type || "system",
    userId: actor?.userId || null,
    label: actor?.label || null,
  };
}

function mergeIdentityRecords(
  current: IdentityRecord[],
  next: IdentityRecord[]
): IdentityRecord[] {
  const merged = new Map<string, IdentityRecord>();
  for (const identity of [...current, ...next]) {
    const key = [
      identity.type,
      identity.channel || "",
      identity.normalizedValue,
    ].join(":");
    if (!merged.has(key)) {
      merged.set(key, identity);
    }
  }
  return Array.from(merged.values());
}

function buildIdentityRecords(params: {
  bundle: ConversationBundle;
  linkMethod: IdentityRecord["linkMethod"];
  linkedBy?: string | null;
  linkConfidence?: number | null;
}): IdentityRecord[] {
  const { bundle, linkMethod, linkedBy, linkConfidence } = params;
  const identities: IdentityRecord[] = [];
  const seedKey = buildConversationSeedKey(bundle.conversation);
  const now = new Date();

  const pushIdentity = (
    type: IdentityRecord["type"],
    rawValue: string | null,
    extra?: Partial<IdentityRecord>
  ) => {
    if (!rawValue) return;
    const normalizedValue =
      type === "email"
        ? normalizeEmail(rawValue)
        : type === "username"
          ? normalizeUsername(rawValue)
          : type === "phone"
            ? normalizePhone(rawValue)
            : rawValue.trim();
    if (!normalizedValue) return;
    identities.push({
      type,
      channel: extra?.channel ?? bundle.conversation.channel ?? null,
      sourceId: extra?.sourceId ?? bundle.conversation.sourceId ?? null,
      value: rawValue,
      normalizedValue,
      label: extra?.label ?? null,
      linkedAt: now,
      linkedBy: linkedBy || null,
      linkMethod,
      linkConfidence: linkConfidence ?? null,
    });
  };

  pushIdentity("seed_key", seedKey, {
    channel: bundle.conversation.channel ?? null,
    label: "Default safe seed key",
  });

  const userId = toStringId(bundle.conversation.user);
  const chatId = toStringId(bundle.conversation.chat);
  const visitorId = normalizeLooseString(bundle.conversation.visitor_id);
  const userEmail = normalizeLooseString(bundle.user?.email);
  const userUsername = normalizeLooseString(bundle.user?.username);
  const chatUsername = normalizeLooseString(bundle.chat?.username);
  const whatsAppBsuidValues = collectWhatsAppBsuidValues(
    bundle.user,
    bundle.chat
  );

  pushIdentity("channel_user", userId, {
    label: "Conversation user id",
  });
  pushIdentity("channel_chat", chatId, {
    label: "Conversation chat id",
  });
  pushIdentity("visitor_id", visitorId, {
    label: "Widget visitor id",
  });
  pushIdentity("email", userEmail, {
    label: "Customer email",
  });
  pushIdentity("username", userUsername, {
    label: "User username",
  });
  pushIdentity("username", chatUsername, {
    label: "Chat username",
  });
  for (const userBsuid of whatsAppBsuidValues.userIds) {
    pushIdentity("whatsapp_user_id", userBsuid, {
      channel: "whatsapp",
      label: "WhatsApp business-scoped user id",
    });
  }
  for (const parentBsuid of whatsAppBsuidValues.parentUserIds) {
    pushIdentity("whatsapp_parent_user_id", parentBsuid, {
      channel: "whatsapp",
      label: "WhatsApp parent business-scoped user id",
    });
  }

  const phoneCandidates = [userId, chatId]
    .map(value => (value ? normalizePhone(value) : null))
    .filter((value): value is string => Boolean(value));
  for (const phone of phoneCandidates) {
    pushIdentity("phone", phone, {
      label: "Normalized phone number",
    });
  }

  return mergeIdentityRecords([], identities);
}

/** A customer's conversations as bundles, latest activity first. */
async function loadCustomerConversationBundles(
  conversationIds: ReadonlyArray<mongoose.Types.ObjectId | string>
): Promise<ConversationBundle[]> {
  const objectIds = conversationIds
    .map(id => toObjectId(id))
    .filter((value): value is mongoose.Types.ObjectId => Boolean(value));
  const conversations = (await Conversation.find({
    _id: { $in: objectIds },
  })
    .select(CUSTOMER_CONVERSATION_SELECT)
    .lean()) as unknown as LeanConversationRecord[];
  const bundles = await loadConversationBundles(conversations);
  bundles.sort((a, b) =>
    compareByLatestActivity(a.conversation, b.conversation)
  );
  return bundles;
}

/**
 * The display name a refresh would store, without writing anything. Null when
 * the customer is missing or has no conversations (a refresh archives those).
 */
export async function previewCustomerDisplayName(customerId: string): Promise<{
  current: string | null;
  next: string | null;
} | null> {
  const objectId = toObjectId(customerId);
  if (!objectId) return null;
  const customerDoc = await Customer.findById(objectId)
    .select("displayName conversationIds")
    .lean<{
      displayName?: string | null;
      conversationIds?: Array<mongoose.Types.ObjectId | string>;
    } | null>();
  if (!customerDoc) return null;
  const [primaryBundle] = await loadCustomerConversationBundles(
    customerDoc.conversationIds || []
  );
  if (!primaryBundle) return null;
  return {
    current: customerDoc.displayName ?? null,
    next: getConversationDisplayName({
      conversation: primaryBundle.conversation,
      user: primaryBundle.user,
      chat: primaryBundle.chat,
    }),
  };
}

async function updateCustomerAggregate(customerId: string) {
  const objectId = toObjectId(customerId);
  if (!objectId) return null;

  const customerDoc = await Customer.findById(objectId).lean<{
    _id: mongoose.Types.ObjectId;
    workspaceId: string;
    status: string;
    seedKeys?: string[];
    profileDates?: { birthday?: { source?: string | null } | null } | null;
    conversationIds: Array<mongoose.Types.ObjectId | string>;
    identities?: IdentityRecord[];
    behavioralProfile?: Record<string, unknown> | null;
    currentFunnelStage?: string | null;
    profileSummary?: {
      tags?: string[] | null;
    } | null;
  } | null>();

  if (!customerDoc) return null;

  const bundles = await loadCustomerConversationBundles(
    customerDoc.conversationIds || []
  );

  if (bundles.length === 0) {
    // Birthday imports create durable contacts before they have conversations.
    // CSV provenance also covers imports whose seed was lost by older refreshes.
    const hasImportedContact =
      customerDoc.seedKeys?.some(seed => seed.startsWith("birthday_import:")) ||
      customerDoc.profileDates?.birthday?.source === "csv";
    if (customerDoc.status === "active" && hasImportedContact) return customerDoc;

    await Customer.updateOne(
      { _id: objectId },
      {
        $set: {
          status: "archived",
          displayName: null,
          primaryConversationId: null,
          lastInteractionAt: null,
          profileSummary: {
            channels: [],
            languages: [],
            tags: readUniqueStringArray(customerDoc.profileSummary?.tags || []),
            contactPoints: {
              emails: [],
              phones: [],
              usernames: [],
              visitorIds: [],
              whatsappUserIds: [],
              whatsappParentUserIds: [],
            },
            lastSentiment: null,
            churnRiskLevel: null,
            estimatedCustomerLtv: null,
            conversationCount: 0,
          },
        },
      }
    );
    return null;
  }

  const primaryBundle = bundles[0];
  const mergedIdentities = mergeIdentityRecords(
    (customerDoc.identities || []) as IdentityRecord[],
    bundles.flatMap(bundle =>
      buildIdentityRecords({
        bundle,
        linkMethod: "system",
      })
    )
  );

  const channels = readUniqueStringArray(
    bundles.map(bundle => normalizeLooseString(bundle.conversation.channel))
  );
  const languages = readUniqueStringArray(
    bundles.map(bundle =>
      normalizeLooseString(bundle.conversation.preferred_language)
    )
  );
  const tags = readUniqueStringArray(customerDoc.profileSummary?.tags || []);
  const emails = readUniqueStringArray(
    mergedIdentities
      .filter(identity => identity.type === "email")
      .map(identity => identity.value)
  );
  const phones = readUniqueStringArray(
    mergedIdentities
      .filter(identity => identity.type === "phone")
      .map(identity => identity.value)
  );
  const usernames = readUniqueStringArray(
    mergedIdentities
      .filter(identity => identity.type === "username")
      .map(identity => identity.value)
  );
  const visitorIds = readUniqueStringArray(
    mergedIdentities
      .filter(identity => identity.type === "visitor_id")
      .map(identity => identity.value)
  );
  const whatsappUserIds = readUniqueStringArray(
    mergedIdentities
      .filter(identity => identity.type === "whatsapp_user_id")
      .map(identity => identity.value)
  );
  const whatsappParentUserIds = readUniqueStringArray(
    mergedIdentities
      .filter(identity => identity.type === "whatsapp_parent_user_id")
      .map(identity => identity.value)
  );
  const currentFunnelStage =
    persistableCrmFunnelStage(primaryBundle.conversation) ||
    normalizeLooseString(customerDoc.currentFunnelStage);
  const lastInteractionAt =
    primaryBundle.conversation.lastMessageAt ||
    primaryBundle.conversation.updatedAt ||
    primaryBundle.conversation.createdAt ||
    null;
  const classification = getCurrentConversationClassification<{
    sentiment?: string | null;
  }>(primaryBundle.conversation);
  const lastSentiment = normalizeLooseString(classification?.sentiment) || null;
  const churnRiskLevel =
    normalizeLooseString(primaryBundle.conversation.churn_risk_level) || null;
  const estimatedCustomerLtv = bundles.reduce<number | null>(
    (maxValue, bundle) => {
      const value = bundle.conversation.estimated_customer_ltv;
      if (typeof value !== "number") return maxValue;
      if (maxValue === null || value > maxValue) return value;
      return maxValue;
    },
    null
  );
  const displayName = getConversationDisplayName({
    conversation: primaryBundle.conversation,
    user: primaryBundle.user,
    chat: primaryBundle.chat,
  });
  const seedKeys = readUniqueStringArray([
    ...(customerDoc.seedKeys || []).filter(seed => seed.startsWith("birthday_import:")),
    ...bundles.map(bundle => buildConversationSeedKey(bundle.conversation)),
  ]);

  await Customer.updateOne(
    { _id: objectId },
    {
      $set: {
        status: "active",
        displayName,
        primaryConversationId: primaryBundle.conversation._id,
        conversationIds: bundles.map(bundle => bundle.conversation._id),
        seedKeys,
        identities: mergedIdentities,
        // An unchanged stage stays out of $set, so the Customer stage hook
        // skips its pre-read on the common path.
        ...((customerDoc.currentFunnelStage ?? null) === currentFunnelStage
          ? {}
          : { currentFunnelStage }),
        lastInteractionAt,
        profileSummary: {
          channels,
          languages,
          tags,
          contactPoints: {
            emails,
            phones,
            usernames,
            visitorIds,
            whatsappUserIds,
            whatsappParentUserIds,
          },
          lastSentiment,
          churnRiskLevel,
          estimatedCustomerLtv,
          conversationCount: bundles.length,
        },
      },
    }
  );

  return Customer.findById(objectId).lean();
}

function shouldRefreshCustomerAggregate(
  customer: {
    lastInteractionAt?: Date | null;
    profileSummary?: {
      conversationCount?: number;
    } | null;
  } | null
): boolean {
  if (!customer) return false;
  // A lead can stay nameless (no profile name yet), so a missing name alone
  // would refresh on every profile open; the fields below mark a stale doc.
  if (!customer.lastInteractionAt) return true;
  if (!customer.profileSummary) return true;
  if (typeof customer.profileSummary.conversationCount !== "number")
    return true;
  return false;
}

async function createCustomerFromBundle(params: {
  bundle: ConversationBundle;
  actor?: CustomerActor;
  linkMethod?: IdentityRecord["linkMethod"];
  linkConfidence?: number | null;
}): Promise<{
  _id: mongoose.Types.ObjectId;
}> {
  const linkMethod = params.linkMethod || "system";
  const identities = buildIdentityRecords({
    bundle: params.bundle,
    linkMethod,
    linkedBy: params.actor?.userId || null,
    linkConfidence: params.linkConfidence ?? null,
  });
  const displayName = getConversationDisplayName({
    conversation: params.bundle.conversation,
    user: params.bundle.user,
    chat: params.bundle.chat,
  });

  const created = await Customer.create({
    workspaceId: params.bundle.conversation.workspaceId,
    status: "active",
    displayName,
    primaryConversationId: params.bundle.conversation._id,
    conversationIds: [params.bundle.conversation._id],
    seedKeys: [buildConversationSeedKey(params.bundle.conversation)],
    identities,
    profileSummary: {
      channels: [],
      languages: [],
      tags: [],
      contactPoints: {
        emails: [],
        phones: [],
        usernames: [],
        visitorIds: [],
        whatsappUserIds: [],
        whatsappParentUserIds: [],
      },
      lastSentiment: null,
      churnRiskLevel: null,
      estimatedCustomerLtv: null,
      conversationCount: 0,
    },
    behavioralProfile: {
      status: "pending",
      motivations: [],
      objections: [],
      trustSignals: [],
      channelAffinity: [],
      recommendedApproach: [],
      evidenceMessageIds: [],
      updatedAt: null,
      error: null,
    },
    currentFunnelStage: persistableCrmFunnelStage(params.bundle.conversation),
    lastInteractionAt:
      params.bundle.conversation.lastMessageAt ||
      params.bundle.conversation.updatedAt ||
      params.bundle.conversation.createdAt ||
      null,
  });

  return { _id: created._id };
}

async function updateConversationCustomerLink(params: {
  conversationId: mongoose.Types.ObjectId;
  customerId: mongoose.Types.ObjectId;
  actor?: CustomerActor;
  linkMethod?: IdentityRecord["linkMethod"];
  linkConfidence?: number | null;
}) {
  await Conversation.updateOne(
    { _id: params.conversationId },
    {
      $set: {
        customerId: params.customerId,
        customerLinkedAt: new Date(),
        customerLinkedBy: params.actor?.userId || null,
        customerLinkMethod: params.linkMethod || "system",
        customerLinkConfidence: params.linkConfidence ?? null,
      },
    }
  );
}

export async function recordCustomerEvent(params: {
  workspaceId: string;
  customerId: string | mongoose.Types.ObjectId;
  type:
    | "conversation_linked"
    | "conversation_unlinked"
    | "stage_snapshot"
    | "stage_changed"
    | "owner_changed"
    | "conversion_recorded"
    | "commerce_behavior"
    | "behavioral_profile_updated";
  occurredAt: Date;
  conversationId?: string | mongoose.Types.ObjectId | null;
  messageId?: string | mongoose.Types.ObjectId | null;
  payload?: Record<string, unknown>;
  actor?: CustomerActor;
  idempotencyKey: string;
}) {
  const customerObjectId = toObjectId(params.customerId);
  if (!customerObjectId) return null;

  const update = {
    workspaceId: params.workspaceId,
    customerId: customerObjectId,
    type: params.type,
    occurredAt: params.occurredAt,
    conversationId: toObjectId(params.conversationId) || null,
    messageId: toObjectId(params.messageId) || null,
    payload: params.payload || {},
    actor: normalizeActor(params.actor),
    idempotencyKey: params.idempotencyKey,
    ...(params.type === "conversion_recorded" ||
    params.type === "commerce_behavior"
      ? {
          behaviorAdmissionStatus: "pending",
          behaviorAdmissionNextAt: new Date(),
        }
      : {}),
  };

  return CustomerEvent.findOneAndUpdate(
    {
      workspaceId: params.workspaceId,
      idempotencyKey: params.idempotencyKey,
    },
    { $setOnInsert: update },
    { new: true, upsert: true }
  );
}

export async function ensureCustomerForConversation(params: {
  conversationId: string;
  actor?: CustomerActor;
  linkMethod?: IdentityRecord["linkMethod"];
  linkConfidence?: number | null;
}) {
  await connectDB();

  const bundle = await loadConversationBundleById(params.conversationId);
  if (!bundle) {
    throw new Error("Conversation not found");
  }

  const actor = params.actor;
  const existingCustomerId = toObjectId(bundle.conversation.customerId);

  if (existingCustomerId) {
    const existingCustomer = await Customer.findById(existingCustomerId).lean<{
      _id: mongoose.Types.ObjectId;
      workspaceId: string;
      status: string;
      conversationIds: Array<mongoose.Types.ObjectId | string>;
      seedKeys?: string[];
      identities?: IdentityRecord[];
    } | null>();

    if (existingCustomer) {
      const identities = mergeIdentityRecords(
        (existingCustomer.identities || []) as IdentityRecord[],
        buildIdentityRecords({
          bundle,
          linkMethod: params.linkMethod || "system",
          linkedBy: actor?.userId || null,
          linkConfidence: params.linkConfidence ?? null,
        })
      );
      await Customer.updateOne(
        { _id: existingCustomerId },
        {
          $set: {
            status: "active",
            identities,
          },
          $addToSet: {
            conversationIds: bundle.conversation._id,
            seedKeys: buildConversationSeedKey(bundle.conversation),
          },
        }
      );
      await updateCustomerAggregate(existingCustomerId.toString());
      return Customer.findById(existingCustomerId).lean();
    }
  }

  const seedKey = buildConversationSeedKey(bundle.conversation);
  const seedCustomer = await Customer.findOne({
    workspaceId: bundle.conversation.workspaceId,
    status: "active",
    seedKeys: seedKey,
  }).lean<{ _id: mongoose.Types.ObjectId } | null>();

  const customerId =
    seedCustomer?._id ||
    (
      await createCustomerFromBundle({
        bundle,
        actor,
        linkMethod: params.linkMethod,
        linkConfidence: params.linkConfidence ?? null,
      })
    )._id;

  await updateConversationCustomerLink({
    conversationId: bundle.conversation._id,
    customerId,
    actor,
    linkMethod: params.linkMethod,
    linkConfidence: params.linkConfidence ?? null,
  });

  await Customer.updateOne(
    { _id: customerId },
    {
      $addToSet: {
        conversationIds: bundle.conversation._id,
        seedKeys: seedKey,
      },
    }
  );

  await updateCustomerAggregate(customerId.toString());
  return Customer.findById(customerId).lean();
}

export async function getCustomerById(params: {
  customerId: string;
  refreshBehavioralProfile?: boolean;
}) {
  await connectDB();
  const customerId = toObjectId(params.customerId);
  if (!customerId) return null;

  const existingCustomer = await Customer.findById(customerId).lean<{
    _id: mongoose.Types.ObjectId;
    displayName?: string | null;
    lastInteractionAt?: Date | null;
    profileSummary?: {
      conversationCount?: number;
    } | null;
  } | null>();
  if (!existingCustomer) return null;

  if (shouldRefreshCustomerAggregate(existingCustomer)) {
    await updateCustomerAggregate(customerId.toString());
  }
  if (params.refreshBehavioralProfile) {
    await generateBehavioralProfileForCustomer({
      customerId: customerId.toString(),
      force: true,
    });
  }
  return Customer.findById(customerId).lean();
}

export async function linkConversations(params: {
  sourceConversationId: string;
  targetConversationId: string;
  actor?: CustomerActor;
  linkMethod?: "manual" | "suggested" | "rule";
  linkConfidence?: number | null;
}) {
  await connectDB();
  const actor = params.actor;
  const sourceBundle = await loadConversationBundleById(
    params.sourceConversationId
  );
  const targetBundle = await loadConversationBundleById(
    params.targetConversationId
  );

  if (!sourceBundle || !targetBundle) {
    throw new Error("Conversation not found");
  }
  if (
    sourceBundle.conversation.workspaceId !==
    targetBundle.conversation.workspaceId
  ) {
    throw new Error("Conversations must belong to the same workspace");
  }

  const [sourceCustomer, targetCustomer] = await Promise.all([
    ensureCustomerForConversation({
      conversationId: params.sourceConversationId,
      actor,
      linkMethod: params.linkMethod || "manual",
      linkConfidence: params.linkConfidence ?? null,
    }),
    ensureCustomerForConversation({
      conversationId: params.targetConversationId,
      actor,
      linkMethod: params.linkMethod || "manual",
      linkConfidence: params.linkConfidence ?? null,
    }),
  ]);

  const sourceCustomerId = toObjectId(
    (sourceCustomer as { _id?: unknown })?._id
  );
  const targetCustomerId = toObjectId(
    (targetCustomer as { _id?: unknown })?._id
  );
  if (!sourceCustomerId || !targetCustomerId) {
    throw new Error("Failed to resolve customers");
  }
  if (String(sourceCustomerId) === String(targetCustomerId)) {
    return Customer.findById(sourceCustomerId).lean();
  }

  await updateConversationCustomerLink({
    conversationId: targetBundle.conversation._id,
    customerId: sourceCustomerId,
    actor,
    linkMethod: params.linkMethod || "manual",
    linkConfidence: params.linkConfidence ?? null,
  });

  await Customer.updateOne(
    { _id: sourceCustomerId },
    {
      $addToSet: {
        conversationIds: targetBundle.conversation._id,
        seedKeys: buildConversationSeedKey(targetBundle.conversation),
      },
    }
  );

  await Customer.updateOne(
    { _id: targetCustomerId },
    { $pull: { conversationIds: targetBundle.conversation._id } }
  );

  await Promise.all([
    recordCustomerEvent({
      workspaceId: sourceBundle.conversation.workspaceId,
      customerId: sourceCustomerId,
      type: "conversation_linked",
      occurredAt: new Date(),
      conversationId: targetBundle.conversation._id,
      payload: {
        sourceConversationId: sourceBundle.conversation._id.toString(),
        targetConversationId: targetBundle.conversation._id.toString(),
        targetCustomerId: targetCustomerId.toString(),
        linkMethod: params.linkMethod || "manual",
      },
      actor,
      idempotencyKey: [
        "customer-link",
        sourceCustomerId.toString(),
        sourceBundle.conversation._id.toString(),
        targetBundle.conversation._id.toString(),
      ].join(":"),
    }),
    recordCustomerEvent({
      workspaceId: targetBundle.conversation.workspaceId,
      customerId: targetCustomerId,
      type: "conversation_unlinked",
      occurredAt: new Date(),
      conversationId: targetBundle.conversation._id,
      payload: {
        movedToCustomerId: sourceCustomerId.toString(),
        sourceConversationId: sourceBundle.conversation._id.toString(),
      },
      actor,
      idempotencyKey: [
        "customer-unlink-move",
        targetCustomerId.toString(),
        targetBundle.conversation._id.toString(),
        sourceCustomerId.toString(),
      ].join(":"),
    }),
  ]);

  await Promise.all([
    updateCustomerAggregate(sourceCustomerId.toString()),
    updateCustomerAggregate(targetCustomerId.toString()),
  ]);

  return Customer.findById(sourceCustomerId).lean();
}

export async function unlinkConversation(params: {
  conversationId: string;
  actor?: CustomerActor;
}) {
  await connectDB();
  const bundle = await loadConversationBundleById(params.conversationId);
  if (!bundle) {
    throw new Error("Conversation not found");
  }

  const currentCustomer = await ensureCustomerForConversation({
    conversationId: params.conversationId,
    actor: params.actor,
    linkMethod: "manual",
  });
  const currentCustomerId = toObjectId(
    (currentCustomer as { _id?: unknown })?._id
  );
  if (!currentCustomerId) {
    throw new Error("Customer not found");
  }

  const currentCustomerDoc = await Customer.findById(currentCustomerId).lean<{
    _id: mongoose.Types.ObjectId;
    workspaceId: string;
    conversationIds: Array<mongoose.Types.ObjectId | string>;
  } | null>();

  const currentConversationIds = (
    currentCustomerDoc?.conversationIds || []
  ).map(id => String(id));
  if (currentConversationIds.length <= 1) {
    return Customer.findById(currentCustomerId).lean();
  }

  await Customer.updateOne(
    { _id: currentCustomerId },
    { $pull: { conversationIds: bundle.conversation._id } }
  );

  const detachedCustomer = await createCustomerFromBundle({
    bundle,
    actor: params.actor,
    linkMethod: "manual",
  });

  await updateConversationCustomerLink({
    conversationId: bundle.conversation._id,
    customerId: detachedCustomer._id,
    actor: params.actor,
    linkMethod: "manual",
    linkConfidence: null,
  });

  await Promise.all([
    recordCustomerEvent({
      workspaceId: bundle.conversation.workspaceId,
      customerId: currentCustomerId,
      type: "conversation_unlinked",
      occurredAt: new Date(),
      conversationId: bundle.conversation._id,
      payload: {
        newCustomerId: detachedCustomer._id.toString(),
      },
      actor: params.actor,
      idempotencyKey: [
        "customer-unlink",
        currentCustomerId.toString(),
        bundle.conversation._id.toString(),
      ].join(":"),
    }),
    recordCustomerEvent({
      workspaceId: bundle.conversation.workspaceId,
      customerId: detachedCustomer._id,
      type: "conversation_linked",
      occurredAt: new Date(),
      conversationId: bundle.conversation._id,
      payload: {
        detachedFromCustomerId: currentCustomerId.toString(),
      },
      actor: params.actor,
      idempotencyKey: [
        "customer-link-detached",
        detachedCustomer._id.toString(),
        bundle.conversation._id.toString(),
      ].join(":"),
    }),
  ]);

  await Promise.all([
    updateCustomerAggregate(currentCustomerId.toString()),
    updateCustomerAggregate(detachedCustomer._id.toString()),
  ]);

  return Customer.findById(detachedCustomer._id).lean();
}

function collectIdentityValues(bundle: ConversationBundle) {
  const displayName = (
    getConversationDisplayName({
      conversation: bundle.conversation,
      user: bundle.user,
      chat: bundle.chat,
    }) || ""
  ).toLowerCase();
  const emailValues = readUniqueStringArray(
    [bundle.user?.email]
      .map(value => (value ? normalizeEmail(value) : null))
      .filter(Boolean)
  );
  const usernameValues = readUniqueStringArray(
    [bundle.user?.username, bundle.chat?.username]
      .map(value => {
        const normalized = normalizeLooseString(value);
        return normalized ? normalizeUsername(normalized) : null;
      })
      .filter(Boolean)
  );
  const phoneValues = readUniqueStringArray(
    [toStringId(bundle.conversation.user), toStringId(bundle.conversation.chat)]
      .map(value => (value ? normalizePhone(value) : null))
      .filter(Boolean)
  );
  const whatsAppBsuidValues = collectWhatsAppBsuidValues(
    bundle.user,
    bundle.chat
  );
  return {
    seedKey: buildConversationSeedKey(bundle.conversation),
    visitorId: normalizeLooseString(bundle.conversation.visitor_id),
    userId: toStringId(bundle.conversation.user),
    chatId: toStringId(bundle.conversation.chat),
    sourceId: normalizeLooseString(bundle.conversation.sourceId),
    displayName,
    emails: emailValues,
    usernames: usernameValues,
    phones: phoneValues,
    whatsappUserIds: whatsAppBsuidValues.userIds,
    whatsappParentUserIds: whatsAppBsuidValues.parentUserIds,
  };
}

function buildSuggestionIdentityFilters(params: {
  bundle: ConversationBundle;
  values: ReturnType<typeof collectIdentityValues>;
}): Array<Record<string, unknown>> {
  const { bundle, values } = params;
  const channel = normalizeLooseString(bundle.conversation.channel);
  const filters = new Map<string, Record<string, unknown>>();

  const pushFilter = (filter: Record<string, unknown>) => {
    filters.set(JSON.stringify(filter), filter);
  };

  pushFilter({
    identities: {
      $elemMatch: {
        type: "seed_key",
        normalizedValue: values.seedKey,
      },
    },
  });

  if (values.visitorId) {
    pushFilter({
      identities: {
        $elemMatch: {
          type: "visitor_id",
          normalizedValue: values.visitorId,
        },
      },
    });
  }

  if (channel && values.userId) {
    pushFilter({
      identities: {
        $elemMatch: {
          type: "channel_user",
          channel,
          normalizedValue: values.userId,
        },
      },
    });
  }

  if (channel && values.chatId) {
    pushFilter({
      identities: {
        $elemMatch: {
          type: "channel_chat",
          channel,
          normalizedValue: values.chatId,
        },
      },
    });
  }

  for (const email of values.emails) {
    pushFilter({
      identities: {
        $elemMatch: {
          type: "email",
          normalizedValue: email,
        },
      },
    });
  }

  for (const phone of values.phones) {
    pushFilter({
      identities: {
        $elemMatch: {
          type: "phone",
          normalizedValue: phone,
        },
      },
    });
  }

  for (const username of values.usernames) {
    pushFilter({
      identities: {
        $elemMatch: {
          type: "username",
          normalizedValue: username,
        },
      },
    });
  }

  for (const whatsappUserId of values.whatsappUserIds) {
    pushFilter({
      identities: {
        $elemMatch: {
          type: "whatsapp_user_id",
          channel: "whatsapp",
          normalizedValue: whatsappUserId,
        },
      },
    });
  }

  for (const whatsappParentUserId of values.whatsappParentUserIds) {
    pushFilter({
      identities: {
        $elemMatch: {
          type: "whatsapp_parent_user_id",
          channel: "whatsapp",
          normalizedValue: whatsappParentUserId,
        },
      },
    });
  }

  return Array.from(filters.values());
}

export async function getCustomerSuggestions(params: {
  conversationId: string;
  limit?: number;
}): Promise<CustomerSuggestion[]> {
  await connectDB();

  const sourceBundle = await loadConversationBundleById(params.conversationId);
  if (!sourceBundle) {
    throw new Error("Conversation not found");
  }

  const sourceCustomerId =
    toStringId(sourceBundle.conversation.customerId) ||
    toStringId(
      (await ensureCustomerForConversation({
        conversationId: params.conversationId,
        linkMethod: "system",
      }).catch(() => null)) as { _id?: unknown } | null
    );
  const sourceValues = collectIdentityValues(sourceBundle);
  const sourceCustomerObjectId = toObjectId(sourceCustomerId);
  const suggestionLimit =
    Number.isFinite(params.limit) && (params.limit || 0) > 0
      ? Math.min(params.limit || 10, 25)
      : 10;
  const candidateWindow = Math.max(suggestionLimit * 4, 24);
  const customerIdentityFilters = buildSuggestionIdentityFilters({
    bundle: sourceBundle,
    values: sourceValues,
  });

  const matchedCustomers = customerIdentityFilters.length
    ? await Customer.find({
        workspaceId: sourceBundle.conversation.workspaceId,
        status: "active",
        ...(sourceCustomerObjectId
          ? { _id: { $ne: sourceCustomerObjectId } }
          : {}),
        $or: customerIdentityFilters,
      })
        .select("_id conversationIds")
        .sort({ lastInteractionAt: -1 })
        .limit(candidateWindow)
        .lean<
          {
            _id: mongoose.Types.ObjectId;
            conversationIds?: Array<mongoose.Types.ObjectId | string>;
          }[]
        >()
    : [];

  const exactCandidateConversationIds = readUniqueStringArray(
    matchedCustomers.flatMap(customer =>
      (customer.conversationIds || []).map(id => toStringId(id))
    )
  )
    .filter(
      candidateId => candidateId !== sourceBundle.conversation._id.toString()
    )
    .slice(0, candidateWindow * 2);

  const exactCandidates = exactCandidateConversationIds.length
    ? ((await Conversation.find({
        _id: { $in: exactCandidateConversationIds },
      })
        .select(CUSTOMER_SUGGESTION_CONVERSATION_SELECT)
        .sort({ lastMessageAt: -1, updatedAt: -1 })
        .lean()) as unknown as LeanConversationRecord[])
    : [];

  const fallbackFilters: Array<Record<string, unknown>> = [];
  const sourceChannel = normalizeLooseString(sourceBundle.conversation.channel);
  if (sourceValues.sourceId) {
    fallbackFilters.push({ sourceId: sourceValues.sourceId });
  }
  if (sourceChannel) {
    fallbackFilters.push({ channel: sourceChannel });
  }

  const fallbackCandidates =
    fallbackFilters.length > 0
      ? ((await Conversation.find({
          workspaceId: sourceBundle.conversation.workspaceId,
          _id: {
            $ne: sourceBundle.conversation._id,
            ...(exactCandidateConversationIds.length > 0
              ? { $nin: exactCandidateConversationIds }
              : {}),
          },
          $or: fallbackFilters,
        })
          .select(CUSTOMER_SUGGESTION_CONVERSATION_SELECT)
          .sort({ lastMessageAt: -1, updatedAt: -1 })
          .limit(candidateWindow)
          .lean()) as unknown as LeanConversationRecord[])
      : [];

  const candidateMap = new Map<string, LeanConversationRecord>();
  for (const candidate of [...exactCandidates, ...fallbackCandidates]) {
    candidateMap.set(candidate._id.toString(), candidate);
    if (candidateMap.size >= candidateWindow) {
      break;
    }
  }

  const candidates = Array.from(candidateMap.values());

  const bundles = await loadConversationBundles(candidates);
  const scored = bundles
    .filter(bundle => {
      const candidateCustomerId = toStringId(bundle.conversation.customerId);
      if (sourceCustomerId && candidateCustomerId === sourceCustomerId) {
        return false;
      }
      return true;
    })
    .map(bundle => {
      const values = collectIdentityValues(bundle);
      const matchingPhones = values.phones.filter(phone =>
        sourceValues.phones.includes(phone)
      );
      const matchingEmails = values.emails.filter(email =>
        sourceValues.emails.includes(email)
      );
      const matchingUsernames = values.usernames.filter(username =>
        sourceValues.usernames.includes(username)
      );
      const matchingWhatsAppUserIds = values.whatsappUserIds.filter(userId =>
        sourceValues.whatsappUserIds.includes(userId)
      );
      const matchingWhatsAppParentUserIds = values.whatsappParentUserIds.filter(
        parentUserId =>
          sourceValues.whatsappParentUserIds.includes(parentUserId)
      );
      const sameDisplayName =
        values.displayName.length > 0 &&
        values.displayName === sourceValues.displayName;
      const score = scoreCustomerSuggestion({
        sameVisitorId:
          Boolean(sourceValues.visitorId) &&
          sourceValues.visitorId === values.visitorId,
        sameChannelUser:
          sourceBundle.conversation.channel === bundle.conversation.channel &&
          ((Boolean(sourceValues.userId) &&
            sourceValues.userId === values.userId) ||
            matchingWhatsAppUserIds.length > 0 ||
            matchingWhatsAppParentUserIds.length > 0),
        sameChannelChat:
          sourceBundle.conversation.channel === bundle.conversation.channel &&
          Boolean(sourceValues.chatId) &&
          sourceValues.chatId === values.chatId,
        matchingPhones,
        matchingEmails,
        matchingUsernames,
        sameDisplayName,
        sameSourceId:
          Boolean(sourceValues.sourceId) &&
          sourceValues.sourceId === values.sourceId,
        sourceLastActivity:
          sourceBundle.conversation.lastMessageAt ||
          sourceBundle.conversation.updatedAt ||
          sourceBundle.conversation.createdAt,
        candidateLastActivity:
          bundle.conversation.lastMessageAt ||
          bundle.conversation.updatedAt ||
          bundle.conversation.createdAt,
      });

      return {
        conversationId: bundle.conversation._id.toString(),
        customerId: toStringId(bundle.conversation.customerId),
        displayName: getConversationDisplayName({
          conversation: bundle.conversation,
          user: bundle.user,
          chat: bundle.chat,
        }),
        channel: normalizeLooseString(bundle.conversation.channel),
        lastActivityAt:
          (
            bundle.conversation.lastMessageAt ||
            bundle.conversation.updatedAt ||
            bundle.conversation.createdAt ||
            null
          )?.toISOString?.() || null,
        currentStage: getConversationStage(bundle.conversation),
        score: score.score,
        reasons: score.reasons,
      } satisfies CustomerSuggestion;
    })
    .filter(candidate => candidate.score >= 20)
    .sort((a, b) => b.score - a.score)
    .slice(0, suggestionLimit);

  return scored;
}

export async function buildCustomerTimeline(params: {
  customerId: string;
  limit?: number;
}) {
  await connectDB();
  const customerId = toObjectId(params.customerId);
  if (!customerId) {
    throw new Error("Invalid customer id");
  }

  const customer = await Customer.findById(customerId).lean<{
    _id: mongoose.Types.ObjectId;
    workspaceId: string;
    conversationIds: Array<mongoose.Types.ObjectId | string>;
  } | null>();

  if (!customer) {
    throw new Error("Customer not found");
  }

  const conversationIds = (customer.conversationIds || [])
    .map(id => toObjectId(id))
    .filter((value): value is mongoose.Types.ObjectId => Boolean(value));

  const timelineLimit =
    Number.isFinite(params.limit) && (params.limit || 0) > 0
      ? Math.min(params.limit || 120, 200)
      : 120;

  const [conversations, messages, events] = await Promise.all([
    Conversation.find({ _id: { $in: conversationIds } })
      .select("_id channel sourceId page_url rename lastMessageAt createdAt")
      .lean(),
    Message.find({ conversation: { $in: conversationIds } })
      .select("_id conversation channel direction text date author")
      .sort({ date: -1 })
      .limit(timelineLimit)
      .lean(),
    CustomerEvent.find({ customerId })
      .sort({ occurredAt: -1 })
      .limit(timelineLimit)
      .lean(),
  ]);

  const conversationMap = new Map(
    (
      conversations as Array<{
        _id: unknown;
        channel?: string;
        sourceId?: string | null;
        page_url?: string | null;
        rename?: string | null;
      }>
    ).map(conversation => [String(conversation._id), conversation])
  );

  const authorIds = mixedIdLookupValues(
    (messages as Array<{ author?: unknown }>).map(message => message.author)
  );
  const authorDocs =
    authorIds.length > 0
      ? await User.find({ _id: { $in: authorIds } })
          .select("_id firstName username isBot")
          .lean()
      : [];
  const authorMap = new Map(
    (
      authorDocs as Array<{
        _id: unknown;
        firstName?: string | null;
        username?: string | null;
        isBot?: boolean;
      }>
    ).map(author => [String(author._id), author])
  );

  const timelineItems = [
    ...(
      messages as Array<{
        _id: unknown;
        conversation?: unknown;
        channel?: string | null;
        direction?: string | null;
        text?: string | null;
        date?: Date | null;
        author?: unknown;
      }>
    ).map(message => {
      const author = authorMap.get(String(message.author));
      const conversation = conversationMap.get(String(message.conversation));
      return {
        id: `message:${String(message._id)}`,
        kind: "message" as const,
        occurredAt: message.date?.toISOString?.() || new Date().toISOString(),
        conversationId: toStringId(message.conversation),
        channel: normalizeLooseString(message.channel),
        direction: normalizeLooseString(message.direction),
        text: normalizeLooseString(message.text),
        author: author
          ? {
              id: String(author._id),
              name:
                normalizeLooseString(author.firstName) ||
                normalizeLooseString(author.username) ||
                "Unknown",
              isBot: author.isBot === true,
            }
          : null,
        meta: {
          pageUrl: normalizeLooseString(conversation?.page_url),
          conversationName: normalizeLooseString(conversation?.rename),
        },
      };
    }),
    ...(
      events as Array<{
        _id: unknown;
        type?: string;
        occurredAt?: Date;
        conversationId?: unknown;
        payload?: Record<string, unknown>;
        actor?: {
          type?: string;
          userId?: string | null;
          label?: string | null;
        };
      }>
    ).map(event => ({
      id: `event:${String(event._id)}`,
      kind: "event" as const,
      occurredAt: event.occurredAt?.toISOString?.() || new Date().toISOString(),
      conversationId: toStringId(event.conversationId),
      eventType: normalizeLooseString(event.type),
      payload: event.payload || {},
      actor: event.actor || null,
    })),
  ].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  return timelineItems.slice(-timelineLimit);
}

export async function recordCustomerStageSnapshotForConversation(params: {
  conversationId: string;
  actor?: CustomerActor;
}) {
  await connectDB();
  const bundle = await loadConversationBundleById(params.conversationId);
  if (!bundle) return null;

  const stage = persistableCrmFunnelStage(bundle.conversation);
  if (!stage) return null;

  const customer = await ensureCustomerForConversation({
    conversationId: params.conversationId,
    actor: params.actor,
    linkMethod: params.actor?.type === "backfill" ? "backfill" : "system",
  });
  const customerId = toObjectId((customer as { _id?: unknown })?._id);
  if (!customerId) return null;

  const event = decodeCustomerStageEnvelope((customer as { crm_stage_event?: unknown }).crm_stage_event);
  if (!event || event.customerId !== String(customerId) || event.workspaceId !== bundle.conversation.workspaceId) return null;
  return materializeCustomerStageEvent(event);
}

export async function recordCustomerConversionEvent(params: {
  expectedWorkspaceId?: string;
  conversationId: string;
  conversionId: string;
  conversionType: string;
  conversionValue?: number | null;
  currency?: string | null;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
  actor?: CustomerActor;
}) {
  await connectDB();
  const bundle = await loadConversationBundleById(params.conversationId);
  if (!bundle) return null;
  if (
    params.expectedWorkspaceId &&
    bundle.conversation.workspaceId !== params.expectedWorkspaceId
  )
    return null;

  const customer = await ensureCustomerForConversation({
    conversationId: params.conversationId,
    actor: params.actor,
    linkMethod: "system",
  });
  const customerId = toObjectId((customer as { _id?: unknown })?._id);
  if (!customerId) return null;

  return recordCustomerEvent({
    workspaceId: bundle.conversation.workspaceId,
    customerId,
    type: "conversion_recorded",
    occurredAt: params.occurredAt || new Date(),
    conversationId: bundle.conversation._id,
    payload: {
      conversionId: params.conversionId,
      conversionType: params.conversionType,
      conversionValue: params.conversionValue ?? null,
      currency: params.currency || null,
      metadata: params.metadata || {},
    },
    actor: params.actor,
    idempotencyKey: [
      "conversion",
      bundle.conversation.workspaceId,
      params.conversionId,
    ].join(":"),
  });
}

export async function generateBehavioralProfileForCustomer(params: {
  customerId: string;
  force?: boolean;
}) {
  await connectDB();
  const customerId = toObjectId(params.customerId);
  if (!customerId) {
    throw new Error("Invalid customer id");
  }

  const customer = await Customer.findById(customerId).lean<{
    _id: mongoose.Types.ObjectId;
    workspaceId: string;
    displayName?: string | null;
    conversationIds: Array<mongoose.Types.ObjectId | string>;
    behavioralProfile?: {
      status?: string;
      updatedAt?: Date | null;
    } | null;
  } | null>();

  if (!customer) {
    throw new Error("Customer not found");
  }

  const existingProfile = customer.behavioralProfile;
  if (
    !params.force &&
    existingProfile?.status === "ready" &&
    existingProfile.updatedAt &&
    Date.now() - existingProfile.updatedAt.getTime() < 6 * 60 * 60 * 1000
  ) {
    return Customer.findById(customerId).lean();
  }

  const conversationIds = (customer.conversationIds || [])
    .map(id => toObjectId(id))
    .filter((value): value is mongoose.Types.ObjectId => Boolean(value));
  const messages = (await Message.find({
    conversation: { $in: conversationIds },
  })
    .select("_id conversation channel direction text date")
    .sort({ date: -1 })
    .limit(24)
    .lean()) as Array<{
    _id: mongoose.Types.ObjectId;
    conversation?: unknown;
    channel?: string | null;
    direction?: string | null;
    text?: string | null;
    date?: Date | null;
  }>;

  const meaningfulMessages = messages
    .filter(message => normalizeLooseString(message.text))
    .slice(0, 18)
    .reverse();

  if (meaningfulMessages.length < 4) {
    await Customer.updateOne(
      { _id: customerId },
      {
        $set: {
          behavioralProfile: {
            status: "insufficient_data",
            summary: null,
            communicationStyle: null,
            decisionStyle: null,
            motivations: [],
            objections: [],
            trustSignals: [],
            urgency: null,
            channelAffinity: [],
            responseCadence: null,
            recommendedApproach: [],
            evidenceMessageIds: [],
            confidence: null,
            model: null,
            updatedAt: new Date(),
            error: null,
          },
        },
      }
    );
    return Customer.findById(customerId).lean();
  }

  const messageReferenceMap = new Map<string, mongoose.Types.ObjectId>();
  const transcript = meaningfulMessages
    .map((message, index) => {
      const ref = `M${index + 1}`;
      messageReferenceMap.set(ref, message._id);
      const text = normalizeLooseString(message.text) || "";
      return [
        `[${ref}]`,
        `date=${message.date?.toISOString?.() || "unknown"}`,
        `channel=${normalizeLooseString(message.channel) || "unknown"}`,
        `direction=${normalizeLooseString(message.direction) || "unknown"}`,
        `text=${text.slice(0, 400)}`,
      ].join(" ");
    })
    .join("\n");

  const systemPrompt = `You are a business-safe customer behavior analyst.
Infer only business-relevant communication and decision patterns from customer conversations.
Never infer sensitive or protected traits, medical status, mental health, religion, ethnicity, politics, sexuality, or diagnoses.
Ground every output in the provided messages only.

Return JSON only with this shape:
{
  "summary": string,
  "communicationStyle": string,
  "decisionStyle": string,
  "motivations": string[],
  "objections": string[],
  "trustSignals": string[],
  "urgency": string,
  "channelAffinity": string[],
  "responseCadence": string,
  "recommendedApproach": string[],
  "confidence": number,
  "evidenceRefs": string[]
}`;

  try {
    const response = await withWorkspaceTextAiAction(
      {
        workspaceId: customer.workspaceId,
        actionId: `customer-profile:${randomUUID()}`,
      },
      () =>
        chatCompletionWithFallback({
          model: getHeavyTextModel(),
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: `Customer: ${customer.displayName || "Unknown"}\n\nMessages:\n${transcript}`,
            },
          ],
          responseFormat: { type: "json_object" },
          temperature: 0.2,
        })
    );

    // No response schema here, so Claude may fence the JSON object.
    const parsed = extractJsonObject(response.content) as {
      summary?: string;
      communicationStyle?: string;
      decisionStyle?: string;
      motivations?: unknown;
      objections?: unknown;
      trustSignals?: unknown;
      urgency?: string;
      channelAffinity?: unknown;
      responseCadence?: string;
      recommendedApproach?: unknown;
      confidence?: number;
      evidenceRefs?: unknown;
    };

    const evidenceMessageIds = Array.isArray(parsed.evidenceRefs)
      ? parsed.evidenceRefs
          .map(ref =>
            typeof ref === "string"
              ? messageReferenceMap.get(ref) || null
              : null
          )
          .filter((value): value is mongoose.Types.ObjectId => Boolean(value))
      : [];

    await Customer.updateOne(
      { _id: customerId },
      {
        $set: {
          behavioralProfile: {
            status: "ready",
            summary: normalizeLooseString(parsed.summary),
            communicationStyle: normalizeLooseString(parsed.communicationStyle),
            decisionStyle: normalizeLooseString(parsed.decisionStyle),
            motivations: Array.isArray(parsed.motivations)
              ? readUniqueStringArray(
                  parsed.motivations.map(value =>
                    typeof value === "string" ? value : null
                  )
                )
              : [],
            objections: Array.isArray(parsed.objections)
              ? readUniqueStringArray(
                  parsed.objections.map(value =>
                    typeof value === "string" ? value : null
                  )
                )
              : [],
            trustSignals: Array.isArray(parsed.trustSignals)
              ? readUniqueStringArray(
                  parsed.trustSignals.map(value =>
                    typeof value === "string" ? value : null
                  )
                )
              : [],
            urgency: normalizeLooseString(parsed.urgency),
            channelAffinity: Array.isArray(parsed.channelAffinity)
              ? readUniqueStringArray(
                  parsed.channelAffinity.map(value =>
                    typeof value === "string" ? value : null
                  )
                )
              : [],
            responseCadence: normalizeLooseString(parsed.responseCadence),
            recommendedApproach: Array.isArray(parsed.recommendedApproach)
              ? readUniqueStringArray(
                  parsed.recommendedApproach.map(value =>
                    typeof value === "string" ? value : null
                  )
                )
              : [],
            evidenceMessageIds,
            confidence:
              typeof parsed.confidence === "number"
                ? Math.max(0, Math.min(1, parsed.confidence))
                : null,
            model: response.model,
            updatedAt: new Date(),
            error: null,
          },
        },
      }
    );

    await recordCustomerEvent({
      workspaceId: customer.workspaceId,
      customerId,
      type: "behavioral_profile_updated",
      occurredAt: new Date(),
      payload: {
        model: response.model,
        confidence:
          typeof parsed.confidence === "number"
            ? Math.max(0, Math.min(1, parsed.confidence))
            : null,
        evidenceCount: evidenceMessageIds.length,
      },
      actor: { type: "ai", label: "behavioral_profile" },
      idempotencyKey: [
        "behavioral-profile",
        customerId.toString(),
        new Date().toISOString().slice(0, 13),
      ].join(":"),
    });
  } catch (error) {
    await Customer.updateOne(
      { _id: customerId },
      {
        $set: {
          behavioralProfile: {
            status: "failed",
            summary: null,
            communicationStyle: null,
            decisionStyle: null,
            motivations: [],
            objections: [],
            trustSignals: [],
            urgency: null,
            channelAffinity: [],
            responseCadence: null,
            recommendedApproach: [],
            evidenceMessageIds: [],
            confidence: null,
            model: getHeavyTextModel(),
            updatedAt: new Date(),
            error: error instanceof Error ? error.message : String(error),
          },
        },
      }
    );
  }

  return Customer.findById(customerId).lean();
}

export async function syncCustomerForConversation(params: {
  conversationId: string;
}) {
  const customer = await ensureCustomerForConversation({
    conversationId: params.conversationId,
    linkMethod: "system",
  });
  await recordCustomerStageSnapshotForConversation({
    conversationId: params.conversationId,
  }).catch(() => null);
  return customer;
}
