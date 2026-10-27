/**
 * Handles Meta's `type: "system"` inbound webhook messages — specifically
 * `system.type = "user_changed_number"`, which Meta sends when a customer
 * moves their WhatsApp account to a new phone number.
 *
 * Without handling this we silently create a brand-new chat keyed on the new
 * `wa_${phone}` and drop the entire thread history, customer tags, and
 * assignee — from the support agent's perspective the conversation "resets".
 *
 * What we do:
 *   1. Parse old + new wa_id from the webhook (fields: `system.wa_id`,
 *      `system.new_wa_id`, `system.customer`, plus a defensive regex fallback
 *      against `system.body = "User A changed from +X to +Y"`).
 *   2. Find every Chat/User doc in this workspace that still references the
 *      old wa_id (via `whatsapp.waId`).
 *   3. Re-pin `whatsapp.waId` to the new value and push the old value onto
 *      `whatsapp.previousWaIds` for audit + future lookups.
 *   4. Publish a workspace alert so agents see the rename in real time.
 *
 * We deliberately do NOT mutate `Chat._id` or `User._id` — those are used as
 * foreign keys by Conversation and Message, and migrating them in place is
 * risky. The identity resolver already prefers `whatsapp.waId` over the
 * legacy `wa_${phone}` id for new lookups, so future inbound traffic from the
 * new number will attach to the same conversation.
 *
 * Docs:
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/reference/messages#system-messages
 */

import * as Cache from "@/lib/cache";
import * as ConversationMessages from "@/lib/conversation-messages";
import * as MongoErrors from "@/lib/mongo-errors";
import * as WorkspaceAlerts from "@/lib/notifications/workspace-alerts";
import * as ServerLogs from "@/lib/observability/server-logs";
import * as RawSourcePayload from "@icecore/shared/lib/raw-source-payload";
import * as ChatModule from "@/models/chat";
import * as ConversationModel from "@/models/conversation";
import * as MessageModule from "@/models/message";
import * as UserModule from "@/models/user";
import { readDefaultExport } from "@icecore/airi-runtime/module-interop";
import connectDB from "@icecore/airi-runtime/mongoose";
import mongoose from "mongoose";
import {
  parseUserChangedNumber,
  parseUserChangedUserId,
  type WhatsAppSystemMessage,
} from "./whatsapp-identity-change-parser.js";
import { persistIdentityChangeMessageAndLink } from "./whatsapp-identity-change-message-link.js";
import { findWhatsAppNumberChangeAffectedRecords } from "./whatsapp-identity-change-recovery.js";
import { workerRealtime } from "./worker-realtime.js";

// Web models compile as CommonJS; under the ESM worker a default import is the
// module wrapper, so unwrap each one to its Mongoose model.
const Chat = readDefaultExport<typeof ChatModule.default>(ChatModule);
const Message = readDefaultExport<typeof MessageModule.default>(MessageModule);
const User = readDefaultExport<typeof UserModule.default>(UserModule);

function getModuleExport<T>(moduleNamespace: unknown, key: string): T {
  const module = moduleNamespace as Record<string, unknown> & {
    default?: Record<string, unknown>;
  };
  const value = module[key] ?? module.default?.[key];
  if (value === undefined) {
    throw new Error(`Module export not found: ${key}`);
  }
  return value as T;
}

const invalidateRequestsForWorkspace = getModuleExport<
  typeof Cache.invalidateRequestsForWorkspace
>(Cache, "invalidateRequestsForWorkspace");
const appendMessageToConversationById = getModuleExport<
  typeof ConversationMessages.appendMessageToConversationById
>(ConversationMessages, "appendMessageToConversationById");
const isMongoDuplicateKeyError = getModuleExport<
  typeof MongoErrors.isMongoDuplicateKeyError
>(MongoErrors, "isMongoDuplicateKeyError");
const publishWorkspaceAlert = getModuleExport<
  typeof WorkspaceAlerts.publishWorkspaceAlert
>(WorkspaceAlerts, "publishWorkspaceAlert");
const createServerLogger = getModuleExport<
  typeof ServerLogs.createServerLogger
>(ServerLogs, "createServerLogger");
const buildRawSourcePayload = getModuleExport<
  typeof RawSourcePayload.buildRawSourcePayload
>(RawSourcePayload, "buildRawSourcePayload");

const logger = createServerLogger("whatsapp.identity-change");

type ConversationModelLike = {
  find: (...args: any[]) => any;
};

function resolveConversationModel(): ConversationModelLike {
  const module = ConversationModel as unknown as {
    Conversation?: ConversationModelLike;
    default?: { Conversation?: ConversationModelLike };
  };
  const model = module.Conversation ?? module.default?.Conversation;
  if (!model) {
    throw new Error("Conversation model export not found");
  }
  return model;
}

const Conversation = resolveConversationModel();

/**
 * Inserts a synthetic inbound `Message` (origin.kind = system) on every
 * conversation tied to a migrated chat so the thread shows *when* Meta
 * re-pinned the customer — not just the header badge.
 */
async function insertWhatsappNumberChangeThreadMessages(input: {
  workspaceId: string;
  sourceId: string | null;
  platformMessageId: string;
  eventAt: Date;
  oldWaId: string;
  newWaId: string;
  chatIds: string[];
  rawMessage?: Record<string, unknown> | null;
}): Promise<void> {
  if (input.chatIds.length === 0) return;
  if (!input.platformMessageId?.trim()) return;

  const workspaceId = input.workspaceId.trim();
  if (!workspaceId) return;

  const chatObjectIds: mongoose.Types.ObjectId[] = [];
  for (const id of input.chatIds) {
    if (mongoose.Types.ObjectId.isValid(id)) {
      chatObjectIds.push(new mongoose.Types.ObjectId(id));
    }
  }
  if (chatObjectIds.length === 0) return;

  const conversations = (await Conversation.find({
    workspaceId,
    channel: "whatsapp",
    chat: { $in: chatObjectIds },
  })
    .select({ _id: 1, chat: 1 })
    .lean()
    .exec()) as Array<{
    _id: mongoose.Types.ObjectId;
    chat?: unknown;
  }>;

  if (conversations.length === 0) return;

  const bodyText = `Customer changed WhatsApp number from +${input.oldWaId} to +${input.newWaId}.`;
  const { triggerConversationRealtime } = await import(
    "@/lib/realtime-updates"
  );

  for (const conv of conversations) {
    const convId = String(conv._id);
    if (conv.chat == null) continue;

    const localMessageId =
      `ws_numchg_${convId}_${input.platformMessageId}`.slice(0, 256);

    const identityFilter = {
      messageId: localMessageId,
      conversation: conv._id,
      workspaceId,
      channel: "whatsapp",
      direction: "inbound",
    };
    const messageDocument = {
      ...identityFilter,
      chat: conv.chat,
      author: null,
      ...(input.rawMessage
        ? {
            rawSourcePayload: buildRawSourcePayload({
              provider: "whatsapp",
              eventType: "system",
              capturedAt: input.eventAt,
              payload: input.rawMessage,
            }),
          }
        : {}),
      text: bodyText,
      date: input.eventAt,
      origin: {
        kind: "system" as const,
        sourceId: input.sourceId || null,
      },
    };

    let persisted;
    try {
      persisted = await persistIdentityChangeMessageAndLink(
        {
          messageModel: Message,
          identityFilter,
          messageDocument,
          conversationId: conv._id,
          eventAt: input.eventAt,
        },
        { appendMessage: appendMessageToConversationById },
      );
    } catch (error) {
      if (!isMongoDuplicateKeyError(error)) {
        logger.error(
          "user_changed_number: thread message persistence failed",
          error,
          {
            workspaceId,
            conversationId: convId,
            localMessageId,
          },
        );
      }
      throw error;
    }
    const { record: messageDoc, linkResult } = persisted;
    const createdId = messageDoc._id as mongoose.Types.ObjectId;

    if (!linkResult.appended) continue;

    try {
      await triggerConversationRealtime(convId, false);
    } catch (error) {
      logger.warn("user_changed_number: triggerConversationRealtime failed", {
        conversationId: convId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const populated = await Message.findById(createdId)
        .populate({ path: "author", model: User, select: "firstName isBot" })
        .lean()
        .exec();
      if (populated) {
        await workerRealtime.trigger(
          `private-conversation-${convId}`,
          "new-message",
          populated,
        );
      }
    } catch (error) {
      logger.warn("user_changed_number: realtime new-message failed", {
        conversationId: convId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    await invalidateRequestsForWorkspace(workspaceId);
  } catch {
    // Non-blocking
  }
}

export async function handleUserChangedNumber(params: {
  workspaceId: string;
  sourceId?: string | null;
  phoneNumberId?: string | null;
  messageFrom?: string | null;
  system: WhatsAppSystemMessage | null | undefined;
  rawMessage?: Record<string, unknown> | null;
  /** Webhook `messages[0].id` — for idempotent per-conversation thread rows */
  platformMessageId?: string | null;
  eventAt?: Date | null;
}): Promise<{
  migrated: boolean;
  chatIds: string[];
  userIds: string[];
  oldWaId: string | null;
  newWaId: string | null;
}> {
  await connectDB();

  const parsed = parseUserChangedNumber({
    messageFrom: params.messageFrom,
    system: params.system,
  });

  if (!parsed) {
    logger.warn("user_changed_number: could not parse old/new wa_id", {
      workspaceId: params.workspaceId,
      sourceId: params.sourceId || null,
      phoneNumberId: params.phoneNumberId || null,
      messageFrom: params.messageFrom || null,
      systemType: params.system?.type || null,
      systemBody: params.system?.body || null,
      rawMessage: params.rawMessage || null,
    });
    return {
      migrated: false,
      chatIds: [],
      userIds: [],
      oldWaId: null,
      newWaId: null,
    };
  }

  const { oldWaId, newWaId } = parsed;

  // Find both records still pinned to the old wa_id and the exact idempotent
  // retry state (new wa_id plus the old value in previousWaIds). Scope to this
  // workspace so we never touch another tenant's records.
  let affectedChatIds: string[] = [];
  let affectedUserIds: string[] = [];

  try {
    const affected = await findWhatsAppNumberChangeAffectedRecords({
      chatModel: Chat,
      userModel: User,
      workspaceId: params.workspaceId,
      oldWaId,
      newWaId,
    });
    affectedChatIds = affected.chatIds;
    affectedUserIds = affected.userIds;
  } catch (error) {
    logger.error("user_changed_number: identity lookup failed", error, {
      workspaceId: params.workspaceId,
      oldWaId,
      newWaId,
    });
    return {
      migrated: false,
      chatIds: [],
      userIds: [],
      oldWaId,
      newWaId,
    };
  }

  if (affectedChatIds.length === 0 && affectedUserIds.length === 0) {
    // No prior record of this contact — nothing to migrate. Meta will have
    // sent the corresponding regular inbound message separately; the normal
    // message-processor path will create a fresh Chat/User under the new id.
    logger.info("user_changed_number: no existing chat/user to migrate", {
      workspaceId: params.workspaceId,
      oldWaId,
      newWaId,
    });
    return {
      migrated: false,
      chatIds: [],
      userIds: [],
      oldWaId,
      newWaId,
    };
  }

  // Apply the re-pin. `$addToSet` keeps `previousWaIds` de-duplicated if Meta
  // re-sends the same system message.
  const update = {
    $set: { "whatsapp.waId": newWaId },
    $addToSet: { "whatsapp.previousWaIds": oldWaId },
  };

  try {
    await Chat.updateMany(
      { workspaceId: params.workspaceId, "whatsapp.waId": oldWaId },
      update,
    );
    await User.updateMany(
      { workspaceId: params.workspaceId, "whatsapp.waId": oldWaId },
      update,
    );
  } catch (error) {
    logger.error("user_changed_number: migration write failed", error, {
      workspaceId: params.workspaceId,
      oldWaId,
      newWaId,
    });
    return {
      migrated: false,
      chatIds: affectedChatIds,
      userIds: affectedUserIds,
      oldWaId,
      newWaId,
    };
  }

  logger.info("user_changed_number: identity migrated", {
    workspaceId: params.workspaceId,
    sourceId: params.sourceId || null,
    phoneNumberId: params.phoneNumberId || null,
    oldWaId,
    newWaId,
    affectedChatCount: affectedChatIds.length,
    affectedUserCount: affectedUserIds.length,
  });

  await publishWorkspaceAlert({
    workspaceId: params.workspaceId,
    type: "info",
    title: "WhatsApp customer changed number",
    message: `A customer moved their WhatsApp from +${oldWaId} to +${newWaId}. Existing conversation history stays attached.`,
    dedupeKey: `whatsapp:identity_change:${oldWaId}:${newWaId}`,
    metadata: {
      oldWaId,
      newWaId,
      chatIds: affectedChatIds,
      userIds: affectedUserIds,
      sourceId: params.sourceId || null,
    },
  });

  if (
    affectedChatIds.length > 0 &&
    params.platformMessageId?.trim() &&
    params.eventAt
  ) {
    await insertWhatsappNumberChangeThreadMessages({
      workspaceId: params.workspaceId,
      sourceId: params.sourceId ?? null,
      platformMessageId: params.platformMessageId.trim(),
      eventAt: params.eventAt,
      oldWaId,
      newWaId,
      chatIds: affectedChatIds,
      rawMessage: params.rawMessage || null,
    });
  }

  return {
    migrated: true,
    chatIds: affectedChatIds,
    userIds: affectedUserIds,
    oldWaId,
    newWaId,
  };
}

export async function handleUserChangedUserId(params: {
  workspaceId: string;
  sourceId?: string | null;
  phoneNumberId?: string | null;
  messageFrom?: string | null;
  system: WhatsAppSystemMessage | null | undefined;
  rawMessage?: Record<string, unknown> | null;
}): Promise<{
  migrated: boolean;
  chatIds: string[];
  userIds: string[];
  oldUserId: string | null;
  newUserId: string | null;
}> {
  await connectDB();

  const parsed = parseUserChangedUserId({
    messageFrom: params.messageFrom,
    system: params.system,
  });

  if (!parsed) {
    logger.warn("user_changed_user_id: could not parse old/new user_id", {
      workspaceId: params.workspaceId,
      sourceId: params.sourceId || null,
      phoneNumberId: params.phoneNumberId || null,
      messageFrom: params.messageFrom || null,
      systemType: params.system?.type || null,
      systemBody: params.system?.body || null,
      rawMessage: params.rawMessage || null,
    });
    return {
      migrated: false,
      chatIds: [],
      userIds: [],
      oldUserId: null,
      newUserId: null,
    };
  }

  const { oldUserId, newUserId } = parsed;
  let affectedChatIds: string[] = [];
  let affectedUserIds: string[] = [];

  try {
    const chats = (await Chat.find({
      workspaceId: params.workspaceId,
      "whatsapp.userId": oldUserId,
    })
      .select({ _id: 1 })
      .lean()) as Array<{ _id: unknown }>;
    affectedChatIds = chats.map((chat) => String(chat._id));

    const users = (await User.find({
      workspaceId: params.workspaceId,
      "whatsapp.userId": oldUserId,
    })
      .select({ _id: 1 })
      .lean()) as Array<{ _id: unknown }>;
    affectedUserIds = users.map((user) => String(user._id));
  } catch (error) {
    logger.error("user_changed_user_id: identity lookup failed", error, {
      workspaceId: params.workspaceId,
      oldUserId,
      newUserId,
    });
    return {
      migrated: false,
      chatIds: [],
      userIds: [],
      oldUserId,
      newUserId,
    };
  }

  if (affectedChatIds.length === 0 && affectedUserIds.length === 0) {
    logger.info("user_changed_user_id: no existing chat/user to migrate", {
      workspaceId: params.workspaceId,
      oldUserId,
      newUserId,
    });
    return {
      migrated: false,
      chatIds: [],
      userIds: [],
      oldUserId,
      newUserId,
    };
  }

  const update = {
    $set: { "whatsapp.userId": newUserId },
    $addToSet: { "whatsapp.previousUserIds": oldUserId },
  };

  try {
    await Chat.updateMany(
      { workspaceId: params.workspaceId, "whatsapp.userId": oldUserId },
      update,
    );
    await User.updateMany(
      { workspaceId: params.workspaceId, "whatsapp.userId": oldUserId },
      update,
    );
  } catch (error) {
    logger.error("user_changed_user_id: migration write failed", error, {
      workspaceId: params.workspaceId,
      oldUserId,
      newUserId,
    });
    return {
      migrated: false,
      chatIds: affectedChatIds,
      userIds: affectedUserIds,
      oldUserId,
      newUserId,
    };
  }

  logger.info("user_changed_user_id: identity migrated", {
    workspaceId: params.workspaceId,
    sourceId: params.sourceId || null,
    phoneNumberId: params.phoneNumberId || null,
    oldUserId,
    newUserId,
    affectedChatCount: affectedChatIds.length,
    affectedUserCount: affectedUserIds.length,
  });

  await publishWorkspaceAlert({
    workspaceId: params.workspaceId,
    type: "info",
    title: "WhatsApp customer ID changed",
    message:
      "A customer's WhatsApp business-scoped user ID changed. Existing conversation history stays attached.",
    dedupeKey: `whatsapp:user_id_change:${oldUserId}:${newUserId}`,
    metadata: {
      oldUserId,
      newUserId,
      chatIds: affectedChatIds,
      userIds: affectedUserIds,
      sourceId: params.sourceId || null,
    },
  });

  try {
    await invalidateRequestsForWorkspace(params.workspaceId);
  } catch {
    // Non-blocking
  }

  return {
    migrated: true,
    chatIds: affectedChatIds,
    userIds: affectedUserIds,
    oldUserId,
    newUserId,
  };
}
