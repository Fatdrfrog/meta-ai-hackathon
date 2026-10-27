import {
  getWorkspaceBotDefault,
  getWorkspaceCoachDefault,
  getWorkspaceScenariosDefault,
} from "@/lib/airi/workspace-bot-default";
import { appendMessageToConversationById } from "@/lib/conversation-messages";
import findOrCreateEmailConversation from "@/lib/email/threading";
import { parseCampaignRecipientName } from "@/lib/campaign/campaign-recipient-name";
import {
  assertCompanyConversationCapacity,
  COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
  isCompanyConversationLimitExceeded,
} from "@/lib/limits/company-limits";
import connectDB from "@/lib/mongoose";
import { triggerConversationChanged } from "@/lib/realtime-updates";
import { realtime } from "@/lib/realtime/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  getOrCreateWhatsAppConversation,
  findExistingWhatsAppConversationForRecipient,
  normalizeWhatsAppConversationPhoneCandidate,
} from "@/lib/whatsapp/conversation-lookup";
import { normalizeWhatsAppMessageId } from "@icecore/shared/lib/whatsapp/message-id";
import { buildStoredWhatsAppTemplatePreview } from "@/lib/whatsapp/templates/preview";
import Chat from "@/models/chat";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import User from "@/models/user";
import { WhatsAppTemplateModel } from "@/models/whatsapp-template";
import {
  buildWhatsAppCanonicalIdFromPhone,
  normalizeWhatsAppPhone,
  parseWhatsAppRecipientTarget,
  type WhatsAppNormalizedContact,
} from "@icecore/shared/lib/whatsapp/contact-identities";
import { buildWhatsAppIdentitySnapshot } from "@icecore/shared/lib/whatsapp/identity-snapshot";
import { Types } from "mongoose";
import { normalizeCampaignEmail } from "./campaign-recipient-utils";

/** Memo for lookups that are identical across one bulk dispatch batch. */
export type CampaignConversationLookupCache = {
  authors?: Map<string, Promise<OutboundAuthor>>;
  templateComponents?: Map<string, Promise<unknown[] | undefined>>;
};

type OutboundAuthor = Awaited<ReturnType<typeof resolveOutboundAuthor>>;

function memoizeLookup<T>(
  cache: Map<string, Promise<T>> | undefined,
  key: string,
  load: () => Promise<T>
): Promise<T> {
  if (!cache) return load();
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = load();
  cache.set(key, pending);
  pending.catch(() => cache.delete(key));
  return pending;
}

type PersistCampaignWhatsAppConversationMessageBase = {
  workspaceId: string;
  sourceId?: string | null;
  phoneNumberId?: string | null;
  campaignId?: string | null;
  scenarioId?: string | null;
  nodeId?: string | null;
  executionSource?: string | null;
  originKind?: "campaign" | "bulk_analytics" | null;
  recipientPhone: string;
  recipientEmail?: string | null;
  /** The name from the recipient's row, when the file has one. */
  recipientName?: string | null;
  messageId: string;
  sentByUserId?: string | null;
  sentAt?: string | Date | null;
  lookupCache?: CampaignConversationLookupCache;
  /**
   * Long-lived workers pass false: realtime fanout then finishes in the
   * background instead of holding the next recipient's send.
   */
  awaitRealtime?: boolean;
};

type PersistCampaignWhatsAppConversationMessageParams =
  PersistCampaignWhatsAppConversationMessageBase &
    (
      | {
          whatsappMessageType?: "template";
          templateName: string;
          templateCategory?: string | null;
          languageCode?: string | null;
          components?: unknown[] | null;
        }
      | {
          whatsappMessageType: "service_text";
          messageText: string;
        }
    );

type PersistCampaignEmailConversationMessageParams = {
  workspaceId: string;
  sourceId?: string | null;
  campaignId?: string | null;
  scenarioId?: string | null;
  nodeId?: string | null;
  executionSource?: string | null;
  originKind?: "campaign" | "bulk_analytics" | null;
  recipientEmail: string;
  fromAddress?: string | null;
  messageId: string;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  headers?: Record<string, string | string[]> | null;
  sentByUserId?: string | null;
  sentAt?: string | Date | null;
};

type PersistCampaignWhatsAppConversationMessageResult =
  | {
      persisted: true;
      conversationId: string;
      messageId: string;
      created: boolean;
    }
  | { persisted: false; reason: string };

type PersistCampaignEmailConversationMessageResult =
  | {
      persisted: true;
      conversationId: string;
      messageId: string;
      created: boolean;
    }
  | { persisted: false; reason: string };

function normalizeTemplateLanguageCode(value: unknown): string {
  const normalized =
    typeof value === "string"
      ? value.trim().replace(/-/g, "_").toLowerCase()
      : "";
  if (!normalized) return "";
  if (normalized === "kz" || normalized === "kz_kz" || normalized === "kk_kz") {
    return "kk";
  }
  return normalized;
}

function parseAcceptedAt(value: string | Date | null | undefined): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return new Date();
}

function normalizeHeaders(
  headers: Record<string, string | string[]> | null | undefined
): Record<string, string | string[]> {
  if (!headers || typeof headers !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(headers)
      .map(([key, value]) => {
        const normalizedKey = String(key || "").trim();
        if (!normalizedKey) return null;
        if (Array.isArray(value)) {
          const values = value
            .map(item => String(item || "").trim())
            .filter(Boolean);
          return values.length > 0 ? [normalizedKey, values] : null;
        }
        const normalizedValue = String(value || "").trim();
        return normalizedValue ? [normalizedKey, normalizedValue] : null;
      })
      .filter((entry): entry is [string, string | string[]] =>
        Array.isArray(entry)
      )
  );
}

/**
 * Keeps the recipient file's name on this workspace's conversation, so its
 * later follow-ups and timers greet the contact by it. The WhatsApp contact
 * and chat records are shared by every workspace that talks to the number,
 * so they never get one workspace's label.
 */
async function keepCampaignRecipientName(
  conversationId: unknown,
  recipientName: string
) {
  try {
    await Conversation.updateOne(
      { _id: conversationId },
      { $set: { campaign_recipient_name: recipientName } }
    );
  } catch (error) {
    // The message still belongs in the conversation without the name.
    console.warn("[Campaign Conversation] Could not save recipient name", {
      conversationId: String(conversationId || ""),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function findExistingWhatsappConversation(params: {
  workspaceId: string;
  sourceId?: string | null;
  recipientPhone: string;
}) {
  return findExistingWhatsAppConversationForRecipient({
    workspaceId: params.workspaceId,
    sourceId: params.sourceId,
    recipient: params.recipientPhone,
  });
}

async function findOrCreateWhatsappConversation(params: {
  workspaceId: string;
  sourceId?: string | null;
  recipientPhone: string;
}) {
  const target = parseWhatsAppRecipientTarget(params.recipientPhone);
  const parsedPhone =
    target?.kind === "phone"
      ? target.value
      : normalizeWhatsAppPhone(
          String(params.recipientPhone).replace(/^wa_/i, "")
        ) || normalizeWhatsAppPhone(params.recipientPhone);
  const phone = normalizeWhatsAppConversationPhoneCandidate(parsedPhone);

  if (!phone) {
    return findExistingWhatsappConversation(params);
  }

  const customerId = buildWhatsAppCanonicalIdFromPhone(phone);
  const contact: WhatsAppNormalizedContact = {
    waId: phone,
    profile: {
      name: phone,
    },
    primaryIdType: "wa_id",
  };
  const identitySnapshot = buildWhatsAppIdentitySnapshot(contact);

  const owner = await getOrCreateWhatsAppConversation({
    workspaceId: params.workspaceId,
    sourceId: params.sourceId,
    chatId: customerId,
    candidateIds: [customerId, params.recipientPhone],
    create: async (ownershipKey, identityKeys) => {
      await assertCompanyConversationCapacity(
        supabaseAdmin,
        params.workspaceId
      );
      const [customerUser, chat] = await Promise.all([
        User.findOneAndUpdate(
          { _id: customerId },
          {
            $set: {
              isBot: false,
              workspaceId: params.workspaceId,
              whatsapp: identitySnapshot,
            },
            $setOnInsert: {
              firstName: "Customer",
            },
          },
          { upsert: true, new: true }
        ),
        Chat.findOneAndUpdate(
          { _id: customerId },
          {
            $set: {
              type: "whatsapp",
              workspaceId: params.workspaceId,
              sourceId: params.sourceId || undefined,
              whatsapp: identitySnapshot,
              title: phone,
            },
          },
          { upsert: true, new: true }
        ),
      ]);

      const [botDefaultEnabled, scenariosDefaultEnabled, coachDefaultEnabled] =
        await Promise.all([
          getWorkspaceBotDefault(params.workspaceId),
          getWorkspaceScenariosDefault(params.workspaceId),
          getWorkspaceCoachDefault(params.workspaceId),
        ]);
      return new Conversation({
        whatsappConversationIdentityKey: ownershipKey,
        whatsappConversationIdentityKeys: identityKeys,
        chat: chat._id,
        user: customerUser._id,
        messages: [],
        is_classified: false,
        workspaceId: params.workspaceId,
        sourceId: params.sourceId || undefined,
        channel: "whatsapp",
        status: "open",
        airi_bot_enabled: botDefaultEnabled,
        airi_scenarios_enabled: scenariosDefaultEnabled,
        airi_coach_enabled: coachDefaultEnabled,
      }).save();
    },
  });
  if (!owner)
    throw new Error("WhatsApp campaign conversation owner was not created");
  const conversation = owner.conversation;
  if (!owner.created && conversation.status === "closed") {
    conversation.status = "open";
    await conversation.save();
  }
  return conversation;
}

async function persistScenarioCampaignConversationState(params: {
  conversationId: unknown;
  scenarioId?: string | null;
  nodeId?: string | null;
  templateName: string;
  sentAt: Date;
  messageId: unknown;
}) {
  const scenarioId = String(params.scenarioId || "").trim();
  const nodeId = String(params.nodeId || "").trim();
  if (!scenarioId || !nodeId) return;
  const scenarioObjectId = new Types.ObjectId(scenarioId);
  const scenarioStatePatch = {
    lockedScenarioId: scenarioId,
    lockedScenarioName: "Scenario",
    currentActionNodeId: nodeId,
    currentPathNodeIds: [nodeId],
    currentBranchNodeIds: [],
    pendingConditionNodeId: null,
    pendingSourceActionNodeId: null,
    pendingLegacyRouting: null,
    pendingStartedAt: null,
    pendingLastOutboundMessageId: null,
    pendingLinkedConditionId: null,
    lastMatchedAt: params.sentAt,
    lastMessageId: String(params.messageId || ""),
    // A campaign send starts a new run: forms and shared locations an
    // earlier run collected must not read as this run's.
    formAnswers: null,
    routedLocations: null,
  };
  const bulkCampaignHistoryEntry = {
    scheduleId: scenarioObjectId,
    scenarioId: scenarioObjectId,
    nodeId,
    sentAt: params.sentAt,
    templateName: params.templateName,
  };

  await Conversation.updateOne({ _id: params.conversationId }, [
    {
      $set: {
        airi_scenarios_enabled: true,
        airi_scenario_state: {
          $mergeObjects: [
            {
              $cond: [
                {
                  $eq: [{ $type: "$airi_scenario_state" }, "object"],
                },
                "$airi_scenario_state",
                {},
              ],
            },
            { $literal: scenarioStatePatch },
          ],
        },
        bulk_campaign_history: {
          $setUnion: [
            {
              $cond: [
                { $isArray: "$bulk_campaign_history" },
                "$bulk_campaign_history",
                [],
              ],
            },
            { $literal: [bulkCampaignHistoryEntry] },
          ],
        },
      },
    },
  ]);
}

function summarizeSendComponents(components: unknown[] | null | undefined) {
  if (!Array.isArray(components) || components.length === 0) {
    return "";
  }

  const values = components.flatMap(component => {
    if (!component || typeof component !== "object") return [];
    const parameters = (component as { parameters?: unknown }).parameters;
    if (!Array.isArray(parameters)) return [];
    return parameters.map(parameter => {
      if (!parameter || typeof parameter !== "object") return "";
      const record = parameter as Record<string, unknown>;
      if (record.type === "text") return String(record.text || "");
      if (record.type === "payload") return String(record.payload || "");
      if (typeof record.type === "string") return record.type;
      return "";
    });
  });

  const compactValues = values
    .map(value => value.trim())
    .filter(Boolean)
    .slice(0, 12);
  return compactValues.length > 0
    ? ` with variables: ${JSON.stringify(compactValues)}`
    : "";
}

async function resolveTemplateComponents(params: {
  workspaceId: string;
  templateName: string;
  languageCode?: string | null;
  /** Rethrow read failures instead of treating them as "not stored". */
  throwOnError?: boolean;
}) {
  const tolerate = () => {
    if (params.throwOnError) throw new Error("Template components read failed");
    return null;
  };
  const requestedLanguage = normalizeTemplateLanguageCode(params.languageCode);
  const baseQuery = {
    workspaceId: params.workspaceId,
    name: params.templateName,
    status: "APPROVED",
  };

  const exact = requestedLanguage
    ? await WhatsAppTemplateModel.findOne({
        ...baseQuery,
        language: requestedLanguage,
      })
        .select("components")
        .lean<{ components?: unknown[] } | null>()
        .catch(tolerate)
    : null;
  if (exact?.components) return exact.components;

  const fallback = await WhatsAppTemplateModel.findOne(baseQuery)
    .select("components")
    .lean<{ components?: unknown[] } | null>()
    .catch(tolerate);
  return fallback?.components;
}

/**
 * Template components memoized per batch. Inside the memo a failed read must
 * not be shared with later recipients: it rejects, which drops the entry, and
 * this recipient falls back to the error-tolerant lookup.
 */
function resolveBatchTemplateComponents(
  lookup: {
    workspaceId: string;
    templateName: string;
    languageCode?: string | null;
  },
  cache: Map<string, Promise<unknown[] | undefined>> | undefined
) {
  if (!cache) return resolveTemplateComponents(lookup);
  return memoizeLookup(
    cache,
    [lookup.workspaceId, lookup.templateName, lookup.languageCode || ""].join(
      "\u0000"
    ),
    () => resolveTemplateComponents({ ...lookup, throwOnError: true })
  ).catch(() => resolveTemplateComponents(lookup));
}

async function resolveOutboundAuthor(params: {
  sentByUserId?: string | null;
  phoneNumberId?: string | null;
}) {
  const managerUserId = String(params.sentByUserId || "").trim();
  if (managerUserId) {
    return User.findOneAndUpdate(
      { _id: managerUserId },
      {
        $set: { isBot: false },
        $setOnInsert: { firstName: "Manager" },
      },
      { upsert: true, new: true }
    );
  }

  const phoneNumberId = String(params.phoneNumberId || "unknown").trim();
  return User.findOneAndUpdate(
    { _id: `whatsapp_business_${phoneNumberId || "unknown"}` },
    {
      $set: {
        firstName: "Business Account",
        isBot: false,
      },
    },
    { upsert: true, new: true }
  );
}

export async function persistCampaignEmailConversationMessage(
  params: PersistCampaignEmailConversationMessageParams
): Promise<PersistCampaignEmailConversationMessageResult> {
  const workspaceId = String(params.workspaceId || "").trim();
  const recipientEmail = normalizeCampaignEmail(params.recipientEmail);
  const fromAddress = normalizeCampaignEmail(params.fromAddress);
  const messageId = String(params.messageId || "").trim();
  if (!workspaceId || !recipientEmail || !fromAddress || !messageId) {
    return { persisted: false, reason: "missing_required_fields" };
  }

  await connectDB();

  const sentAt = parseAcceptedAt(params.sentAt);
  const existingMessage = await Message.findOne({
    workspaceId,
    channel: "email",
    "external_ids.messageId": messageId,
  });
  if (existingMessage?.conversation) {
    await appendMessageToConversationById(
      existingMessage.conversation,
      existingMessage._id,
      {
        lastMessageAt: existingMessage.date || sentAt,
        direction:
          existingMessage.direction === "inbound" ? "inbound" : "outbound",
        set: {
          is_read_by_manager: true,
        },
      }
    );
    return {
      persisted: true,
      conversationId: String(existingMessage.conversation),
      messageId,
      created: false,
    };
  }

  const headers = normalizeHeaders(params.headers);
  let conversation;
  try {
    conversation = await findOrCreateEmailConversation({
      workspaceId,
      to: [recipientEmail],
      from: [fromAddress],
      subject: params.subject || null,
      headers,
    });
  } catch (error) {
    if (isCompanyConversationLimitExceeded(error)) {
      console.warn(
        "[Campaign Conversation] New email conversation blocked by limit",
        {
          workspaceId,
          recipientEmail,
          code: COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
        }
      );
      return {
        persisted: false,
        reason: COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
      };
    }
    throw error;
  }

  if (!conversation?._id) {
    return { persisted: false, reason: "conversation_unavailable" };
  }

  if (existingMessage) {
    await appendMessageToConversationById(
      conversation._id,
      existingMessage._id,
      {
        lastMessageAt: existingMessage.date || sentAt,
        direction:
          existingMessage.direction === "inbound" ? "inbound" : "outbound",
        set: {
          is_read_by_manager: true,
          ...(params.sourceId ? { sourceId: params.sourceId } : {}),
        },
      }
    );
    return {
      persisted: true,
      conversationId: String(conversation._id),
      messageId,
      created: false,
    };
  }

  const outbound = await Message.create({
    workspaceId,
    conversation: conversation._id,
    channel: "email",
    direction: "outbound",
    origin: {
      kind: params.originKind || "campaign",
      campaignId: params.campaignId || null,
      scenarioId: params.scenarioId || null,
      nodeId: params.nodeId || null,
      sourceId: params.sourceId || null,
      executionSource: params.executionSource || null,
      sentByUserId: params.sentByUserId || null,
    },
    subject: params.subject || undefined,
    text: params.text || undefined,
    html: params.html || undefined,
    headers,
    external_ids: { messageId },
    date: sentAt,
    delivery: {
      status: "sent",
      sentAt,
      recipientId: recipientEmail,
    },
  });

  await appendMessageToConversationById(conversation._id, outbound._id, {
    lastMessageAt: sentAt,
    direction: "outbound",
    set: {
      is_read_by_manager: true,
      ...(params.sourceId ? { sourceId: params.sourceId } : {}),
    },
  });

  await Promise.allSettled([
    Message.findById(outbound._id)
      .populate({ path: "author", select: "firstName isBot" })
      .then(populated =>
        populated
          ? realtime.trigger(
              `private-conversation-${conversation._id}`,
              "new-message",
              populated
            )
          : null
      ),
    triggerConversationChanged(String(conversation._id)),
  ]);

  return {
    persisted: true,
    conversationId: String(conversation._id),
    messageId,
    created: true,
  };
}

export async function persistCampaignWhatsAppConversationMessage(
  params: PersistCampaignWhatsAppConversationMessageParams
): Promise<PersistCampaignWhatsAppConversationMessageResult> {
  const workspaceId = String(params.workspaceId || "").trim();
  const recipientPhone = String(params.recipientPhone || "").trim();
  const messageId = String(params.messageId || "").trim();
  const isServiceText = params.whatsappMessageType === "service_text";
  const templateName = isServiceText
    ? ""
    : String(params.templateName || "").trim();
  const messageText = isServiceText ? params.messageText : "";
  if (
    !workspaceId ||
    !recipientPhone ||
    !messageId ||
    (isServiceText ? !messageText.trim() : !templateName)
  ) {
    return { persisted: false, reason: "missing_required_fields" };
  }

  await connectDB();

  const recipientName = parseCampaignRecipientName(params.recipientName);
  let conversation;
  try {
    conversation = await findOrCreateWhatsappConversation({
      workspaceId,
      sourceId: params.sourceId,
      recipientPhone,
    });
  } catch (error) {
    if (isCompanyConversationLimitExceeded(error)) {
      console.warn(
        "[Campaign Conversation] New conversation blocked by limit",
        {
          workspaceId,
          sourceId: params.sourceId || null,
          recipientPhone,
          code: COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
        }
      );
      return {
        persisted: false,
        reason: COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE,
      };
    }
    throw error;
  }
  if (!conversation) {
    return { persisted: false, reason: "conversation_unavailable" };
  }

  if (recipientName) {
    await keepCampaignRecipientName(conversation._id, recipientName);
  }

  const recipientEmail = normalizeCampaignEmail(params.recipientEmail);
  if (recipientEmail) {
    await Conversation.updateOne(
      { _id: conversation._id },
      { $addToSet: { "participants.to": recipientEmail } }
    );
  }

  const normalizedMessageId = normalizeWhatsAppMessageId(messageId);
  const existingMessage = await Message.findOne({
    channel: "whatsapp",
    $or: [{ messageId }, { messageId: normalizedMessageId }],
  });
  if (existingMessage) {
    await appendMessageToConversationById(
      conversation._id,
      existingMessage._id,
      {
        lastMessageAt: existingMessage.date || new Date(),
        direction:
          existingMessage.direction === "inbound" ? "inbound" : "outbound",
      }
    );
    if (!isServiceText) {
      await persistScenarioCampaignConversationState({
        conversationId: conversation._id,
        scenarioId: params.scenarioId,
        nodeId: params.nodeId,
        templateName,
        sentAt:
          existingMessage.date instanceof Date
            ? existingMessage.date
            : parseAcceptedAt(params.sentAt),
        messageId: existingMessage._id,
      });
    }
    return {
      persisted: true,
      conversationId: String(conversation._id),
      messageId,
      created: false,
    };
  }

  const authorKey = String(params.sentByUserId || "").trim()
    ? `manager:${String(params.sentByUserId).trim()}`
    : `business:${String(params.phoneNumberId || "unknown").trim()}`;
  const author = await memoizeLookup(
    params.lookupCache?.authors,
    authorKey,
    () =>
      resolveOutboundAuthor({
        sentByUserId: params.sentByUserId,
        phoneNumberId: params.phoneNumberId,
      })
  );
  const templateComponents = isServiceText
    ? []
    : await resolveBatchTemplateComponents(
        { workspaceId, templateName, languageCode: params.languageCode },
        params.lookupCache?.templateComponents
      );
  const sentAt = parseAcceptedAt(params.sentAt);
  const templateOrigin = isServiceText
    ? {}
    : {
        templateName,
        templateCategory: params.templateCategory || null,
      };
  const outbound = new Message({
    messageId,
    chat: conversation.chat,
    author: author._id,
    text: isServiceText
      ? messageText
      : `[Template: ${templateName}]${summarizeSendComponents(
          params.components
        )}`,
    date: sentAt,
    workspaceId,
    conversation: conversation._id,
    channel: "whatsapp",
    direction: "outbound",
    origin: {
      kind: params.originKind || "campaign",
      campaignId: params.campaignId || null,
      scenarioId: params.scenarioId || null,
      nodeId: params.nodeId || null,
      ...templateOrigin,
      sourceId: params.sourceId || null,
      executionSource: params.executionSource || null,
      sentByUserId: params.sentByUserId || null,
    },
    ...(isServiceText
      ? {}
      : {
          whatsappTemplate: buildStoredWhatsAppTemplatePreview({
            name: templateName,
            languageCode: params.languageCode,
            components: templateComponents,
          }),
        }),
  });

  await outbound.save();
  await appendMessageToConversationById(conversation._id, outbound._id, {
    lastMessageAt: sentAt,
    direction: "outbound",
  });
  if (!isServiceText) {
    await persistScenarioCampaignConversationState({
      conversationId: conversation._id,
      scenarioId: params.scenarioId,
      nodeId: params.nodeId,
      templateName,
      sentAt,
      messageId: outbound._id,
    });
  }

  const realtimeFanout = Promise.allSettled([
    Message.findById(outbound._id)
      .populate({ path: "author", select: "firstName isBot" })
      .then(populated =>
        populated
          ? realtime.trigger(
              `private-conversation-${conversation._id}`,
              "new-message",
              populated
            )
          : null
      ),
    triggerConversationChanged(String(conversation._id)),
  ]);
  if (params.awaitRealtime !== false) await realtimeFanout;

  return {
    persisted: true,
    conversationId: String(conversation._id),
    messageId,
    created: true,
  };
}
