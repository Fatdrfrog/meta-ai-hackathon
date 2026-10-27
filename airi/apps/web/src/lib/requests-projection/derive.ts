import mongoose from "mongoose";
import { resolveClassificationSourceId } from "@/lib/classifier/conversation-analysis-context";
import { stripInstagramCommentMeta } from "@/lib/instagram/comment-format";
import {
  buildInstagramMediaPermalink,
  resolveInstagramMediaPreviewUrl,
} from "@/lib/instagram/thread-meta";
import { getProviderMessageDisplayOverride } from "@/lib/provider-message-display";
import {
  asNullableRecord,
  readFiniteNumber,
  readArray,
} from "@icecore/shared/lib/value-utils";
import { truncateUtf8 } from "@icecore/shared/lib/utf8";
import {
  REQUEST_LIST_RECENT_MESSAGE_MAX_COUNT,
  REQUEST_LIST_ROW_MAX_BYTES,
  REQUEST_LIST_SCHEMA_VERSION,
  REQUEST_PROJECTION_ID_MAX_BYTES,
  assertRequestListItemPayload,
  assertRequestListPayloadWithinByteCap,
  encodeRequestDependencyKey,
  requestListPayloadUtf8Bytes,
  type ProjectionInt64,
  type RequestListItemPayload,
  type RequestProjectionSource,
  type RequestProjectionWorkState,
} from "./contract";

/** Lowest Date value supported by JavaScript and BSON's signed int64 epoch millis. */
export const REQUEST_LIST_MIN_SORT_AT = new Date(-8_640_000_000_000_000);

const SLA_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const STRING_CAPS = {
  label: 256,
  messageText: 2048,
  profileSearch: 2048,
  subject: 1024,
  rename: 1024,
  generic: 512,
} as const;

type DeriveRequestListItemInput = {
  source: RequestProjectionSource;
  generation: ProjectionInt64;
  workspaceUnreadGeneration: ProjectionInt64;
  sourceWatermark: mongoose.mongo.Timestamp;
  readStateWatermark: mongoose.mongo.Timestamp;
  projectedAt?: Date;
  projection?: Omit<
    RequestProjectionWorkState,
    "sourceWatermark" | "readStateWatermark"
  >;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
}

function idString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof mongoose.Types.ObjectId
  ) {
    return String(value);
  }
  return null;
}

function dependencyKey(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    return encodeRequestDependencyKey(value);
  } catch {
    return null;
  }
}

function collisionSensitiveId(value: unknown, field: string): string | null {
  const id = asString(value);
  if (!id) return null;
  if (Buffer.byteLength(id, "utf8") > REQUEST_PROJECTION_ID_MAX_BYTES) {
    throw new Error(
      `${field} exceeds ${REQUEST_PROJECTION_ID_MAX_BYTES} UTF-8 bytes`
    );
  }
  return id;
}

function capProjectionStrings(
  values: readonly unknown[],
  options: { maxCount: number; maxBytes: number; maxTotalBytes?: number }
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const value of values) {
    if (result.length >= options.maxCount) break;
    const stringValue = asString(value);
    if (!stringValue) continue;
    const capped = truncateUtf8(stringValue.trim(), options.maxBytes);
    if (!capped || seen.has(capped)) continue;
    const cappedBytes = Buffer.byteLength(capped, "utf8");
    if (
      options.maxTotalBytes !== undefined &&
      totalBytes + cappedBytes > options.maxTotalBytes
    ) {
      continue;
    }
    seen.add(capped);
    result.push(capped);
    totalBytes += cappedBytes;
  }
  return result;
}

function pickStrings(
  record: Record<string, unknown> | null,
  fields: readonly string[],
  maxBytes: number = STRING_CAPS.generic
): Record<string, string> {
  if (!record) return {};
  return Object.fromEntries(
    fields.flatMap(field => {
      const value = asString(record[field]);
      return value ? [[field, truncateUtf8(value, maxBytes)] as const] : [];
    })
  );
}

function findUser(
  users: readonly Record<string, unknown>[],
  id: unknown
): Record<string, unknown> | null {
  const wanted = dependencyKey(id);
  if (!wanted) return null;
  return users.find(user => dependencyKey(user._id) === wanted) || null;
}

function boundedUser(user: Record<string, unknown> | null) {
  if (!user) return undefined;
  const rawId = user._id;
  const id =
    typeof rawId === "string" || typeof rawId === "number"
      ? rawId
      : idString(rawId);
  return {
    ...(id !== null
      ? {
          _id: typeof id === "number" ? id : truncateUtf8(id, 256),
        }
      : {}),
    ...pickStrings(user, ["firstName", "lastName", "username"], 256),
    ...pickStrings(user, ["avatar_url"], 1024),
    ...(typeof user.isBot === "boolean" ? { isBot: user.isBot } : {}),
  };
}

function messageSort(
  left: Record<string, unknown>,
  right: Record<string, unknown>
) {
  const dateDifference =
    (asDate(right.date)?.getTime() ?? REQUEST_LIST_MIN_SORT_AT.getTime()) -
    (asDate(left.date)?.getTime() ?? REQUEST_LIST_MIN_SORT_AT.getTime());
  if (dateDifference !== 0) return dateDifference;
  return (idString(right._id) || "").localeCompare(idString(left._id) || "");
}

function boundedFlow(value: unknown, fields: readonly string[]) {
  const record = asNullableRecord(value);
  if (!record) return undefined;
  const picked = pickStrings(record, fields, 512);
  return Object.keys(picked).length > 0 ? picked : undefined;
}

const FLOW_RESPONSE_SKIP_KEYS = new Set([
  "flow_token",
  "token",
  "wa_flow_response_keys",
]);

/** Answered fields in a WhatsApp Flow responseJson, which is never persisted. */
function countWhatsAppFlowResponseFields(responseJson: string | null): number {
  const raw = responseJson?.trim() ?? "";
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return 0;
    }
    return Object.keys(parsed).filter(key => {
      const normalized = key.trim().toLowerCase();
      return normalized && !FLOW_RESPONSE_SKIP_KEYS.has(normalized);
    }).length;
  } catch {
    return 0;
  }
}

function boundedEditMeta(value: unknown) {
  const record = asNullableRecord(value);
  if (!record) return undefined;
  const editedAt = asDate(record.editedAt);
  const editCount = readFiniteNumber(record.editCount);
  const result = {
    ...(editedAt ? { editedAt } : {}),
    ...pickStrings(record, ["previousText"], 512),
    ...(editCount !== null ? { editCount } : {}),
    ...pickStrings(record, ["source", "kind"], 64),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

function boundedTemplate(value: unknown) {
  const record = asNullableRecord(value);
  if (!record) return undefined;
  const buttons = (Array.isArray(record.buttons) ? record.buttons : [])
    .slice(0, 8)
    .flatMap(button => {
      const item = asNullableRecord(button);
      if (!item) return [];
      const bounded = pickStrings(
        item,
        ["type", "text", "value", "flowId", "flowAction"],
        256
      );
      return Object.keys(bounded).length > 0 ? [bounded] : [];
    });
  const result = {
    ...pickStrings(
      record,
      ["name", "languageCode", "headerText", "bodyText", "footerText"],
      512
    ),
    ...(buttons.length > 0 ? { buttons } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

function boundedServiceMessage(value: unknown) {
  const record = asNullableRecord(value);
  if (!record) return undefined;
  const version = readFiniteNumber(record.version);
  const result = {
    ...(version !== null ? { version } : {}),
    ...pickStrings(record, ["kind"], 64),
    ...pickStrings(record, ["bodyText"], 1024),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

function boundedGroundedReplyOptions(value: unknown) {
  const record = asNullableRecord(value);
  if (!record) return undefined;
  const options = (Array.isArray(record.options) ? record.options : [])
    .slice(0, 8)
    .flatMap(option => {
      const item = asNullableRecord(option);
      if (!item) return [];
      const id = asString(item.id);
      const label = asString(item.label);
      if (!id || !label) return [];
      const amount = readFiniteNumber(item.quotedPriceAmount);
      const bounded = {
        ...pickStrings(
          item,
          [
            "id",
            "callbackKey",
            "label",
            "description",
            "selectionKind",
            "sourceKind",
            "quotedPriceText",
            "quotedPriceCurrency",
          ],
          512
        ),
        sourceIds: [],
        ...(amount !== null ? { quotedPriceAmount: amount } : {}),
      };
      return [bounded];
    });
  const surface = asString(record.surface);
  if (!surface && options.length === 0) return undefined;
  return {
    ...(surface ? { surface: truncateUtf8(surface, 64) } : {}),
    ...(options.length > 0 ? { options } : {}),
  };
}

function boundedTelegramReplyMarkup(value: unknown) {
  const record = asNullableRecord(value);
  const rows = Array.isArray(record?.inlineKeyboard)
    ? record.inlineKeyboard
    : [];
  const inlineKeyboard = rows.slice(0, 8).flatMap(row => {
    if (!Array.isArray(row)) return [];
    const buttons = row.slice(0, 8).flatMap(button => {
      const item = asNullableRecord(button);
      if (!item) return [];
      const bounded = pickStrings(item, ["text", "type", "url"], 512);
      return bounded.text && bounded.type ? [bounded] : [];
    });
    return buttons.length > 0 ? [buttons] : [];
  });
  return inlineKeyboard.length > 0 ? { inlineKeyboard } : undefined;
}

function boundedMessage(
  message: Record<string, unknown>,
  users: readonly Record<string, unknown>[],
  options: { stripInstagramMeta: boolean }
) {
  const providerOverride = getProviderMessageDisplayOverride(
    message.rawSourcePayload
  );
  const date = asDate(message.date);
  const id = idString(message._id);
  const rawText = asString(providerOverride?.text ?? message.text);
  const text =
    rawText && options.stripInstagramMeta
      ? stripInstagramCommentMeta(rawText)
      : rawText;
  const author = boundedUser(findUser(users, message.author));
  const whatsappFlow = boundedFlow(message.whatsappFlow, [
    "flowId",
    "flowToken",
    "flowCta",
    "headerText",
    "bodyText",
    "footerText",
    "flowActionType",
    "scenarioId",
    "scenarioName",
    "actionNodeId",
    "status",
  ]);
  const whatsappFlowReplyBase = boundedFlow(message.whatsappFlowReply, [
    "flowName",
    "flowToken",
    "body",
  ]);
  const rawFlowReply = asNullableRecord(message.whatsappFlowReply);
  const rawResponseJson = asString(rawFlowReply?.responseJson);
  const existingResponseCount = readFiniteNumber(
    rawFlowReply?.responseFieldCount
  );
  const responseSubmitted =
    rawFlowReply?.responseSubmitted === true ||
    Boolean(rawResponseJson) ||
    Boolean(asString(rawFlowReply?.flowToken));
  const whatsappFlowReply =
    whatsappFlowReplyBase || responseSubmitted
      ? {
          ...whatsappFlowReplyBase,
          ...(responseSubmitted
            ? {
                responseFieldCount:
                  existingResponseCount !== null &&
                  Number.isInteger(existingResponseCount) &&
                  existingResponseCount >= 0
                    ? Math.min(existingResponseCount, 10_000)
                    : countWhatsAppFlowResponseFields(rawResponseJson),
                responseSubmitted: true,
              }
            : {}),
        }
      : undefined;
  const editMeta = boundedEditMeta(message.editMeta);
  const whatsappTemplate = boundedTemplate(message.whatsappTemplate);
  const whatsappServiceMessage = boundedServiceMessage(
    message.whatsappServiceMessage
  );
  const groundedReplyOptions = boundedGroundedReplyOptions(
    message.groundedReplyOptions
  );
  const telegramReplyMarkup = boundedTelegramReplyMarkup(
    message.telegramReplyMarkup
  );
  const whatsappCtaLink = boundedFlow(message.whatsappCtaLink, [
    "title",
    "url",
  ]);
  const telegramMeta = boundedFlow(message.telegramMeta, [
    "businessConnectionId",
    "senderDisplayName",
    "senderChatId",
    "senderChatTitle",
    "senderChatType",
    "authorSignature",
    "senderTag",
    "replyToTelegramMessageId",
    "replyToTextPreview",
  ]);
  const mediaType = asString(message.mediaType);

  return {
    ...(id ? { _id: id } : {}),
    ...(text ? { text: truncateUtf8(text, STRING_CAPS.messageText) } : {}),
    ...(date ? { date } : {}),
    ...pickStrings(message, ["direction"], 32),
    ...pickStrings(message, ["imageUrl"], 1024),
    ...(mediaType ? { mediaType: truncateUtf8(mediaType, 64) } : {}),
    ...pickStrings(message, ["mimeType", "fileName"], 256),
    ...(author && Object.keys(author).length > 0 ? { author } : {}),
    ...(editMeta ? { editMeta } : {}),
    ...(whatsappFlow ? { whatsappFlow } : {}),
    ...(whatsappFlowReply ? { whatsappFlowReply } : {}),
    ...(whatsappTemplate ? { whatsappTemplate } : {}),
    ...(whatsappServiceMessage ? { whatsappServiceMessage } : {}),
    ...(whatsappCtaLink ? { whatsappCtaLink } : {}),
    ...(groundedReplyOptions ? { groundedReplyOptions } : {}),
    ...(telegramReplyMarkup ? { telegramReplyMarkup } : {}),
    ...(telegramMeta
      ? {
          telegramMeta: {
            ...telegramMeta,
            ...(typeof asNullableRecord(message.telegramMeta)
              ?.messageThreadId === "number"
              ? {
                  messageThreadId: asNullableRecord(message.telegramMeta)
                    ?.messageThreadId,
                }
              : {}),
          },
        }
      : {}),
  };
}

function normalizedSearchText(values: readonly unknown[]): string {
  return truncateUtf8(
    values
      .flatMap(value => (asString(value) ? [String(value)] : []))
      .join(" ")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim(),
    STRING_CAPS.profileSearch
  );
}

function boundedInstagramPreview(
  conversation: Record<string, unknown>,
  latestMessage: Record<string, unknown> | undefined
) {
  if (conversation.channel !== "instagram") return undefined;
  const thread = asNullableRecord(conversation.external_thread);
  if (thread?.type !== "comment") return undefined;
  const comment = asNullableRecord(thread.comment);
  const media = asNullableRecord(thread.media);
  const permalink = buildInstagramMediaPermalink(
    thread.permalink,
    media?.shortcode
  );
  const previewUrl = resolveInstagramMediaPreviewUrl({
    thumbnailUrl: media?.thumbnailUrl,
    mediaUrl: media?.mediaUrl,
  });
  const commentTimestamp =
    asDate(comment?.timestamp) || asDate(latestMessage?.date);
  const mediaTimestamp = asDate(media?.timestamp);
  const likeCount = readFiniteNumber(comment?.likeCount);
  return {
    ...(commentTimestamp ? { commentTimestamp } : {}),
    isReply: Boolean(asString(comment?.parentId)),
    ...(typeof comment?.hidden === "boolean"
      ? { isHidden: comment.hidden }
      : {}),
    ...(likeCount !== null ? { likeCount } : {}),
    ...pickStrings(media, ["mediaType", "mediaProductType"], 64),
    ...(mediaTimestamp ? { mediaTimestamp } : {}),
    ...(asString(media?.caption)
      ? { mediaCaption: truncateUtf8(String(media?.caption), 1024) }
      : {}),
    ...(previewUrl ? { mediaPreviewUrl: truncateUtf8(previewUrl, 1024) } : {}),
    ...(permalink ? { mediaPermalink: truncateUtf8(permalink, 1024) } : {}),
    ...(asString(media?.shortcode)
      ? { mediaShortcode: truncateUtf8(String(media?.shortcode), 128) }
      : {}),
    ...(asString(media?.username)
      ? {
          mediaAuthorUsername: truncateUtf8(String(media?.username), 256),
        }
      : {}),
  };
}

function fitPayload(row: RequestListItemPayload): RequestListItemPayload {
  if (requestListPayloadUtf8Bytes(row) <= REQUEST_LIST_ROW_MAX_BYTES)
    return row;

  const mutable = row as RequestListItemPayload & Record<string, unknown>;
  // Deterministic low-priority shedding; query and identity fields are retained.
  for (const field of ["instagram", "classification", "chat"] as const) {
    delete mutable[field];
    if (requestListPayloadUtf8Bytes(mutable) <= REQUEST_LIST_ROW_MAX_BYTES) {
      return mutable;
    }
  }
  mutable.recentMessages = (mutable.recentMessages || []).map(message => {
    const record = { ...message };
    if (typeof record.text === "string") {
      record.text = truncateUtf8(record.text, 512);
    }
    return record;
  });
  if (requestListPayloadUtf8Bytes(mutable) <= REQUEST_LIST_ROW_MAX_BYTES) {
    return mutable;
  }
  mutable.recentMessages = [];
  if (requestListPayloadUtf8Bytes(mutable) <= REQUEST_LIST_ROW_MAX_BYTES) {
    return mutable;
  }
  for (const field of [
    "customer",
    "participants",
    "rename",
    "subject",
  ] as const) {
    delete mutable[field];
    if (requestListPayloadUtf8Bytes(mutable) <= REQUEST_LIST_ROW_MAX_BYTES) {
      return mutable;
    }
  }
  mutable.internalLabels = [];
  mutable.profileSearchText = truncateUtf8(
    mutable.profileSearchText || "",
    512
  );
  if (requestListPayloadUtf8Bytes(mutable) <= REQUEST_LIST_ROW_MAX_BYTES) {
    return mutable;
  }
  mutable.profileSearchText = "";
  mutable.channel = null;
  mutable.category = null;
  mutable.phoneDigits = null;
  assertRequestListPayloadWithinByteCap(mutable);
  return mutable;
}

export function deriveRequestListItem({
  source,
  generation,
  workspaceUnreadGeneration,
  sourceWatermark,
  readStateWatermark,
  projectedAt = new Date(),
  projection,
}: DeriveRequestListItemInput): RequestListItemPayload {
  const conversation = source.conversation;
  const conversationId = conversation._id;
  if (!(conversationId instanceof mongoose.Types.ObjectId)) {
    throw new TypeError(
      "Request projection source requires an ObjectId conversation"
    );
  }
  const workspaceId = collisionSensitiveId(
    conversation.workspaceId,
    "workspaceId"
  );
  const createdAt = asDate(conversation.createdAt);
  if (!workspaceId || !createdAt) {
    throw new TypeError(
      "Request projection source requires workspaceId and createdAt"
    );
  }

  const customer = findUser(source.users, conversation.user);
  const chat = source.chat;
  const participants = asNullableRecord(conversation.participants);
  const from = capProjectionStrings(readArray(participants?.from), {
    maxCount: 32,
    maxBytes: 256,
    maxTotalBytes: 2048,
  });
  const to = capProjectionStrings(readArray(participants?.to), {
    maxCount: 32,
    maxBytes: 256,
    maxTotalBytes: 2048,
  });
  const searchInputs = [
    customer?.username,
    customer?.firstName,
    customer?.lastName,
    chat?.title,
    chat?.username,
    conversation.rename,
    ...from,
    ...to,
  ];
  const phoneDigits = [conversation.user, ...from, ...to]
    .flatMap(value => {
      const digits = asString(value)?.replace(/\D/g, "") || "";
      return digits.length >= 7 ? [digits] : [];
    })
    .join("");
  const lastMessageAt = asDate(conversation.lastMessageAt);
  const classification = asNullableRecord(conversation.classification);
  const resolvedSourceId = resolveClassificationSourceId({
    sourceId: asString(conversation.sourceId),
    chat: chat ? { sourceId: chat.sourceId } : null,
  });
  const sourceId = collisionSensitiveId(resolvedSourceId, "sourceId");
  const businessConnectionId = collisionSensitiveId(
    conversation.business_connection_id,
    "businessConnectionId"
  );
  const recentMessages = [...source.messages]
    .sort(messageSort)
    .slice(0, REQUEST_LIST_RECENT_MESSAGE_MAX_COUNT)
    .map(message =>
      boundedMessage(message, source.users, {
        stripInstagramMeta:
          conversation.channel === "instagram" &&
          asNullableRecord(conversation.external_thread)?.type === "comment",
      })
    );
  const effectiveUnreadGeneration =
    conversation.is_read_by_manager === true ? null : workspaceUnreadGeneration;

  const row: RequestListItemPayload = {
    _id: conversationId,
    workspaceId,
    schemaVersion: REQUEST_LIST_SCHEMA_VERSION,
    projectedAt,
    sortAt: lastMessageAt || REQUEST_LIST_MIN_SORT_AT,
    displayAt: lastMessageAt || createdAt,
    channel: asString(conversation.channel)
      ? truncateUtf8(String(conversation.channel), 64)
      : null,
    status: truncateUtf8(asString(conversation.status) || "open", 128),
    category: asString(classification?.category)
      ? truncateUtf8(String(classification?.category), 256)
      : null,
    internalLabels: capProjectionStrings(
      readArray(conversation.internal_labels),
      {
        maxCount: 64,
        maxBytes: STRING_CAPS.label,
        maxTotalBytes: 2048,
      }
    ),
    unreadGeneration: effectiveUnreadGeneration,
    hasAiriReply: Boolean(
      asDate(conversation.last_outbound_at) && source.airiWitness
    ),
    isBestPractice: conversation.is_best_practice === true,
    customerSatisfactionScore: readFiniteNumber(
      conversation.customer_satisfaction_score
    ),
    slaDueAt: new Date(createdAt.getTime() + SLA_WINDOW_MS),
    profileSearchText: normalizedSearchText(searchInputs),
    phoneDigits: phoneDigits ? truncateUtf8(phoneDigits, 64) : null,
    createdAt,
    lastInboundAt: asDate(conversation.last_inbound_at),
    sourceId,
    businessConnectionId,
    rename: asString(conversation.rename)
      ? truncateUtf8(String(conversation.rename), STRING_CAPS.rename)
      : null,
    subject: asString(conversation.subject)
      ? truncateUtf8(String(conversation.subject), STRING_CAPS.subject)
      : null,
    participants: { from, to },
    customer: boundedUser(customer),
    chat: chat
      ? {
          ...pickStrings(
            chat,
            ["title", "type", "first_name", "last_name", "username"],
            512
          ),
          ...(typeof chat.is_forum === "boolean"
            ? { is_forum: chat.is_forum }
            : {}),
        }
      : undefined,
    classification: classification
      ? pickStrings(
          classification,
          ["summary", "category", "priority", "action"],
          1024
        )
      : undefined,
    awaitingCsat:
      typeof conversation.awaiting_csat === "boolean"
        ? conversation.awaiting_csat
        : null,
    recentMessages,
    instagram: boundedInstagramPreview(conversation, recentMessages[0]),
    projection: {
      ...(projection || {
        status: "ready",
        generation,
        fence: BigInt(0),
      }),
      sourceWatermark,
      readStateWatermark,
    },
  };

  const fitted = fitPayload(row);
  return assertRequestListItemPayload(fitted);
}
