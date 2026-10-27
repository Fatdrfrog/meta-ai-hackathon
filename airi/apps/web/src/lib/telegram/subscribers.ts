import connectDB from "@/lib/mongoose";
import { logger } from "@/lib/logger";
import {
  isTelegramPrivateChatId as isTelegramPrivateSubscriberChatId,
  normalizeTelegramChatId as normalizeTelegramSubscriberChatId,
} from "@/lib/telegram/chat-id";
import { Conversation } from "@/models/conversation";
import { TelegramSubscriber } from "@/models/telegram-subscriber";
import { TelegramSubscriberImportBatch } from "@/models/telegram-subscriber-import-batch";
import type { TelegramMessage, TelegramUser } from "@/types/telegram";
import { parse as parseCsvSync } from "csv-parse/sync";
import type { AnyBulkWriteOperation } from "mongoose";
import { after } from "next/server";
import { readStringOrEmpty } from "@icecore/shared/lib/value-utils";

export type TelegramSubscriberStatus =
  | "active"
  | "imported"
  | "blocked"
  | "invalid"
  | "suppressed";

export type TelegramSubscriberOrigin =
  | "webhook"
  | "conversation_backfill"
  | "import";

export type TelegramSubscriberCsvRow = {
  chatId: string;
  sourceId: string;
  telegramUserId?: string | null;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  languageCode?: string | null;
  externalId?: string | null;
  tags?: string[];
};

export type TelegramSubscriberImportError = {
  rowNumber: number;
  reason:
    | "missing_chat_id"
    | "invalid_chat_id"
    | "telegram_group_dm_not_supported"
    | "duplicate_chat_id";
  value?: string;
};

export type TelegramSubscriberParseResult = {
  validRows: TelegramSubscriberCsvRow[];
  errors: TelegramSubscriberImportError[];
  summary: {
    totalRows: number;
    validRows: number;
    invalidRows: number;
    duplicateRows: number;
  };
};

export type TelegramSubscriberExportRow = {
  chatId: string;
  sourceId: string;
  status: TelegramSubscriberStatus;
  origin: TelegramSubscriberOrigin;
  displayName?: string | null;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  languageCode?: string | null;
  externalId?: string | null;
  tags?: string[] | null;
  importedAt?: Date | string | null;
  lastSeenAt?: Date | string | null;
  lastSuccessfulSendAt?: Date | string | null;
  lastSendError?: string | null;
};

export type TelegramSubscriberContactRow = {
  identifier: string;
  channel: "telegram";
  name: string;
  sourceId: string;
  status: TelegramSubscriberStatus;
  origin: TelegramSubscriberOrigin;
};

export type TelegramSubscriberImportBatchSummary = {
  id: string;
  status: "processing" | "completed" | "failed";
  fileName?: string | null;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  insertedRows: number;
  updatedRows: number;
  createdAt?: Date | string | null;
  completedAt?: Date | string | null;
  failedAt?: Date | string | null;
  failureReason?: string | null;
};

type SubscriberLeanRow = TelegramSubscriberExportRow & {
  _id?: unknown;
  importBatchId?: unknown;
};

type ConversationBackfillRow = {
  chat?: unknown;
  user?: unknown;
  sourceId?: string | null;
  first_inbound_at?: Date | string | null;
  last_inbound_at?: Date | string | null;
};

export { isTelegramPrivateSubscriberChatId, normalizeTelegramSubscriberChatId };

const CHAT_ID_ALIASES = new Set([
  "chat_id",
  "chatid",
  "telegram_chat_id",
  "telegram_id",
  "user_id",
  "id",
  "recipient_id",
]);
const FIRST_NAME_ALIASES = new Set(["first_name", "firstname", "first"]);
const LAST_NAME_ALIASES = new Set(["last_name", "lastname", "last"]);
const DISPLAY_NAME_ALIASES = new Set([
  "name",
  "full_name",
  "display_name",
  "customer_name",
]);
const USERNAME_ALIASES = new Set(["username", "telegram_username", "handle"]);
const LANGUAGE_ALIASES = new Set(["language", "language_code", "lang"]);
const EXTERNAL_ID_ALIASES = new Set(["external_id", "externalid", "crm_id"]);
const TAG_ALIASES = new Set(["tags", "tag"]);
const ELIGIBLE_SUBSCRIBER_STATUSES = ["active", "imported"] as const;
const IMPORT_BULK_CHUNK_SIZE = 1000;
const DEFAULT_LIST_LIMIT = 200;
const MAX_AUDIENCE_RECIPIENTS = 100_000;
const CONVERSATION_BACKFILL_BATCH_SIZE = 500;
const CONVERSATION_BACKFILL_MAX_BATCH_SIZE = 1_000;
const CONVERSATION_BACKFILL_SCHEDULE_TTL_MS = 60_000;
const CONVERSATION_BACKFILL_SCHEDULE_MAX_KEYS = 5_000;

const scheduledConversationBackfills = new Map<string, number>();

function normalizeHeader(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/^\uFEFF/, "")
    .toLowerCase()
    .replace(/[\s.-]+/g, "_");
}

function pickByAliases(
  row: Record<string, unknown>,
  aliases: Set<string>
): string {
  for (const [key, value] of Object.entries(row)) {
    if (aliases.has(normalizeHeader(key))) {
      return readStringOrEmpty(value, { trim: true, coerce: true });
    }
  }
  return "";
}

function splitTags(value: string): string[] {
  if (!value) return [];
  return Array.from(
    new Set(
      value
        .split(/[;,|]/)
        .map(tag => tag.trim())
        .filter(Boolean)
    )
  );
}

function displayNameFromParts(params: {
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  chatId: string;
}): string {
  const displayName = params.displayName?.trim();
  if (displayName) return displayName;
  const fullName = [params.firstName, params.lastName]
    .map(value => value?.trim())
    .filter(Boolean)
    .join(" ");
  if (fullName) return fullName;
  if (params.username?.trim()) return `@${params.username.trim()}`;
  return params.chatId;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
}

function csvDate(value: Date | string | null | undefined): string {
  const date = toDate(value);
  return date ? date.toISOString() : "";
}

function normalizeLimit(
  value: number | null | undefined,
  fallback: number,
  max: number
): number {
  const parsed = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function normalizeSourceIds(sourceIds: string[]): string[] {
  const normalized = new Set<string>();
  for (const sourceId of sourceIds) {
    const value = sourceId.trim();
    if (value) normalized.add(value);
  }
  return Array.from(normalized);
}

function pruneScheduledConversationBackfills(now: number): void {
  if (
    scheduledConversationBackfills.size <=
    CONVERSATION_BACKFILL_SCHEDULE_MAX_KEYS
  ) {
    return;
  }

  for (const [key, scheduledAt] of scheduledConversationBackfills) {
    if (now - scheduledAt >= CONVERSATION_BACKFILL_SCHEDULE_TTL_MS) {
      scheduledConversationBackfills.delete(key);
    }
  }

  for (const key of scheduledConversationBackfills.keys()) {
    if (
      scheduledConversationBackfills.size <=
      CONVERSATION_BACKFILL_SCHEDULE_MAX_KEYS
    ) {
      break;
    }
    scheduledConversationBackfills.delete(key);
  }
}

function csvCell(value: unknown): string {
  const text = Array.isArray(value)
    ? value.join(";")
    : value instanceof Date
      ? value.toISOString()
      : String(value ?? "");
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function normalizeCsvRecord(record: Record<string, unknown>) {
  const chatId = normalizeTelegramSubscriberChatId(
    pickByAliases(record, CHAT_ID_ALIASES)
  );
  const username = pickByAliases(record, USERNAME_ALIASES).replace(/^@/, "");
  const firstName = pickByAliases(record, FIRST_NAME_ALIASES);
  const lastName = pickByAliases(record, LAST_NAME_ALIASES);
  const displayName = pickByAliases(record, DISPLAY_NAME_ALIASES);
  const languageCode = pickByAliases(record, LANGUAGE_ALIASES);
  const externalId = pickByAliases(record, EXTERNAL_ID_ALIASES);
  const tags = splitTags(pickByAliases(record, TAG_ALIASES));

  return {
    chatId,
    username,
    firstName,
    lastName,
    displayName,
    languageCode,
    externalId,
    tags,
  };
}

export function parseTelegramSubscriberCsv(params: {
  csv: string;
  sourceId: string;
}): TelegramSubscriberParseResult {
  const records = parseCsvSync(params.csv, {
    bom: true,
    columns: header => header.map(normalizeHeader),
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Record<string, unknown>[];

  const validRows: TelegramSubscriberCsvRow[] = [];
  const errors: TelegramSubscriberImportError[] = [];
  const seenChatIds = new Set<string>();

  records.forEach((record, index) => {
    const rowNumber = index + 2;
    const normalized = normalizeCsvRecord(record);
    if (!normalized.chatId) {
      errors.push({ rowNumber, reason: "missing_chat_id" });
      return;
    }
    if (normalized.chatId.startsWith("-")) {
      errors.push({
        rowNumber,
        reason: "telegram_group_dm_not_supported",
        value: normalized.chatId,
      });
      return;
    }
    if (!isTelegramPrivateSubscriberChatId(normalized.chatId)) {
      errors.push({
        rowNumber,
        reason: "invalid_chat_id",
        value: normalized.chatId,
      });
      return;
    }
    if (seenChatIds.has(normalized.chatId)) {
      errors.push({
        rowNumber,
        reason: "duplicate_chat_id",
        value: normalized.chatId,
      });
      return;
    }

    seenChatIds.add(normalized.chatId);
    validRows.push({
      sourceId: params.sourceId,
      chatId: normalized.chatId,
      telegramUserId: normalized.chatId,
      username: normalized.username || null,
      firstName: normalized.firstName || null,
      lastName: normalized.lastName || null,
      displayName:
        displayNameFromParts({
          ...normalized,
          chatId: normalized.chatId,
        }) || null,
      languageCode: normalized.languageCode || null,
      externalId: normalized.externalId || null,
      tags: normalized.tags,
    });
  });

  const duplicateRows = errors.filter(
    error => error.reason === "duplicate_chat_id"
  ).length;

  return {
    validRows,
    errors,
    summary: {
      totalRows: records.length,
      validRows: validRows.length,
      invalidRows: errors.length - duplicateRows,
      duplicateRows,
    },
  };
}

export function buildTelegramSubscribersCsv(
  rows: TelegramSubscriberExportRow[]
): string {
  const header = [
    "chat_id",
    "source_id",
    "status",
    "origin",
    "display_name",
    "username",
    "first_name",
    "last_name",
    "language_code",
    "external_id",
    "tags",
    "imported_at",
    "last_seen_at",
    "last_successful_send_at",
    "last_send_error",
  ];
  const lines = rows.map(row =>
    [
      row.chatId,
      row.sourceId,
      row.status,
      row.origin,
      row.displayName,
      row.username,
      row.firstName,
      row.lastName,
      row.languageCode,
      row.externalId,
      row.tags || [],
      csvDate(row.importedAt),
      csvDate(row.lastSeenAt),
      csvDate(row.lastSuccessfulSendAt),
      row.lastSendError,
    ]
      .map(csvCell)
      .join(",")
  );
  return [header.join(","), ...lines].join("\n");
}

export async function importTelegramSubscriberCsv(params: {
  workspaceId: string;
  sourceId: string;
  csv: string;
  importedBy: string;
  fileName?: string | null;
}) {
  await connectDB();
  const parsed = parseTelegramSubscriberCsv({
    csv: params.csv,
    sourceId: params.sourceId,
  });

  const batch = await TelegramSubscriberImportBatch.create({
    workspaceId: params.workspaceId,
    sourceId: params.sourceId,
    importedBy: params.importedBy,
    fileName: params.fileName || null,
    status: "processing",
    totalRows: parsed.summary.totalRows,
    validRows: parsed.summary.validRows,
    invalidRows: parsed.summary.invalidRows,
    duplicateRows: parsed.summary.duplicateRows,
    errorSamples: parsed.errors.slice(0, 50),
  });

  let insertedRows = 0;
  let updatedRows = 0;
  const now = new Date();

  try {
    for (
      let index = 0;
      index < parsed.validRows.length;
      index += IMPORT_BULK_CHUNK_SIZE
    ) {
      const chunk = parsed.validRows.slice(
        index,
        index + IMPORT_BULK_CHUNK_SIZE
      );
      const operations: AnyBulkWriteOperation[] = chunk.map(row => ({
        updateOne: {
          filter: {
            workspaceId: params.workspaceId,
            sourceId: params.sourceId,
            chatId: row.chatId,
          },
          update: {
            $set: {
              telegramUserId: row.telegramUserId || row.chatId,
              username: row.username || null,
              firstName: row.firstName || null,
              lastName: row.lastName || null,
              displayName: row.displayName || null,
              languageCode: row.languageCode || null,
              externalId: row.externalId || null,
              tags: row.tags || [],
              origin: "import",
              status: "imported",
              invalidReason: null,
              importBatchId: batch._id,
              importedBy: params.importedBy,
              importedAt: now,
              sourceFileName: params.fileName || null,
            },
            $setOnInsert: {
              workspaceId: params.workspaceId,
              sourceId: params.sourceId,
              chatId: row.chatId,
              firstSeenAt: now,
            },
          },
          upsert: true,
        },
      }));
      if (operations.length === 0) continue;
      const result = await TelegramSubscriber.bulkWrite(operations, {
        ordered: false,
      });
      insertedRows += result.upsertedCount || 0;
      updatedRows += result.modifiedCount || 0;
    }

    await TelegramSubscriberImportBatch.updateOne(
      { _id: batch._id },
      {
        $set: {
          status: "completed",
          insertedRows,
          updatedRows,
          completedAt: new Date(),
        },
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await TelegramSubscriberImportBatch.updateOne(
      { _id: batch._id },
      {
        $set: {
          status: "failed",
          failureReason: message,
          failedAt: new Date(),
        },
      }
    );
    throw error;
  }

  return {
    batchId: String(batch._id),
    insertedRows,
    updatedRows,
    ...parsed,
  };
}

export async function upsertTelegramSubscriberFromMessage(params: {
  workspaceId: string;
  sourceId?: string | null;
  message: TelegramMessage;
}) {
  const sourceId = params.sourceId?.trim();
  if (!sourceId || params.message.chat?.type !== "private") return;
  const chatId = normalizeTelegramSubscriberChatId(params.message.chat.id);
  if (!isTelegramPrivateSubscriberChatId(chatId)) return;

  const user: Partial<TelegramUser> = params.message.from || {};
  const now = new Date();
  const firstName = user.first_name || params.message.chat.first_name || null;
  const lastName = user.last_name || params.message.chat.last_name || null;
  const username = user.username || params.message.chat.username || null;
  const displayName = displayNameFromParts({
    chatId,
    username,
    firstName,
    lastName,
    displayName: null,
  });

  try {
    await TelegramSubscriber.updateOne(
      {
        workspaceId: params.workspaceId,
        sourceId,
        chatId,
      },
      {
        $set: {
          telegramUserId: String(user.id || params.message.chat.id),
          username,
          firstName,
          lastName,
          displayName,
          languageCode: user.language_code || null,
          origin: "webhook",
          status: "active",
          invalidReason: null,
          lastSeenAt: now,
        },
        $setOnInsert: {
          workspaceId: params.workspaceId,
          sourceId,
          chatId,
          firstSeenAt: now,
        },
      },
      { upsert: true }
    );
  } catch (error) {
    logger.warn("Failed to upsert Telegram subscriber from webhook", {
      workspaceId: params.workspaceId,
      sourceId,
      chatId,
      error,
    });
  }
}

export async function backfillTelegramSubscribersFromConversations(params: {
  workspaceId: string;
  sourceId: string;
  limit?: number;
}) {
  await connectDB();
  const limit = normalizeLimit(
    params.limit,
    CONVERSATION_BACKFILL_BATCH_SIZE,
    CONVERSATION_BACKFILL_MAX_BATCH_SIZE
  );
  const conversations = (await Conversation.find({
    workspaceId: params.workspaceId,
    channel: "telegram",
    sourceId: params.sourceId,
    $and: [
      {
        $or: [
          { business_connection_id: { $exists: false } },
          { business_connection_id: null },
          { business_connection_id: "" },
        ],
      },
      {
        $or: [
          { first_inbound_at: { $exists: true, $ne: null } },
          { last_inbound_at: { $exists: true, $ne: null } },
        ],
      },
    ],
    $nor: [{ chat: /^-/ }, { chat: /^tg_-/ }],
  })
    .select("chat user sourceId first_inbound_at last_inbound_at")
    .sort({ last_inbound_at: -1, first_inbound_at: -1 })
    .limit(limit)
    .lean()) as ConversationBackfillRow[];

  const operations: AnyBulkWriteOperation[] = [];
  const seenChatIds = new Set<string>();
  for (const conversation of conversations) {
    const chatId = normalizeTelegramSubscriberChatId(conversation.chat);
    if (
      !chatId ||
      !isTelegramPrivateSubscriberChatId(chatId) ||
      seenChatIds.has(chatId)
    ) {
      continue;
    }
    seenChatIds.add(chatId);
    const firstSeenAt =
      toDate(conversation.first_inbound_at) ||
      toDate(conversation.last_inbound_at) ||
      new Date();
    operations.push({
      updateOne: {
        filter: {
          workspaceId: params.workspaceId,
          sourceId: params.sourceId,
          chatId,
        },
        update: {
          $set: {
            telegramUserId: chatId,
            origin: "conversation_backfill",
            status: "active",
            lastSeenAt: toDate(conversation.last_inbound_at) || firstSeenAt,
          },
          $setOnInsert: {
            workspaceId: params.workspaceId,
            sourceId: params.sourceId,
            chatId,
            displayName: chatId,
            firstSeenAt,
          },
        },
        upsert: true,
      },
    });
  }

  if (operations.length === 0)
    return { upserted: 0, scanned: conversations.length };
  const result = await TelegramSubscriber.bulkWrite(operations, {
    ordered: false,
  });
  return {
    upserted: result.upsertedCount || 0,
    scanned: conversations.length,
  };
}

export function scheduleTelegramSubscriberBackfill(params: {
  workspaceId: string;
  sourceId: string;
  reason: string;
  limit?: number;
}): boolean {
  const sourceId = params.sourceId.trim();
  if (!params.workspaceId || !sourceId) return false;

  const now = Date.now();
  pruneScheduledConversationBackfills(now);
  const key = `${params.workspaceId}:${sourceId}`;
  const lastScheduledAt = scheduledConversationBackfills.get(key) ?? 0;
  if (now - lastScheduledAt < CONVERSATION_BACKFILL_SCHEDULE_TTL_MS) {
    return false;
  }

  scheduledConversationBackfills.set(key, now);
  const run = async () => {
    try {
      await backfillTelegramSubscribersFromConversations({
        workspaceId: params.workspaceId,
        sourceId,
        limit: params.limit,
      });
    } catch (error) {
      logger.warn("Failed to backfill Telegram subscribers after response", {
        workspaceId: params.workspaceId,
        sourceId,
        reason: params.reason,
        error,
      });
    }
  };

  try {
    after(run);
  } catch {
    void run();
  }

  return true;
}

export async function listTelegramSubscribers(params: {
  workspaceId: string;
  sourceId: string;
  search?: string;
  limit?: number;
}): Promise<SubscriberLeanRow[]> {
  await connectDB();
  const limit = Math.min(
    1000,
    Math.max(1, Math.floor(params.limit || DEFAULT_LIST_LIMIT))
  );
  const query: Record<string, unknown> = {
    workspaceId: params.workspaceId,
    sourceId: params.sourceId,
  };
  const search = params.search?.trim();
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "i");
    query.$or = [
      { chatId: regex },
      { displayName: regex },
      { username: regex },
      { firstName: regex },
      { lastName: regex },
    ];
  }

  return (await TelegramSubscriber.find(query)
    .sort({ lastSeenAt: -1, importedAt: -1, createdAt: -1 })
    .limit(limit)
    .lean()) as unknown as SubscriberLeanRow[];
}

export async function countTelegramSubscribers(params: {
  workspaceId: string;
  sourceId: string;
  search?: string;
}): Promise<number> {
  await connectDB();
  const query: Record<string, unknown> = {
    workspaceId: params.workspaceId,
    sourceId: params.sourceId,
  };
  const search = params.search?.trim();
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "i");
    query.$or = [
      { chatId: regex },
      { displayName: regex },
      { username: regex },
      { firstName: regex },
      { lastName: regex },
    ];
  }

  return TelegramSubscriber.countDocuments(query);
}

export async function getLatestTelegramSubscriberImportBatch(params: {
  workspaceId: string;
  sourceId: string;
}): Promise<TelegramSubscriberImportBatchSummary | null> {
  await connectDB();
  const batch = await TelegramSubscriberImportBatch.findOne({
    workspaceId: params.workspaceId,
    sourceId: params.sourceId,
  })
    .sort({ createdAt: -1 })
    .lean();

  if (!batch) return null;

  const row = batch as unknown as TelegramSubscriberImportBatchSummary & {
    _id?: { toString: () => string };
  };
  return {
    id: row._id?.toString() || row.id,
    status: row.status,
    fileName: row.fileName,
    totalRows: row.totalRows || 0,
    validRows: row.validRows || 0,
    invalidRows: row.invalidRows || 0,
    duplicateRows: row.duplicateRows || 0,
    insertedRows: row.insertedRows || 0,
    updatedRows: row.updatedRows || 0,
    createdAt: row.createdAt || null,
    completedAt: row.completedAt || null,
    failedAt: row.failedAt || null,
    failureReason: row.failureReason || null,
  };
}

export async function fetchTelegramSubscriberContacts(params: {
  workspaceId: string;
  sourceIds: string[];
  search?: string;
  limit?: number;
}): Promise<TelegramSubscriberContactRow[]> {
  await connectDB();
  const sourceIds = normalizeSourceIds(params.sourceIds);
  const query: Record<string, unknown> = {
    workspaceId: params.workspaceId,
    status: { $in: ELIGIBLE_SUBSCRIBER_STATUSES },
  };
  if (sourceIds.length > 0) {
    query.sourceId = { $in: sourceIds };
  }
  const search = params.search?.trim();
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "i");
    query.$or = [
      { chatId: regex },
      { displayName: regex },
      { username: regex },
      { firstName: regex },
      { lastName: regex },
    ];
  }

  const rows = (await TelegramSubscriber.find(query)
    .sort({ lastSeenAt: -1, importedAt: -1, createdAt: -1 })
    .limit(Math.min(1000, Math.max(1, params.limit || DEFAULT_LIST_LIMIT)))
    .lean()) as unknown as SubscriberLeanRow[];

  return rows.map(row => ({
    identifier: row.chatId,
    channel: "telegram",
    sourceId: row.sourceId,
    name: displayNameFromParts({
      chatId: row.chatId,
      displayName: row.displayName,
      firstName: row.firstName,
      lastName: row.lastName,
      username: row.username,
    }),
    status: row.status,
    origin: row.origin,
  }));
}

export async function findEligibleTelegramSubscriberMap(params: {
  workspaceId: string;
  sourceIds: string[];
  chatIds: string[];
}): Promise<
  Map<
    string,
    {
      chatId: string;
      sourceId: string;
      status: TelegramSubscriberStatus;
    }
  >
> {
  await connectDB();
  const sourceIds = normalizeSourceIds(params.sourceIds);
  const chatIds = Array.from(
    new Set(
      params.chatIds
        .map(normalizeTelegramSubscriberChatId)
        .filter(isTelegramPrivateSubscriberChatId)
    )
  );
  if (sourceIds.length === 0 || chatIds.length === 0) return new Map();

  const rows = (await TelegramSubscriber.find({
    workspaceId: params.workspaceId,
    sourceId: { $in: sourceIds },
    chatId: { $in: chatIds },
    status: { $in: ELIGIBLE_SUBSCRIBER_STATUSES },
  })
    .select("chatId sourceId status")
    .lean()) as unknown as Array<{
    chatId: string;
    sourceId: string;
    status: TelegramSubscriberStatus;
  }>;

  return new Map(rows.map(row => [`${row.chatId}:${row.sourceId}`, row]));
}

export async function findTelegramSubscriberStatusMap(params: {
  workspaceId: string;
  sourceIds: string[];
  chatIds: string[];
}): Promise<
  Map<
    string,
    {
      chatId: string;
      sourceId: string;
      status: TelegramSubscriberStatus;
    }
  >
> {
  await connectDB();
  const sourceIds = normalizeSourceIds(params.sourceIds);
  const chatIds = Array.from(
    new Set(
      params.chatIds
        .map(normalizeTelegramSubscriberChatId)
        .filter(isTelegramPrivateSubscriberChatId)
    )
  );
  if (sourceIds.length === 0 || chatIds.length === 0) return new Map();

  const rows = (await TelegramSubscriber.find({
    workspaceId: params.workspaceId,
    sourceId: { $in: sourceIds },
    chatId: { $in: chatIds },
  })
    .select("chatId sourceId status")
    .lean()) as unknown as Array<{
    chatId: string;
    sourceId: string;
    status: TelegramSubscriberStatus;
  }>;

  return new Map(rows.map(row => [`${row.chatId}:${row.sourceId}`, row]));
}

export async function resolveTelegramSubscribersAudience(params: {
  workspaceId: string;
  sourceId: string;
  selectedChatIds?: string[];
}) {
  await connectDB();
  scheduleTelegramSubscriberBackfill({
    workspaceId: params.workspaceId,
    sourceId: params.sourceId,
    reason: "telegram_subscriber_audience",
  });
  const query: Record<string, unknown> = {
    workspaceId: params.workspaceId,
    sourceId: params.sourceId,
    status: { $in: ELIGIBLE_SUBSCRIBER_STATUSES },
  };
  const selectedChatIds = (params.selectedChatIds || [])
    .map(normalizeTelegramSubscriberChatId)
    .filter(isTelegramPrivateSubscriberChatId);
  if (selectedChatIds.length > 0) {
    query.chatId = { $in: Array.from(new Set(selectedChatIds)) };
  }

  const rows = (await TelegramSubscriber.find(query)
    .sort({ lastSeenAt: -1, importedAt: -1, createdAt: -1 })
    .limit(MAX_AUDIENCE_RECIPIENTS)
    .lean()) as unknown as SubscriberLeanRow[];

  return {
    total: rows.length,
    recipients: rows.map(row => ({
      chatId: row.chatId,
      sourceId: row.sourceId,
      name: displayNameFromParts({
        chatId: row.chatId,
        displayName: row.displayName,
        firstName: row.firstName,
        lastName: row.lastName,
        username: row.username,
      }),
      fields: {
        name: displayNameFromParts({
          chatId: row.chatId,
          displayName: row.displayName,
          firstName: row.firstName,
          lastName: row.lastName,
          username: row.username,
        }),
        username: row.username || "",
        first_name: row.firstName || "",
        last_name: row.lastName || "",
        chat_id: row.chatId,
      },
      variables: {
        name: displayNameFromParts({
          chatId: row.chatId,
          displayName: row.displayName,
          firstName: row.firstName,
          lastName: row.lastName,
          username: row.username,
        }),
        username: row.username || "",
        first_name: row.firstName || "",
        last_name: row.lastName || "",
        chat_id: row.chatId,
      },
    })),
  };
}

export function classifyTelegramSendFailure(error: string | null | undefined): {
  status: TelegramSubscriberStatus | null;
  code: string | null;
} {
  const text = String(error || "").toLowerCase();
  if (!text) return { status: null, code: null };
  if (text.includes("bot was blocked") || text.includes("bot blocked")) {
    return { status: "blocked", code: "bot_blocked" };
  }
  if (
    text.includes("chat not found") ||
    text.includes("user not found") ||
    text.includes("recipient not found")
  ) {
    return { status: "invalid", code: "chat_not_found" };
  }
  if (text.includes("forbidden")) {
    return { status: "suppressed", code: "forbidden" };
  }
  if (text.includes("too many requests") || text.includes("429")) {
    return { status: null, code: "rate_limited" };
  }
  return { status: null, code: "transient_error" };
}

export async function markTelegramSubscriberSendResult(params: {
  workspaceId: string;
  sourceId?: string | null;
  chatId?: string | null;
  success: boolean;
  error?: string | null;
}) {
  const sourceId = params.sourceId?.trim();
  const chatId = normalizeTelegramSubscriberChatId(params.chatId);
  if (!sourceId || !chatId || !isTelegramPrivateSubscriberChatId(chatId)) {
    return;
  }

  const now = new Date();
  const failure = classifyTelegramSendFailure(params.error);
  const update: Record<string, unknown> = params.success
    ? {
        $set: {
          status: "active",
          invalidReason: null,
          lastSendAttemptAt: now,
          lastSuccessfulSendAt: now,
          lastSendError: null,
          lastSendErrorCode: null,
        },
      }
    : {
        $set: {
          lastSendAttemptAt: now,
          lastSendError: params.error || "Telegram send failed",
          lastSendErrorCode: failure.code,
          ...(failure.status ? { status: failure.status } : {}),
          ...(failure.status === "invalid"
            ? { invalidReason: params.error || "Telegram send failed" }
            : {}),
        },
      };

  try {
    await connectDB();
    await TelegramSubscriber.updateOne(
      { workspaceId: params.workspaceId, sourceId, chatId },
      update
    );
  } catch (error) {
    logger.warn("Failed to update Telegram subscriber send result", {
      workspaceId: params.workspaceId,
      sourceId,
      chatId,
      error,
    });
  }
}
