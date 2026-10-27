import mongoose from "mongoose";
import {
  ENGAGEMENT_MESSAGE_SELECT,
  type EngagementMessageInput,
} from "./conversation-engagement-metrics";
import {
  buildLegacyEngagementFixture,
  LEGACY_ENGAGEMENT_METRICS,
} from "./conversation-engagement.fixtures";
import { serializeWhatsAppRealtimeMessage } from "@icecore/airi-runtime/whatsapp-webhook-runtime";
import {
  computeConversationEngagementMetrics,
  drainPendingConversationEngagement,
  refreshConversationEngagement,
  ensureConversationEngagementIndexes,
} from "./conversation-engagement";

const mongoUri = process.env.ENGAGEMENT_TEST_MONGODB_URI;
const describeMongo = mongoUri ? describe : describe.skip;
const workspaceId = "engagement-cost-integration";
let Message: typeof import("@/models/message").default;
let Conversation: typeof import("@/models/conversation").Conversation;
let EngagementState: typeof import("@/models/conversation-engagement-state").ConversationEngagementState;
let bootstrap: typeof import("./conversation-engagement-bootstrap");
let conversationId: mongoose.Types.ObjectId;
const id = (number: number) =>
  new mongoose.Types.ObjectId(number.toString(16).padStart(24, "0"));
const date = (minutes: number) => new Date(Date.UTC(2026, 8, 1, 0, minutes));

async function insert(
  number: number,
  minutes: number,
  direction = "inbound",
  extra = {}
) {
  await Message.collection.insertOne({
    _id: id(number),
    workspaceId,
    conversation: conversationId,
    direction,
    date: date(minutes),
    text: "Price?",
    engagementRefreshPending: true,
    ...extra,
  });
}
async function readConversation(
  select = "",
  targetConversationId = conversationId
) {
  const query = Conversation.findById(
    targetConversationId
  ).lean<mongoose.mongo.Document | null>();
  if (select) query.select(select);
  const result = await query.exec();
  if (!result) throw new Error("Missing test conversation");
  return result;
}
async function readState(targetConversationId = conversationId) {
  const result = await EngagementState.collection.findOne({
    _id: targetConversationId,
  });
  if (!result) throw new Error("Missing test engagement state");
  return result;
}
async function expireBootstrapLease(targetConversationId = conversationId) {
  await EngagementState.collection.updateOne(
    { _id: targetConversationId },
    { $set: { "engagement_accumulator.leaseUntil": new Date(0) } }
  );
}
async function readRawMessage(number: number) {
  const result = await Message.collection.findOne({ _id: id(number) });
  if (!result) throw new Error("Missing test message");
  return result;
}
async function expectCanonical(targetConversationId = conversationId) {
  const messages = await Message.find({ conversation: targetConversationId })
    .sort({ date: 1, _id: 1 })
    .lean<EngagementMessageInput[]>()
    .exec();
  const conversation = await readConversation("", targetConversationId);
  expect(conversation.engagement_metrics).toEqual({
    ...computeConversationEngagementMetrics(messages),
    computedAt: expect.any(Date),
  });
  expect(conversation.message_count).toBe(
    computeConversationEngagementMetrics(messages).messageCount
  );
  expect((await readState(targetConversationId)).engagement_metrics).toEqual(
    conversation.engagement_metrics
  );
}

/**
 * A second worker instance: the same database and models, but its own
 * in-process engagement queue, like a second Cloud Run instance.
 */
async function loadSecondProcessEngagement(): Promise<
  typeof import("./conversation-engagement-store")
> {
  const shared: Record<string, unknown> = {
    mongoose,
    "@/lib/mongoose": await import("@/lib/mongoose"),
    "@/models/message": await import("@/models/message"),
    "@/models/conversation": await import("@/models/conversation"),
    "@/models/conversation-engagement-lease": await import(
      "@/models/conversation-engagement-lease"
    ),
    "@/models/conversation-engagement-state": await import(
      "@/models/conversation-engagement-state"
    ),
  };
  let second: typeof import("./conversation-engagement-store") | undefined;
  await jest.isolateModulesAsync(async () => {
    for (const [path, value] of Object.entries(shared))
      jest.doMock(path, () => value);
    // The store itself, not the wrapper: the wrapper imports it lazily.
    second = await import("./conversation-engagement-store");
  });
  if (!second) throw new Error("Second engagement process did not load");
  return second;
}

describeMongo("engagement transactions on isolated local Mongo", () => {
  beforeAll(async () => {
    if (
      !mongoUri?.startsWith(
        "mongodb://127.0.0.1:27277/airi_engagement_cost_tests?"
      ) ||
      process.env.MONGODB_URI !== mongoUri
    ) {
      throw new Error(
        "Engagement integration requires the explicit isolated local replica set URI in both env variables"
      );
    }
    Message = (await import("@/models/message")).default;
    Conversation = (await import("@/models/conversation")).Conversation;
    EngagementState = (await import("@/models/conversation-engagement-state"))
      .ConversationEngagementState;
    bootstrap = await import("./conversation-engagement-bootstrap");
    await (await import("@/lib/mongoose")).default();
    // Only this guarded isolated fixture may replace stale cost-test index definitions.
    await Message.createCollection();
    const { MESSAGE_ENGAGEMENT_INDEX_SPECS } = await import("@/models/message");
    const indexes = await Message.collection.indexes();
    for (const spec of MESSAGE_ENGAGEMENT_INDEX_SPECS.slice(0, 2)) {
      const existing = indexes.find(index => index.name === spec.options.name);
      if (
        existing &&
        JSON.stringify(existing.key) !== JSON.stringify(spec.keys)
      )
        await Message.collection.dropIndex(spec.options.name);
    }
    await ensureConversationEngagementIndexes();
  }, 30_000);

  beforeEach(async () => {
    await Message.collection.deleteMany({ workspaceId });
    await Conversation.collection.deleteMany({ workspaceId });
    await EngagementState.collection.deleteMany({ workspaceId });
    conversationId = new mongoose.Types.ObjectId();
    await Conversation.collection.insertOne({
      _id: conversationId,
      workspaceId,
    });
  });
  afterAll(async () => {
    await Message?.collection.deleteMany({ workspaceId });
    await Conversation?.collection.deleteMany({ workspaceId });
    await EngagementState?.collection.deleteMany({ workspaceId });
    await mongoose.disconnect();
  });

  it("matches every legacy metric through stored out-of-order appends and historical edge mutations", async () => {
    const messages = buildLegacyEngagementFixture();
    for (const [index, message] of messages.entries()) {
      await Message.collection.insertOne({
        _id: id(index + 1),
        workspaceId,
        conversation: conversationId,
        engagementRefreshPending: true,
        ...message,
      });
      await refreshConversationEngagement(conversationId, {
        messageId: id(index + 1),
      });
      await expectCanonical();
    }
    expect((await readConversation()).engagement_metrics).toEqual({
      ...LEGACY_ENGAGEMENT_METRICS,
      computedAt: expect.any(Date),
    });

    // Same-date ids, late insertion and historical mutations exercise both edge rewiring branches.
    await insert(65, 0, "inbound");
    await refreshConversationEngagement(conversationId, { messageId: id(65) });
    await expectCanonical();
    const mutations = [
      { date: date(-10) },
      { direction: "outbound", origin: { kind: "campaign" } },
      { direction: "inbound", origin: null },
      { date: null },
      { date: date(15) },
      { direction: "invalid" },
      {
        direction: "inbound",
        whatsappFlowReply: { responseJson: "{}" },
        reactions: [{ emoji: "like" }],
        delivery: { status: "read" },
      },
    ];
    for (const mutation of mutations) {
      await Message.updateOne({ _id: id(65) }, { $set: mutation });
      await refreshConversationEngagement(conversationId, {
        messageId: id(65),
      });
      await expectCanonical();
    }
    await Message.collection.updateOne(
      { _id: id(65) },
      { $set: { date: "invalid-date", engagementRefreshPending: true } }
    );
    await drainPendingConversationEngagement({ limit: 10 });
    await expectCanonical();
    await Message.updateOne({ _id: id(65) }, { $set: { date: date(1) } });
    await drainPendingConversationEngagement({ limit: 10 });
    await expectCanonical();
    const beforeDuplicate = (await readConversation()).engagement_metrics;
    await refreshConversationEngagement(conversationId, { messageId: id(65) });
    expect((await readConversation()).engagement_metrics).toEqual(
      beforeDuplicate
    );
  }, 30_000);

  it("loads private source state and bounds using actual narrow Mongo projections", async () => {
    await insert(1, 0, "outbound", {
      attachments: [{ payload: "large message payload" }],
    });
    await insert(2, 10);
    await refreshConversationEngagement(conversationId, { messageId: id(2) });
    const store = await import("./conversation-engagement-store");
    const source = await Message.findById(id(1))
      .select(`${ENGAGEMENT_MESSAGE_SELECT} ${store.ENGAGEMENT_PRIVATE_SELECT}`)
      .lean<mongoose.mongo.Document>()
      .exec();
    expect(source?.engagementContribution.date).toEqual(date(0));
    expect(source?.engagementRefreshPending).toBe(false);
    expect(source?.attachments).toBeUndefined();
    const metadata = await EngagementState.findById(conversationId)
      .select("_id engagement_accumulator")
      .lean<mongoose.mongo.Document>()
      .exec();
    expect(Object.keys(metadata ?? {}).sort()).toEqual([
      "_id",
      "engagement_accumulator",
    ]);
    const findOne = jest.spyOn(Message.collection, "findOne");
    try {
      expect(
        await store.withEngagementTransaction(session =>
          store.readEngagementBounds(
            conversationId,
            metadata!.engagement_accumulator.generation,
            session
          )
        )
      ).toEqual({
        firstMessageAt: date(0),
        lastMessageAt: date(10),
        firstReplyDelayMilliseconds: 600_000,
      });
      expect(findOne).toHaveBeenCalledTimes(3);
      for (const [, options] of findOne.mock.calls) {
        expect(options?.projection).toEqual({
          _id: 1,
          engagementContribution: 1,
        });
      }
    } finally {
      findOne.mockRestore();
    }
    const neighbor = await Message.findOne({ _id: id(1) })
      .select("_id engagementContribution")
      .lean<mongoose.mongo.Document>()
      .exec();
    expect(Object.keys(neighbor ?? {}).sort()).toEqual([
      "_id",
      "engagementContribution",
    ]);
    expect(neighbor?.engagementContribution.date).toEqual(date(0));
  });

  it("uses generation equality index prefixes for neighbor, bounds and reply sorts despite old snapshots", async () => {
    const { buildEngagementContribution } = await import(
      "./conversation-engagement-metrics"
    );
    const old = Array.from({ length: 256 }, (_, index) => ({
      _id: id(index + 1),
      workspaceId,
      conversation: conversationId,
      engagementContribution: buildEngagementContribution(
        { direction: "outbound", date: date(index + 1) },
        "old-generation"
      ),
    }));
    const current = [1, 64, 128, 192, 256].map((minute, index) => ({
      _id: id(1001 + index),
      workspaceId,
      conversation: conversationId,
      engagementContribution: {
        ...buildEngagementContribution(
          { direction: index % 2 ? "inbound" : "outbound", date: date(minute) },
          "current-generation"
        ),
        edge: {
          turnSwitchCount: 1,
          customerRepliesAfterOutbound: index % 2,
          campaignReplyCount: 0,
          replyDelayMilliseconds: 600_000,
        },
      },
    }));
    await Message.collection.insertMany([...old, ...current]);
    const filter = {
      conversation: conversationId,
      "engagementContribution.generation": "current-generation",
      "engagementContribution.date": { $type: "date" },
    };
    const cases: Array<{
      filter: mongoose.mongo.Document;
      sort: mongoose.mongo.Sort;
      index: string;
    }> = [
      {
        filter,
        sort: { "engagementContribution.date": 1, _id: 1 },
        index: "engagement_contribution_order_v1",
      },
      {
        filter,
        sort: { "engagementContribution.date": -1, _id: -1 },
        index: "engagement_contribution_order_v1",
      },
      {
        filter: {
          ...filter,
          "engagementContribution.edge.customerRepliesAfterOutbound": 1,
        },
        sort: { "engagementContribution.date": 1, _id: 1 },
        index: "engagement_contribution_reply_v1",
      },
    ];
    for (const direction of [1, -1] as const) {
      const comparison = direction === 1 ? "$gt" : "$lt";
      cases.push({
        filter: {
          ...filter,
          _id: { $ne: id(1003) },
          $or: [
            { "engagementContribution.date": { [comparison]: date(128) } },
            {
              "engagementContribution.date": date(128),
              _id: { [comparison]: id(1003) },
            },
          ],
        },
        sort: { "engagementContribution.date": direction, _id: direction },
        index: "engagement_contribution_order_v1",
      });
    }
    for (const query of cases) {
      const plan = await Message.collection
        .find(query.filter, {
          projection: { _id: 1, engagementContribution: 1 },
        })
        .sort(query.sort)
        .limit(1)
        .explain("executionStats");
      expect(plan.executionStats.nReturned).toBe(1);
      expect(plan.executionStats.totalKeysExamined).toBeLessThanOrEqual(16);
      expect(plan.executionStats.totalDocsExamined).toBeLessThanOrEqual(8);
      expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain(
        query.index
      );
    }
  });

  it("serializes concurrent duplicate appends, historical delivery and reaction mutations", async () => {
    await insert(1, 0, "outbound", { origin: { kind: "campaign" } });
    await refreshConversationEngagement(conversationId, {
      messageId: id(1),
      workspaceId,
    });
    await Promise.all([insert(3, 20), insert(2, 10, "outbound")]);
    await Promise.all([
      refreshConversationEngagement(conversationId, { messageId: id(3) }),
      refreshConversationEngagement(conversationId, { messageId: id(2) }),
      refreshConversationEngagement(conversationId, { messageId: id(3) }),
    ]);
    await Message.updateOne(
      { _id: id(1) },
      { $set: { "delivery.status": "played", engagementRefreshPending: true } }
    );
    await Message.updateOne(
      { _id: id(3) },
      {
        $push: { reactions: { emoji: "like" } },
        $set: { engagementRefreshPending: true },
      }
    );
    await Promise.all([
      refreshConversationEngagement(conversationId, { messageId: id(1) }),
      refreshConversationEngagement(conversationId, { messageId: id(3) }),
    ]);
    await expectCanonical();
    expect(
      await Message.countDocuments({
        conversation: conversationId,
        engagementRefreshPending: true,
      })
    ).toBe(0);
  }, 30_000);

  it("applies a same-conversation callback burst without transactions aborting each other", async () => {
    const abortedTransactions = async () =>
      Number(
        (await mongoose.connection.db!.admin().serverStatus()).transactions
          .totalAborted
      );
    await insert(1, 0, "outbound");
    await refreshConversationEngagement(conversationId, {
      messageId: id(1),
      workspaceId,
    });
    const burst = Array.from({ length: 24 }, (_, index) => index + 2);
    for (const number of burst)
      await insert(number, number, number % 3 ? "inbound" : "outbound");
    const before = await abortedTransactions();
    await Promise.all(
      burst.map(number =>
        refreshConversationEngagement(conversationId, {
          messageId: id(number),
          workspaceId,
        })
      )
    );
    // Production post-save callbacks and webhook deliveries race exactly like this.
    expect((await abortedTransactions()) - before).toBe(0);
    expect(
      await Message.countDocuments({
        conversation: conversationId,
        engagementRefreshPending: true,
      })
    ).toBe(0);
    await expectCanonical();
  }, 60_000);

  it("keeps an engagement transaction committed when an ingest write lands on the conversation mid-transaction", async () => {
    await insert(1, 0, "outbound");
    await refreshConversationEngagement(conversationId, {
      messageId: id(1),
      workspaceId,
    });
    await insert(2, 10);
    const findOne = Message.findOne;
    let injected = false;
    const spy = jest.spyOn(Message, "findOne").mockImplementation(((
      ...args: Parameters<typeof Message.findOne>
    ) => {
      const query = findOne.apply(Message, args);
      const exec = query.exec.bind(query);
      query.exec = (async () => {
        // The append and the timestamp hook write the conversation exactly so.
        if (!injected && query.getOptions().session) {
          injected = true;
          await Conversation.collection.updateOne(
            { _id: conversationId },
            { $set: { lastMessageAt: date(10), last_inbound_at: date(10) } }
          );
        }
        return exec();
      }) as typeof query.exec;
      return query;
    }) as typeof Message.findOne);
    const aborted = async () =>
      Number(
        (await mongoose.connection.db!.admin().serverStatus()).transactions
          .totalAborted
      );
    const before = await aborted();
    try {
      await refreshConversationEngagement(conversationId, {
        messageId: id(2),
        workspaceId,
      });
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBe(true);
    expect((await aborted()) - before).toBe(0);
    await expectCanonical();
  });

  it("settles a real save-and-append burst without aborted transactions", async () => {
    const { appendMessageToConversationById } = await import(
      "@/lib/conversation-messages"
    );
    const aborted = async () =>
      Number(
        (await mongoose.connection.db!.admin().serverStatus()).transactions
          .totalAborted
      );
    const before = await aborted();
    for (let number = 1; number <= 20; number++) {
      const direction = number % 3 ? "inbound" : "outbound";
      const message = new Message({
        _id: id(number),
        workspaceId,
        conversation: conversationId,
        date: date(number),
        direction,
        channel: "whatsapp",
        text: "Price?",
      });
      await message.save();
      await appendMessageToConversationById(
        conversationId,
        message._id,
        { direction, lastMessageAt: message.date },
        { scheduleWake: async () => undefined }
      );
      // Ingest pacing: the next message's writes land while engagement runs.
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    for (let quiet = 0, round = 0; quiet < 3 && round < 300; round++) {
      const pending = await Message.countDocuments({
        conversation: conversationId,
        engagementRefreshPending: true,
      });
      quiet = pending === 0 ? quiet + 1 : 0;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect((await aborted()) - before).toBe(0);
    await expectCanonical();
  }, 60_000);

  it("adopts a legacy conversation state once and leaves older deployments a lease they never own", async () => {
    await insert(1, 0, "outbound");
    await insert(2, 10);
    await refreshConversationEngagement(conversationId, { messageId: id(2) });
    const built = await readState();
    // An older deployment kept the state on the conversation itself.
    await EngagementState.collection.deleteOne({ _id: conversationId });
    await Conversation.collection.updateOne(
      { _id: conversationId },
      {
        $set: { engagement_accumulator: built.engagement_accumulator },
        $unset: { engagement_revision: 1 },
      }
    );
    await insert(3, 20, "outbound");
    const historyReads = jest.spyOn(Message, "find");
    try {
      await refreshConversationEngagement(conversationId, {
        messageId: id(3),
      });
      expect(
        historyReads.mock.calls.some(
          ([filter]) =>
            filter &&
            !("engagementRefreshPending" in filter) &&
            !("engagementContribution.generation" in filter)
        )
      ).toBe(false);
    } finally {
      historyReads.mockRestore();
    }
    await expectCanonical();
    const state = await readState();
    expect(state.engagement_accumulator.generation).toBe(
      built.engagement_accumulator.generation
    );
    expect(state.workspaceId).toBe(workspaceId);
    const legacy = (await readConversation("+engagement_accumulator"))
      .engagement_accumulator;
    // What an older deployment's claim sees: a live bootstrap someone else
    // owns, under a generation that no contribution carries.
    expect(legacy.version).toBe(1);
    expect(legacy.phase).toBe("building");
    expect(legacy.leaseUntil.getTime()).toBeGreaterThan(Date.now());
    expect(legacy.generation).not.toBe(state.engagement_accumulator.generation);
    expect(
      await Message.countDocuments({
        "engagementContribution.generation": legacy.generation,
      })
    ).toBe(0);
  });

  it("maintenance adopts and finishes an expired bootstrap an older deployment left on the conversation", async () => {
    for (let number = 1; number <= 60; number++)
      await insert(number, number, number % 2 ? "outbound" : "inbound");
    const claim = await bootstrap.claimEngagementBootstrap(
      conversationId,
      workspaceId,
      null
    );
    const lease = claim as Extract<
      NonNullable<typeof claim>,
      { phase: "building" }
    >;
    await bootstrap.advanceEngagementBootstrap(
      conversationId,
      lease.leaseToken
    );
    const checkpoint = await readState();
    await EngagementState.collection.deleteOne({ _id: conversationId });
    await Conversation.collection.updateOne(
      { _id: conversationId },
      {
        $set: {
          engagement_accumulator: {
            ...checkpoint.engagement_accumulator,
            leaseUntil: new Date(0),
          },
        },
      }
    );
    await Message.updateMany(
      { conversation: conversationId },
      { $set: { engagementRefreshPending: false } }
    );
    expect(await drainPendingConversationEngagement({ limit: 10 })).toEqual({
      processed: 0,
      bootstrapsAdvanced: 1,
    });
    expect((await readState()).engagement_accumulator.phase).toBe("ready");
    await expectCanonical();
  });

  it("drops the state of a deleted conversation so its expired lease stops heading the scan", async () => {
    const deletedId = id(3000);
    await EngagementState.collection.insertOne({
      _id: deletedId,
      workspaceId,
      engagement_accumulator: {
        version: 1,
        phase: "building",
        generation: "deleted",
        leaseToken: "deleted",
        leaseUntil: new Date(0),
        afterId: null,
        accumulator: null,
      },
      revision: 0,
    });
    await drainPendingConversationEngagement({ limit: 1 });
    expect(
      await EngagementState.collection.countDocuments({ _id: deletedId })
    ).toBe(0);
  });


  it("does not let two processes abort each other on a conversation's status burst", async () => {
    const abortedTransactions = async () =>
      Number(
        (await mongoose.connection.db!.admin().serverStatus()).transactions
          .totalAborted
      );
    const pendingCount = () =>
      Message.countDocuments({
        conversation: conversationId,
        engagementRefreshPending: true,
      });
    const second = await loadSecondProcessEngagement();
    const outbound = Array.from({ length: 20 }, (_, index) => index + 1);
    for (const number of outbound) await insert(number, number, "outbound");
    await refreshConversationEngagement(conversationId, {
      messageId: id(outbound.at(-1)!),
      workspaceId,
    });
    expect(await pendingCount()).toBe(0);

    const before = await abortedTransactions();
    for (const status of ["delivered", "read"]) {
      // Parallel status webhooks, split across two instances as in production.
      await Promise.all(
        outbound.map(async number => {
          await Message.updateOne(
            { _id: id(number) },
            { $set: { delivery: { status, lastEventAt: new Date() } } }
          );
          const refresh =
            number % 2
              ? refreshConversationEngagement
              : second.refreshStoredConversationEngagement;
          await refresh(conversationId, { messageId: id(number), workspaceId });
        })
      );
    }
    // Deferred refreshes retry behind the owner within a few seconds.
    for (let round = 0; round < 100 && (await pendingCount()) > 0; round++)
      await new Promise(resolve => setTimeout(resolve, 100));

    expect((await abortedTransactions()) - before).toBe(0);
    expect(await pendingCount()).toBe(0);
    await expectCanonical();
  }, 120_000);
  it("resumes a bounded committed bootstrap page and fences a stale owner after takeover", async () => {
    for (let number = 1; number <= 65; number++)
      await insert(number, number, number % 2 ? "outbound" : "inbound");
    const first = await bootstrap.claimEngagementBootstrap(
      conversationId,
      workspaceId,
      id(65)
    );
    expect(first?.phase).toBe("building");
    const lease = first as Extract<
      NonNullable<typeof first>,
      { phase: "building" }
    >;
    expect(
      await bootstrap.advanceEngagementBootstrap(
        conversationId,
        lease.leaseToken
      )
    ).toBe(true);
    const checkpoint = await readState();
    expect(String(checkpoint.engagement_accumulator.afterId)).toBe(
      String(id(50))
    );
    await expireBootstrapLease();
    const next = (await bootstrap.claimEngagementBootstrap(
      conversationId,
      workspaceId,
      null
    )) as Extract<NonNullable<typeof first>, { phase: "building" }>;
    expect(next.generation).toBe(lease.generation);
    expect(next.leaseToken).not.toBe(lease.leaseToken);
    await expect(
      bootstrap.advanceEngagementBootstrap(conversationId, lease.leaseToken)
    ).rejects.toThrow("lease was replaced");
    await bootstrap.bootstrapConversationEngagement(
      conversationId,
      next.leaseToken
    );
    await drainPendingConversationEngagement({ limit: 100 });
    await expectCanonical();
  }, 30_000);

  it("bootstraps each page in a bounded number of queries", async () => {
    const queries = async () =>
      Number(
        (await mongoose.connection.db!.admin().serverStatus()).opcounters.query
      );
    // Dates out of _id order make the second page interleave with the first.
    for (let number = 1; number <= 60; number++)
      await insert(
        number,
        (number * 7) % 60,
        number % 3 ? "inbound" : "outbound"
      );
    const claim = await bootstrap.claimEngagementBootstrap(
      conversationId,
      workspaceId,
      null,
      true
    );
    const lease = claim as Extract<
      NonNullable<typeof claim>,
      { phase: "building" }
    >;
    const perPage: number[] = [];
    let hasMore = true;
    while (hasMore) {
      const before = await queries();
      hasMore = await bootstrap.advanceEngagementBootstrap(
        conversationId,
        lease.leaseToken
      );
      perPage.push((await queries()) - before);
    }
    // Per-message neighbor reads made a page ~150 queries (~20 s across regions).
    expect(perPage).toHaveLength(2);
    expect(Math.max(...perPage)).toBeLessThanOrEqual(10);
    await expectCanonical();
  });

  it("rolls back an interrupted bootstrap page before resuming its unchanged checkpoint", async () => {
    for (let number = 1; number <= 65; number++)
      await insert(number, number, number % 2 ? "outbound" : "inbound");
    const claim = await bootstrap.claimEngagementBootstrap(
      conversationId,
      workspaceId,
      id(65)
    );
    const lease = claim as Extract<
      NonNullable<typeof claim>,
      { phase: "building" }
    >;
    let beats = 0;
    await expect(
      bootstrap.advanceEngagementBootstrap(conversationId, lease.leaseToken, {
        heartbeat: () => {
          if (++beats === 20) throw new Error("simulated interruption");
        },
      })
    ).rejects.toThrow("simulated interruption");
    const checkpoint = await readState();
    expect(checkpoint.engagement_accumulator.afterId).toBeNull();
    expect(
      await Message.countDocuments({
        conversation: conversationId,
        "engagementContribution.generation": lease.generation,
      })
    ).toBe(0);
    await bootstrap.bootstrapConversationEngagement(
      conversationId,
      lease.leaseToken
    );
    await expectCanonical();
  });

  it("drains old mutations and inserts behind the bootstrap checkpoint without a future callback", async () => {
    for (let number = 2; number <= 60; number++)
      await insert(number, number, number % 2 ? "inbound" : "outbound");
    const claim = await bootstrap.claimEngagementBootstrap(
      conversationId,
      workspaceId,
      id(60)
    );
    const lease = claim as Extract<
      NonNullable<typeof claim>,
      { phase: "building" }
    >;
    await bootstrap.advanceEngagementBootstrap(
      conversationId,
      lease.leaseToken
    );
    await Message.updateOne(
      { _id: id(2) },
      {
        $set: {
          date: date(15),
          direction: "inbound",
          engagementRefreshPending: true,
        },
      }
    );
    await insert(1, 0, "outbound", { origin: { kind: "campaign" } });
    await bootstrap.bootstrapConversationEngagement(
      conversationId,
      lease.leaseToken
    );
    await drainPendingConversationEngagement({ limit: 100 });
    await expectCanonical();
    expect(
      await Message.countDocuments({
        conversation: conversationId,
        engagementRefreshPending: true,
      })
    ).toBe(0);
  }, 30_000);

  it("maintenance recovers an expired bootstrap even when all pending flags were cleared before a crash", async () => {
    for (let number = 1; number <= 50; number++)
      await insert(number, number, number % 2 ? "outbound" : "inbound");
    const claim = await bootstrap.claimEngagementBootstrap(
      conversationId,
      workspaceId,
      id(1)
    );
    const lease = claim as Extract<
      NonNullable<typeof claim>,
      { phase: "building" }
    >;
    await bootstrap.advanceEngagementBootstrap(
      conversationId,
      lease.leaseToken
    );
    expect(
      await Message.countDocuments({
        conversation: conversationId,
        engagementRefreshPending: true,
      })
    ).toBe(0);
    await expireBootstrapLease();
    const conversationReads = jest.spyOn(Conversation.collection, "findOne");
    const stateReads = jest.spyOn(EngagementState.collection, "findOne");
    try {
      expect(await drainPendingConversationEngagement({ limit: 10 })).toEqual({
        processed: 0,
        bootstrapsAdvanced: 1,
      });
      // Claim and bootstrap each read their transaction snapshot of the state;
      // only the claim checks the conversation. Recovery reuses the result.
      expect(conversationReads).toHaveBeenCalledTimes(1);
      expect(stateReads).toHaveBeenCalledTimes(2);
    } finally {
      conversationReads.mockRestore();
      stateReads.mockRestore();
    }
    await expectCanonical();
  });

  it("bounds a recovery invocation to one bootstrap page across multiple pending conversations", async () => {
    const otherId = new mongoose.Types.ObjectId();
    await Conversation.collection.insertOne({ _id: otherId, workspaceId });
    await insert(1, 0, "outbound");
    await Message.collection.insertOne({
      _id: id(2),
      workspaceId,
      conversation: otherId,
      direction: "inbound",
      date: date(1),
      engagementRefreshPending: true,
    });
    const heartbeat = jest.fn();
    const result = await drainPendingConversationEngagement({
      limit: 10,
      heartbeat,
    });
    expect(result.bootstrapsAdvanced).toBe(1);
    expect(heartbeat).toHaveBeenCalled();
    expect(
      await Message.countDocuments({
        workspaceId,
        engagementRefreshPending: true,
      })
    ).toBe(1);
    await drainPendingConversationEngagement({ limit: 10 });
    expect(
      await Message.countDocuments({
        workspaceId,
        engagementRefreshPending: true,
      })
    ).toBe(0);
  });

  it("caps a hot callback bootstrap at one page and lets maintenance finish its durable checkpoint", async () => {
    for (let number = 1; number <= 65; number++)
      await insert(number, number, number % 2 ? "outbound" : "inbound");
    expect(
      await refreshConversationEngagement(conversationId, {
        messageId: id(65),
        workspaceId,
      })
    ).toBeNull();
    const checkpoint = await readState();
    expect(String(checkpoint.engagement_accumulator.afterId)).toBe(
      String(id(50))
    );
    expect(await drainPendingConversationEngagement({ limit: 100 })).toEqual({
      processed: 0,
      bootstrapsAdvanced: 1,
    });
    await expectCanonical();
  });

  it("marks source saves and query reactions atomically while private state stays excluded from default projections", async () => {
    const immediate = jest
      .spyOn(globalThis, "setImmediate")
      .mockImplementation(() => ({}) as ReturnType<typeof setImmediate>);
    try {
      const fresh = await Message.create({
        _id: id(1),
        workspaceId,
        conversation: conversationId,
        date: date(0),
        direction: "outbound",
        channel: "whatsapp",
        text: "Hello",
      });
      expect(fresh.toObject().engagementRefreshPending).toBeUndefined();
      expect(fresh.toJSON().engagementRefreshPending).toBeUndefined();
      expect(
        serializeWhatsAppRealtimeMessage(fresh)?.engagementRefreshPending
      ).toBeUndefined();
      expect(
        serializeWhatsAppRealtimeMessage(fresh)?.engagementContribution
      ).toBeUndefined();
    } finally {
      immediate.mockRestore();
    }
    expect((await readRawMessage(1)).engagementRefreshPending).toBe(true);
    await refreshConversationEngagement(conversationId, { messageId: id(1) });
    await Message.updateOne(
      { _id: id(1) },
      { $push: { reactions: { emoji: "like" } } }
    );
    expect((await readRawMessage(1)).engagementRefreshPending).toBe(true);
    await drainPendingConversationEngagement({ limit: 10 });
    await expectCanonical();
    const message = await Message.findById(id(1))
      .lean<mongoose.mongo.Document>()
      .exec();
    if (!message) throw new Error("Missing test message");
    const conversation = await readConversation();
    expect(message.engagementContribution).toBeUndefined();
    expect(message.engagementRefreshPending).toBeUndefined();
    expect(conversation.engagement_accumulator).toBeUndefined();
    const privateConversation = await Conversation.findById(conversationId)
      .select("+engagement_accumulator")
      .exec();
    if (!privateConversation)
      throw new Error("Missing private test conversation");
    expect(privateConversation.toJSON().engagement_accumulator).toBeUndefined();
    expect(
      privateConversation.toObject().engagement_accumulator
    ).toBeUndefined();
  });

  it("clears orphan and deleted-conversation pending markers so later work can advance", async () => {
    await Message.collection.insertOne({
      _id: id(0),
      workspaceId,
      direction: "inbound",
      date: date(0),
      engagementRefreshPending: true,
    });
    await Message.collection.insertOne({
      _id: id(1),
      workspaceId,
      conversation: id(999),
      direction: "inbound",
      date: date(1),
      engagementRefreshPending: true,
    });
    await drainPendingConversationEngagement({ limit: 1 });
    expect((await readRawMessage(0)).engagementRefreshPending).toBe(false);
    await drainPendingConversationEngagement({ limit: 1 });
    expect((await readRawMessage(1)).engagementRefreshPending).toBe(false);
  });

  it.each(["detached", "deleted destination"])(
    "preserves source repair when clearing a contributed message with %s conversation",
    async destination => {
      await insert(1, 0, "outbound", { origin: { kind: "campaign" } });
      await insert(2, 10, "inbound");
      await insert(3, 20, "outbound");
      await refreshConversationEngagement(conversationId, { messageId: id(3) });
      if (destination === "detached") {
        await Message.updateOne(
          { _id: id(2) },
          { $unset: { conversation: 1 } }
        );
      } else {
        const destinationId = id(2000);
        await Conversation.collection.insertOne({
          _id: destinationId,
          workspaceId,
        });
        await Message.updateOne(
          { _id: id(2) },
          { $set: { conversation: destinationId } }
        );
        await Conversation.collection.deleteOne({ _id: destinationId });
      }
      await drainPendingConversationEngagement({ limit: 10 });
      expect((await readRawMessage(2)).engagementRefreshPending).toBe(false);
      const invalidated = await readState();
      expect(invalidated.engagement_accumulator.phase).toBe("building");
      expect(
        invalidated.engagement_accumulator.leaseUntil.getTime()
      ).toBeLessThan(Date.now());
      // Recovery remains discoverable even though the orphan's marker was cleared.
      await drainPendingConversationEngagement({ limit: 10 });
      await expectCanonical();
    }
  );

  it("durably repairs source and destination after a contributed message is reassigned", async () => {
    await insert(1, 0, "outbound", { origin: { kind: "campaign" } });
    await insert(2, 10, "inbound");
    await insert(3, 20, "outbound");
    await refreshConversationEngagement(conversationId, { messageId: id(3) });
    expect(
      (await readRawMessage(2)).engagementContribution.conversationId
    ).toBe(String(conversationId));
    const destinationId = id(2000);
    await Conversation.collection.insertOne({
      _id: destinationId,
      workspaceId,
    });
    await Message.collection.insertOne({
      _id: id(10),
      workspaceId,
      conversation: destinationId,
      direction: "outbound",
      date: date(5),
      engagementRefreshPending: true,
    });
    await refreshConversationEngagement(destinationId, { messageId: id(10) });
    expect((await readState()).engagement_accumulator.phase).toBe("ready");
    // Telegram's canonical reassignment owner uses the same query update.
    await Message.updateOne(
      { _id: id(2) },
      { $set: { conversation: destinationId } }
    );
    await refreshConversationEngagement(destinationId, { messageId: id(2) });
    const source = await readState();
    expect(source.engagement_accumulator.phase).toBe("building");
    expect((await readRawMessage(2)).engagementRefreshPending).toBe(false);
    await expectCanonical(destinationId);
    // No message callback remains: the durable source lease alone drives recovery.
    await drainPendingConversationEngagement({ limit: 10 });
    await expectCanonical();
    await expectCanonical(destinationId);
  });

  it("retains reassignment invalidation when source recovery is interrupted", async () => {
    await insert(1, 0, "outbound");
    await insert(2, 10, "inbound");
    await insert(3, 20, "outbound");
    await refreshConversationEngagement(conversationId, { messageId: id(3) });
    const destinationId = id(2000);
    await Conversation.collection.insertOne({
      _id: destinationId,
      workspaceId,
    });
    await Message.updateOne(
      { _id: id(2) },
      { $set: { conversation: destinationId } }
    );
    await refreshConversationEngagement(destinationId, { messageId: id(2) });
    const claim = await bootstrap.claimEngagementBootstrap(
      conversationId,
      workspaceId,
      null
    );
    const lease = claim as Extract<
      NonNullable<typeof claim>,
      { phase: "building" }
    >;
    expect(claim?.phase).toBe("building");
    let beats = 0;
    await expect(
      bootstrap.advanceEngagementBootstrap(conversationId, lease.leaseToken, {
        heartbeat: () => {
          if (++beats === 2) throw new Error("interrupted source recovery");
        },
      })
    ).rejects.toThrow("interrupted source recovery");
    const source = await readState();
    expect(source.engagement_accumulator.phase).toBe("building");
    expect(source.engagement_accumulator.afterId).toBeNull();
    await bootstrap.releaseEngagementBootstrap(
      conversationId,
      lease.leaseToken
    );
    await drainPendingConversationEngagement({ limit: 10 });
    await expectCanonical();
    await expectCanonical(destinationId);
  });

  it("includes raw historical replay in a ready accumulator through maintenance alone", async () => {
    await insert(2, 10, "outbound");
    await insert(3, 20, "inbound");
    await refreshConversationEngagement(conversationId, { messageId: id(3) });
    const { persistReplayWhatsAppMessageAndLink } = await import(
      "../../../../temporal-worker/src/replay-whatsapp-message-link"
    );
    await persistReplayWhatsAppMessageAndLink(
      {
        messageModel: Message,
        normalizedMessageId: "historical-replay-1",
        providerMessageId: "historical-replay-1",
        fallbackDate: date(0),
        fallbackWorkspaceId: workspaceId,
        fallbackSourceId: "replay-source",
        existingMessageKnownMissing: true,
        messageDocument: {
          _id: id(1),
          conversation: conversationId,
          workspaceId,
          sourceId: "replay-source",
          channel: "whatsapp",
          messageId: "historical-replay-1",
          direction: "inbound",
          date: date(0),
          text: "Price?",
        },
      },
      { appendMessage: async () => ({ appended: true }) }
    );
    expect((await readRawMessage(1)).engagementRefreshPending).toBe(true);
    await drainPendingConversationEngagement({ limit: 10 });
    await expectCanonical();
    expect((await readRawMessage(1)).engagementRefreshPending).toBe(false);
  });

  it("seeks past an active bootstrap conversation and wraps to retry deferred work", async () => {
    const blockedId = id(1000);
    const readyId = id(1001);
    await Conversation.collection.insertMany([
      { _id: blockedId, workspaceId },
      { _id: readyId, workspaceId },
    ]);
    await Message.collection.insertMany([
      {
        _id: id(1),
        workspaceId,
        conversation: blockedId,
        direction: "inbound",
        date: date(0),
        engagementRefreshPending: true,
      },
      {
        _id: id(2),
        workspaceId,
        conversation: readyId,
        direction: "inbound",
        date: date(1),
        engagementRefreshPending: true,
      },
    ]);
    await refreshConversationEngagement(readyId, { messageId: id(2) });
    const claim = await bootstrap.claimEngagementBootstrap(
      blockedId,
      workspaceId,
      id(1)
    );
    const lease = claim as Extract<
      NonNullable<typeof claim>,
      { phase: "building" }
    >;
    await Message.updateOne({ _id: id(2) }, { $set: { text: "Updated?" } });
    await drainPendingConversationEngagement({ limit: 1 });
    await drainPendingConversationEngagement({ limit: 1 });
    expect((await readRawMessage(2)).engagementRefreshPending).toBe(false);
    await bootstrap.releaseEngagementBootstrap(blockedId, lease.leaseToken);
    await drainPendingConversationEngagement({ limit: 1 });
    expect((await readRawMessage(1)).engagementRefreshPending).toBe(false);
  });
});
