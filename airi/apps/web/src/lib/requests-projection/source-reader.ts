import mongoose from "mongoose";
import Chat from "@/models/chat";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import User from "@/models/user";
import { isRecord } from "@icecore/shared/lib/value-utils";
import {
  REQUEST_LIST_RECENT_MESSAGE_MAX_COUNT,
  type RequestProjectionSource,
} from "./contract";

// An "Airi replied" witness is an Airi-origin LLM reply ("Airi: ..."), not a
// template, Flow or other Meta interactive follow-up.
const AIRI_REPLY_ORIGIN_KINDS = ["airi"] as const;
const AIRI_LLM_REPLY_TEXT_PATTERN = /^Airi\s*:/i;

const CONVERSATION_SOURCE_FIELDS = [
  "_id",
  "workspaceId",
  "createdAt",
  "lastMessageAt",
  "last_inbound_at",
  "last_outbound_at",
  "channel",
  "status",
  "user",
  "chat",
  "sourceId",
  "business_connection_id",
  "internal_labels",
  "subject",
  "rename",
  "participants",
  "classification",
  "is_read_by_manager",
  "is_best_practice",
  "customer_satisfaction_score",
  "awaiting_csat",
  "external_thread.type",
  "external_thread.permalink",
  "external_thread.comment.timestamp",
  "external_thread.comment.parentId",
  "external_thread.comment.hidden",
  "external_thread.comment.likeCount",
  "external_thread.media.mediaType",
  "external_thread.media.mediaProductType",
  "external_thread.media.timestamp",
  "external_thread.media.caption",
  "external_thread.media.mediaUrl",
  "external_thread.media.thumbnailUrl",
  "external_thread.media.shortcode",
  "external_thread.media.username",
] as const;
const MESSAGE_SOURCE_FIELDS = [
  "_id",
  "text",
  "date",
  "direction",
  "imageUrl",
  "mediaType",
  "mimeType",
  "fileName",
  "author",
  "rawSourcePayload",
  "editMeta",
  "whatsappFlow",
  "whatsappFlowReply",
  "whatsappTemplate",
  "whatsappServiceMessage",
  "whatsappCtaLink",
  "groundedReplyOptions",
  "telegramReplyMarkup",
  "telegramMeta",
] as const;
const CHAT_SOURCE_FIELDS = [
  "_id",
  "title",
  "type",
  "first_name",
  "last_name",
  "username",
  "sourceId",
  "is_forum",
] as const;
const USER_SOURCE_FIELDS = [
  "_id",
  "username",
  "firstName",
  "lastName",
  "avatar_url",
  "isBot",
] as const;

const MESSAGE_CHANGE_FIELDS = [
  ...MESSAGE_SOURCE_FIELDS,
  "conversation",
  "workspaceId",
  "origin.kind",
] as const;

function selectedFieldAffected(
  changedPath: string,
  selectedFields: readonly string[]
): boolean {
  return selectedFields.some(
    selectedPath =>
      changedPath === selectedPath ||
      changedPath.startsWith(`${selectedPath}.`) ||
      selectedPath.startsWith(`${changedPath}.`)
  );
}

export function isRequestProjectionChangeRelevant(input: {
  change: Record<string, unknown>;
  conversationCollection: string;
  messageCollection: string;
  chatCollection: string;
  userCollection: string;
}): boolean {
  const operationType = input.change.operationType;
  if (operationType !== "update") return true;

  const namespace = isRecord(input.change.ns) ? input.change.ns : null;
  const collection =
    typeof namespace?.coll === "string" ? namespace.coll : null;
  const selectedFields =
    collection === input.conversationCollection
      ? CONVERSATION_SOURCE_FIELDS
      : collection === input.messageCollection
        ? MESSAGE_CHANGE_FIELDS
        : collection === input.chatCollection
          ? CHAT_SOURCE_FIELDS
          : collection === input.userCollection
            ? USER_SOURCE_FIELDS
            : null;
  if (!selectedFields) return true;

  const description = isRecord(input.change.updateDescription)
    ? input.change.updateDescription
    : null;
  if (!description) return true;

  const updatedFields = isRecord(description.updatedFields)
    ? description.updatedFields
    : null;
  const removedFields: unknown[] | null = Array.isArray(
    description.removedFields
  )
    ? description.removedFields
    : null;
  const truncatedArrays: unknown[] | null = Array.isArray(
    description.truncatedArrays
  )
    ? description.truncatedArrays
    : null;
  if (!updatedFields && !removedFields && !truncatedArrays) {
    return true;
  }

  const changedPaths = [
    ...(updatedFields ? Object.keys(updatedFields) : []),
    ...(removedFields
      ? removedFields.filter(
          (field): field is string => typeof field === "string"
        )
      : []),
    ...(truncatedArrays
      ? truncatedArrays.flatMap(entry =>
          isRecord(entry) && typeof entry.field === "string"
            ? [entry.field]
            : []
        )
      : []),
  ];

  return changedPaths.some(path => selectedFieldAffected(path, selectedFields));
}

export type RequestProjectionReadStateWatermarkMode =
  | "preserve"
  | "advance_if_changed";

type RequestProjectionSourceReaderDeps = {
  readSnapshot(input: {
    conversationId: mongoose.Types.ObjectId;
    session: mongoose.ClientSession;
    readPreference: "primary";
    readConcern: "majority";
  }): Promise<RequestProjectionSource | null>;
};

function selectFields(fields: readonly string[]): Record<string, 1> {
  return Object.fromEntries(fields.map(field => [field, 1]));
}

// Use the existing source field allowlists and indexed joins. One aggregation
// replaces five sequential round trips without parallel operations on a session.
export function buildRequestProjectionSourcePipeline(
  conversationId: mongoose.Types.ObjectId
): mongoose.PipelineStage[] {
  return [
    { $match: { _id: conversationId } },
    { $project: selectFields(CONVERSATION_SOURCE_FIELDS) },
    { $replaceWith: { conversation: "$$ROOT" } },
    {
      $lookup: {
        from: Message.collection.collectionName,
        localField: "conversation._id",
        foreignField: "conversation",
        pipeline: [
          { $sort: { date: -1, _id: -1 } },
          { $limit: REQUEST_LIST_RECENT_MESSAGE_MAX_COUNT },
          { $project: selectFields(MESSAGE_SOURCE_FIELDS) },
        ],
        as: "messages",
      },
    },
    {
      $lookup: {
        from: Message.collection.collectionName,
        localField: "conversation._id",
        foreignField: "conversation",
        pipeline: [
          {
            $match: {
              direction: "outbound",
              "origin.kind": { $in: [...AIRI_REPLY_ORIGIN_KINDS] },
              text: AIRI_LLM_REPLY_TEXT_PATTERN,
              $and: [
                {
                  $or: [
                    { whatsappTemplate: null },
                    { "whatsappTemplate.name": null },
                  ],
                },
                {
                  $or: [
                    { whatsappFlow: null },
                    { "whatsappFlow.flowId": null },
                  ],
                },
                { whatsappServiceMessage: null },
                {
                  $or: [
                    { whatsappCtaLink: null },
                    { "whatsappCtaLink.url": null },
                  ],
                },
              ],
            },
          },
          { $sort: { _id: -1 } },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
        as: "airiWitness",
      },
    },
    {
      $lookup: {
        from: Chat.collection.collectionName,
        localField: "conversation.chat",
        foreignField: "_id",
        pipeline: [
          { $limit: 1 },
          { $project: selectFields(CHAT_SOURCE_FIELDS) },
        ],
        as: "chat",
      },
    },
    {
      $set: {
        _userIds: {
          $setUnion: [
            [{ $ifNull: ["$conversation.user", null] }],
            { $ifNull: ["$messages.author", []] },
          ],
        },
      },
    },
    {
      $lookup: {
        from: User.collection.collectionName,
        localField: "_userIds",
        foreignField: "_id",
        pipeline: [
          { $match: { _id: { $ne: null } } },
          { $limit: REQUEST_LIST_RECENT_MESSAGE_MAX_COUNT + 1 },
          { $project: selectFields(USER_SOURCE_FIELDS) },
        ],
        as: "users",
      },
    },
    {
      $set: {
        chat: { $ifNull: [{ $first: "$chat" }, null] },
        airiWitness: { $ifNull: [{ $first: "$airiWitness" }, null] },
      },
    },
    { $unset: "_userIds" },
  ];
}

const defaultDeps: RequestProjectionSourceReaderDeps = {
  async readSnapshot(input) {
    const rows = await Conversation.aggregate<RequestProjectionSource>(
      buildRequestProjectionSourcePipeline(input.conversationId)
    )
      .session(input.session)
      .read(input.readPreference)
      .readConcern(input.readConcern)
      .exec();
    return rows[0] || null;
  },
};

export function requireRequestProjectionSourceClusterTime(
  value: unknown
): mongoose.mongo.Timestamp {
  if (
    !(value instanceof mongoose.mongo.Timestamp) ||
    value.toBigInt() === BigInt(0)
  ) {
    throw new TypeError(
      "Request projection sourceClusterTime must be a nonzero BSON Timestamp"
    );
  }
  return value;
}

export async function readRequestProjectionSource(
  input: {
    conversationId: mongoose.Types.ObjectId;
    session: mongoose.ClientSession;
    sourceClusterTime: mongoose.mongo.Timestamp;
  },
  deps: RequestProjectionSourceReaderDeps = defaultDeps
): Promise<RequestProjectionSource | null> {
  const sourceClusterTime = requireRequestProjectionSourceClusterTime(
    input.sourceClusterTime
  );
  input.session.advanceOperationTime(sourceClusterTime);
  return deps.readSnapshot({
    conversationId: input.conversationId,
    session: input.session,
    readPreference: "primary",
    readConcern: "majority",
  });
}
