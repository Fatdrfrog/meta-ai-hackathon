import { randomUUID } from "node:crypto";
import mongoose, { type ClientSession } from "mongoose";
import { Conversation } from "@/models/conversation";
import { ConversationEngagementState } from "@/models/conversation-engagement-state";
import Message from "@/models/message";
import {
  ENGAGEMENT_MESSAGE_SELECT,
  createEngagementAccumulator,
  computeEngagementMetricsFromAccumulator,
  type ConversationEngagementMetrics,
  type EngagementAccumulator,
} from "./conversation-engagement-metrics";
import {
  ENGAGEMENT_PRIVATE_SELECT,
  applyEngagementContributionPage,
  copyEngagementMetricsToConversation,
  withEngagementTransaction,
  readEngagementBounds,
  type EngagementMetricsCopy,
  type EngagementStoredMessage,
  type StoredEngagementConversation,
  type StoredEngagementState,
} from "./conversation-engagement-store";

export const ENGAGEMENT_BOOTSTRAP_BATCH_SIZE = 50;
const BOOTSTRAP_LEASE_MS = 60_000;

export type EngagementBootstrapState = {
  version: 1;
  phase: "building";
  generation: string;
  leaseToken: string;
  leaseUntil: Date;
  afterId: mongoose.Types.ObjectId | null;
  accumulator: EngagementAccumulator;
};
type BootstrapClaim =
  | { phase: "ready" }
  | {
      phase: "building";
      generation: string;
      leaseToken: string;
      owned: boolean;
    };

export class EngagementBootstrapLeaseLostError extends Error {
  constructor() {
    super("Conversation engagement bootstrap lease was replaced");
  }
}

/**
 * Left in an adopted conversation's legacy field. Deployments that still keep
 * the state on the conversation read it as a live bootstrap owned by someone
 * else, so they leave the conversation's engagement to this code; its
 * generation matches no contribution, so their reassignment repair skips it.
 */
export const ENGAGEMENT_STATE_MOVED_MARKER = {
  version: 1,
  phase: "building",
  generation: "moved:conversation_engagement_states",
  leaseToken: "moved:conversation_engagement_states",
  leaseUntil: new Date("9999-12-31T00:00:00.000Z"),
  afterId: null,
  accumulator: null,
} as const;

function createBootstrapState(
  now: Date,
  previous?: EngagementBootstrapState
): EngagementBootstrapState {
  const generation = previous?.generation ?? randomUUID();
  return {
    version: 1,
    phase: "building",
    generation,
    leaseToken: randomUUID(),
    leaseUntil: new Date(now.getTime() + BOOTSTRAP_LEASE_MS),
    afterId: previous?.afterId ?? null,
    accumulator:
      previous?.accumulator ?? createEngagementAccumulator(generation),
  };
}

function isMovedMarker(
  state: StoredEngagementConversation["engagement_accumulator"]
) {
  return state?.generation === ENGAGEMENT_STATE_MOVED_MARKER.generation;
}

/** Legacy conversation state that this code can continue. */
function legacyEngagementState(
  conversation: StoredEngagementConversation
): StoredEngagementState["engagement_accumulator"] {
  const state = conversation.engagement_accumulator;
  if (!state || state.version !== 1 || isMovedMarker(state)) return undefined;
  if (state.phase === "ready") return state;
  // Moving the state fences out the old owner, so its lease ends now.
  if (state.phase === "building") return { ...state, leaseUntil: new Date(0) };
  return undefined;
}

const LEGACY_STATE_SELECT =
  "_id workspaceId engagement_accumulator engagement_metrics engagement_revision";

/**
 * Creates the state document; the caller's transaction also marks the
 * conversation, so no deployment keeps writing a copy of the state there.
 */
async function storeAdoptedState(
  conversation: StoredEngagementConversation,
  state: StoredEngagementState["engagement_accumulator"],
  session: ClientSession
): Promise<void> {
  await ConversationEngagementState.updateOne(
    { _id: conversation._id },
    {
      $set: {
        workspaceId: conversation.workspaceId ?? null,
        engagement_accumulator: state,
        engagement_metrics: conversation.engagement_metrics ?? null,
        revision: conversation.engagement_revision ?? 0,
      },
    },
    { upsert: true, session }
  ).exec();
}

/**
 * Moves a conversation's state on its first claim. Marking the conversation
 * is the transaction's first operation, so the ingest writes of a brand-new
 * conversation wait for this short transaction instead of aborting it.
 */
async function adoptEngagementState(
  conversationId: mongoose.Types.ObjectId
): Promise<void> {
  await withEngagementTransaction(async session => {
    const conversation = await Conversation.findOneAndUpdate(
      { _id: conversationId },
      { $set: { engagement_accumulator: ENGAGEMENT_STATE_MOVED_MARKER } },
      { session, timestamps: false, new: false }
    )
      .select(LEGACY_STATE_SELECT)
      .lean<StoredEngagementConversation | null>()
      .exec();
    if (!conversation) return;
    // Another process adopted it between our claim's read and this write.
    if (await readStoredEngagementState(conversationId, session)) return;
    await storeAdoptedState(
      conversation,
      legacyEngagementState(conversation),
      session
    );
  });
}

async function readStoredEngagementState(
  conversationId: mongoose.Types.ObjectId,
  session: ClientSession
): Promise<StoredEngagementState | null> {
  return ConversationEngagementState.findOne({ _id: conversationId })
    .select("_id engagement_accumulator engagement_metrics revision")
    .session(session)
    .lean<StoredEngagementState | null>()
    .exec();
}

/** Reassignment commits source invalidation with the destination contribution. */
export async function invalidateEngagementContributionOwner(
  conversationId: string,
  generation: string,
  session: ClientSession
): Promise<void> {
  if (!mongoose.Types.ObjectId.isValid(conversationId)) return;
  const id = new mongoose.Types.ObjectId(conversationId);
  // An expired lease lets existing maintenance rebuild the source even after a process crash.
  const invalidated = createBootstrapState(new Date(0));
  const stored = await readStoredEngagementState(id, session);
  if (stored) {
    const state = stored.engagement_accumulator;
    if (!state || state.version !== 1 || state.generation !== generation)
      return;
    await ConversationEngagementState.updateOne(
      { _id: id, "engagement_accumulator.generation": generation },
      { $set: { engagement_accumulator: invalidated } },
      { session }
    ).exec();
    return;
  }
  const source = await Conversation.findOne({ _id: id })
    .select(LEGACY_STATE_SELECT)
    .session(session)
    .lean<StoredEngagementConversation | null>()
    .exec();
  const legacy = source && legacyEngagementState(source);
  if (!legacy || legacy.generation !== generation) return;
  await storeAdoptedState(source, invalidated, session);
  await Conversation.updateOne(
    { _id: id },
    { $set: { engagement_accumulator: ENGAGEMENT_STATE_MOVED_MARKER } },
    { session, timestamps: false }
  ).exec();
}

export async function claimEngagementBootstrap(
  conversationId: mongoose.Types.ObjectId,
  workspaceId: string | undefined,
  messageId: mongoose.Types.ObjectId | null,
  forceRebuild = false,
  now = new Date()
): Promise<BootstrapClaim | null> {
  const claim = () =>
    withEngagementTransaction<{
      claim: BootstrapClaim | null;
      adopt?: true;
      staleCopy?: EngagementMetricsCopy;
    }>(async session => {
      const conversation = await Conversation.findOne({
        _id: conversationId,
        ...(workspaceId ? { workspaceId } : {}),
      })
        .select("_id engagement_revision")
        .session(session)
        .lean<StoredEngagementConversation | null>()
        .exec();
      if (!conversation) return { claim: null };
      // Saves and query updates already mark the source atomically; only a
      // missing marker needs this write, which otherwise locks a fresh message.
      if (messageId)
        await Message.updateOne(
          {
            _id: messageId,
            conversation: conversationId,
            engagementRefreshPending: { $ne: true },
          },
          { $set: { engagementRefreshPending: true } },
          { session, timestamps: false }
        ).exec();
      const stored = await readStoredEngagementState(conversationId, session);
      if (!stored) return { claim: null, adopt: true };
      const state = stored.engagement_accumulator;
      if (state?.phase === "ready" && state.version === 1 && !forceRebuild) {
        // A crash between a commit and its copy leaves the conversation behind.
        const stale =
          stored.engagement_metrics &&
          (stored.revision ?? 0) > (conversation.engagement_revision ?? 0);
        return {
          claim: { phase: "ready" },
          ...(stale
            ? {
                staleCopy: {
                  revision: stored.revision ?? 0,
                  metrics: stored.engagement_metrics!,
                },
              }
            : {}),
        };
      }
      if (
        state?.phase === "building" &&
        state.version === 1 &&
        new Date(state.leaseUntil).getTime() > now.getTime()
      ) {
        return {
          claim: {
            phase: "building",
            generation: state.generation,
            leaseToken: state.leaseToken,
            owned: false,
          },
        };
      }
      const lease = createBootstrapState(
        now,
        state?.phase === "building" && state.version === 1 ? state : undefined
      );
      await ConversationEngagementState.updateOne(
        { _id: conversationId },
        { $set: { engagement_accumulator: lease } },
        { session }
      ).exec();
      return {
        claim: {
          phase: "building",
          generation: lease.generation,
          leaseToken: lease.leaseToken,
          owned: true,
        },
      };
    });
  let outcome = await claim();
  if (outcome.adopt) {
    await adoptEngagementState(conversationId);
    outcome = await claim();
    if (outcome.adopt) return null;
  }
  if (outcome.staleCopy)
    await copyEngagementMetricsToConversation(
      conversationId,
      outcome.staleCopy
    );
  return outcome.claim;
}

async function fenceBootstrap(
  conversationId: mongoose.Types.ObjectId,
  leaseToken: string,
  session: ClientSession
): Promise<void> {
  const result = await ConversationEngagementState.updateOne(
    {
      _id: conversationId,
      "engagement_accumulator.phase": "building",
      "engagement_accumulator.leaseToken": leaseToken,
    },
    {
      $set: {
        "engagement_accumulator.leaseUntil": new Date(
          Date.now() + BOOTSTRAP_LEASE_MS
        ),
      },
    },
    { session }
  ).exec();
  if (result.matchedCount !== 1) throw new EngagementBootstrapLeaseLostError();
}

export async function releaseEngagementBootstrap(
  conversationId: mongoose.Types.ObjectId,
  leaseToken: string,
  now = new Date()
): Promise<void> {
  await ConversationEngagementState.updateOne(
    {
      _id: conversationId,
      "engagement_accumulator.phase": "building",
      "engagement_accumulator.leaseToken": leaseToken,
    },
    { $set: { "engagement_accumulator.leaseUntil": now } }
  ).exec();
}

/** One bounded transaction owns both the contribution edits and the resumable checkpoint. */
export async function advanceEngagementBootstrap(
  conversationId: mongoose.Types.ObjectId,
  leaseToken: string,
  options?: { heartbeat?: () => void }
): Promise<boolean> {
  const outcome = await withEngagementTransaction(async session => {
    await fenceBootstrap(conversationId, leaseToken, session);
    const stored = (await readStoredEngagementState(conversationId, session))!;
    const state = stored.engagement_accumulator as EngagementBootstrapState;
    // _id is immutable: date edits and late inserts cannot repeat a cursor row.
    const messages = await Message.find({
      conversation: conversationId,
      ...(state.afterId ? { _id: { $gt: state.afterId } } : {}),
    })
      .select(`${ENGAGEMENT_MESSAGE_SELECT} ${ENGAGEMENT_PRIVATE_SELECT}`)
      .sort({ _id: 1 })
      .limit(ENGAGEMENT_BOOTSTRAP_BATCH_SIZE)
      .session(session)
      .lean<EngagementStoredMessage[]>()
      .exec();
    await applyEngagementContributionPage(
      conversationId,
      messages,
      state.accumulator,
      session,
      {
        priorPagesCommitted: Boolean(state.afterId),
        heartbeat: options?.heartbeat,
      }
    );
    if (messages.length < ENGAGEMENT_BOOTSTRAP_BATCH_SIZE) {
      const metrics: ConversationEngagementMetrics =
        computeEngagementMetricsFromAccumulator(
          state.accumulator,
          await readEngagementBounds(conversationId, state.generation, session)
        );
      const revision = (stored.revision ?? 0) + 1;
      await ConversationEngagementState.updateOne(
        {
          _id: conversationId,
          "engagement_accumulator.leaseToken": leaseToken,
        },
        {
          $set: {
            engagement_accumulator: state.accumulator,
            engagement_metrics: metrics,
            revision,
          },
        },
        { session }
      ).exec();
      return { hasMore: false, copy: { revision, metrics } };
    }
    state.afterId = messages.at(-1)!._id;
    state.leaseUntil = new Date(Date.now() + BOOTSTRAP_LEASE_MS);
    await ConversationEngagementState.updateOne(
      { _id: conversationId, "engagement_accumulator.leaseToken": leaseToken },
      { $set: { engagement_accumulator: state } },
      { session }
    ).exec();
    return { hasMore: true, copy: null };
  });
  if (outcome.copy)
    await copyEngagementMetricsToConversation(conversationId, outcome.copy);
  return outcome.hasMore;
}

export async function bootstrapConversationEngagement(
  conversationId: mongoose.Types.ObjectId,
  leaseToken: string
): Promise<void> {
  while (await advanceEngagementBootstrap(conversationId, leaseToken)) {
    // Yield between bounded commits; a process restart resumes afterId under a new lease token.
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}
