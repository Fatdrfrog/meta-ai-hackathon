/** Thread and message persistence for Airi chat turns. */

import type { Types } from "mongoose";
import { throwIfCancelled } from "@/lib/ai/cancellation";
import {
  AIRI_CHAT_MESSAGE_CONTENT_MAX_LENGTH,
  AiriChatMessage,
} from "@/models/airi-chat-message";
import { truncateToCharBudget } from "@/lib/airi/shared/token-budget";
import {
  AiriChatThread,
  type AiriChatThreadSource,
} from "@/models/airi-chat-thread";
import type {
  GeneratedAiriChatReply,
  SerializedAiriChatThread,
  SerializedAiriChatMessage,
  ThreadLike,
  MessageLike,
} from "./types";
import {
  serializeAiriChatThread,
  serializeAiriChatMessage,
} from "./serialization";

/** The partial report a Meta Ads turn saves itself when it is stopped. */
function isAiriMetaAdsCancellationReport(
  metadata: Record<string, unknown>
): boolean {
  const coverage = metadata.airiMetaAdsMcpCoverage;
  return Boolean(
    metadata.intent === "meta_ads_mcp" &&
      coverage &&
      typeof coverage === "object" &&
      "complete" in coverage &&
      coverage.complete === false &&
      "reasons" in coverage &&
      Array.isArray(coverage.reasons) &&
      coverage.reasons.includes("cancelled")
  );
}

/**
 * A reply that records a Stop: the run layer's stopped reply
 * (metadata.cancelled) or a Meta Ads partial cancellation report. A normal
 * answer is never one, even when the Stop arrived after it was saved.
 */
export function isAiriChatCancelledReply(
  metadata: Record<string, unknown> | null | undefined
): boolean {
  if (!metadata) return false;
  return (
    metadata.cancelled === true || isAiriMetaAdsCancellationReport(metadata)
  );
}

export function assertAiriChatReplyCanBeSaved(
  reply: GeneratedAiriChatReply,
  signal?: AbortSignal
): void {
  // The MCP loop can deliberately return a partial cancellation report to save.
  if (isAiriMetaAdsCancellationReport(reply.metadata)) return;
  throwIfCancelled(signal);
}

export const AIRI_CHAT_SHORTENED_REPLY_SUFFIX = "\n\n[...]";

/**
 * A generated answer can be longer than a stored chat message (the Meta
 * summary allows 32k chars and the general answer has no output cap).
 * Shorten it at a sentence boundary instead of failing the insert after the
 * whole generation already ran.
 */
export function clampAiriChatReplyForStorage<
  T extends { content: string; metadata: Record<string, unknown> },
>(reply: T): T {
  const content = reply.content.trim();
  if (content.length <= AIRI_CHAT_MESSAGE_CONTENT_MAX_LENGTH) return reply;
  const shortened = truncateToCharBudget(
    content,
    AIRI_CHAT_MESSAGE_CONTENT_MAX_LENGTH -
      AIRI_CHAT_SHORTENED_REPLY_SUFFIX.length
  );
  return {
    ...reply,
    content: `${shortened}${AIRI_CHAT_SHORTENED_REPLY_SUFFIX}`,
    metadata: {
      ...reply.metadata,
      contentShortened: { originalLength: content.length },
    },
  };
}

export function isDefaultAiriChatTitle(title: unknown): boolean {
  const normalized = String(title ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return (
    !normalized ||
    normalized === "new chat" ||
    normalized === "new thread" ||
    normalized === "untitled chat"
  );
}

export function buildAiriChatTitle(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return "New chat";
  return normalized.length > 64 ? `${normalized.slice(0, 61)}...` : normalized;
}

export async function listAiriChatThreads(params: {
  workspaceId: string;
  userId: string;
}): Promise<SerializedAiriChatThread[]> {
  const threads = await AiriChatThread.find({
    workspaceId: params.workspaceId,
    createdByUserId: params.userId,
    status: "active",
  })
    .sort({ pinnedAt: -1, updatedAt: -1 })
    .limit(50)
    .lean<ThreadLike[]>();

  const defaultTitleThreadIds = threads
    .filter(thread => isDefaultAiriChatTitle(thread.title))
    .map(thread => thread._id);
  const fallbackTitles =
    defaultTitleThreadIds.length > 0
      ? await AiriChatMessage.aggregate<{
          _id: unknown;
          content?: string | null;
        }>([
          {
            $match: {
              workspaceId: params.workspaceId,
              threadId: { $in: defaultTitleThreadIds },
              role: "user",
            },
          },
          { $sort: { createdAt: 1 } },
          { $group: { _id: "$threadId", content: { $first: "$content" } } },
        ])
      : [];
  const fallbackTitleEntries: Array<[string, string]> = fallbackTitles
    .map((item): [string, string] => [
      String(item._id),
      buildAiriChatTitle(item.content || ""),
    ])
    .filter(([, title]) => !isDefaultAiriChatTitle(title));
  const fallbackTitleByThreadId = new Map<string, string>(fallbackTitleEntries);

  return threads.map(thread => {
    const serialized = serializeAiriChatThread(thread);
    const fallbackTitle = fallbackTitleByThreadId.get(String(thread._id));
    return fallbackTitle ? { ...serialized, title: fallbackTitle } : serialized;
  });
}

export function createAiriChatThreadDocument(params: {
  workspaceId: string;
  userId: string;
  title?: string | null;
  source?: AiriChatThreadSource | null;
  /** An id allocated up front (a durable run records it first). */
  id?: Types.ObjectId;
}) {
  return AiriChatThread.create({
    ...(params.id ? { _id: params.id } : {}),
    workspaceId: params.workspaceId,
    createdByUserId: params.userId,
    title: params.title?.trim() || "New chat",
    source: params.source || "manual",
    status: "active",
  });
}

export async function createAiriChatThread(params: {
  workspaceId: string;
  userId: string;
  title?: string | null;
  source?: AiriChatThreadSource | null;
}): Promise<SerializedAiriChatThread> {
  const thread = await createAiriChatThreadDocument(params);
  return serializeAiriChatThread(thread as unknown as ThreadLike);
}

export async function getAiriChatThreadForUser(params: {
  workspaceId: string;
  userId: string;
  threadId: string;
}) {
  return AiriChatThread.findOne({
    _id: params.threadId,
    workspaceId: params.workspaceId,
    createdByUserId: params.userId,
    status: "active",
  });
}

export async function listAiriChatMessages(params: {
  workspaceId: string;
  threadId: string;
  recent?: boolean;
}): Promise<SerializedAiriChatMessage[]> {
  const messages = await AiriChatMessage.find({
    workspaceId: params.workspaceId,
    threadId: params.threadId,
  })
    .sort({ createdAt: params.recent ? -1 : 1 })
    .limit(200)
    .lean<MessageLike[]>();

  const serialized = messages.map(serializeAiriChatMessage);
  return params.recent ? serialized.reverse() : serialized;
}

/** Default and largest page of GET messages. */
export const AIRI_CHAT_MESSAGE_PAGE_DEFAULT_LIMIT = 50;
export const AIRI_CHAT_MESSAGE_PAGE_MAX_LIMIT = 100;

/**
 * One page of a thread, newest page first: the `limit` messages before the
 * `before` message (or the latest ones), returned oldest first, and whether
 * older messages remain. Ordered by createdAt with _id as the tie-break so a
 * cursor never skips or repeats a message created in the same millisecond.
 * An unknown cursor (another thread's message) yields an empty page.
 */
export async function listAiriChatMessagePage(params: {
  workspaceId: string;
  threadId: string;
  before?: string | null;
  limit?: number;
}): Promise<{ messages: SerializedAiriChatMessage[]; hasMore: boolean }> {
  const limit = Math.min(
    Math.max(
      1,
      Math.trunc(params.limit ?? AIRI_CHAT_MESSAGE_PAGE_DEFAULT_LIMIT)
    ),
    AIRI_CHAT_MESSAGE_PAGE_MAX_LIMIT
  );
  const threadFilter = {
    workspaceId: params.workspaceId,
    threadId: params.threadId,
  };
  let cursorFilter: Record<string, unknown> = {};
  if (params.before) {
    const cursor = await AiriChatMessage.findOne(
      { ...threadFilter, _id: params.before },
      { _id: 1, createdAt: 1 }
    ).lean<{ _id: unknown; createdAt?: Date | null } | null>();
    if (!cursor?.createdAt) return { messages: [], hasMore: false };
    cursorFilter = {
      $or: [
        { createdAt: { $lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, _id: { $lt: cursor._id } },
      ],
    };
  }
  const rows = await AiriChatMessage.find({ ...threadFilter, ...cursorFilter })
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean<MessageLike[]>();
  return {
    messages: rows.slice(0, limit).map(serializeAiriChatMessage).reverse(),
    hasMore: rows.length > limit,
  };
}

/**
 * Fields the per-turn history read needs: the prompt history and classifier
 * use role, content and the routing intent; the legacy Meta confirmation
 * fields rewrite a historical confirmation's content (see
 * toPublicAiriChatMessageContent). Traces, drafts and pending payloads stay
 * in the database.
 */
export const AIRI_CHAT_TURN_HISTORY_PROJECTION = {
  _id: 1,
  threadId: 1,
  workspaceId: 1,
  role: 1,
  content: 1,
  createdAt: 1,
  "metadata.intent": 1,
  "metadata.confirmedMutationId": 1,
  "metadata.confirmedToolName": 1,
  "metadata.confirmationStatus": 1,
} as const;

/** The latest messages of a thread for one turn, oldest first, projected. */
export async function listAiriChatTurnHistory(params: {
  workspaceId: string;
  threadId: string;
}): Promise<SerializedAiriChatMessage[]> {
  const messages = await AiriChatMessage.find(
    { workspaceId: params.workspaceId, threadId: params.threadId },
    AIRI_CHAT_TURN_HISTORY_PROJECTION
  )
    .sort({ createdAt: -1 })
    .limit(200)
    .lean<MessageLike[]>();
  return messages.map(serializeAiriChatMessage).reverse();
}

export async function archiveAiriChatThreadForUser(params: {
  workspaceId: string;
  userId: string;
  threadId: string;
}): Promise<boolean> {
  const result = await AiriChatThread.findOneAndUpdate(
    {
      _id: params.threadId,
      workspaceId: params.workspaceId,
      createdByUserId: params.userId,
      status: "active",
    },
    {
      $set: {
        status: "archived",
        pinnedAt: null,
      },
    },
    {
      new: false,
      projection: "_id",
    }
  ).lean<{ _id: unknown } | null>();

  return Boolean(result);
}

export type AiriChatThreadDocument = NonNullable<
  Awaited<ReturnType<typeof getAiriChatThreadForUser>>
>;

/**
 * One turn's thread write: bumps updatedAt (the recent list's order) and, for
 * a chat still on its default title, sets the first-message title. The title
 * is written only over the title this turn started from, so a rename or
 * another turn's title is never overwritten.
 */
export async function touchAiriChatThreadForTurn(params: {
  threadId: unknown;
  seenTitle: unknown;
  fallbackTitle: string | null;
  at: Date;
}): Promise<{ titled: boolean; at: Date }> {
  if (params.fallbackTitle) {
    const titled = await AiriChatThread.updateOne(
      { _id: params.threadId, title: params.seenTitle },
      { $set: { title: params.fallbackTitle, updatedAt: params.at } }
    );
    if (titled.matchedCount > 0) return { titled: true, at: params.at };
  }
  await AiriChatThread.updateOne(
    { _id: params.threadId },
    { $set: { updatedAt: params.at } }
  );
  return { titled: false, at: params.at };
}

export async function countSuccessfulAiriChatAnswers(params: {
  workspaceId: string;
  userId: string;
}): Promise<number> {
  const threads = await AiriChatThread.find({
    workspaceId: params.workspaceId,
    createdByUserId: params.userId,
    status: "active",
  })
    .select("_id")
    .lean<Array<{ _id: unknown }>>();

  if (threads.length === 0) return 0;

  const assistantMessagesCount = await AiriChatMessage.countDocuments({
    workspaceId: params.workspaceId,
    threadId: { $in: threads.map(thread => thread._id) },
    role: "assistant",
  });

  return assistantMessagesCount > 0 ? 1 : 0;
}
