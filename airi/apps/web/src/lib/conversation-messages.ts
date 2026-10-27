import {
  buildClassificationInputPendingTransitionPipeline,
  type ClassificationWakeScheduler,
} from "@/lib/classifier/classification-contract";
import { scheduleConversationClassificationWakeBestEffort } from "@/lib/classifier/classification-pubsub";
import {
  buildConversationMessageTimestampSet,
  type ConversationMessageDirection,
} from "@/lib/conversation-message-denorm";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import { realtime } from "@/lib/realtime/server";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import User from "@/models/user";
import type {
  MessageDocument,
  PopulatedMessage,
  UserDocument,
} from "@/types/models";
import mongoose from "mongoose";
import { after } from "next/server";

export type AppendConversationMessageOptions = {
  lastMessageAt?: Date | null;
  direction: ConversationMessageDirection;
  set?: Record<string, unknown>;
  /** Preserve source chronology during the explicit historical replay tool. */
  historicalUpdatedAt?: Date;
  /** Imported history is not a new customer action and must preserve read state. */
  importMode?: "history";
};

export type AppendConversationMessageResult = {
  appended: boolean;
  classificationRevision: number;
  requestedRevision: number | null;
  generation: number;
  status: string | null;
  requestedAt: Date | null;
};

export type AppendConversationMessageDependencies = {
  conversationModel: typeof Conversation;
  now: () => Date;
  scheduleWake: ClassificationWakeScheduler;
};

const APPEND_RESERVED_SET_PATHS = [
  "messages",
  "message_count",
  "lastMessageAt",
  "last_inbound_at",
  "last_outbound_at",
  "first_inbound_at",
  "first_response_at",
  "first_response_seconds",
  "first_response_manager_id",
  "first_response_manager_name",
  "updatedAt",
  "classification_revision",
  "classification_state",
  "classification",
  "classification_meta",
  "classification_error",
  "is_classified",
  "is_qa_analyzed",
] as const;

const APPEND_TEMPORARY_MESSAGES_PATH = "__append_next_messages";
const APPEND_RESULT_PROJECTION = {
  _id: 1,
  classification_revision: 1,
  "classification_state.status": 1,
  "classification_state.requestedRevision": 1,
  "classification_state.generation": 1,
  "classification_state.requestedAt": 1,
} as const;

type AppendConversationProjection = {
  _id: mongoose.Types.ObjectId;
  classification_revision?: number;
  classification_state?: {
    status?: string;
    requestedRevision?: number;
    generation?: number;
    requestedAt?: Date | null;
  } | null;
};

function dependencies(
  overrides: Partial<AppendConversationMessageDependencies> = {}
): AppendConversationMessageDependencies {
  return {
    conversationModel: overrides.conversationModel ?? Conversation,
    now: overrides.now ?? (() => new Date()),
    scheduleWake:
      overrides.scheduleWake ??
      scheduleConversationClassificationWakeBestEffort,
  };
}

function toObjectId(
  value: mongoose.Types.ObjectId | string,
  fieldName: string
): mongoose.Types.ObjectId {
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new TypeError(`${fieldName} must be a valid ObjectId`);
  }
  return new mongoose.Types.ObjectId(value);
}

function assertSafeAppendSet(set: Record<string, unknown> | undefined): void {
  if (!set) return;

  for (const path of Object.keys(set)) {
    const invalid =
      !path ||
      path.startsWith("$") ||
      path.startsWith("__") ||
      path.startsWith(".") ||
      path.endsWith(".") ||
      path.includes("..");
    const reserved = APPEND_RESERVED_SET_PATHS.some(
      reservedPath =>
        path === reservedPath || path.startsWith(`${reservedPath}.`)
    );
    if (invalid || reserved) {
      throw new TypeError(`Append set path is reserved or invalid: ${path}`);
    }
  }
}

function assertAppendOptions(options: AppendConversationMessageOptions): void {
  if (options.direction !== "inbound" && options.direction !== "outbound") {
    throw new TypeError("Conversation message direction is required");
  }
  if (
    options.historicalUpdatedAt &&
    !Number.isFinite(options.historicalUpdatedAt.getTime())
  ) {
    throw new TypeError("historicalUpdatedAt must be a valid Date");
  }
  assertSafeAppendSet(options.set);
}

function historicalUpdatedAtExpression(value: Date): Record<string, unknown> {
  return {
    $let: {
      vars: {
        currentMessages: {
          $cond: [{ $isArray: "$messages" }, "$messages", []],
        },
      },
      in: {
        $cond: [
          { $eq: [{ $size: "$$currentMessages" }, 0] },
          value,
          {
            $cond: [
              {
                $or: [
                  { $ne: [{ $type: "$updatedAt" }, "date"] },
                  { $gt: [value, "$updatedAt"] },
                ],
              },
              value,
              "$updatedAt",
            ],
          },
        ],
      },
    },
  };
}

function buildAppendMetadataSet(
  options: AppendConversationMessageOptions,
  includeMessages: boolean
): Record<string, unknown> {
  const set: Record<string, unknown> = { ...(options.set ?? {}) };

  if (options.lastMessageAt) {
    Object.assign(
      set,
      buildConversationMessageTimestampSet(
        options.lastMessageAt,
        options.direction
      )
    );
  }
  // A retry of an already linked message must preserve a manager's later read.
  if (
    includeMessages &&
    options.direction === "inbound" &&
    options.importMode !== "history"
  ) {
    set.is_read_by_manager = false;
  }
  if (options.historicalUpdatedAt) {
    set.updatedAt = historicalUpdatedAtExpression(options.historicalUpdatedAt);
  }
  if (includeMessages) {
    set.messages = `$${APPEND_TEMPORARY_MESSAGES_PATH}`;
  }
  set.message_count = {
    $size: includeMessages
      ? `$${APPEND_TEMPORARY_MESSAGES_PATH}`
      : { $ifNull: ["$messages", []] },
  };
  return set;
}

function buildUniqueAppendPipeline(
  messageId: mongoose.Types.ObjectId,
  options: AppendConversationMessageOptions,
  now: Date
): mongoose.PipelineStage[] {
  return [
    {
      $set: {
        [APPEND_TEMPORARY_MESSAGES_PATH]: {
          $let: {
            vars: { currentMessages: { $ifNull: ["$messages", []] } },
            in: {
              $cond: [
                { $in: [messageId, "$$currentMessages"] },
                "$$currentMessages",
                { $concatArrays: ["$$currentMessages", [messageId]] },
              ],
            },
          },
        },
      },
    },
    { $set: buildAppendMetadataSet(options, true) },
    { $unset: APPEND_TEMPORARY_MESSAGES_PATH },
    ...buildClassificationInputPendingTransitionPipeline({
      now,
      hasInboundInput: options.direction === "inbound" ? true : undefined,
    }),
  ];
}

function buildDuplicateMetadataPipeline(
  options: AppendConversationMessageOptions
): mongoose.PipelineStage[] {
  return [{ $set: buildAppendMetadataSet(options, false) }];
}

function linkedMessageIdentityExpression(messageIdHex: string) {
  return {
    $in: [
      messageIdHex,
      {
        $map: {
          input: {
            $cond: [{ $isArray: "$messages" }, "$messages", []],
          },
          as: "linkedMessageId",
          in: {
            $convert: {
              input: "$$linkedMessageId",
              to: "string",
              onError: "",
              onNull: "",
            },
          },
        },
      },
    ],
  };
}

function buildAppendResult(
  conversation: AppendConversationProjection,
  appended: boolean
): AppendConversationMessageResult {
  const state = conversation.classification_state;
  return {
    appended,
    classificationRevision: Number.isSafeInteger(
      conversation.classification_revision
    )
      ? (conversation.classification_revision as number)
      : 0,
    requestedRevision: Number.isSafeInteger(state?.requestedRevision)
      ? (state?.requestedRevision as number)
      : null,
    generation: Number.isSafeInteger(state?.generation)
      ? (state?.generation as number)
      : 0,
    status: typeof state?.status === "string" ? state.status : null,
    requestedAt: state?.requestedAt instanceof Date ? state.requestedAt : null,
  };
}

export async function appendMessageToConversationById(
  conversationIdInput: mongoose.Types.ObjectId | string,
  messageIdInput: mongoose.Types.ObjectId | string,
  options: AppendConversationMessageOptions,
  overrides: Partial<AppendConversationMessageDependencies> = {}
): Promise<AppendConversationMessageResult> {
  assertAppendOptions(options);
  const deps = dependencies(overrides);
  const conversationId = toObjectId(conversationIdInput, "conversationId");
  const messageId = toObjectId(messageIdInput, "messageId");
  const linkedMessageIdentity = linkedMessageIdentityExpression(
    messageId.toHexString()
  );
  const now = deps.now();
  const queryOptions = {
    new: true,
    projection: APPEND_RESULT_PROJECTION,
    ...(options.historicalUpdatedAt ? { timestamps: false } : {}),
  };

  const appendedConversation = (await deps.conversationModel
    .findOneAndUpdate(
      { _id: conversationId, $expr: { $not: [linkedMessageIdentity] } },
      buildUniqueAppendPipeline(messageId, options, now),
      queryOptions
    )
    .lean()
    .exec()) as AppendConversationProjection | null;

  if (appendedConversation) {
    const result = buildAppendResult(appendedConversation, true);
    if (
      result.status !== "not_applicable" &&
      result.requestedRevision !== null &&
      result.requestedAt
    ) {
      try {
        await deps.scheduleWake({
          conversationId: String(appendedConversation._id),
          requestedRevision: result.requestedRevision,
          generation: result.generation,
          requestedAt: result.requestedAt,
        });
      } catch {
        // Pending Mongo state is the durable outbox; reconciliation republishes.
      }
    }
    return result;
  }

  const duplicateConversation = (await deps.conversationModel
    .findOneAndUpdate(
      { _id: conversationId, $expr: linkedMessageIdentity },
      buildDuplicateMetadataPipeline(options),
      queryOptions
    )
    .lean()
    .exec()) as AppendConversationProjection | null;
  if (!duplicateConversation) {
    throw new Error("Conversation was not found for message append");
  }
  return buildAppendResult(duplicateConversation, false);
}

export type ManagerAuthor = {
  id: string;
  /** Used when namePromise is absent, rejects or resolves empty. */
  name: string;
  namePromise?: Promise<string>;
};

/** Upserts the Mongo author record that a manager's sent messages point at. */
export async function upsertManagerAuthor(
  manager: ManagerAuthor
): Promise<UserDocument> {
  const resolvedName = manager.namePromise
    ? await manager.namePromise.catch(() => "")
    : "";
  return (await User.findOneAndUpdate(
    { _id: manager.id },
    { _id: manager.id, isBot: false, firstName: resolvedName || manager.name },
    { upsert: true, new: true }
  )) as UserDocument;
}

export type ManagerOutboundMessage = {
  /** Provider message id; with the chat it is the message's unique key. */
  messageId?: string;
  date: Date;
  text: string;
  /** Channel fields: media, provider meta, previews. */
  fields?: Record<string, unknown>;
  /** Origin fields beside kind/sentByUserId (template name, source). */
  origin?: Record<string, unknown>;
};

/**
 * Stores one message a manager sent through a provider, links it to the
 * conversation and emits it to the inbox. A provider id this chat already
 * stores (an echo or a retried request) is claimed for the manager instead
 * of failing on the { chat, messageId } unique index.
 */
export async function persistManagerOutboundMessage(params: {
  conversation: { _id: mongoose.Types.ObjectId | string; chat?: unknown };
  workspaceId: string;
  channel: "whatsapp" | "telegram" | "instagram" | "web_widget";
  managerId: string;
  managerUser: UserDocument;
  message: ManagerOutboundMessage;
  logTag: string;
}): Promise<PopulatedMessage> {
  const { conversation, managerId, managerUser, message } = params;
  const chat =
    conversation.chat &&
    typeof conversation.chat === "object" &&
    "_id" in conversation.chat
      ? conversation.chat._id
      : conversation.chat;
  const origin = {
    kind: "manager" as const,
    sentByUserId: managerId,
    ...message.origin,
  };
  const content = { text: message.text, ...message.fields };

  let saved: MessageDocument;
  try {
    const created = new Message({
      messageId: message.messageId,
      chat,
      author: managerUser._id,
      date: message.date,
      workspaceId: params.workspaceId,
      conversation: conversation._id,
      channel: params.channel,
      direction: "outbound",
      origin,
      ...content,
    });
    await created.save();
    saved = created as MessageDocument;
  } catch (error) {
    if (!isMongoDuplicateKeyError(error) || !message.messageId) throw error;
    const existing = (await Message.findOne({
      chat,
      messageId: message.messageId,
    })) as MessageDocument | null;
    if (!existing) throw error;
    existing.set({
      ...content,
      author: managerUser._id,
      origin: { ...(existing.origin || {}), ...origin },
    });
    await existing.save();
    saved = existing;
  }

  await appendMessageToConversationById(conversation._id, saved._id, {
    lastMessageAt: saved.date,
    direction: "outbound",
    set: { handled_by_agent_id: managerId },
  });

  const populated = {
    ...(typeof saved.toObject === "function" ? saved.toObject() : saved),
    _id: saved._id,
    author: {
      _id: managerUser._id ?? managerId,
      firstName: managerUser.firstName,
      isBot: false,
    },
  } as unknown as PopulatedMessage;

  // Inbox fanout never holds the reply; after() keeps it alive past the response.
  const emit = realtime
    .trigger(
      `private-conversation-${conversation._id}`,
      "new-message",
      populated
    )
    .catch(() => {
      console.warn(`[${params.logTag}] Realtime emit failed`, {
        conversationId: String(conversation._id),
        workspaceId: params.workspaceId,
        messageId: String(saved._id),
      });
    });
  try {
    after(emit);
  } catch {
    // Outside a request scope the emit still settles on its own.
  }

  return populated;
}
