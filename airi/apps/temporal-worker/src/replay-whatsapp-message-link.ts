import * as MongoErrors from "@/lib/mongo-errors";
import { readRuntimeExport } from "@icecore/airi-runtime/module-interop";
import { persistOrRecoverAndLink } from "@icecore/shared/lib/persist-recover-link";
import { buildWhatsAppInboundDedupeKey } from "@icecore/shared/lib/whatsapp/message-id";
import type { Types } from "mongoose";

const isMongoDuplicateKeyError = readRuntimeExport<
  typeof MongoErrors.isMongoDuplicateKeyError
>(MongoErrors, "isMongoDuplicateKeyError");

type MongoId = string | Types.ObjectId;

type ReplayMessageRecord = {
  _id: MongoId;
  conversation?: MongoId;
  date?: Date | string | null;
  direction?: unknown;
  workspaceId?: unknown;
  sourceId?: unknown;
  whatsappGroup?: unknown;
};

type ReplayMessageModel = {
  findOne: (filter: Record<string, unknown>) => {
    select: (fields: string) => {
      lean: () => Promise<ReplayMessageRecord | null>;
    };
  };
  collection: {
    insertOne: (document: Record<string, unknown>) => Promise<unknown>;
  };
};

type ReplayAppendResult = { appended: boolean } & Record<string, unknown>;

type ReplayLinkParams = {
  messageModel: unknown;
  normalizedMessageId: string;
  providerMessageId: string;
  fallbackDate: Date;
  fallbackWorkspaceId: string;
  fallbackSourceId: string;
  fallbackWhatsappGroup?: unknown;
};

type ReplayLinkDependencies = {
  appendMessage: (
    conversationId: MongoId,
    messageId: MongoId,
    options: {
      lastMessageAt: Date;
      direction: "inbound" | "outbound";
      historicalUpdatedAt: Date;
      set: Record<string, unknown>;
    },
  ) => Promise<ReplayAppendResult>;
};

function findReplayMessage(
  params: ReplayLinkParams,
): Promise<ReplayMessageRecord | null> {
  const messageModel = params.messageModel as ReplayMessageModel;
  return messageModel
    .findOne({
      workspaceId: params.fallbackWorkspaceId,
      channel: "whatsapp",
      $or: [
        { messageId: params.normalizedMessageId },
        { messageId: params.providerMessageId },
      ],
    })
    .select(
      "_id conversation date direction workspaceId sourceId whatsappGroup",
    )
    .lean();
}

function linkReplayMessage(
  message: ReplayMessageRecord,
  params: ReplayLinkParams,
  dependencies: ReplayLinkDependencies,
): Promise<ReplayAppendResult> {
  const direction =
    message.direction === "inbound" || message.direction === "outbound"
      ? message.direction
      : null;
  if (!message.conversation || !direction) {
    throw new Error(
      `Persisted WhatsApp message ${String(message._id)} is missing canonical link metadata.`,
    );
  }

  const eventAt = new Date(message.date || params.fallbackDate);
  if (Number.isNaN(eventAt.getTime())) {
    throw new Error(
      `Persisted WhatsApp message ${String(message._id)} has an invalid date.`,
    );
  }

  const workspaceId = String(message.workspaceId || params.fallbackWorkspaceId);
  const sourceId = String(message.sourceId || params.fallbackSourceId);

  return dependencies.appendMessage(message.conversation, message._id, {
    lastMessageAt: eventAt,
    direction,
    historicalUpdatedAt: eventAt,
    set: {
      workspaceId,
      sourceId,
      ...(message.whatsappGroup
        ? { whatsappGroup: message.whatsappGroup }
        : params.fallbackWhatsappGroup
          ? { whatsappGroup: params.fallbackWhatsappGroup }
          : {}),
    },
  });
}

export async function recoverReplayWhatsAppMessageLinkIfExisting(
  params: ReplayLinkParams,
  dependencies: ReplayLinkDependencies,
) {
  const record = await findReplayMessage(params);
  if (!record) return null;

  const linkResult = await linkReplayMessage(record, params, dependencies);
  return { record, linkResult };
}

export async function persistReplayWhatsAppMessageAndLink(
  params: ReplayLinkParams & {
    messageDocument: Record<string, unknown> & { _id: MongoId };
    /** The caller already performed the cheap pre-context lookup. */
    existingMessageKnownMissing?: boolean;
  },
  dependencies: ReplayLinkDependencies,
) {
  const messageModel = params.messageModel as ReplayMessageModel;
  let skipInitialLookup = params.existingMessageKnownMissing === true;

  return persistOrRecoverAndLink({
    findExisting: () => {
      if (skipInitialLookup) {
        skipInitialLookup = false;
        return Promise.resolve(null);
      }
      return findReplayMessage(params);
    },
    persist: async () => {
      // Raw history replay skips Mongoose lifecycle hooks, so enroll dedupe and
      // durable engagement recovery in the same insert as the replayed message.
      const messageDocument = { ...params.messageDocument };
      const dedupeKey = buildWhatsAppInboundDedupeKey({
        channel: messageDocument.channel,
        direction: messageDocument.direction,
        workspaceId: messageDocument.workspaceId,
        messageId: messageDocument.messageId,
      });
      if (dedupeKey) messageDocument.whatsappInboundDedupeKey = dedupeKey;
      else delete messageDocument.whatsappInboundDedupeKey;
      if (
        messageDocument.conversation &&
        (messageDocument.direction === "inbound" ||
          messageDocument.direction === "outbound")
      ) {
        messageDocument.engagementRefreshPending = true;
      }
      await messageModel.collection.insertOne(messageDocument);
      return messageDocument as ReplayMessageRecord;
    },
    isDuplicateError: isMongoDuplicateKeyError,
    link: (message) => linkReplayMessage(message, params, dependencies),
  });
}
