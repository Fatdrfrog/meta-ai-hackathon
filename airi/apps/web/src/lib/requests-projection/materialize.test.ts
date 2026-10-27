import mongoose from "mongoose";

const mockReadRequestProjectionSource = jest.fn();
const mockFindProjectionRow = jest.fn();
const mockConversationFind = jest.fn();

jest.mock("@/lib/requests-projection/source-reader", () => {
  const actual = jest.requireActual(
    "@/lib/requests-projection/source-reader"
  ) as Record<string, unknown>;
  return {
    ...actual,
    readRequestProjectionSource: (...args: unknown[]) =>
      mockReadRequestProjectionSource(...args),
  };
});
jest.mock("@/models/request-list-item", () => ({
  RequestListItem: {
    collection: {
      findOne: (...args: unknown[]) => mockFindProjectionRow(...args),
    },
  },
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    find: (...args: unknown[]) => mockConversationFind(...args),
  },
}));

import {
  materializeRequestConversation,
  materializeRequestConversationPage,
  projectionChangeConversationIds,
} from "./materialize";

const conversationId = new mongoose.Types.ObjectId("65f000000000000000000001");
const previousConversationId = new mongoose.Types.ObjectId(
  "65f000000000000000000002"
);

type CausalMaterializeInput = {
  conversationId: mongoose.Types.ObjectId | string;
  generation: mongoose.mongo.Long;
  fence: mongoose.mongo.Long;
  sourceClusterTime: mongoose.mongo.Timestamp;
  readStateWatermarkMode: "preserve" | "advance_if_changed";
  projectedAt?: Date;
  workspaceId?: string;
};

type MaterializeDeps = {
  startSession(options: {
    causalConsistency: true;
  }): Promise<mongoose.ClientSession>;
};

const materializeCausally = materializeRequestConversation as unknown as (
  input: CausalMaterializeInput,
  deps?: MaterializeDeps
) => ReturnType<typeof materializeRequestConversation>;

const materializePageCausally =
  materializeRequestConversationPage as unknown as (
    input: {
      afterId?: mongoose.Types.ObjectId | null;
      limit?: number;
      generation: mongoose.mongo.Long;
      fence: mongoose.mongo.Long;
      sourceClusterTime: mongoose.mongo.Timestamp;
      signal?: AbortSignal;
    },
    deps?: MaterializeDeps
  ) => ReturnType<typeof materializeRequestConversationPage>;

function sourceBoundary(t = 12, i = 3): mongoose.mongo.Timestamp {
  return new mongoose.mongo.Timestamp({ t, i });
}

function sessionHarness(operationTime = sourceBoundary(99, 9)) {
  const lifecycle: string[] = [];
  const session = {
    operationTime,
    advanceOperationTime: jest.fn(() => lifecycle.push("advance")),
    endSession: jest.fn(async () => {
      lifecycle.push("end");
    }),
  } as unknown as mongoose.ClientSession;
  const startSession = jest.fn(async () => {
    lifecycle.push("start");
    return session;
  });
  return { lifecycle, session, startSession };
}

function liveSource() {
  return {
    conversation: {
      _id: conversationId,
      workspaceId: "workspace-1",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    },
    messages: [],
    users: [],
    chat: null,
    airiWitness: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("projection change routing", () => {
  beforeEach(() => {
    mockReadRequestProjectionSource.mockReset();
    mockFindProjectionRow.mockReset();
    mockConversationFind.mockReset();
  });

  it("routes a conversation delete from the preimage", () => {
    expect(
      projectionChangeConversationIds({
        conversationCollection: "conversations",
        messageCollection: "messages",
        change: {
          ns: { coll: "conversations" },
          fullDocumentBeforeChange: {
            _id: conversationId,
            workspaceId: "workspace-1",
          },
        },
      })
    ).toEqual([{ conversationId, workspaceId: "workspace-1" }]);
  });

  it("routes both conversations when a message is reparented", () => {
    expect(
      projectionChangeConversationIds({
        conversationCollection: "conversations",
        messageCollection: "messages",
        change: {
          ns: { coll: "messages" },
          fullDocument: {
            conversation: conversationId,
            workspaceId: "workspace-1",
          },
          fullDocumentBeforeChange: {
            conversation: previousConversationId,
            workspaceId: "workspace-1",
          },
        },
      }).map(row => row.conversationId.toHexString())
    ).toEqual([
      conversationId.toHexString(),
      previousConversationId.toHexString(),
    ]);
  });

  it("owns one causal session, writes the raw boundary, preserves prior read state, and closes before resolving", async () => {
    const boundary = sourceBoundary();
    const priorReadStateWatermark = sourceBoundary(11, 9);
    const harness = sessionHarness(sourceBoundary(99, 9));
    let sourceInput: unknown;
    mockReadRequestProjectionSource.mockImplementation(async input => {
      sourceInput = input;
      return liveSource();
    });
    mockFindProjectionRow.mockResolvedValue({
      workspaceId: "workspace-1",
      projection: { readStateWatermark: priorReadStateWatermark },
    });

    const result = await materializeCausally(
      {
        conversationId,
        workspaceId: "workspace-1",
        generation: mongoose.mongo.Long.fromNumber(7),
        fence: mongoose.mongo.Long.fromNumber(3),
        sourceClusterTime: boundary,
        readStateWatermarkMode: "preserve",
      },
      { startSession: harness.startSession }
    );

    expect(harness.startSession).toHaveBeenCalledWith({
      causalConsistency: true,
    });
    expect(sourceInput).toEqual({
      conversationId,
      session: harness.session,
      sourceClusterTime: boundary,
    });
    expect(mockFindProjectionRow).toHaveBeenCalledWith(
      { _id: conversationId },
      expect.objectContaining({
        session: harness.session,
        readPreference: "primary",
        readConcern: { level: "majority" },
        promoteLongs: false,
      })
    );
    expect(result?.row.projection.sourceWatermark).toBe(boundary);
    expect(result?.row.projection.readStateWatermark).toBe(
      priorReadStateWatermark
    );
    expect(harness.lifecycle).toEqual(["start", "end"]);
    expect(harness.session.endSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "advances to a newer unsigned boundary",
      prior: sourceBoundary(0x7fffffff, 0xffffffff),
      boundary: sourceBoundary(0x80000000, 0),
      expected: "boundary",
    },
    {
      label: "does not regress at the unsigned sign-bit edge",
      prior: sourceBoundary(0x80000000, 0),
      boundary: sourceBoundary(0x7fffffff, 0xffffffff),
      expected: "prior",
    },
    {
      label: "accepts an equal idempotent boundary",
      prior: sourceBoundary(12, 3),
      boundary: sourceBoundary(12, 3),
      expected: "prior",
    },
  ])("$label", async ({ prior, boundary, expected }) => {
    const harness = sessionHarness();
    mockReadRequestProjectionSource.mockResolvedValue(liveSource());
    mockFindProjectionRow.mockResolvedValue({
      workspaceId: "workspace-1",
      projection: { readStateWatermark: prior },
    });

    const result = await materializeCausally(
      {
        conversationId,
        generation: mongoose.mongo.Long.fromNumber(7),
        fence: mongoose.mongo.Long.fromNumber(3),
        sourceClusterTime: boundary,
        readStateWatermarkMode: "advance_if_changed",
      },
      { startSession: harness.startSession }
    );

    expect(result?.row.projection.readStateWatermark).toBe(
      expected === "boundary" ? boundary : prior
    );
    expect(result?.row.projection.sourceWatermark).toBe(boundary);
    expect(harness.session.endSession).toHaveBeenCalledTimes(1);
  });

  it("uses native zero only when a preserved prior read-state watermark is absent", async () => {
    const boundary = sourceBoundary();
    const harness = sessionHarness();
    mockReadRequestProjectionSource.mockResolvedValue(liveSource());
    mockFindProjectionRow.mockResolvedValue({ workspaceId: "workspace-1" });

    const result = await materializeCausally(
      {
        conversationId,
        generation: mongoose.mongo.Long.fromNumber(7),
        fence: mongoose.mongo.Long.fromNumber(3),
        sourceClusterTime: boundary,
        readStateWatermarkMode: "preserve",
      },
      { startSession: harness.startSession }
    );

    expect(result?.row.projection.readStateWatermark).toBeInstanceOf(
      mongoose.mongo.Timestamp
    );
    expect(result?.row.projection.readStateWatermark.toBigInt()).toBe(
      BigInt(0)
    );
    expect(result?.row.projection.sourceWatermark).toBe(boundary);
  });

  it("preserves a tombstone read-state watermark regardless of requested advance mode", async () => {
    const boundary = sourceBoundary(12, 3);
    const priorReadStateWatermark = sourceBoundary(7, 9);
    const harness = sessionHarness();
    mockReadRequestProjectionSource.mockResolvedValue(null);
    mockFindProjectionRow.mockResolvedValue({
      workspaceId: "workspace-1",
      projection: { readStateWatermark: priorReadStateWatermark },
    });

    const result = await materializeCausally(
      {
        conversationId,
        generation: mongoose.mongo.Long.fromNumber(7),
        fence: mongoose.mongo.Long.fromNumber(3),
        sourceClusterTime: boundary,
        readStateWatermarkMode: "advance_if_changed",
      },
      { startSession: harness.startSession }
    );

    expect(result?.row.deletedAt).toBeInstanceOf(Date);
    expect(result?.row.projection.sourceWatermark).toBe(boundary);
    expect(result?.row.projection.readStateWatermark).toBe(
      priorReadStateWatermark
    );
    expect(harness.session.endSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["live", liveSource()],
    ["tombstone", null],
  ])(
    "fails closed on a present corrupt %s prior watermark and still closes the session",
    async (_label, source) => {
      const harness = sessionHarness();
      mockReadRequestProjectionSource.mockResolvedValue(source);
      mockFindProjectionRow.mockResolvedValue({
        workspaceId: "workspace-1",
        projection: {
          readStateWatermark: mongoose.mongo.Long.fromNumber(9),
        },
      });

      await expect(
        materializeCausally(
          {
            conversationId,
            generation: mongoose.mongo.Long.fromNumber(7),
            fence: mongoose.mongo.Long.fromNumber(3),
            sourceClusterTime: sourceBoundary(),
            readStateWatermarkMode: "preserve",
          },
          { startSession: harness.startSession }
        )
      ).rejects.toThrow(/readStateWatermark.*BSON Timestamp/i);
      expect(harness.session.endSession).toHaveBeenCalledTimes(1);
    }
  );

  it("ends the source session exactly once when a source query fails", async () => {
    const failure = new Error("source read failed");
    const harness = sessionHarness();
    mockReadRequestProjectionSource.mockRejectedValue(failure);

    await expect(
      materializeCausally(
        {
          conversationId,
          generation: mongoose.mongo.Long.fromNumber(7),
          fence: mongoose.mongo.Long.fromNumber(3),
          sourceClusterTime: sourceBoundary(),
          readStateWatermarkMode: "preserve",
        },
        { startSession: harness.startSession }
      )
    ).rejects.toBe(failure);
    expect(mockFindProjectionRow).not.toHaveBeenCalled();
    expect(harness.session.endSession).toHaveBeenCalledTimes(1);
  });

  it("enumerates one backfill page causally and releases that session before returning", async () => {
    const boundary = sourceBoundary();
    const harness = sessionHarness();
    const queryCalls: Array<[string, unknown]> = [];
    const query: Record<string, jest.Mock> = {};
    query.select = jest.fn(() => query);
    query.sort = jest.fn(() => query);
    query.limit = jest.fn(() => query);
    query.session = jest.fn((value: unknown) => {
      queryCalls.push(["session", value]);
      return query;
    });
    query.read = jest.fn((value: unknown) => {
      queryCalls.push(["read", value]);
      return query;
    });
    query.readConcern = jest.fn((value: unknown) => {
      queryCalls.push(["readConcern", value]);
      return query;
    });
    query.lean = jest.fn(() => query);
    query.exec = jest.fn(async () => []);
    mockConversationFind.mockReturnValue(query);

    await expect(
      materializePageCausally(
        {
          generation: mongoose.mongo.Long.fromNumber(7),
          fence: mongoose.mongo.Long.fromNumber(3),
          sourceClusterTime: boundary,
        },
        { startSession: harness.startSession }
      )
    ).resolves.toEqual({
      rows: [],
      projected: 0,
      lastId: null,
      hasMore: false,
    });

    expect(harness.startSession).toHaveBeenCalledWith({
      causalConsistency: true,
    });
    expect(harness.session.advanceOperationTime).toHaveBeenCalledWith(boundary);
    expect(queryCalls).toEqual([
      ["session", harness.session],
      ["read", "primary"],
      ["readConcern", "majority"],
    ]);
    expect(harness.session.endSession).toHaveBeenCalledTimes(1);
  });

  it("waits for every distinct row session to close before a concurrent backfill row failure escapes", async () => {
    const boundary = sourceBoundary();
    const firstId = new mongoose.Types.ObjectId("65f000000000000000000001");
    const secondId = new mongoose.Types.ObjectId("65f000000000000000000002");
    const enumeration = sessionHarness();
    const firstRow = sessionHarness();
    const secondRow = sessionHarness();
    const startSession = jest
      .fn()
      .mockResolvedValueOnce(enumeration.session)
      .mockResolvedValueOnce(firstRow.session)
      .mockResolvedValueOnce(secondRow.session);
    const query: Record<string, jest.Mock> = {};
    query.select = jest.fn(() => query);
    query.sort = jest.fn(() => query);
    query.limit = jest.fn(() => query);
    query.session = jest.fn(() => query);
    query.read = jest.fn(() => query);
    query.readConcern = jest.fn(() => query);
    query.lean = jest.fn(() => query);
    query.exec = jest.fn(async () => [
      { _id: firstId, workspaceId: "workspace-1" },
      { _id: secondId, workspaceId: "workspace-1" },
    ]);
    mockConversationFind.mockReturnValue(query);
    const failure = new Error("first row source failed");
    const slowSource = deferred<ReturnType<typeof liveSource>>();
    mockReadRequestProjectionSource
      .mockRejectedValueOnce(failure)
      .mockImplementationOnce(async () => slowSource.promise);
    mockFindProjectionRow.mockResolvedValue(null);

    const pagePromise = materializePageCausally(
      {
        generation: mongoose.mongo.Long.fromNumber(7),
        fence: mongoose.mongo.Long.fromNumber(3),
        sourceClusterTime: boundary,
      },
      { startSession }
    );
    let settled = false;
    void pagePromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await new Promise(resolve => setImmediate(resolve));

    expect(settled).toBe(false);
    expect(firstRow.session.endSession).toHaveBeenCalledTimes(1);
    expect(secondRow.session.endSession).not.toHaveBeenCalled();

    slowSource.resolve(liveSource());
    await expect(pagePromise).rejects.toBe(failure);
    expect(secondRow.session.endSession).toHaveBeenCalledTimes(1);
    expect(startSession).toHaveBeenCalledTimes(3);
  });
});
