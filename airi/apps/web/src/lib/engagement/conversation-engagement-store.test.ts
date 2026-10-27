import mongoose from "mongoose";

const mockMessages = new Map<string, mongoose.mongo.Document>();
const mockLeases = new Map<string, mongoose.mongo.Document>();
let mockLeaseFailure = false;
let mockConversation: mongoose.mongo.Document;
let mockState: mongoose.mongo.Document | null;
let mockHistoryReads = 0;
let mockFailCommit = false;
let mockRetryTransaction = false;
let mockTransactionTail = Promise.resolve();
const mockSession = { withTransaction: jest.fn(), endSession: jest.fn() };
const mockWrites = jest.fn();
const mockConversationWrites: Array<{
  update: mongoose.mongo.Document;
  session: unknown;
}> = [];
const mockMessageUpdates: Array<{
  filter: mongoose.mongo.Document;
  update: mongoose.mongo.Document;
  matchedCount: number;
}> = [];
let mockRequestedTransactions = 0;
let mockMaxRequestedTransactions = 0;
const mockMessageFindOnes = jest.fn();
const mockBulkWrites = jest.fn();
const mockSelections: string[] = [];
type TestQuery = {
  select: (...args: unknown[]) => TestQuery;
  sort: (order: Record<string, number>) => TestQuery;
  lean: () => TestQuery;
  limit: (count: number) => TestQuery;
  session: (session: unknown) => TestQuery;
  exec: () => Promise<mongoose.mongo.Document[string]>;
};

function clone<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clone(item)])
    ) as T;
  return value;
}

function field(
  document: mongoose.mongo.Document,
  path: string
): mongoose.mongo.Document[string] {
  return path.split(".").reduce((value, key) => value?.[key], document);
}

function matches(
  document: mongoose.mongo.Document,
  filter: mongoose.mongo.Document
): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$or")
      return condition.some((part: mongoose.mongo.Document) =>
        matches(document, part)
      );
    if (key === "$and")
      return condition.every((part: mongoose.mongo.Document) =>
        matches(document, part)
      );
    const value = field(document, key);
    if (
      condition &&
      typeof condition === "object" &&
      !(condition instanceof Date) &&
      !(condition instanceof mongoose.Types.ObjectId)
    ) {
      return Object.entries(condition).every(([operator, operand]) => {
        if (operator === "$ne") return String(value) !== String(operand);
        if (operator === "$type") return value instanceof Date;
        if (operator === "$lt") return value < (operand as number);
        if (operator === "$gt") return value > (operand as number);
        if (operator === "$lte") return value <= (operand as number);
        if (operator === "$gte") return value >= (operand as number);
        if (operator === "$exists") return (value !== undefined) === operand;
        throw new Error(`Unsupported test operator ${operator}`);
      });
    }
    return value instanceof Date || condition instanceof Date
      ? Number(value) === Number(condition)
      : String(value) === String(condition);
  });
}

function query(documents: () => mongoose.mongo.Document[], one: boolean) {
  let sort: Record<string, number> = {};
  let limit = Infinity;
  const read = () => {
    const result = documents().sort((left, right) => {
      for (const [key, direction] of Object.entries(sort)) {
        const a = field(left, key);
        const b = field(right, key);
        const order = a < b ? -1 : a > b ? 1 : 0;
        if (order) return order * direction;
      }
      return 0;
    });
    return clone(one ? (result[0] ?? null) : result.slice(0, limit));
  };
  const chain: TestQuery = {
    select: (selection: unknown) => {
      if (typeof selection === "string") mockSelections.push(selection);
      return chain;
    },
    sort: (order: Record<string, number>) => {
      sort = order;
      return chain;
    },
    lean: () => chain,
    limit: (count: number) => {
      limit = count;
      return chain;
    },
    session: (session: unknown) => {
      expect(session).toBe(mockSession);
      return chain;
    },
    exec: async () => read(),
  };
  return chain;
}

function setFields(
  document: mongoose.mongo.Document,
  update: mongoose.mongo.Document
) {
  for (const [path, value] of Object.entries(update.$set ?? {})) {
    const keys = path.split(".");
    let current = document;
    for (const key of keys.slice(0, -1)) current = current[key] ??= {};
    current[keys.at(-1)!] = clone(value);
  }
}

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: async () => undefined,
}));
jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    find: (filter: mongoose.mongo.Document) => {
      // Pending pages and contribution windows are bounded; a conversation scan is not.
      if (
        !filter._id &&
        !("engagementRefreshPending" in filter) &&
        !("engagementContribution.generation" in filter)
      )
        mockHistoryReads++;
      return query(
        () => [...mockMessages.values()].filter(doc => matches(doc, filter)),
        false
      );
    },
    findOne: (filter: mongoose.mongo.Document) => {
      mockMessageFindOnes();
      return query(
        () => [...mockMessages.values()].filter(doc => matches(doc, filter)),
        true
      );
    },
    updateOne: (
      filter: mongoose.mongo.Document,
      update: mongoose.mongo.Document,
      options: { session?: unknown }
    ) => {
      mockWrites(options?.session);
      let matchedCount = 0;
      for (const document of mockMessages.values())
        if (matches(document, filter)) {
          setFields(document, update);
          matchedCount++;
        }
      mockMessageUpdates.push({ filter, update, matchedCount });
      return { exec: async () => ({ matchedCount }) };
    },
    bulkWrite: async (
      operations: Array<{
        updateOne: {
          filter: mongoose.mongo.Document;
          update: mongoose.mongo.Document;
        };
      }>,
      options: { session?: unknown }
    ) => {
      mockWrites(options?.session);
      mockBulkWrites(operations.length);
      for (const { updateOne } of operations) {
        for (const document of mockMessages.values())
          if (matches(document, updateOne.filter))
            setFields(document, updateOne.update);
      }
    },
  },
}));
jest.mock("@/models/conversation-engagement-lease", () => ({
  ConversationEngagementLease: {
    findOneAndUpdate: (
      filter: mongoose.mongo.Document,
      update: mongoose.mongo.Document
    ) => ({
      lean: () => ({
        exec: async () => {
          if (mockLeaseFailure) throw new Error("lease store unavailable");
          const existing = mockLeases.get(String(filter._id));
          if (existing && !matches(existing, filter)) {
            throw Object.assign(new Error("E11000 duplicate key"), {
              code: 11000,
            });
          }
          const lease = existing ?? { _id: String(filter._id) };
          setFields(lease, update);
          mockLeases.set(String(filter._id), lease);
          return clone(lease);
        },
      }),
    }),
    updateOne: (
      filter: mongoose.mongo.Document,
      update: mongoose.mongo.Document
    ) => ({
      exec: async () => {
        const lease = mockLeases.get(String(filter._id));
        if (lease && matches(lease, filter)) setFields(lease, update);
        return { matchedCount: lease ? 1 : 0 };
      },
    }),
  },
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    startSession: async () => mockSession,
    findOne: (filter: mongoose.mongo.Document) =>
      query(
        () => (matches(mockConversation, filter) ? [mockConversation] : []),
        true
      ),
    updateOne: (
      filter: mongoose.mongo.Document,
      update: mongoose.mongo.Document,
      options?: { session?: unknown }
    ) => {
      mockWrites(options?.session);
      mockConversationWrites.push({ update, session: options?.session });
      const matchedCount = matches(mockConversation, filter) ? 1 : 0;
      if (matchedCount) setFields(mockConversation, update);
      return { exec: async () => ({ matchedCount }) };
    },
    findOneAndUpdate: (
      filter: mongoose.mongo.Document,
      update: mongoose.mongo.Document,
      options: { session?: unknown; new?: boolean }
    ) => {
      expect(options.new).toBe(false);
      mockWrites(options.session);
      mockConversationWrites.push({ update, session: options.session });
      const before = matches(mockConversation, filter)
        ? clone(mockConversation)
        : null;
      if (before) setFields(mockConversation, update);
      return query(() => (before ? [before] : []), true);
    },
  },
}));
jest.mock("@/models/conversation-engagement-state", () => ({
  ConversationEngagementState: {
    findOne: (filter: mongoose.mongo.Document) =>
      query(
        () => (mockState && matches(mockState, filter) ? [mockState] : []),
        true
      ),
    updateOne: (
      filter: mongoose.mongo.Document,
      update: mongoose.mongo.Document,
      options?: { session?: unknown; upsert?: boolean }
    ) => {
      mockWrites(options?.session);
      // Fails the commit-time state write; adoption upserts stay unaffected.
      if (mockFailCommit && !options?.upsert) throw new Error("commit failed");
      if (!mockState && options?.upsert) mockState = { _id: filter._id };
      const matchedCount = mockState && matches(mockState, filter) ? 1 : 0;
      if (matchedCount) setFields(mockState!, update);
      return { exec: async () => ({ matchedCount }) };
    },
  },
}));

import {
  computeConversationEngagementMetrics,
  refreshConversationEngagement,
} from "./conversation-engagement";
import { ENGAGEMENT_STATE_MOVED_MARKER } from "./conversation-engagement-bootstrap";

const conversationId = "100000000000000000000001";
const messageId = (number: number) => number.toString(16).padStart(24, "0");
const date = (minutes: number) => new Date(Date.UTC(2026, 8, 1, 0, minutes));
function add(
  number: number,
  minutes: number,
  direction = "inbound",
  extra: mongoose.mongo.Document = {}
) {
  mockMessages.set(messageId(number), {
    _id: messageId(number),
    conversation: conversationId,
    date: date(minutes),
    direction,
    ...extra,
  });
}
async function refresh(number: number) {
  return refreshConversationEngagement(conversationId, {
    workspaceId: "workspace",
    messageId: messageId(number),
  });
}
function expectCanonical() {
  expect(mockState?.engagement_metrics).toEqual(
    mockConversation.engagement_metrics
  );
  const messages = [...mockMessages.values()].sort(
    (a, b) => Number(a.date) - Number(b.date) || a._id.localeCompare(b._id)
  );
  const expected = computeConversationEngagementMetrics(messages);
  expect(mockConversation.engagement_metrics).toEqual({
    ...expected,
    computedAt: expect.any(Date),
  });
  expect(mockConversation.message_count).toBe(expected.messageCount);
}

beforeEach(() => {
  mockMessages.clear();
  mockLeases.clear();
  mockLeaseFailure = false;
  mockConversation = { _id: conversationId, workspaceId: "workspace" };
  mockState = null;
  mockConversationWrites.length = 0;
  mockHistoryReads = 0;
  mockFailCommit = false;
  mockRetryTransaction = false;
  mockTransactionTail = Promise.resolve();
  mockWrites.mockClear();
  mockMessageUpdates.length = 0;
  mockRequestedTransactions = 0;
  mockMaxRequestedTransactions = 0;
  mockMessageFindOnes.mockClear();
  mockBulkWrites.mockClear();
  mockSelections.length = 0;
  mockSession.endSession.mockClear();
  mockSession.withTransaction.mockImplementation(
    async (operation: () => Promise<unknown>) => {
      mockMaxRequestedTransactions = Math.max(
        mockMaxRequestedTransactions,
        ++mockRequestedTransactions
      );
      const preceding = mockTransactionTail;
      let unlock!: () => void;
      mockTransactionTail = new Promise<void>(resolve => {
        unlock = resolve;
      });
      await preceding;
      const savedConversation = clone(mockConversation);
      const savedState = clone(mockState);
      const savedMessages = clone([...mockMessages]);
      const rollback = () => {
        mockConversation = clone(savedConversation);
        mockState = clone(savedState);
        mockMessages.clear();
        for (const [id, document] of clone(savedMessages))
          mockMessages.set(id, document);
      };
      try {
        if (mockRetryTransaction) {
          await operation();
          rollback();
          mockRetryTransaction = false;
        }
        return await operation();
      } catch (error) {
        rollback();
        throw error;
      } finally {
        mockRequestedTransactions--;
        unlock();
      }
    }
  );
});

describe("durable incremental engagement", () => {
  it("bootstraps once, then updates appends and old delivery/reaction edits without reading history", async () => {
    add(1, 0, "outbound", { origin: { kind: "campaign" } });
    add(2, 10, "inbound", { text: "Price?" });
    await refresh(2);
    expectCanonical();
    expect(mockHistoryReads).toBe(1);
    expect(mockSelections).not.toContain("+engagementContribution");
    for (let i = 3; i < 30; i++) {
      add(i, i * 10, i % 2 ? "outbound" : "inbound");
      await refresh(i);
      expectCanonical();
    }
    mockMessages.get(messageId(1))!.delivery = {
      status: "played",
      readAt: date(300),
    };
    mockMessages.get(messageId(2))!.reactions = [
      { emoji: "like" },
      { emoji: "heart" },
    ];
    await refresh(1);
    await refresh(2);
    await refresh(1);
    expectCanonical();
    expect(mockHistoryReads).toBe(1);
    // Transactions write messages and the state document; the conversation
    // gets only the one-time moved marker inside one, and copies after commit.
    const transactional = mockConversationWrites.filter(
      ({ session }) => session === mockSession
    );
    expect(
      transactional.map(({ update }) => update.$set.engagement_accumulator)
    ).toEqual([ENGAGEMENT_STATE_MOVED_MARKER]);
    const copies = mockConversationWrites.filter(
      ({ session }) => session !== mockSession
    );
    expect(copies.length).toBeGreaterThan(0);
    expect(
      mockWrites.mock.calls.filter(([session]) => session !== mockSession)
    ).toHaveLength(copies.length);
    expect(
      copies.every(({ update }) => !("engagement_accumulator" in update.$set))
    ).toBe(true);
  });

  it("repairs old and new edges for late messages, date moves, direction changes and campaign edits", async () => {
    add(1, 0, "outbound", { origin: { kind: "campaign" } });
    add(3, 20, "inbound");
    add(4, 30, "outbound");
    add(5, 40, "inbound");
    await refresh(5);
    add(2, 10, "outbound");
    await refresh(2);
    expectCanonical();
    mockMessages.get(messageId(2))!.date = date(35);
    await refresh(2);
    expectCanonical();
    mockMessages.get(messageId(4))!.direction = "inbound";
    await refresh(4);
    expectCanonical();
    mockMessages.get(messageId(1))!.origin = { campaignId: "late-campaign" };
    await refresh(1);
    expectCanonical();
    mockMessages.get(messageId(2))!.direction = "invalid";
    await refresh(2);
    expectCanonical();
    mockMessages.get(messageId(2))!.direction = "outbound";
    await refresh(2);
    expectCanonical();
    mockMessages.get(messageId(3))!.date = "invalid-date";
    await refresh(3);
    expectCanonical();
    mockMessages.get(messageId(3))!.date = date(20);
    await refresh(3);
    expectCanonical();
    expect(mockHistoryReads).toBe(1);
  });

  it("preserves deterministic same-date ordering and first reply rounding", async () => {
    add(3, 0, "inbound");
    add(1, 0, "outbound");
    add(4, 1, "inbound");
    await refresh(4);
    add(2, 0, "outbound", { origin: { kind: "campaign" } });
    await refresh(2);
    expectCanonical();
    mockMessages.get(messageId(3))!.date = new Date(date(0).getTime() + 9000);
    await refresh(3);
    expectCanonical();
    expect(
      mockConversation.engagement_metrics.firstCustomerReplyDelayMinutes
    ).toBe(0.2);
  });

  it("counts concurrent duplicate callbacks once and retries a transaction from durable snapshots", async () => {
    add(1, 0, "outbound");
    await refresh(1);
    add(2, 10, "inbound");
    add(3, 20, "outbound");
    await Promise.all([refresh(3), refresh(2), refresh(2)]);
    mockMessages.get(messageId(1))!.delivery = { status: "read" };
    mockRetryTransaction = true;
    await refresh(1);
    expectCanonical();
    expect(mockConversation.engagement_metrics.readCount).toBe(1);
    expect(mockConversation.engagement_metrics.deliveredCount).toBe(1);
    expect(mockHistoryReads).toBe(1);
  });

  it("runs a same-conversation callback burst one transaction at a time", async () => {
    add(1, 0, "outbound");
    await refresh(1);
    for (let i = 2; i <= 8; i++)
      add(i, i * 10, i % 2 ? "outbound" : "inbound", {
        engagementRefreshPending: true,
      });
    mockMaxRequestedTransactions = 0;
    await Promise.all([2, 3, 4, 5, 6, 7, 8].map(refresh));
    // Concurrent same-conversation transactions only abort each other in Mongo.
    expect(mockMaxRequestedTransactions).toBe(1);
    expectCanonical();
    expect(
      [...mockMessages.values()].every(
        message => message.engagementRefreshPending === false
      )
    ).toBe(true);
  });

  it("does not rewrite a pending marker that the source write already set", async () => {
    add(1, 0, "outbound");
    await refresh(1);
    add(2, 10, "inbound", { engagementRefreshPending: true });
    mockMessageUpdates.length = 0;
    await refresh(2);
    expect(
      mockMessageUpdates.filter(
        ({ update, matchedCount }) =>
          matchedCount > 0 && update.$set?.engagementRefreshPending === true
      )
    ).toEqual([]);
    expectCanonical();
  });

  it("rolls back contributions with failed metrics writes, then reconciles on retry", async () => {
    add(1, 0, "outbound");
    await refresh(1);
    add(2, 10, "inbound");
    mockFailCommit = true;
    await expect(refresh(2)).rejects.toThrow("commit failed");
    expect(
      mockMessages.get(messageId(2))!.engagementContribution
    ).toBeUndefined();
    mockFailCommit = false;
    await refresh(2);
    expectCanonical();
  });

  it("bootstraps a page with one bulk write instead of per-message reads", async () => {
    for (let i = 1; i <= 30; i++)
      add(i, i * 10, i % 3 ? "inbound" : "outbound", {
        text: i % 4 ? "ok" : "Price?",
      });
    await refreshConversationEngagement(conversationId, {
      workspaceId: "workspace",
    });
    expectCanonical();
    // Per-message round trips held a production conversation for ~20 s.
    expect(mockBulkWrites).toHaveBeenCalledTimes(1);
    expect(mockMessageFindOnes.mock.calls.length).toBeLessThan(10);
  });

  it("replays later bootstrap pages in memory across out-of-order dates", async () => {
    for (let i = 1; i <= 120; i++)
      add(
        i,
        (i * 37) % 120,
        i % 2 ? "inbound" : "outbound",
        i % 11 === 0 ? { origin: { kind: "campaign" } } : {}
      );
    await refreshConversationEngagement(conversationId, {
      workspaceId: "workspace",
    });
    expectCanonical();
    expect(mockBulkWrites).toHaveBeenCalledTimes(3);
    expect(mockMessageFindOnes.mock.calls.length).toBeLessThan(20);
  });

  it("drains a pending burst in one page transaction", async () => {
    add(1, 0, "outbound");
    await refresh(1);
    for (let i = 2; i <= 9; i++)
      add(i, i * 10, i % 2 ? "outbound" : "inbound", {
        engagementRefreshPending: true,
      });
    mockBulkWrites.mockClear();
    await refresh(9);
    expectCanonical();
    expect(mockBulkWrites).toHaveBeenCalledTimes(1);
    expect(
      [...mockMessages.values()].every(
        message => message.engagementRefreshPending === false
      )
    ).toBe(true);
  });

  it("adopts a legacy conversation state without rebuilding history", async () => {
    add(1, 0, "outbound");
    add(2, 10, "inbound");
    await refresh(2);
    // An older deployment kept this state on the conversation itself.
    mockConversation = {
      _id: conversationId,
      workspaceId: "workspace",
      engagement_accumulator: clone(mockState!.engagement_accumulator),
      engagement_metrics: clone(mockState!.engagement_metrics),
      message_count: 2,
    };
    mockState = null;
    mockHistoryReads = 0;
    add(3, 20, "outbound");
    await refresh(3);
    expectCanonical();
    expect(mockHistoryReads).toBe(0);
    expect(mockConversation.engagement_accumulator).toEqual(
      ENGAGEMENT_STATE_MOVED_MARKER
    );
    expect(mockState!.engagement_accumulator.phase).toBe("ready");
  });

  it("resumes a legacy bootstrap from its checkpoint after fencing out the old owner", async () => {
    add(1, 0, "outbound");
    add(2, 10, "inbound");
    await refresh(2);
    const accumulator = clone(mockState!.engagement_accumulator);
    mockConversation = {
      _id: conversationId,
      workspaceId: "workspace",
      engagement_accumulator: {
        version: 1,
        phase: "building",
        generation: accumulator.generation,
        leaseToken: "old-deployment-owner",
        leaseUntil: new Date(Date.now() + 60_000),
        afterId: messageId(2),
        accumulator,
      },
    };
    mockState = null;
    mockHistoryReads = 0;
    add(3, 20, "outbound", { engagementRefreshPending: true });
    await refresh(3);
    expectCanonical();
    // The checkpoint continues after message 2 instead of scanning from the start.
    expect(mockHistoryReads).toBe(0);
    expect(mockState!.engagement_accumulator.generation).toBe(
      accumulator.generation
    );
    expect(mockConversation.engagement_accumulator).toEqual(
      ENGAGEMENT_STATE_MOVED_MARKER
    );
  });

  it("re-copies metrics a crash left behind and never lets an older copy win", async () => {
    add(1, 0, "outbound");
    add(2, 10, "inbound");
    await refresh(2);
    const current = clone(mockConversation.engagement_metrics);
    // A crash after the state commit skipped the copy.
    mockConversation.engagement_metrics = { messageCount: 1 };
    mockConversation.engagement_revision = mockState!.revision - 1;
    await refresh(2);
    expect(mockConversation.engagement_metrics).toEqual(current);
    expect(mockConversation.engagement_revision).toBe(mockState!.revision);
    const { copyEngagementMetricsToConversation } = await import(
      "./conversation-engagement-store"
    );
    await copyEngagementMetricsToConversation(
      new mongoose.Types.ObjectId(conversationId),
      {
        revision: mockState!.revision - 1,
        metrics: { ...current, messageCount: 1 },
      }
    );
    expect(mockConversation.engagement_metrics).toEqual(current);
  });

  it("leaves a mismatched workspace untouched before reading message history", async () => {
    add(1, 0);
    const result = await refreshConversationEngagement(conversationId, {
      workspaceId: "other",
      messageId: messageId(1),
    });
    expect(result).toBeNull();
    expect(mockHistoryReads).toBe(0);
    expect(mockWrites).not.toHaveBeenCalled();
  });
});

describe("cross-instance engagement lease", () => {
  const sleep = (ms: number) =>
    new Promise(resolve => {
      setTimeout(resolve, ms);
    });

  it("defers to another process holding the conversation, then applies after it releases", async () => {
    add(1, 0, "outbound");
    await refresh(1);
    add(2, 10, "inbound", { text: "Price?" });
    mockLeases.set(conversationId, {
      _id: conversationId,
      ownerToken: "other-process",
      expiresAt: new Date(Date.now() + 60_000),
    });
    mockSession.withTransaction.mockClear();

    await expect(refresh(2)).resolves.toBeNull();
    expect(mockSession.withTransaction).not.toHaveBeenCalled();
    expect(mockMessages.get(messageId(2))?.engagementRefreshPending).toBe(true);

    mockLeases.get(conversationId)!.expiresAt = new Date(0);
    await sleep(400);
    expectCanonical();
    expect(mockMessages.get(messageId(2))?.engagementRefreshPending).not.toBe(
      true
    );
    expect(mockLeases.get(conversationId)?.ownerToken).toBeNull();
  });

  it("releases the lease after refreshing", async () => {
    add(1, 0);
    await refresh(1);
    expectCanonical();
    expect(mockLeases.get(conversationId)).toEqual({
      _id: conversationId,
      ownerToken: null,
      expiresAt: expect.any(Date),
    });
  });

  it("still refreshes when the lease store itself fails", async () => {
    mockLeaseFailure = true;
    add(1, 0, "outbound");
    add(2, 5, "inbound");
    await refresh(1);
    await refresh(2);
    expectCanonical();
  });
});

