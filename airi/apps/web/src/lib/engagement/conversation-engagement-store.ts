import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import connectDB from "@/lib/mongoose";
import { Conversation } from "@/models/conversation";
import { ConversationEngagementLease } from "@/models/conversation-engagement-lease";
import { ConversationEngagementState } from "@/models/conversation-engagement-state";
import Message from "@/models/message";
import mongoose, { type ClientSession } from "mongoose";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { RefreshConversationEngagementOptions } from "./conversation-engagement";
import {
  ENGAGEMENT_MESSAGE_SELECT,
  applyEngagementContribution,
  applyEngagementEdge,
  buildEngagementContribution,
  buildEngagementEdge,
  computeEngagementMetricsFromAccumulator,
  type ConversationEngagementMetrics,
  type EngagementAccumulator,
  type EngagementContribution,
  type EngagementEdge,
  type EngagementMessageInput,
} from "./conversation-engagement-metrics";
import {
  advanceEngagementBootstrap,
  bootstrapConversationEngagement,
  claimEngagementBootstrap,
  releaseEngagementBootstrap,
  invalidateEngagementContributionOwner,
} from "./conversation-engagement-bootstrap";

export type EngagementStoredMessage = EngagementMessageInput & {
  _id: mongoose.Types.ObjectId;
  engagementContribution?: EngagementContribution | null;
  engagementRefreshPending?: boolean;
};
export const ENGAGEMENT_PRIVATE_SELECT =
  "engagementContribution engagementRefreshPending";
export const ENGAGEMENT_TRANSACTION_OPTIONS = {
  readConcern: { level: "snapshot" as const },
  writeConcern: { w: "majority" as const },
};

export async function withEngagementTransaction<T>(
  operation: (session: ClientSession) => Promise<T>
): Promise<T> {
  const session = await Conversation.startSession();
  try {
    return (await session.withTransaction(
      () => operation(session),
      ENGAGEMENT_TRANSACTION_OPTIONS
    )) as T;
  } finally {
    await session.endSession();
  }
}

const engagementTurns = new Map<string, Promise<void>>();

/**
 * Every engagement transaction writes the conversation accumulator, so
 * same-conversation callbacks running side by side only abort and retry each
 * other while their message locks stall plain ingest writes.
 */
async function withConversationEngagementTurn<T>(
  conversationId: mongoose.Types.ObjectId,
  operation: () => Promise<T>
): Promise<T> {
  const key = String(conversationId);
  const previous = engagementTurns.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>(resolve => {
    release = resolve;
  });
  const tail = previous.then(() => turn);
  engagementTurns.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (engagementTurns.get(key) === tail) engagementTurns.delete(key);
  }
}

const ENGAGEMENT_LEASE_MS = 60_000;
/** Retries behind another owner; after the last one, maintenance drains the marker. */
const ENGAGEMENT_DEFERRED_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000];

type LeaseOutcome<T> = { acquired: true; value: T } | { acquired: false };

async function tryAcquireEngagementLease(
  conversationId: mongoose.Types.ObjectId,
  ownerToken: string,
  now = new Date()
): Promise<boolean> {
  try {
    // Every attempt uses a fresh token, so only a free (expired) row matches.
    const lease = await ConversationEngagementLease.findOneAndUpdate(
      { _id: String(conversationId), expiresAt: { $lte: now } },
      {
        $set: {
          ownerToken,
          expiresAt: new Date(now.getTime() + ENGAGEMENT_LEASE_MS),
        },
      },
      { upsert: true, new: true }
    )
      .lean<{ ownerToken?: string | null } | null>()
      .exec();
    return lease?.ownerToken === ownerToken;
  } catch (error) {
    // The upsert collides with a live lease row owned by another process.
    if (isMongoDuplicateKeyError(error)) return false;
    throw error;
  }
}

async function releaseEngagementLease(
  conversationId: mongoose.Types.ObjectId,
  ownerToken: string
): Promise<void> {
  await ConversationEngagementLease.updateOne(
    { _id: String(conversationId), ownerToken },
    { $set: { ownerToken: null, expiresAt: new Date() } }
  ).exec();
}

/**
 * Cross-instance companion to `withConversationEngagementTurn`. Two worker
 * instances (or a worker and the web app) refreshing one conversation abort
 * each other's snapshot transactions: 23-26% of them in a two-process repro,
 * 0% with one process. Correctness never depends on the lease, so when the
 * lease store itself fails the work runs unleased.
 */
async function withConversationEngagementLease<T>(
  conversationId: mongoose.Types.ObjectId,
  operation: () => Promise<T>
): Promise<LeaseOutcome<T>> {
  const ownerToken = randomUUID();
  let acquired: boolean;
  try {
    acquired = await tryAcquireEngagementLease(conversationId, ownerToken);
  } catch {
    return { acquired: true, value: await operation() };
  }
  if (!acquired) return { acquired: false };
  try {
    return { acquired: true, value: await operation() };
  } finally {
    await releaseEngagementLease(conversationId, ownerToken).catch(() => {
      // An unreleased lease expires on its own.
    });
  }
}

/** Saves and query updates mark the source atomically; this covers the rest. */
async function markEngagementPending(
  conversationId: mongoose.Types.ObjectId,
  messageId: mongoose.Types.ObjectId
): Promise<void> {
  await Message.updateOne(
    {
      _id: messageId,
      conversation: conversationId,
      engagementRefreshPending: { $ne: true },
    },
    { $set: { engagementRefreshPending: true } },
    { timestamps: false }
  ).exec();
}

type DeferredEngagementWork =
  | {
      kind: "refresh";
      messageId: mongoose.Types.ObjectId | null;
      options?: RefreshConversationEngagementOptions;
    }
  | { kind: "drain" };

const deferredWork = new Map<string, DeferredEngagementWork>();

/** A full rebuild covers everything; any refresh drains as much as a drain. */
function mergeDeferredWork(
  current: DeferredEngagementWork | undefined,
  next: DeferredEngagementWork
): DeferredEngagementWork {
  if (!current) return next;
  const isRebuild = (work: DeferredEngagementWork) =>
    work.kind === "refresh" && !work.messageId;
  if (isRebuild(current)) return current;
  if (isRebuild(next) || current.kind === "drain") return next;
  return current;
}

function runDeferredWork(
  conversationId: mongoose.Types.ObjectId,
  work: DeferredEngagementWork
): Promise<LeaseOutcome<unknown>> {
  return work.kind === "refresh"
    ? refreshUnderLease(conversationId, work.messageId, work.options)
    : drainUnderLease(conversationId);
}

/** One retry chain per conversation and process, behind the current owner. */
function deferEngagementWork(
  conversationId: mongoose.Types.ObjectId,
  work: DeferredEngagementWork
): void {
  const key = String(conversationId);
  const pending = deferredWork.has(key);
  deferredWork.set(key, mergeDeferredWork(deferredWork.get(key), work));
  if (pending) return;
  const attempt = (index: number) => {
    const delay = ENGAGEMENT_DEFERRED_RETRY_DELAYS_MS[index];
    if (delay === undefined) {
      // Durable pending markers are retried by webhook-drain maintenance.
      deferredWork.delete(key);
      return;
    }
    setTimeout(() => {
      const next = deferredWork.get(key);
      if (!next) return;
      void runDeferredWork(conversationId, next)
        .then(outcome => {
          if (outcome.acquired) deferredWork.delete(key);
          else attempt(index + 1);
        })
        .catch(() => {
          deferredWork.delete(key);
        });
    }, delay).unref?.();
  };
  attempt(0);
}

export type EngagementMetricsCopy = {
  revision: number;
  metrics: ConversationEngagementMetrics;
};

/**
 * Plain write after the state commit: ingest writes to the conversation never
 * conflict with an engagement transaction, and the revision keeps a slower
 * copy from replacing a newer one.
 */
export async function copyEngagementMetricsToConversation(
  conversationId: mongoose.Types.ObjectId,
  { revision, metrics }: EngagementMetricsCopy
): Promise<void> {
  await Conversation.updateOne(
    {
      _id: conversationId,
      $or: [
        { engagement_revision: { $lt: revision } },
        { engagement_revision: { $exists: false } },
      ],
    },
    {
      $set: {
        engagement_metrics: metrics,
        message_count: metrics.messageCount,
        ...(metrics.lastMessageAt
          ? { lastMessageAt: metrics.lastMessageAt }
          : {}),
        engagement_revision: revision,
      },
    }
  ).exec();
}

/** Ordered same-generation contributions, kept in Mongo or replayed in memory. */
type EngagementOrdering = {
  neighbor(
    messageId: mongoose.Types.ObjectId,
    date: Date,
    direction: 1 | -1
  ): Promise<EngagementStoredMessage | null>;
  setEdge(
    messageId: mongoose.Types.ObjectId,
    edge: EngagementEdge
  ): Promise<void>;
  detach(messageId: mongoose.Types.ObjectId): Promise<void>;
  /** A null contribution only clears the pending marker. */
  settle(
    messageId: mongoose.Types.ObjectId,
    contribution: EngagementContribution | null
  ): Promise<void>;
};

function contributionOrderFilter(
  conversationId: mongoose.Types.ObjectId,
  generation: string
) {
  return {
    conversation: conversationId,
    "engagementContribution.generation": generation,
    "engagementContribution.date": { $type: "date" },
  };
}

function storedOrdering(
  conversationId: mongoose.Types.ObjectId,
  generation: string,
  session: ClientSession
): EngagementOrdering {
  const write = async (
    messageId: mongoose.Types.ObjectId,
    set: Record<string, unknown>
  ) => {
    await Message.updateOne(
      { _id: messageId },
      { $set: set },
      { session, timestamps: false }
    ).exec();
  };
  return {
    neighbor(messageId, date, direction) {
      const comparison = direction === 1 ? "$gt" : "$lt";
      return Message.findOne({
        ...contributionOrderFilter(conversationId, generation),
        _id: { $ne: messageId },
        $or: [
          { "engagementContribution.date": { [comparison]: date } },
          {
            "engagementContribution.date": date,
            _id: { [comparison]: messageId },
          },
        ],
      })
        .select("_id engagementContribution")
        .sort({ "engagementContribution.date": direction, _id: direction })
        .session(session)
        .lean<EngagementStoredMessage | null>()
        .exec();
    },
    setEdge: (messageId, edge) =>
      write(messageId, { "engagementContribution.edge": edge }),
    detach: messageId => write(messageId, { engagementContribution: null }),
    settle: (messageId, contribution) =>
      write(
        messageId,
        contribution
          ? {
              engagementContribution: contribution,
              engagementRefreshPending: false,
            }
          : { engagementRefreshPending: false }
      ),
  };
}

async function replaceSuccessorEdge(
  successor: EngagementStoredMessage | null,
  previous: EngagementContribution | null,
  accumulator: EngagementAccumulator,
  ordering: EngagementOrdering
): Promise<void> {
  if (!successor?.engagementContribution) return;
  applyEngagementEdge(accumulator, successor.engagementContribution.edge, -1);
  const edge = buildEngagementEdge(previous, successor.engagementContribution);
  applyEngagementEdge(accumulator, edge);
  await ordering.setEdge(successor._id, edge);
}

export async function readEngagementBounds(
  conversationId: mongoose.Types.ObjectId,
  generation: string,
  session: ClientSession
) {
  const filter = {
    conversation: conversationId,
    "engagementContribution.generation": generation,
    "engagementContribution.date": { $type: "date" },
  };
  const first = await Message.findOne(filter)
    .select("_id engagementContribution")
    .sort({ "engagementContribution.date": 1, _id: 1 })
    .session(session)
    .lean<EngagementStoredMessage | null>()
    .exec();
  const last = await Message.findOne(filter)
    .select("_id engagementContribution")
    .sort({ "engagementContribution.date": -1, _id: -1 })
    .session(session)
    .lean<EngagementStoredMessage | null>()
    .exec();
  const reply = await Message.findOne({
    ...filter,
    "engagementContribution.edge.customerRepliesAfterOutbound": 1,
  })
    .select("_id engagementContribution")
    .sort({ "engagementContribution.date": 1, _id: 1 })
    .session(session)
    .lean<EngagementStoredMessage | null>()
    .exec();
  return {
    firstMessageAt: first?.engagementContribution?.date ?? null,
    lastMessageAt: last?.engagementContribution?.date ?? null,
    firstReplyDelayMilliseconds:
      reply?.engagementContribution?.edge.replyDelayMilliseconds ?? null,
  };
}

type StoredAccumulator =
  | EngagementAccumulator
  | import("./conversation-engagement-bootstrap").EngagementBootstrapState;

/** A conversation's legacy state fields, read only to adopt them. */
export type StoredEngagementConversation = {
  _id: mongoose.Types.ObjectId;
  workspaceId?: string | null;
  engagement_accumulator?: StoredAccumulator;
  engagement_metrics?: ConversationEngagementMetrics | null;
  engagement_revision?: number;
};

export type StoredEngagementState = {
  _id: mongoose.Types.ObjectId;
  engagement_accumulator?: StoredAccumulator;
  engagement_metrics?: ConversationEngagementMetrics | null;
  revision?: number;
};

/** One contribution edit; the ordering decides whether neighbors and writes hit Mongo or memory. */
async function applyContributionEdit(
  conversationId: mongoose.Types.ObjectId,
  message: EngagementStoredMessage,
  state: EngagementAccumulator,
  ordering: EngagementOrdering,
  session: ClientSession
): Promise<boolean> {
  const messageId = message._id;
  const priorOwner = message.engagementContribution?.conversationId;
  if (priorOwner && priorOwner !== String(conversationId)) {
    await invalidateEngagementContributionOwner(
      priorOwner,
      message.engagementContribution!.generation,
      session
    );
  }
  const old =
    message.engagementContribution?.generation === state.generation
      ? message.engagementContribution
      : null;
  const next = buildEngagementContribution(message, state.generation);
  next.conversationId = String(conversationId);
  const topologyUnchanged =
    old &&
    Number(old.date) === Number(next.date) &&
    old.direction === next.direction &&
    old.campaign === next.campaign;
  if (topologyUnchanged) {
    next.edge = old.edge;
    if (isDeepStrictEqual(old, next)) {
      await ordering.settle(messageId, null);
      return false;
    }
    applyEngagementContribution(state, old, -1);
    applyEngagementContribution(state, next);
  } else {
    if (old) {
      applyEngagementContribution(state, old, -1);
      if (old.date) {
        const before = await ordering.neighbor(messageId, old.date, -1);
        const after = await ordering.neighbor(messageId, old.date, 1);
        await replaceSuccessorEdge(
          after,
          before?.engagementContribution ?? null,
          state,
          ordering
        );
      }
      // Remove the old ordering key before finding the insertion neighbors.
      await ordering.detach(messageId);
    }
    if (next.date) {
      const before = await ordering.neighbor(messageId, next.date, -1);
      const after = await ordering.neighbor(messageId, next.date, 1);
      next.edge = buildEngagementEdge(
        before?.engagementContribution ?? null,
        next
      );
      await replaceSuccessorEdge(after, next, state, ordering);
    }
    applyEngagementContribution(state, next);
  }
  await ordering.settle(messageId, next);
  return true;
}

async function updateEngagementContribution(
  conversationId: mongoose.Types.ObjectId,
  messageId: mongoose.Types.ObjectId,
  state: EngagementAccumulator,
  session: ClientSession
): Promise<boolean> {
  const message = await Message.findOne({
    _id: messageId,
    conversation: conversationId,
  })
    .select(`${ENGAGEMENT_MESSAGE_SELECT} ${ENGAGEMENT_PRIVATE_SELECT}`)
    .session(session)
    .lean<EngagementStoredMessage | null>()
    .exec();
  if (!message) return false;
  return applyContributionEdit(
    conversationId,
    message,
    state,
    storedOrdering(conversationId, state.generation, session),
    session
  );
}

/** Beyond this many overlapping earlier contributions a page keeps the per-message path. */
export const ENGAGEMENT_PAGE_PRIOR_LIMIT = 1_000;

type PageEntry = {
  id: mongoose.Types.ObjectId;
  initial: EngagementContribution | null | undefined;
  contribution: EngagementContribution | null | undefined;
  onPage: boolean;
  edgeChanged: boolean;
};

function orderedDate(
  contribution: EngagementContribution | null | undefined,
  generation: string
): Date | null {
  return contribution?.generation === generation &&
    contribution.date instanceof Date
    ? contribution.date
    : null;
}

function compareOrder(
  leftDate: Date,
  leftId: string,
  rightDate: Date,
  rightId: string
): number {
  return (
    leftDate.getTime() - rightDate.getTime() ||
    (leftId < rightId ? -1 : leftId > rightId ? 1 : 0)
  );
}

/** Mirrors the stored neighbor query: same generation, dated, ordered by date then _id. */
function memoryOrdering(
  entries: Map<string, PageEntry>,
  generation: string
): EngagementOrdering {
  const entry = (messageId: mongoose.Types.ObjectId) =>
    entries.get(String(messageId))!;
  return {
    async neighbor(messageId, date, direction) {
      const self = String(messageId);
      let best: { key: string; date: Date; entry: PageEntry } | null = null;
      for (const [key, candidate] of entries) {
        const candidateDate = orderedDate(candidate.contribution, generation);
        if (key === self || !candidateDate) continue;
        if (compareOrder(candidateDate, key, date, self) * direction <= 0)
          continue;
        if (
          !best ||
          compareOrder(candidateDate, key, best.date, best.key) * direction < 0
        )
          best = { key, date: candidateDate, entry: candidate };
      }
      return best
        ? ({
            _id: best.entry.id,
            engagementContribution: best.entry.contribution,
          } as EngagementStoredMessage)
        : null;
    },
    async setEdge(messageId, edge) {
      const target = entry(messageId);
      target.contribution = { ...target.contribution!, edge };
      target.edgeChanged = true;
    },
    async detach(messageId) {
      entry(messageId).contribution = null;
    },
    async settle(messageId, contribution) {
      if (contribution) entry(messageId).contribution = contribution;
    },
  };
}

async function loadPriorContributions(
  conversationId: mongoose.Types.ObjectId,
  messages: EngagementStoredMessage[],
  generation: string,
  session: ClientSession
): Promise<EngagementStoredMessage[] | null> {
  // Every neighbor lookup happens at a page message's old or new date.
  const times = messages
    .flatMap(message => [
      buildEngagementContribution(message, generation).date,
      orderedDate(message.engagementContribution, generation),
    ])
    .filter((date): date is Date => date instanceof Date)
    .map(date => date.getTime());
  if (times.length === 0) return [];
  const first = new Date(Math.min(...times));
  const last = new Date(Math.max(...times));
  const ordered = contributionOrderFilter(conversationId, generation);
  const read = (
    range: Record<string, Date>,
    direction: 1 | -1,
    limit: number
  ) =>
    Message.find({ ...ordered, "engagementContribution.date": range })
      .select("_id engagementContribution")
      .sort({ "engagementContribution.date": direction, _id: direction })
      .limit(limit)
      .session(session)
      .lean<EngagementStoredMessage[]>()
      .exec();
  const window = await read(
    { $gte: first, $lte: last },
    1,
    ENGAGEMENT_PAGE_PRIOR_LIMIT + 1
  );
  if (window.length > ENGAGEMENT_PAGE_PRIOR_LIMIT) return null;
  // Sequential on purpose: one transaction session cannot run operations in parallel.
  const before = await read({ $lt: first }, -1, 1);
  const after = await read({ $gt: last }, 1, 1);
  return [...before, ...window, ...after];
}

/**
 * Bootstrap and drain pages replay the per-message edits in memory and commit
 * them in one bulk write, so a page takes a few round trips instead of several
 * per message. Resolves whether any contribution changed.
 */
export async function applyEngagementContributionPage(
  conversationId: mongoose.Types.ObjectId,
  messages: EngagementStoredMessage[],
  state: EngagementAccumulator,
  session: ClientSession,
  options: { priorPagesCommitted: boolean; heartbeat?: () => void }
): Promise<boolean> {
  let changed = false;
  const entries = new Map<string, PageEntry>();
  for (const message of messages)
    entries.set(String(message._id), {
      id: message._id,
      initial: message.engagementContribution,
      contribution: message.engagementContribution,
      onPage: true,
      edgeChanged: false,
    });
  // A fresh generation has no contributions outside its first page.
  if (options.priorPagesCommitted) {
    const prior = await loadPriorContributions(
      conversationId,
      messages,
      state.generation,
      session
    );
    if (!prior) {
      for (const message of messages) {
        options.heartbeat?.();
        changed =
          (await updateEngagementContribution(
            conversationId,
            message._id,
            state,
            session
          )) || changed;
      }
      return changed;
    }
    for (const message of prior)
      if (!entries.has(String(message._id)))
        entries.set(String(message._id), {
          id: message._id,
          initial: message.engagementContribution,
          contribution: message.engagementContribution,
          onPage: false,
          edgeChanged: false,
        });
  }
  const ordering = memoryOrdering(entries, state.generation);
  // In order: each edit reads the ordering and accumulator the previous edit left.
  for (const message of messages) {
    options.heartbeat?.();
    changed =
      (await applyContributionEdit(
        conversationId,
        {
          ...message,
          engagementContribution: entries.get(String(message._id))!
            .contribution,
        },
        state,
        ordering,
        session
      )) || changed;
  }
  const writes = [...entries.values()].flatMap(entry => {
    const set = entry.onPage
      ? isDeepStrictEqual(entry.contribution, entry.initial)
        ? { engagementRefreshPending: false }
        : {
            engagementContribution: entry.contribution,
            engagementRefreshPending: false,
          }
      : entry.edgeChanged
        ? { "engagementContribution.edge": entry.contribution!.edge }
        : null;
    return set
      ? [
          {
            updateOne: {
              filter: { _id: entry.id },
              update: { $set: set },
              timestamps: false,
            },
          },
        ]
      : [];
  });
  if (writes.length > 0) await Message.bulkWrite(writes, { session });
  return changed;
}

/** Pending messages settled per transaction; a page costs about ten round trips. */
export const ENGAGEMENT_DRAIN_PAGE_SIZE = 50;

type EngagementDrainPage = {
  processed: number;
  hasMore: boolean;
  metrics: ConversationEngagementMetrics | null;
};

/**
 * Settles one page of a ready conversation's pending messages. The transaction
 * writes the messages and the state document only, so ingest writes landing on
 * the conversation meanwhile can't abort it.
 */
export async function applyPendingEngagementPage(
  conversationId: mongoose.Types.ObjectId
): Promise<EngagementDrainPage | null> {
  const page = await withEngagementTransaction(async session => {
    const stored = await ConversationEngagementState.findOne({
      _id: conversationId,
    })
      .select("_id engagement_accumulator engagement_metrics revision")
      .session(session)
      .lean<StoredEngagementState | null>()
      .exec();
    const state = stored?.engagement_accumulator;
    if (!state || state.version !== 1 || state.phase !== "ready") return null;
    const pending = await Message.find({
      conversation: conversationId,
      engagementRefreshPending: true,
    })
      .select(`${ENGAGEMENT_MESSAGE_SELECT} ${ENGAGEMENT_PRIVATE_SELECT}`)
      .sort({ _id: 1 })
      .limit(ENGAGEMENT_DRAIN_PAGE_SIZE + 1)
      .session(session)
      .lean<EngagementStoredMessage[]>()
      .exec();
    const messages = pending.slice(0, ENGAGEMENT_DRAIN_PAGE_SIZE);
    const unchanged = {
      processed: messages.length,
      hasMore: pending.length > messages.length,
      metrics: stored!.engagement_metrics ?? null,
      copy: null,
    };
    if (messages.length === 0) return unchanged;
    if (
      !(await applyEngagementContributionPage(
        conversationId,
        messages,
        state,
        session,
        { priorPagesCommitted: true }
      ))
    )
      return unchanged;
    const metrics = computeEngagementMetricsFromAccumulator(
      state,
      await readEngagementBounds(conversationId, state.generation, session)
    );
    const revision = (stored!.revision ?? 0) + 1;
    await ConversationEngagementState.updateOne(
      { _id: conversationId },
      {
        $set: {
          engagement_accumulator: state,
          engagement_metrics: metrics,
          revision,
        },
      },
      { session }
    ).exec();
    return { ...unchanged, metrics, copy: { revision, metrics } };
  });
  if (!page) return null;
  if (page.copy)
    await copyEngagementMetricsToConversation(conversationId, page.copy);
  return {
    processed: page.processed,
    hasMore: page.hasMore,
    metrics: page.metrics,
  };
}

const scheduledDrains = new Set<string>();
function schedulePendingDrain(conversationId: mongoose.Types.ObjectId): void {
  const key = String(conversationId);
  if (scheduledDrains.has(key)) return;
  scheduledDrains.add(key);
  setImmediate(() => {
    void drainUnderLease(conversationId)
      .then(outcome => {
        scheduledDrains.delete(key);
        if (!outcome.acquired)
          deferEngagementWork(conversationId, { kind: "drain" });
        else if (outcome.value) schedulePendingDrain(conversationId);
      })
      .catch(() => {
        // Durable pending markers are retried by webhook-drain maintenance.
        scheduledDrains.delete(key);
      });
  });
}

export async function drainPendingEngagement(
  conversationId: mongoose.Types.ObjectId,
  limit = 100
): Promise<{
  hasMore: boolean;
  metrics: ConversationEngagementMetrics | null;
}> {
  let metrics: ConversationEngagementMetrics | null = null;
  for (let processed = 0; processed < limit; ) {
    const page = await applyPendingEngagementPage(conversationId);
    if (!page) return { hasMore: false, metrics };
    metrics = page.metrics;
    if (!page.hasMore) return { hasMore: false, metrics };
    processed += page.processed;
  }
  return { hasMore: true, metrics };
}

function objectId(
  value: string | mongoose.Types.ObjectId | undefined
): mongoose.Types.ObjectId | null {
  if (value instanceof mongoose.Types.ObjectId) return value;
  return value && mongoose.Types.ObjectId.isValid(value)
    ? new mongoose.Types.ObjectId(value)
    : null;
}

/** The outcome's value says whether pending messages remain after this pass. */
function drainUnderLease(
  conversationId: mongoose.Types.ObjectId
): Promise<LeaseOutcome<boolean>> {
  return withConversationEngagementTurn(conversationId, () =>
    withConversationEngagementLease(
      conversationId,
      async () => (await drainPendingEngagement(conversationId)).hasMore
    )
  );
}

export async function refreshStoredConversationEngagement(
  conversationId: string | mongoose.Types.ObjectId,
  options?: RefreshConversationEngagementOptions
): Promise<ConversationEngagementMetrics | null> {
  const id = objectId(conversationId);
  const messageId = objectId(options?.messageId);
  if (!id || (options?.messageId && !messageId)) return null;
  await connectDB();
  const outcome = await refreshUnderLease(id, messageId, options);
  if (outcome.acquired) return outcome.value;
  // Another process owns this conversation's engagement work. Leave the
  // durable marker for it and look again shortly, behind it.
  if (messageId) await markEngagementPending(id, messageId);
  deferEngagementWork(id, { kind: "refresh", messageId, options });
  return null;
}

function refreshUnderLease(
  id: mongoose.Types.ObjectId,
  messageId: mongoose.Types.ObjectId | null,
  options?: RefreshConversationEngagementOptions
): Promise<LeaseOutcome<ConversationEngagementMetrics | null>> {
  return withConversationEngagementTurn(id, () =>
    withConversationEngagementLease(id, () =>
      refreshOwnedConversationEngagement(id, messageId, options)
    )
  );
}

async function refreshOwnedConversationEngagement(
  id: mongoose.Types.ObjectId,
  messageId: mongoose.Types.ObjectId | null,
  options?: RefreshConversationEngagementOptions
): Promise<ConversationEngagementMetrics | null> {
  const claim = await claimEngagementBootstrap(
    id,
    options?.workspaceId,
    messageId,
    !options?.messageId
  );
  if (!claim) return null;
  if (claim.phase === "building") {
    if (!claim.owned) return null;
    if (!options?.messageId) {
      await bootstrapConversationEngagement(id, claim.leaseToken);
    } else if (await advanceEngagementBootstrap(id, claim.leaseToken)) {
      await releaseEngagementBootstrap(id, claim.leaseToken);
      return null;
    }
  }
  // The claim marked this message pending, so the drain settles it with the rest.
  const drained = await drainPendingEngagement(id);
  if (drained.hasMore) schedulePendingDrain(id);
  return drained.metrics;
}

type PendingEngagementMessage = {
  _id: mongoose.Types.ObjectId;
  conversation?: mongoose.Types.ObjectId;
};
let pendingSeek: PendingEngagementMessage | null = null;

async function pendingRecoveryPage(
  limit: number
): Promise<PendingEngagementMessage[]> {
  async function read(after: PendingEngagementMessage | null) {
    const seek = after
      ? {
          $or: [
            after.conversation
              ? { conversation: { $gt: after.conversation } }
              : { conversation: { $type: "objectId" } },
            {
              conversation: after.conversation ?? null,
              _id: { $gt: after._id },
            },
          ],
        }
      : {};
    return Message.find({ engagementRefreshPending: true, ...seek })
      .select("_id conversation")
      .sort({ conversation: 1, _id: 1 })
      .limit(limit)
      .lean<PendingEngagementMessage[]>()
      .exec();
  }
  let page = await read(pendingSeek);
  if (page.length === 0 && pendingSeek) page = await read(null);
  // This seek is a fairness hint only; pending markers remain durable across process restarts.
  pendingSeek = page.at(-1) ?? null;
  return page;
}

async function clearOrphanPending(
  message: PendingEngagementMessage
): Promise<void> {
  await withEngagementTransaction(async session => {
    const filter = {
      _id: message._id,
      conversation: message.conversation ?? null,
      engagementRefreshPending: true,
    };
    const orphan = await Message.findOne(filter)
      .select("_id engagementContribution")
      .session(session)
      .lean<EngagementStoredMessage | null>()
      .exec();
    if (!orphan) return;
    const contribution = orphan.engagementContribution;
    if (contribution?.conversationId) {
      await invalidateEngagementContributionOwner(
        contribution.conversationId,
        contribution.generation,
        session
      );
    }
    await Message.updateOne(
      filter,
      { $set: { engagementRefreshPending: false } },
      { session, timestamps: false }
    ).exec();
  });
}

/** Recovery owns only pending work and existing bootstrap leases, with bounded commits. */
export async function drainPendingConversationEngagement(
  options: { limit?: number; now?: Date; heartbeat?: () => void } = {}
): Promise<{ processed: number; bootstrapsAdvanced: number }> {
  await connectDB();
  const limit = Number.isFinite(options.limit)
    ? Math.max(1, Math.min(100, Math.floor(options.limit!)))
    : 100;
  const now = options.now ?? new Date();
  const expiredFilter = {
    "engagement_accumulator.phase": "building",
    "engagement_accumulator.leaseUntil": { $lte: now },
  };
  const expiredOrder = {
    "engagement_accumulator.leaseUntil": 1,
    _id: 1,
  } as const;
  const expired = [
    ...(await ConversationEngagementState.find(expiredFilter)
      .select("_id")
      .sort(expiredOrder)
      .limit(1)
      .lean<Array<{ _id: mongoose.Types.ObjectId }>>()
      .exec()),
    // Leases an older deployment left on the conversation; claiming adopts them.
    ...(await Conversation.find(expiredFilter)
      .select("_id")
      .sort(expiredOrder)
      .limit(1)
      .lean<Array<{ _id: mongoose.Types.ObjectId }>>()
      .exec()),
  ];
  let bootstrapsAdvanced = 0;
  let processed = 0;
  const advanced = new Set<string>();
  const drained = new Set<string>();
  const missingConversations = new Set<string>();
  async function advanceOne(
    conversationId: mongoose.Types.ObjectId
  ): Promise<boolean> {
    if (advanced.has(String(conversationId))) return false;
    const claim = await claimEngagementBootstrap(
      conversationId,
      undefined,
      null,
      false,
      now
    );
    if (!claim) {
      missingConversations.add(String(conversationId));
      // Without this, a deleted conversation's expired lease heads every scan.
      await ConversationEngagementState.deleteOne({
        _id: conversationId,
      }).exec();
      return false;
    }
    if (claim.phase === "ready") return true;
    if (!claim.owned) return false;
    if (bootstrapsAdvanced >= 1) {
      await releaseEngagementBootstrap(conversationId, claim.leaseToken, now);
      return false;
    }
    advanced.add(String(conversationId));
    options.heartbeat?.();
    const hasMore = await advanceEngagementBootstrap(
      conversationId,
      claim.leaseToken,
      options
    );
    // A bounded maintenance run releases ownership so the next tick can resume immediately.
    await releaseEngagementBootstrap(conversationId, claim.leaseToken, now);
    bootstrapsAdvanced++;
    return !hasMore;
  }
  // A conversation another process is working on is left to that owner; its
  // pending markers stay durable for the next maintenance tick.
  for (const conversation of expired)
    await withConversationEngagementTurn(conversation._id, () =>
      withConversationEngagementLease(conversation._id, () =>
        advanceOne(conversation._id)
      )
    );
  const pending = await pendingRecoveryPage(limit);
  for (const message of pending) {
    options.heartbeat?.();
    const conversationId = message.conversation;
    if (!conversationId) {
      await clearOrphanPending(message);
      continue;
    }
    await withConversationEngagementTurn(conversationId, () =>
      withConversationEngagementLease(conversationId, async () => {
        // One page per conversation per run: it already settled this message.
        if (drained.has(String(conversationId))) return;
        if (await advanceOne(conversationId)) {
          drained.add(String(conversationId));
          const page = await applyPendingEngagementPage(conversationId);
          processed += page?.processed ?? 0;
        } else if (missingConversations.has(String(conversationId))) {
          await clearOrphanPending(message);
        }
      })
    );
  }
  return { processed, bootstrapsAdvanced };
}
