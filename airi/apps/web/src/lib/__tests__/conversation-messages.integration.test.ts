import mongoose from "mongoose";

import { appendMessageToConversationById } from "@/lib/conversation-messages";
import { Conversation } from "@/models/conversation";

const mongoUri = process.env.CLASSIFICATION_CONTRACT_TEST_MONGODB_URI;
const describeMongo = mongoUri ? describe : describe.skip;
const NOW = new Date("2026-08-10T06:00:00.000Z");

async function insertConversation(
  overrides: Record<string, unknown> = {}
): Promise<mongoose.Types.ObjectId> {
  const _id = new mongoose.Types.ObjectId();
  await Conversation.collection.insertOne({
    _id,
    workspaceId: "workspace-append-integration",
    channel: "whatsapp",
    messages: [],
    message_count: 0,
    classification_revision: 0,
    classification_state: null,
    last_inbound_at: null,
    is_classified: false,
    is_qa_analyzed: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
  return _id;
}

describeMongo("canonical conversation message append real Mongo gates", () => {
  beforeAll(async () => {
    await mongoose.connect(mongoUri as string, {
      serverSelectionTimeoutMS: 5_000,
    });
  });

  afterEach(async () => {
    await mongoose.connection.db?.dropDatabase();
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  it("increments two revisions for two concurrent unique inbound appends", async () => {
    const conversationId = await insertConversation();
    const firstMessageId = new mongoose.Types.ObjectId();
    const secondMessageId = new mongoose.Types.ObjectId();
    const scheduleWake = jest.fn().mockResolvedValue(undefined);

    const results = await Promise.all([
      appendMessageToConversationById(
        conversationId,
        firstMessageId,
        { direction: "inbound", lastMessageAt: NOW },
        { now: () => NOW, scheduleWake }
      ),
      appendMessageToConversationById(
        conversationId,
        secondMessageId,
        { direction: "inbound", lastMessageAt: NOW },
        { now: () => NOW, scheduleWake }
      ),
    ]);

    const stored = await Conversation.collection.findOne({
      _id: conversationId,
    });
    expect(results.every(result => result.appended)).toBe(true);
    expect(stored?.messages).toEqual(
      expect.arrayContaining([firstMessageId, secondMessageId])
    );
    expect(stored?.messages).toHaveLength(2);
    expect(stored?.message_count).toBe(2);
    expect(stored?.classification_revision).toBe(2);
    expect(stored?.classification_state).toMatchObject({
      status: "pending",
      requestedRevision: 2,
      generation: 2,
    });
    expect(
      results.map(result => result.classificationRevision).sort((a, b) => a - b)
    ).toEqual([1, 2]);
    expect(
      results.map(result => result.generation).sort((a, b) => a - b)
    ).toEqual([1, 2]);
    expect(scheduleWake).toHaveBeenCalledTimes(2);
    expect(
      scheduleWake.mock.calls
        .map(([request]) => request.requestedRevision)
        .sort((a, b) => a - b)
    ).toEqual([1, 2]);
    expect(
      scheduleWake.mock.calls
        .map(([request]) => request.generation)
        .sort((a, b) => a - b)
    ).toEqual([1, 2]);
  });

  it("preserves a manager read after an already linked inbound message is replayed", async () => {
    const conversationId = await insertConversation();
    const messageId = new mongoose.Types.ObjectId();
    const scheduleWake = jest.fn().mockResolvedValue(undefined);
    const options = { direction: "inbound" as const, lastMessageAt: NOW };
    await appendMessageToConversationById(conversationId, messageId, options, {
      scheduleWake,
    });
    await Conversation.collection.updateOne(
      { _id: conversationId },
      { $set: { is_read_by_manager: true } }
    );

    const replay = await appendMessageToConversationById(
      conversationId,
      messageId,
      options,
      { scheduleWake }
    );
    const stored = await Conversation.collection.findOne({
      _id: conversationId,
    });
    expect(replay.appended).toBe(false);
    expect(stored?.is_read_by_manager).toBe(true);
    expect(stored?.message_count).toBe(1);
    expect(stored?.classification_revision).toBe(1);
    expect(scheduleWake).toHaveBeenCalledTimes(1);
  });

  it("links two concurrent copies of one message only once", async () => {
    const conversationId = await insertConversation();
    const messageId = new mongoose.Types.ObjectId();
    const scheduleWake = jest.fn().mockResolvedValue(undefined);

    const results = await Promise.all([
      appendMessageToConversationById(
        conversationId,
        messageId,
        { direction: "inbound", lastMessageAt: NOW },
        { now: () => NOW, scheduleWake }
      ),
      appendMessageToConversationById(
        conversationId,
        messageId,
        { direction: "inbound", lastMessageAt: NOW },
        { now: () => NOW, scheduleWake }
      ),
    ]);

    const stored = await Conversation.collection.findOne({
      _id: conversationId,
    });
    expect(results.filter(result => result.appended)).toHaveLength(1);
    expect(stored?.messages).toEqual([messageId]);
    expect(stored?.message_count).toBe(1);
    expect(stored?.classification_revision).toBe(1);
    expect(stored?.classification_state).toMatchObject({
      requestedRevision: 1,
      generation: 1,
    });
    expect(results.map(result => result.classificationRevision)).toEqual([
      1, 1,
    ]);
    expect(results.map(result => result.generation)).toEqual([1, 1]);
    expect(scheduleWake).toHaveBeenCalledTimes(1);
  });

  it("treats a legacy string message reference as the same ObjectId", async () => {
    const messageId = new mongoose.Types.ObjectId();
    const requestedAt = new Date("2026-08-10T05:00:00.000Z");
    const conversationId = await insertConversation({
      messages: [messageId.toHexString()],
      message_count: 1,
      classification_revision: 7,
      classification_state: {
        contractVersion: 2,
        status: "ready",
        requestedRevision: 7,
        processingRevision: null,
        appliedRevision: 7,
        generation: 4,
        attemptRevision: 7,
        attemptCount: 1,
        fence: 1,
        requestedAt,
        nextAttemptAt: null,
        lastEnqueuedAt: requestedAt,
        completedAt: requestedAt,
        lease: null,
        error: null,
        review: null,
        blocked: null,
      },
      is_classified: true,
    });
    const scheduleWake = jest.fn();

    const result = await appendMessageToConversationById(
      conversationId,
      messageId,
      { direction: "inbound", lastMessageAt: NOW },
      { now: () => NOW, scheduleWake }
    );

    const stored = await Conversation.collection.findOne({
      _id: conversationId,
    });
    expect(result.appended).toBe(false);
    expect(stored?.messages).toEqual([messageId.toHexString()]);
    expect(stored?.classification_revision).toBe(7);
    expect(stored?.classification_state).toMatchObject({
      status: "ready",
      requestedRevision: 7,
      generation: 4,
    });
    expect(scheduleWake).not.toHaveBeenCalled();
  });

  it("keeps outbound-only work not applicable until its first inbound append", async () => {
    const conversationId = await insertConversation();
    const scheduleWake = jest.fn().mockResolvedValue(undefined);

    const outbound = await appendMessageToConversationById(
      conversationId,
      new mongoose.Types.ObjectId(),
      { direction: "outbound", lastMessageAt: NOW },
      { now: () => NOW, scheduleWake }
    );
    expect(outbound).toMatchObject({
      appended: true,
      classificationRevision: 1,
      requestedRevision: 1,
      generation: 0,
      status: "not_applicable",
    });
    expect(scheduleWake).not.toHaveBeenCalled();

    const inboundAt = new Date("2026-08-10T06:01:00.000Z");
    const inbound = await appendMessageToConversationById(
      conversationId,
      new mongoose.Types.ObjectId(),
      { direction: "inbound", lastMessageAt: inboundAt },
      { now: () => inboundAt, scheduleWake }
    );
    expect(inbound).toMatchObject({
      appended: true,
      classificationRevision: 2,
      requestedRevision: 2,
      generation: 1,
      status: "pending",
    });
    expect(scheduleWake).toHaveBeenCalledTimes(1);
  });

  it("advances the requested revision while retaining a live processing lease", async () => {
    const leaseExpiry = new Date("2026-08-10T06:10:00.000Z");
    const conversationId = await insertConversation({
      classification_revision: 3,
      last_inbound_at: new Date("2026-08-10T05:55:00.000Z"),
      classification_state: {
        contractVersion: 2,
        status: "processing",
        requestedRevision: 3,
        processingRevision: 3,
        appliedRevision: 2,
        generation: 2,
        attemptRevision: 3,
        attemptCount: 1,
        fence: 9,
        requestedAt: new Date("2026-08-10T05:59:00.000Z"),
        nextAttemptAt: null,
        lastEnqueuedAt: null,
        completedAt: null,
        lease: {
          ownerToken: "worker-3",
          claimedAt: new Date("2026-08-10T05:59:00.000Z"),
          expiresAt: leaseExpiry,
        },
        error: null,
        review: null,
        blocked: null,
      },
    });

    const result = await appendMessageToConversationById(
      conversationId,
      new mongoose.Types.ObjectId(),
      { direction: "inbound", lastMessageAt: NOW },
      { now: () => NOW, scheduleWake: jest.fn() }
    );
    const stored = await Conversation.collection.findOne({
      _id: conversationId,
    });

    expect(result).toMatchObject({
      classificationRevision: 4,
      requestedRevision: 4,
      generation: 3,
      status: "processing",
    });
    expect(stored?.classification_state).toMatchObject({
      status: "processing",
      requestedRevision: 4,
      processingRevision: 3,
      fence: 9,
      lease: {
        ownerToken: "worker-3",
        expiresAt: leaseExpiry,
      },
    });
  });

  it("establishes source chronology from the first historical append", async () => {
    const historicalAt = new Date("2025-01-01T10:00:00.000Z");
    const conversationId = await insertConversation({ updatedAt: NOW });

    await appendMessageToConversationById(
      conversationId,
      new mongoose.Types.ObjectId(),
      {
        direction: "outbound",
        lastMessageAt: historicalAt,
        historicalUpdatedAt: historicalAt,
      },
      { now: () => NOW, scheduleWake: jest.fn() }
    );

    const stored = await Conversation.collection.findOne({
      _id: conversationId,
    });
    expect(stored?.updatedAt).toEqual(historicalAt);
  });

  it("does not move established chronology backward for an older unique append", async () => {
    const newerAt = new Date("2025-01-03T10:00:00.000Z");
    const olderAt = new Date("2025-01-02T10:00:00.000Z");
    const conversationId = await insertConversation();

    await appendMessageToConversationById(
      conversationId,
      new mongoose.Types.ObjectId(),
      {
        direction: "outbound",
        lastMessageAt: newerAt,
        historicalUpdatedAt: newerAt,
      },
      { now: () => NOW, scheduleWake: jest.fn() }
    );
    await appendMessageToConversationById(
      conversationId,
      new mongoose.Types.ObjectId(),
      {
        direction: "outbound",
        lastMessageAt: olderAt,
        historicalUpdatedAt: olderAt,
      },
      { now: () => NOW, scheduleWake: jest.fn() }
    );

    const stored = await Conversation.collection.findOne({
      _id: conversationId,
    });
    expect(stored?.updatedAt).toEqual(newerAt);
  });

  it("does not move established chronology backward for an older duplicate replay", async () => {
    const newerAt = new Date("2025-01-03T10:00:00.000Z");
    const olderAt = new Date("2025-01-01T10:00:00.000Z");
    const messageId = new mongoose.Types.ObjectId();
    const conversationId = await insertConversation();

    await appendMessageToConversationById(
      conversationId,
      messageId,
      {
        direction: "outbound",
        lastMessageAt: newerAt,
        historicalUpdatedAt: newerAt,
      },
      { now: () => NOW, scheduleWake: jest.fn() }
    );
    const duplicate = await appendMessageToConversationById(
      conversationId,
      messageId,
      {
        direction: "outbound",
        lastMessageAt: olderAt,
        historicalUpdatedAt: olderAt,
      },
      { now: () => NOW, scheduleWake: jest.fn() }
    );

    const stored = await Conversation.collection.findOne({
      _id: conversationId,
    });
    expect(duplicate.appended).toBe(false);
    expect(stored?.updatedAt).toEqual(newerAt);
  });
});
