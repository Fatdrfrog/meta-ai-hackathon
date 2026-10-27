const mockConnectDB = jest.fn(async () => undefined);
const mockAdminCommand = jest.fn(async (_command: Record<string, unknown>) => ({
  setName: "rs0",
}));
const mockCommand = jest.fn(async (_command: Record<string, unknown>) => ({
  ok: 1,
}));
const mockListCollections = jest.fn();
const mockListIndexes = jest.fn();
const mockInfrastructureFindOne = jest.fn();
const mockCreateCollection = jest.fn(async () => undefined);
const mockCreateIndex = jest.fn(
  async (_keys: Record<string, unknown>, _options: Record<string, unknown>) =>
    "ok"
);
const mockEnsureCheckpoint = jest.fn(async () => undefined);
const mockEnsureRealtimeEventIndexes = jest.fn(async () => undefined);
type MockLease = {
  ownerToken: string;
  fence: { value: string };
  claimedAt: Date;
  expiresAt: Date;
};
const mockClaimLease = jest.fn(
  async (_input: Record<string, unknown>): Promise<MockLease | null> => null
);
const mockReadCheckpoint = jest.fn(
  async () => null as Record<string, unknown> | null
);
const mockReleaseLease = jest.fn(
  async (_input: Record<string, unknown>) => true
);
const mockRenewLease = jest.fn(async (_input: Record<string, unknown>) => null);
const mockUpdateCheckpoint = jest.fn(
  async (_input: Record<string, unknown>) => null
);
const mockReserveBoundary = jest.fn();
const mockAdvanceIdleResumeToken = jest.fn(
  async (_input: Record<string, unknown>) => null
);
const mockAssertBoundary = jest.fn(
  async (_input: Record<string, unknown>) => undefined
);
const mockFinalizeBoundary = jest.fn(
  async (input: Record<string, unknown>) => input.lease
);
const mockResetCheckpointForRebuild = jest.fn(
  async (input: Record<string, unknown>) => input.lease
);
const mockWatch = jest.fn(
  (_pipeline: unknown[], _options: Record<string, unknown>) => ({})
);
const mockMaterializeRequestConversation = jest.fn();
const mockMaterializeRequestConversationPage = jest.fn();
const mockProjectionChangeConversationIds = jest.fn();
const mockCommitProjectedBatch = jest.fn();
const mockConversationFind = jest.fn(
  (..._args: unknown[]): unknown => undefined
);
const mockConversationCountDocuments = jest.fn(
  async (..._args: unknown[]) => 0
);
const mockProjectionCountDocuments = jest.fn(async (..._args: unknown[]) => 0);
const mockProjectionFind = jest.fn((..._args: unknown[]) => ({
  toArray: async () => [],
}));
const mockProjectionBulkWrite = jest.fn(
  async (..._args: unknown[]) => undefined
);
const mockProjectionDeleteMany = jest.fn(
  async (..._args: unknown[]) => undefined
);
const mockOutboxUpdateOne = jest.fn(async (..._args: unknown[]) => undefined);
const mockOutboxBulkWrite = jest.fn(async (..._args: unknown[]) => undefined);
const mockStartSession = jest.fn();
const mockPublishRealtimePubSubEvent = jest.fn();
const mockMarkPendingV3PubSubConfirmed = jest.fn();

jest.mock("@/lib/realtime/server", () => ({
  publishRealtimePubSubEvent: (...args: unknown[]) =>
    mockPublishRealtimePubSubEvent(...args),
}));
jest.mock("@/lib/realtime/outbox-lifecycle", () => ({
  markPendingV3PubSubConfirmed: (...args: unknown[]) =>
    mockMarkPendingV3PubSubConfirmed(...args),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: () => mockConnectDB(),
}));

jest.mock("mongoose", () => {
  const actual = jest.requireActual("mongoose") as typeof import("mongoose");
  return {
    __esModule: true,
    default: {
      ...actual.default,
      connection: {
        db: {
          admin: () => ({
            command: (command: Record<string, unknown>) =>
              mockAdminCommand(command),
          }),
          command: (command: Record<string, unknown>) => mockCommand(command),
          listCollections: (
            filter: { name: { $in: string[] } },
            options: { nameOnly: boolean }
          ) => mockListCollections(filter, options),
          collection: (name: string) => ({
            findOne: (filter: Record<string, unknown>, options?: unknown) =>
              mockInfrastructureFindOne(name, filter, options),
            listIndexes: () => ({
              toArray: () => mockListIndexes(name),
            }),
          }),
          watch: (pipeline: unknown[], options: Record<string, unknown>) =>
            mockWatch(pipeline, options),
        },
      },
      startSession: (...args: unknown[]) => mockStartSession(...args),
    },
  };
});

jest.mock("@/lib/requests-projection/checkpoint", () => ({
  toLegacyClusterTimeGeneration: (clusterTime: { t: number; i: number }) =>
    BigInt(clusterTime.t) * BigInt(1_000_000_000) + BigInt(clusterTime.i),
  advanceIdleProjectionResumeToken: (input: Record<string, unknown>) =>
    mockAdvanceIdleResumeToken(input),
  assertReservedProjectionBoundary: (input: Record<string, unknown>) =>
    mockAssertBoundary(input),
  claimRequestsProjectionCheckpointLease: (input: Record<string, unknown>) =>
    mockClaimLease(input),
  deriveProjectionBackfillBoundaryDigest: (input: {
    backfillAfterId?: { toString(): string } | null;
  }) => `backfill:${input.backfillAfterId?.toString() || "start"}`,
  deriveProjectionResumeTokenDigest: (input: Record<string, unknown>) =>
    `raw:${String(input.token || input._data || "token")}`,
  ensureRequestsProjectionCheckpoint: () => mockEnsureCheckpoint(),
  finalizeProjectionBoundary: (input: Record<string, unknown>) =>
    mockFinalizeBoundary(input),
  readRequestsProjectionCheckpoint: () => mockReadCheckpoint(),
  releaseRequestsProjectionCheckpointLease: (input: Record<string, unknown>) =>
    mockReleaseLease(input),
  requiresFreshRequestsProjectionBackfill: (checkpoint: unknown) =>
    !checkpoint ||
    ["initializing", "failed"].includes(
      String((checkpoint as { state?: unknown })?.state)
    ),
  renewRequestsProjectionCheckpointLease: (input: Record<string, unknown>) =>
    mockRenewLease(input),
  reserveProjectionBoundary: (input: Record<string, unknown>) =>
    mockReserveBoundary(input),
  resetRequestsProjectionCheckpointForRebuild: (
    input: Record<string, unknown>
  ) => mockResetCheckpointForRebuild(input),
  updateRequestsProjectionCheckpoint: (input: Record<string, unknown>) =>
    mockUpdateCheckpoint(input),
}));

jest.mock("@/lib/requests-projection/materialize", () => ({
  materializeRequestConversation: (input: Record<string, unknown>) =>
    mockMaterializeRequestConversation(input),
  materializeRequestConversationPage: (input: Record<string, unknown>) =>
    mockMaterializeRequestConversationPage(input),
  projectionChangeConversationIds: (input: Record<string, unknown>) =>
    mockProjectionChangeConversationIds(input),
}));

jest.mock("@/lib/requests-projection/projector", () => ({
  buildProjectedRealtimeEvent: jest.fn(),
  buildProjectedRealtimeOutboxInsert: jest.fn(),
  commitProjectedBatch: (
    input: Record<string, unknown>,
    dependencies: Record<string, unknown>
  ) => mockCommitProjectedBatch(input, dependencies),
  RequestsProjectionLeaseLostError: class extends Error {},
  selectAdvancingProjectionRows: (rows: unknown[]) => rows,
}));

jest.mock("@/models/chat", () => ({
  __esModule: true,
  default: { collection: { collectionName: "chats" } },
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    collection: { collectionName: "conversations" },
    countDocuments: (...args: unknown[]) =>
      mockConversationCountDocuments(...args),
    find: (...args: unknown[]) => mockConversationFind(...args),
  },
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: { collection: { collectionName: "messages" } },
}));

jest.mock("@/models/realtime-event", () => ({
  REALTIME_EVENT_INDEX_DEFINITIONS: [
    {
      keys: { eventId: 1 },
      options: { name: "realtime_events_event_id_unique", unique: true },
    },
    {
      keys: { workspaceId: 1, createdAt: -1 },
      options: { name: "realtime_events_workspace_created_desc" },
    },
    {
      keys: { status: 1, createdAt: 1 },
      options: { name: "realtime_events_status_created" },
    },
    {
      keys: { status: 1, nextAttemptAt: 1, createdAt: 1 },
      options: { name: "realtime_events_status_next_attempt_created" },
    },
    {
      keys: { status: 1, replayLeaseExpiresAt: 1, createdAt: 1 },
      options: { name: "realtime_events_status_replay_lease_created" },
    },
    {
      keys: { dedupeKey: 1, createdAt: -1 },
      options: { name: "realtime_events_dedupe_created_desc" },
    },
    {
      keys: { publishedAt: 1 },
      options: {
        name: "realtime_events_published_ttl",
        expireAfterSeconds: 604800,
      },
    },
  ],
  RealtimeEvent: {
    collection: {
      collectionName: "realtime_events",
      updateOne: (...args: unknown[]) => mockOutboxUpdateOne(...args),
      bulkWrite: (...args: unknown[]) => mockOutboxBulkWrite(...args),
    },
  },
  ensureRealtimeEventIndexes: () => mockEnsureRealtimeEventIndexes(),
}));

jest.mock("@/models/requests-projection-checkpoint", () => ({
  REQUESTS_PROJECTION_CHECKPOINT_ID: "requests-read-model:v2",
  RequestsProjectionCheckpoint: {
    collection: { collectionName: "requests_projection_checkpoint_v2" },
    createCollection: () => mockCreateCollection(),
  },
}));

jest.mock("@/models/request-list-item", () => ({
  RequestListItem: {
    createCollection: () => mockCreateCollection(),
    collection: {
      collectionName: "request_list_items",
      bulkWrite: (...args: unknown[]) => mockProjectionBulkWrite(...args),
      countDocuments: (...args: unknown[]) =>
        mockProjectionCountDocuments(...args),
      createIndex: (
        keys: Record<string, unknown>,
        options: Record<string, unknown>
      ) => mockCreateIndex(keys, options),
      deleteMany: (...args: unknown[]) => mockProjectionDeleteMany(...args),
      find: (...args: unknown[]) => mockProjectionFind(...args),
    },
  },
}));

jest.mock("@/models/user", () => ({
  __esModule: true,
  default: { collection: { collectionName: "users" } },
}));

import {
  decideRequestsProjectionActivation,
  ensureRequestsProjectionInfrastructure,
  readRequestsProjectionActivationDecision,
  REQUESTS_PROJECTION_ROW_INDEX_DEFINITIONS,
  REQUESTS_PROJECTION_TARGETED_ROW_INDEX_DEFINITION,
  runProductionRequestsProjectionActivation,
  startProductionRequestsProjectionRuntime,
  publishCommittedEvents,
} from "./activation";
import mongoose from "mongoose";

const sourceCollections = ["conversations", "messages", "chats", "users"];
const infrastructureCollections = [
  "request_list_items",
  "requests_projection_checkpoint_v2",
  "realtime_events",
  ...sourceCollections,
];

describe("committed Requests immediate publication", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockPublishRealtimePubSubEvent.mockReset();
    mockMarkPendingV3PubSubConfirmed.mockReset().mockResolvedValue(true);
  });
  afterEach(() => jest.useRealTimers());

  const event = { eventId: "requests-row:v3:committed" } as Parameters<
    typeof publishCommittedEvents
  >[0][number];

  it("acknowledges only after the broker confirms the committed event", async () => {
    let confirm!: (value: { ok: boolean; messageId: string }) => void;
    mockPublishRealtimePubSubEvent.mockImplementation(
      () =>
        new Promise(resolve => {
          confirm = resolve;
        })
    );
    publishCommittedEvents([event]);
    await jest.advanceTimersByTimeAsync(0);
    expect(mockMarkPendingV3PubSubConfirmed).not.toHaveBeenCalled();
    confirm({ ok: true, messageId: "pubsub-1" });
    await jest.advanceTimersByTimeAsync(0);
    expect(mockMarkPendingV3PubSubConfirmed).toHaveBeenCalledWith({
      eventId: event.eventId,
      messageId: "pubsub-1",
      publishedAt: expect.any(Date),
    });
  });

  it.each(["rejected", "missing_confirmation"])(
    "leaves durable recovery pending when publication is %s",
    async outcome => {
      if (outcome === "rejected")
        mockPublishRealtimePubSubEvent.mockRejectedValue(
          new Error("broker unavailable")
        );
      else
        mockPublishRealtimePubSubEvent.mockResolvedValue({
          ok: true,
          messageId: null,
        });
      publishCommittedEvents([event]);
      await jest.advanceTimersByTimeAsync(0);
      expect(mockMarkPendingV3PubSubConfirmed).not.toHaveBeenCalled();
    }
  );

  it("leaves a claimed event to its replay owner without republishing", async () => {
    mockPublishRealtimePubSubEvent.mockResolvedValue({
      ok: true,
      messageId: "pubsub-1",
    });
    mockMarkPendingV3PubSubConfirmed.mockResolvedValue(false);
    publishCommittedEvents([event]);
    await jest.advanceTimersByTimeAsync(0);
    expect(mockMarkPendingV3PubSubConfirmed).toHaveBeenCalledTimes(1);
    expect(mockPublishRealtimePubSubEvent).toHaveBeenCalledTimes(1);
  });
});

describe("targeted Requests projection index ownership", () => {
  it("exports the exact targeted row index definition from the activation owner", () => {
    expect(REQUESTS_PROJECTION_TARGETED_ROW_INDEX_DEFINITION).toEqual({
      keys: { workspaceId: 1, _id: 1 },
      options: { name: "request_projection_workspace_id_v1" },
    });
  });

  it("deep-freezes the targeted row index definition", () => {
    expect(
      Object.isFrozen(REQUESTS_PROJECTION_TARGETED_ROW_INDEX_DEFINITION)
    ).toBe(true);
    expect(
      Object.isFrozen(REQUESTS_PROJECTION_TARGETED_ROW_INDEX_DEFINITION.keys)
    ).toBe(true);
    expect(
      Object.isFrozen(REQUESTS_PROJECTION_TARGETED_ROW_INDEX_DEFINITION.options)
    ).toBe(true);
  });

  it("includes the exported targeted definition exactly once by identity", () => {
    const identityMatches = REQUESTS_PROJECTION_ROW_INDEX_DEFINITIONS.filter(
      definition =>
        definition === REQUESTS_PROJECTION_TARGETED_ROW_INDEX_DEFINITION
    );
    const nameMatches = REQUESTS_PROJECTION_ROW_INDEX_DEFINITIONS.filter(
      definition =>
        definition.options.name ===
        REQUESTS_PROJECTION_TARGETED_ROW_INDEX_DEFINITION.options.name
    );

    expect(identityMatches).toEqual([
      REQUESTS_PROJECTION_TARGETED_ROW_INDEX_DEFINITION,
    ]);
    expect(nameMatches).toEqual(identityMatches);
  });
});

const healthyRowIndexes = [
  {
    name: "requests_projection_serving_v2",
    key: { workspaceId: 1, sortAt: -1, _id: -1 },
    partialFilterExpression: {
      deletedAt: null,
      "projection.status": "ready",
    },
  },
  {
    name: "requests_projection_unread_v2",
    key: { workspaceId: 1, unreadGeneration: 1, sortAt: -1, _id: -1 },
    partialFilterExpression: {
      deletedAt: null,
      "projection.status": "ready",
      unreadGeneration: { $type: "long" },
    },
  },
  {
    name: "requests_projection_channel_v2",
    key: { workspaceId: 1, channel: 1, sortAt: -1, _id: -1 },
  },
  {
    name: "requests_projection_status_v2",
    key: { workspaceId: 1, status: 1, sortAt: -1, _id: -1 },
  },
  {
    name: "requests_projection_category_v2",
    key: { workspaceId: 1, category: 1, sortAt: -1, _id: -1 },
  },
  {
    name: "requests_projection_labels_v2",
    key: { workspaceId: 1, internalLabels: 1, sortAt: -1, _id: -1 },
  },
  {
    name: "requests_projection_phone_v2",
    key: { workspaceId: 1, phoneDigits: 1 },
    partialFilterExpression: { phoneDigits: { $type: "string" } },
  },
  {
    name: "request_projection_generation_desc_v4_seed",
    key: { "projection.generation": -1, _id: 1 },
  },
  {
    name: "request_projection_workspace_id_v1",
    key: { workspaceId: 1, _id: 1 },
  },
];

const healthyOutboxIndexes = [
  {
    name: "realtime_events_event_id_unique",
    key: { eventId: 1 },
    unique: true,
  },
  {
    name: "realtime_events_workspace_created_desc",
    key: { workspaceId: 1, createdAt: -1 },
  },
  {
    name: "realtime_events_status_created",
    key: { status: 1, createdAt: 1 },
  },
  {
    name: "realtime_events_status_next_attempt_created",
    key: { status: 1, nextAttemptAt: 1, createdAt: 1 },
  },
  {
    name: "realtime_events_status_replay_lease_created",
    key: { status: 1, replayLeaseExpiresAt: 1, createdAt: 1 },
  },
  {
    name: "realtime_events_dedupe_created_desc",
    key: { dedupeKey: 1, createdAt: -1 },
  },
  {
    name: "realtime_events_published_ttl",
    key: { publishedAt: 1 },
    expireAfterSeconds: 604800,
  },
];

function healthyCollectionMetadata(name: string) {
  return {
    name,
    type: "collection",
    info: {
      readOnly: false,
      uuid: {
        sub_type: 4,
        buffer: Buffer.alloc(16, infrastructureCollections.indexOf(name) + 1),
      },
    },
    options: sourceCollections.includes(name)
      ? { changeStreamPreAndPostImages: { enabled: true } }
      : {},
  };
}

function installHealthyInfrastructureMocks(): void {
  mockListCollections.mockImplementation(
    ({ name }: { name: { $in: string[] } }) => ({
      toArray: async () =>
        infrastructureCollections
          .filter(collectionName => name.$in.includes(collectionName))
          .map(healthyCollectionMetadata)
          .reverse(),
    })
  );
  mockListIndexes.mockImplementation(async (name: string) => {
    if (name === "request_list_items") return healthyRowIndexes;
    if (name === "realtime_events") return healthyOutboxIndexes;
    return [{ name: "_id_", key: { _id: 1 } }];
  });
  mockInfrastructureFindOne.mockImplementation(async (name: string) =>
    name === "requests_projection_checkpoint_v2"
      ? { _id: "requests-read-model:v2" }
      : null
  );
}

function transformMetadataPass(
  pass: number,
  transform: (
    metadata: ReturnType<typeof healthyCollectionMetadata>[]
  ) => unknown[]
): void {
  let reads = 0;
  mockListCollections.mockImplementation(() => ({
    toArray: async () => {
      const metadata = infrastructureCollections.map(healthyCollectionMetadata);
      return ++reads === pass ? transform(metadata) : metadata;
    },
  }));
}

function sourceBoundary(t = 12, i = 3): mongoose.mongo.Timestamp {
  return new mongoose.mongo.Timestamp({ t, i });
}

function causalSession(order: string[] = []) {
  const session = {
    advanceOperationTime: jest.fn((boundary: unknown) => {
      order.push("advance");
      return boundary;
    }),
    withTransaction: jest.fn(async (work: () => Promise<void>) => work()),
    endSession: jest.fn(async () => {
      order.push("end-session");
    }),
  } as unknown as mongoose.ClientSession;
  return session;
}

function queryReturning<T>(rows: T, order: string[] = []) {
  const query: Record<string, jest.Mock> = {};
  query.select = jest.fn(() => query);
  query.sort = jest.fn(() => query);
  query.limit = jest.fn(() => query);
  query.session = jest.fn((_value: unknown) => {
    order.push("query-session");
    return query;
  });
  query.read = jest.fn((value: unknown) => {
    order.push(`read:${String(value)}`);
    return query;
  });
  query.readConcern = jest.fn((value: unknown) => {
    order.push(`read-concern:${String(value)}`);
    return query;
  });
  query.lean = jest.fn(() => query);
  query.exec = jest.fn(async () => {
    order.push("query-exec");
    return rows;
  });
  return query;
}

function activeLease(ownerToken = "active-worker"): MockLease {
  return {
    ownerToken,
    fence: { value: "1" },
    claimedAt: new Date("2026-08-20T08:00:00.000Z"),
    expiresAt: new Date("2026-08-20T08:01:00.000Z"),
  };
}

function streamWithInitialChange(
  change: Record<string, unknown> | null,
  buffered: Record<string, unknown>[] = []
) {
  let resolvePendingRead: ((value: null) => void) | undefined;
  return {
    close: jest.fn(async () => {
      resolvePendingRead?.(null);
    }),
    resumeToken: null,
    tryNext: jest
      .fn()
      .mockResolvedValueOnce(change)
      .mockImplementation(() =>
        buffered.length
          ? Promise.resolve(buffered.shift())
          : new Promise<null>(resolve => {
              resolvePendingRead = resolve;
            })
      ),
  };
}

function resetGenerationMocks(): void {
  mockCommitProjectedBatch.mockImplementation(async input => ({
    lease: input.lease,
  }));
  mockReserveBoundary.mockReset();
  mockReserveBoundary.mockImplementation(
    async (input: Record<string, unknown>) => ({
      resumeTokenDigest: input.resumeTokenDigest,
      generation: input.legacyGeneration,
      sourceClusterTime: input.sourceClusterTime,
    })
  );
  mockAdvanceIdleResumeToken.mockReset();
  mockAdvanceIdleResumeToken.mockResolvedValue(null);
  mockAssertBoundary.mockReset();
  mockAssertBoundary.mockResolvedValue(undefined);
  mockFinalizeBoundary.mockReset();
  mockFinalizeBoundary.mockImplementation(
    async (input: Record<string, unknown>) => input.lease
  );
  mockResetCheckpointForRebuild.mockReset();
  mockResetCheckpointForRebuild.mockImplementation(
    async (input: Record<string, unknown>) => input.lease
  );
}

describe("ensureRequestsProjectionInfrastructure", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAdminCommand.mockResolvedValue({ setName: "rs0" });
    mockCommand.mockResolvedValue({ ok: 1 });
    mockCreateCollection.mockResolvedValue(undefined);
    mockCreateIndex.mockResolvedValue("ok");
    mockEnsureCheckpoint.mockResolvedValue(undefined);
    mockEnsureRealtimeEventIndexes.mockResolvedValue(undefined);
    mockClaimLease.mockResolvedValue(null);
    mockReadCheckpoint.mockResolvedValue(null);
    mockReleaseLease.mockResolvedValue(true);
    mockRenewLease.mockResolvedValue(null);
    mockUpdateCheckpoint.mockResolvedValue(null);
    mockWatch.mockReset();
    mockMaterializeRequestConversation.mockReset();
    mockMaterializeRequestConversationPage.mockReset();
    mockProjectionChangeConversationIds.mockReset();
    mockCommitProjectedBatch.mockReset();
    mockConversationFind.mockReset();
    mockConversationCountDocuments.mockResolvedValue(0);
    mockProjectionCountDocuments.mockResolvedValue(0);
    mockProjectionFind.mockReturnValue({ toArray: async () => [] });
    mockProjectionBulkWrite.mockResolvedValue(undefined);
    mockProjectionDeleteMany.mockResolvedValue(undefined);
    mockOutboxUpdateOne.mockResolvedValue(undefined);
    mockStartSession.mockReset();
    mockStartSession.mockImplementation(async () => causalSession());
    resetGenerationMocks();
    installHealthyInfrastructureMocks();
  });

  it("verifies infrastructure with metadata and checkpoint reads only", async () => {
    await expect(ensureRequestsProjectionInfrastructure()).resolves.toEqual({
      collectionUuids: {
        requestListItem: "01".repeat(16),
        checkpoint: "02".repeat(16),
        realtimeOutbox: "03".repeat(16),
        conversation: "04".repeat(16),
        message: "05".repeat(16),
        chat: "06".repeat(16),
        user: "07".repeat(16),
      },
      rowIndexDigest:
        "aca1f152594649541fb902b42861fa143019b1168a37fa526038798758536348",
      outboxIndexDigest:
        "03a82dd17878e0867ce1694d64d52a3fd41c9bc37fc91cace3f2328a6546ef3c",
      imageProofs: {
        conversation: true,
        message: true,
        chat: true,
        user: true,
      },
      canaryContractVersion: 1,
      approvedCardinalityCap: 10_000_000,
    });

    expect(mockListCollections).toHaveBeenCalledTimes(2);
    expect(mockListCollections).toHaveBeenNthCalledWith(
      1,
      {
        name: {
          $in: [
            "request_list_items",
            "requests_projection_checkpoint_v2",
            "realtime_events",
            "conversations",
            "messages",
            "chats",
            "users",
          ],
        },
      },
      { nameOnly: false }
    );
    expect(mockListCollections).toHaveBeenNthCalledWith(
      2,
      {
        name: {
          $in: [
            "request_list_items",
            "requests_projection_checkpoint_v2",
            "realtime_events",
            "conversations",
            "messages",
            "chats",
            "users",
          ],
        },
      },
      { nameOnly: false }
    );
    expect(mockListIndexes).toHaveBeenCalledWith("request_list_items");
    expect(mockListIndexes).toHaveBeenCalledWith("realtime_events");
    expect(mockInfrastructureFindOne).toHaveBeenCalledWith(
      "requests_projection_checkpoint_v2",
      { _id: "requests-read-model:v2" },
      expect.objectContaining({ projection: { _id: 1 } })
    );
    expect(mockCommand).not.toHaveBeenCalled();
    expect(mockCreateCollection).not.toHaveBeenCalled();
    expect(mockCreateIndex).not.toHaveBeenCalled();
    expect(mockEnsureCheckpoint).not.toHaveBeenCalled();
    expect(mockEnsureRealtimeEventIndexes).not.toHaveBeenCalled();
  });

  it("accepts an optional unread index without changing sealed physical evidence", async () => {
    const requiredEvidence = await ensureRequestsProjectionInfrastructure();
    mockListIndexes.mockImplementation(async (name: string) =>
      name === "request_list_items"
        ? [
            ...healthyRowIndexes,
            {
              name: "requests_projection_unread_ordered_v1",
              key: { workspaceId: 1, sortAt: -1, _id: -1 },
              partialFilterExpression: {
                deletedAt: null,
                "projection.status": "ready",
                unreadGeneration: { $type: "long" },
              },
            },
          ]
        : healthyOutboxIndexes
    );

    await expect(ensureRequestsProjectionInfrastructure()).resolves.toEqual(
      requiredEvidence
    );
    expect(requiredEvidence.rowIndexDigest).toBe(
      "aca1f152594649541fb902b42861fa143019b1168a37fa526038798758536348"
    );
  });

  it("reads an activation decision in seven database commands", async () => {
    mockReadCheckpoint.mockResolvedValue({ state: "ready" });

    await readRequestsProjectionActivationDecision();

    expect(
      mockAdminCommand.mock.calls.length +
        mockListCollections.mock.calls.length +
        mockListIndexes.mock.calls.length +
        mockInfrastructureFindOne.mock.calls.length +
        mockReadCheckpoint.mock.calls.length
    ).toBe(7);
  });

  it("preserves both metadata passes and each physical evidence barrier", async () => {
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>(complete => {
        resolve = complete;
      });
      return { promise, resolve };
    };
    const hello = deferred();
    const firstPass = deferred();
    const secondPass = deferred();
    const rowIndexes = deferred();
    const outboxIndexes = deferred();
    const singleton = deferred();
    const freshCheckpoint = deferred();
    const readMetadata = mockListCollections.getMockImplementation()!;
    let metadataReads = 0;
    mockAdminCommand.mockImplementation(async () => {
      await hello.promise;
      return { setName: "rs0" };
    });
    mockListCollections.mockImplementation(
      (filter: { name: { $in: string[] } }) => ({
        toArray: async () => {
          await (++metadataReads === 1 ? firstPass : secondPass).promise;
          return readMetadata(filter).toArray();
        },
      })
    );
    mockListIndexes.mockImplementation(async (name: string) => {
      await (name === "request_list_items" ? rowIndexes : outboxIndexes)
        .promise;
      return name === "request_list_items"
        ? healthyRowIndexes
        : healthyOutboxIndexes;
    });
    mockInfrastructureFindOne.mockImplementation(async () => {
      await singleton.promise;
      return { _id: "requests-read-model:v2" };
    });
    mockReadCheckpoint.mockImplementation(async () => {
      await freshCheckpoint.promise;
      return { state: "ready" };
    });
    let settled = false;
    const decision = readRequestsProjectionActivationDecision().then(result => {
      settled = true;
      return result;
    });
    const flush = () => new Promise<void>(resolve => setImmediate(resolve));

    try {
      await flush();
      expect(mockListCollections).not.toHaveBeenCalled();

      hello.resolve();
      await flush();
      expect(mockListCollections).toHaveBeenCalledTimes(1);
      expect(mockListIndexes).not.toHaveBeenCalled();
      expect(mockInfrastructureFindOne).not.toHaveBeenCalled();

      firstPass.resolve();
      await flush();
      expect(mockListIndexes).toHaveBeenCalledTimes(2);
      expect(mockInfrastructureFindOne).toHaveBeenCalledTimes(1);
      rowIndexes.resolve();
      await flush();
      expect(mockListCollections).toHaveBeenCalledTimes(1);

      outboxIndexes.resolve();
      await flush();
      expect(mockListCollections).toHaveBeenCalledTimes(1);

      singleton.resolve();
      await flush();
      expect(mockListCollections).toHaveBeenCalledTimes(2);
      expect(settled).toBe(false);
      expect(mockReadCheckpoint).not.toHaveBeenCalled();

      secondPass.resolve();
      await flush();
      expect(mockReadCheckpoint).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      freshCheckpoint.resolve();
      await decision;
    } finally {
      [
        hello,
        firstPass,
        rowIndexes,
        outboxIndexes,
        singleton,
        secondPass,
        freshCheckpoint,
      ].forEach(read => read.resolve());
      await decision;
    }
  });

  describe.each([1, 2])("metadata pass %i", pass => {
    it.each(infrastructureCollections)(
      "fails closed when %s is absent",
      async name => {
        transformMetadataPass(pass, metadata =>
          metadata.filter(item => item.name !== name)
        );

        await expect(
          readRequestsProjectionActivationDecision()
        ).rejects.toThrow(`requests_projection_collection_missing_${name}`);
        expect(mockListCollections).toHaveBeenCalledTimes(pass);
        expect(mockReadCheckpoint).not.toHaveBeenCalled();
        if (pass === 1) {
          expect(mockListIndexes).not.toHaveBeenCalled();
          expect(mockInfrastructureFindOne).not.toHaveBeenCalled();
        }
      }
    );

    it.each([
      { label: "missing", uuid: null },
      {
        label: "wrong subtype",
        uuid: { sub_type: 3, buffer: Buffer.alloc(16) },
      },
      {
        label: "wrong length",
        uuid: { sub_type: 4, buffer: Buffer.alloc(15) },
      },
    ])("fails closed on a $label UUID", async ({ uuid }) => {
      transformMetadataPass(pass, metadata =>
        metadata.map(item =>
          item.name === "messages"
            ? { ...item, info: { ...item.info, uuid } }
            : item
        )
      );

      await expect(readRequestsProjectionActivationDecision()).rejects.toThrow(
        "requests_projection_collection_uuid_invalid"
      );
      expect(mockReadCheckpoint).not.toHaveBeenCalled();
    });

    it.each(sourceCollections)(
      "fails closed when %s loses preimages",
      async name => {
        transformMetadataPass(pass, metadata =>
          metadata.map(item =>
            item.name === name
              ? {
                  ...item,
                  options: { changeStreamPreAndPostImages: { enabled: false } },
                }
              : item
          )
        );

        await expect(
          readRequestsProjectionActivationDecision()
        ).rejects.toThrow(`requests_projection_source_image_missing_${name}`);
        expect(mockReadCheckpoint).not.toHaveBeenCalled();
        expect(mockCommand).not.toHaveBeenCalled();
      }
    );

    it("propagates a metadata read failure without granting readiness or retrying", async () => {
      transformMetadataPass(pass, () => {
        throw new Error("metadata_read_failed");
      });

      await expect(readRequestsProjectionActivationDecision()).rejects.toThrow(
        "metadata_read_failed"
      );
      expect(mockListCollections).toHaveBeenCalledTimes(pass);
      expect(mockReadCheckpoint).not.toHaveBeenCalled();
    });
  });

  it.each(infrastructureCollections)(
    "fails closed when %s changes UUID between metadata passes",
    async name => {
      transformMetadataPass(2, metadata =>
        metadata.map(item =>
          item.name === name
            ? {
                ...item,
                info: {
                  ...item.info,
                  uuid: { sub_type: 4, buffer: Buffer.alloc(16, 0xff) },
                },
              }
            : item
        )
      );

      await expect(readRequestsProjectionActivationDecision()).rejects.toThrow(
        `requests_projection_collection_uuid_drift_${name}`
      );
      expect(mockListCollections).toHaveBeenCalledTimes(2);
      expect(mockReadCheckpoint).not.toHaveBeenCalled();
    }
  );

  it("fails closed on a same-name wrong-direction row index", async () => {
    mockListIndexes.mockImplementation(async (name: string) =>
      name === "request_list_items"
        ? healthyRowIndexes.map(index =>
            index.name === "request_projection_generation_desc_v4_seed"
              ? { ...index, key: { "projection.generation": 1, _id: 1 } }
              : index
          )
        : healthyOutboxIndexes
    );

    await expect(ensureRequestsProjectionInfrastructure()).rejects.toThrow(
      /index|generation/i
    );
    expect(mockCreateIndex).not.toHaveBeenCalled();
  });

  it("fails before lease claim when the provisioned singleton is missing", async () => {
    mockInfrastructureFindOne.mockResolvedValue(null);

    await expect(ensureRequestsProjectionInfrastructure()).rejects.toThrow(
      /checkpoint|singleton/i
    );
    expect(mockClaimLease).not.toHaveBeenCalled();
    expect(mockEnsureCheckpoint).not.toHaveBeenCalled();
  });
});

describe("Requests projection list activation decision", () => {
  const completedAt = new Date("2026-08-20T12:00:00.000Z");
  const provisionReceipt = {
    schemaVersion: 1,
    contractVersion: 1,
    collectionUuids: {
      requestListItem: "01".repeat(16),
      checkpoint: "02".repeat(16),
      realtimeOutbox: "03".repeat(16),
      conversation: "04".repeat(16),
      message: "05".repeat(16),
      chat: "06".repeat(16),
      user: "07".repeat(16),
    },
    rowIndexDigest:
      "aca1f152594649541fb902b42861fa143019b1168a37fa526038798758536348",
    outboxIndexDigest:
      "03a82dd17878e0867ce1694d64d52a3fd41c9bc37fc91cace3f2328a6546ef3c",
    imageProofs: {
      conversation: true,
      message: true,
      chat: true,
      user: true,
    },
    canaryContractVersion: 1,
    approvedCardinalityCap: 10_000_000,
    preflightCardinality: 42,
    completedAt,
  };
  const migrationReceipt = {
    schemaVersion: 1,
    contractVersion: 1,
    collectionUuids: provisionReceipt.collectionUuids,
    rowIndexDigest: provisionReceipt.rowIndexDigest,
    outboxIndexDigest: provisionReceipt.outboxIndexDigest,
    provisionReceiptDigest:
      "b5fca4cf10524b0de6a83bf528afde0163712ee67dbc14fe4956880456d5559b",
    approvedCardinalityCap: 10_000_000,
    preflightCardinality: 42,
    scanned: 42,
    matched: 2,
    updated: 2,
    missingAfter: 0,
    invalidAfter: 0,
    verifiedAt: completedAt,
    completedAt,
  };
  const physicalEvidence = {
    collectionUuids: provisionReceipt.collectionUuids,
    rowIndexDigest: provisionReceipt.rowIndexDigest,
    outboxIndexDigest: provisionReceipt.outboxIndexDigest,
    imageProofs: provisionReceipt.imageProofs,
    canaryContractVersion: 1 as const,
    approvedCardinalityCap: 10_000_000 as const,
  };

  it.each([
    [undefined],
    [{ schemaVersion: 1, state: "running" }],
    [{ schemaVersion: 99, state: "complete" }],
  ])("keeps progress-only state compatible and not ready", progress => {
    expect(
      decideRequestsProjectionActivation({
        watermarkMigrationProgress: progress,
      })
    ).toEqual({
      listWatermarkMode: "pre_migration_legacy_list",
      capability: "not_ready",
    });
  });

  it("selects strict ready only for the paired healthy completion evidence", () => {
    expect(
      (
        decideRequestsProjectionActivation as unknown as (
          checkpoint: Record<string, unknown>,
          evidence: typeof physicalEvidence
        ) => ReturnType<typeof decideRequestsProjectionActivation>
      )(
        {
          watermarkMigrationCompletedAt: completedAt,
          provisionReceipt,
          watermarkMigrationReceipt: migrationReceipt,
        },
        physicalEvidence
      )
    ).toEqual({
      listWatermarkMode: "strict_persisted",
      capability: "ready",
    });
  });

  it.each([
    {
      ...physicalEvidence,
      collectionUuids: {
        ...physicalEvidence.collectionUuids,
        requestListItem: "ff".repeat(16),
      },
    },
    {
      ...physicalEvidence,
      rowIndexDigest: "ff".repeat(32),
    },
    {
      ...physicalEvidence,
      outboxIndexDigest: "ee".repeat(32),
    },
  ])("keeps strict mode not ready when physical evidence differs", evidence => {
    expect(
      (
        decideRequestsProjectionActivation as unknown as (
          checkpoint: Record<string, unknown>,
          evidence: typeof physicalEvidence
        ) => ReturnType<typeof decideRequestsProjectionActivation>
      )(
        {
          watermarkMigrationCompletedAt: completedAt,
          provisionReceipt,
          watermarkMigrationReceipt: migrationReceipt,
        },
        evidence
      )
    ).toEqual({
      listWatermarkMode: "strict_persisted",
      capability: "not_ready",
    });
  });

  it("reads fresh physical evidence before granting capability readiness", async () => {
    jest.clearAllMocks();
    mockAdminCommand.mockResolvedValue({ setName: "rs0" });
    installHealthyInfrastructureMocks();
    mockReadCheckpoint.mockResolvedValue({
      watermarkMigrationCompletedAt: completedAt,
      provisionReceipt: {
        ...provisionReceipt,
        collectionUuids: {
          ...provisionReceipt.collectionUuids,
          requestListItem: "ff".repeat(16),
        },
      },
      watermarkMigrationReceipt: migrationReceipt,
    } as never);
    const activation = jest.requireActual(
      "./activation"
    ) as typeof import("./activation") & {
      readRequestsProjectionActivationDecision?: () => Promise<
        ReturnType<typeof decideRequestsProjectionActivation>
      >;
    };

    expect(typeof activation.readRequestsProjectionActivationDecision).toBe(
      "function"
    );
    await expect(
      activation.readRequestsProjectionActivationDecision?.()
    ).resolves.toEqual({
      listWatermarkMode: "strict_persisted",
      capability: "not_ready",
    });
    expect(mockListCollections).toHaveBeenCalled();
    expect(mockReadCheckpoint).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      watermarkMigrationCompletedAt: completedAt,
      provisionReceipt,
    },
    {
      watermarkMigrationCompletedAt: completedAt,
      provisionReceipt,
      watermarkMigrationReceipt: {
        ...migrationReceipt,
        completedAt: new Date(completedAt.getTime() + 1),
      },
    },
    {
      watermarkMigrationCompletedAt: completedAt,
      provisionReceipt,
      watermarkMigrationReceipt: {
        ...migrationReceipt,
        scanned: -1,
      },
    },
    { watermarkMigrationReceipt: migrationReceipt, provisionReceipt },
    { generationTransitionReceipt: { schemaVersion: 1 } },
  ])(
    "selects strict not-ready for inconsistent or transitioned state",
    checkpoint => {
      expect(decideRequestsProjectionActivation(checkpoint)).toEqual({
        listWatermarkMode: "strict_persisted",
        capability: "not_ready",
      });
    }
  );
});

describe("startProductionRequestsProjectionRuntime", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockAdminCommand.mockResolvedValue({ setName: "rs0" });
    mockCommand.mockResolvedValue({ ok: 1 });
    installHealthyInfrastructureMocks();
    mockCreateCollection.mockResolvedValue(undefined);
    mockCreateIndex.mockResolvedValue("ok");
    mockEnsureCheckpoint.mockResolvedValue(undefined);
    mockEnsureRealtimeEventIndexes.mockResolvedValue(undefined);
    mockClaimLease.mockResolvedValue(null);
    mockReadCheckpoint.mockResolvedValue({
      state: "ready",
      resumeToken: { token: "ready" },
    });
    mockWatch.mockReset();
    mockMaterializeRequestConversation.mockReset();
    mockMaterializeRequestConversationPage.mockReset();
    mockProjectionChangeConversationIds.mockReset();
    mockCommitProjectedBatch.mockReset();
    mockConversationFind.mockReset();
    mockConversationCountDocuments.mockResolvedValue(0);
    mockProjectionCountDocuments.mockResolvedValue(0);
    mockProjectionFind.mockReturnValue({ toArray: async () => [] });
    mockProjectionBulkWrite.mockResolvedValue(undefined);
    mockProjectionDeleteMany.mockResolvedValue(undefined);
    mockOutboxUpdateOne.mockResolvedValue(undefined);
    mockStartSession.mockReset();
    mockStartSession.mockImplementation(async () => causalSession());
    resetGenerationMocks();
    installHealthyInfrastructureMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("starts as a passive standby when another runtime owns a ready projection", async () => {
    const controller = new AbortController();
    const onFatal = jest.fn();
    const startup = startProductionRequestsProjectionRuntime({
      signal: controller.signal,
      ownerToken: "standby-worker",
      onFatal,
    });
    const raced = Promise.race([
      startup.then(stop => ({ status: "started" as const, stop })),
      new Promise<{ status: "pending" }>(resolve => {
        setTimeout(() => resolve({ status: "pending" }), 50);
      }),
    ]);

    await jest.advanceTimersByTimeAsync(50);
    const result = await raced;

    if (result.status === "started") {
      await result.stop();
    } else {
      controller.abort(new Error("test cleanup"));
      await jest.advanceTimersByTimeAsync(1_000);
      await startup.catch(() => undefined);
    }

    expect(result.status).toBe("started");
    expect(onFatal).not.toHaveBeenCalled();
  });

  it("takes projection ownership after the active lease becomes claimable", async () => {
    let resolvePendingRead: ((value: null) => void) | undefined;
    const stream = {
      close: jest.fn(async () => {
        resolvePendingRead?.(null);
      }),
      resumeToken: null,
      tryNext: jest
        .fn<Promise<null>, []>()
        .mockResolvedValueOnce(null)
        .mockImplementation(
          () =>
            new Promise<null>(resolve => {
              resolvePendingRead = resolve;
            })
        ),
    };
    const lease = {
      ownerToken: "standby-worker",
      fence: { value: "1" },
      claimedAt: new Date("2026-08-20T08:00:00.000Z"),
      expiresAt: new Date("2026-08-20T08:01:00.000Z"),
    };
    mockWatch.mockReturnValue(stream);
    mockClaimLease.mockResolvedValueOnce(null).mockResolvedValueOnce(lease);

    const stop = await startProductionRequestsProjectionRuntime({
      signal: new AbortController().signal,
      ownerToken: "standby-worker",
    });

    await jest.advanceTimersByTimeAsync(5_000);

    expect(mockWatch).toHaveBeenCalledTimes(1);
    await stop();
    expect(mockReleaseLease).toHaveBeenCalledWith({ lease });
  });

  it("uses lease expiry to avoid standby claim writes and bounds takeover to five seconds", async () => {
    const start = Date.now();
    mockReadCheckpoint.mockResolvedValue({
      state: "ready",
      resumeToken: { token: "ready" },
      lease: {
        ownerToken: "active-worker",
        expiresAt: new Date(start + 12_000),
      },
    });
    const stop = await startProductionRequestsProjectionRuntime({
      signal: new AbortController().signal,
      ownerToken: "standby-worker",
    });
    expect(mockClaimLease).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(mockClaimLease).toHaveBeenCalledTimes(1);
    expect(mockReadCheckpoint).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(mockClaimLease).toHaveBeenCalledTimes(2);
    await stop();
  });

  it("does not overlap standby checkpoint reads and cancels the next poll on shutdown", async () => {
    const stop = await startProductionRequestsProjectionRuntime({
      signal: new AbortController().signal,
      ownerToken: "standby-worker",
    });
    let resolveRead!: (value: null) => void;
    mockReadCheckpoint.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveRead = resolve;
        })
    );
    await jest.advanceTimersByTimeAsync(20_000);
    expect(mockReadCheckpoint).toHaveBeenCalledTimes(2);
    resolveRead(null);
    await jest.advanceTimersByTimeAsync(0);
    await stop();
    const claims = mockClaimLease.mock.calls.length;
    await jest.advanceTimersByTimeAsync(10_000);
    expect(mockClaimLease).toHaveBeenCalledTimes(claims);
  });

  it("opens the idle stream with a one-second server await and preserves its resume token", async () => {
    let resolveRead!: (value: null) => void;
    const lease: MockLease = {
      ownerToken: "active-worker",
      fence: { value: "1" },
      claimedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    };
    mockClaimLease.mockResolvedValueOnce(lease);
    mockWatch.mockReturnValue({
      close: async () => resolveRead?.(null),
      tryNext: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockImplementation(
          () =>
            new Promise(resolve => {
              resolveRead = resolve;
            })
        ),
    });
    const stop = await startProductionRequestsProjectionRuntime({
      signal: new AbortController().signal,
    });
    expect(mockWatch.mock.calls[0][1]).toMatchObject({
      maxAwaitTimeMS: 1_000,
      resumeAfter: { token: "ready" },
    });
    await stop();
  });

  it("reports shutdown while waiting for the active projection as cancellation", async () => {
    mockReadCheckpoint.mockResolvedValue({ state: "backfilling" });
    const controller = new AbortController();
    const startup = startProductionRequestsProjectionRuntime({
      signal: controller.signal,
      ownerToken: "standby-worker",
    });
    await jest.advanceTimersByTimeAsync(0);

    controller.abort("worker_shutdown");

    await expect(startup).rejects.toMatchObject({
      name: "AbortError",
      message: "worker_shutdown",
    });
  });

  it("reports an active owner stream failure exactly once", async () => {
    const failure = new Error("change stream failed");
    const stream = {
      close: jest.fn(async () => undefined),
      resumeToken: null,
      tryNext: jest
        .fn<Promise<null>, []>()
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(failure),
    };
    const lease: MockLease = {
      ownerToken: "active-worker",
      fence: { value: "1" },
      claimedAt: new Date("2026-08-20T08:00:00.000Z"),
      expiresAt: new Date("2026-08-20T08:01:00.000Z"),
    };
    mockClaimLease.mockResolvedValueOnce(lease);
    mockWatch.mockReturnValue(stream);
    const onFatal = jest.fn();

    const stop = await startProductionRequestsProjectionRuntime({
      signal: new AbortController().signal,
      ownerToken: "active-worker",
      onFatal,
    });
    await jest.advanceTimersByTimeAsync(0);

    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal).toHaveBeenCalledWith(failure);
    await expect(stop()).rejects.toBe(failure);
    expect(mockReleaseLease).toHaveBeenCalledWith({ lease });
  });

  it.each([
    ["cluster_time_v1", 2, 1],
    ["sequence_v2", 4, 5],
  ])(
    "bounds repeated source work in %s while preserving its checkpoint contract",
    async (mode, reads, commits) => {
      const ids = [
        new mongoose.Types.ObjectId(),
        new mongoose.Types.ObjectId(),
      ];
      const changes = [0, 0, 0, 1, 1].map((id, index) => ({
        _id: { token: `batch-${index}` },
        clusterTime: sourceBoundary(100, index + 1),
        operationType: index === 3 ? "update" : "insert",
        ns: { coll: "messages" },
        fullDocument: { conversation: ids[id], workspaceId: "workspace-1" },
        ...(index === 3
          ? { updateDescription: { updatedFields: { delivery: "read" } } }
          : {}),
      }));
      const last = changes.at(-1)!;
      let resolvePending: ((value: null) => void) | undefined;
      const stream = {
        close: jest.fn(async () => {
          resolvePending?.(null);
        }),
        tryNext: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockImplementation(() =>
            changes.length
              ? Promise.resolve(changes.shift())
              : new Promise(resolve => {
                  resolvePending = resolve;
                })
          ),
      };
      mockReadCheckpoint.mockResolvedValue({
        state: "ready",
        generationMode: mode,
        resumeToken: { token: "ready" },
      });
      mockClaimLease.mockResolvedValueOnce(activeLease());
      mockWatch.mockReturnValue(stream);
      mockProjectionChangeConversationIds.mockImplementation(({ change }) => [
        {
          conversationId: change.fullDocument.conversation,
          workspaceId: "workspace-1",
        },
      ]);
      mockMaterializeRequestConversation.mockImplementation(async input => ({
        row: { _id: input.conversationId },
      }));
      const stop = await startProductionRequestsProjectionRuntime({
        signal: new AbortController().signal,
      });
      await jest.advanceTimersByTimeAsync(10);
      await stop();
      expect(mockMaterializeRequestConversation).toHaveBeenCalledTimes(
        Number(reads)
      );
      expect(mockCommitProjectedBatch).toHaveBeenCalledTimes(Number(commits));
      expect(mockCommitProjectedBatch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          progress: {
            kind: "change_stream_v1",
            resumeToken: last._id,
            clusterTime: last.clusterTime,
          },
        }),
        expect.anything()
      );
    }
  );

  it.each([false, true])(
    "preserves receipt boundaries and never commits a failed coalesced batch (failure=%s)",
    async fail => {
      const id = new mongoose.Types.ObjectId();
      const changes = Array.from({ length: 5 }, (_, index) => ({
        _id: { token: `receipt-batch-${index}` },
        clusterTime: sourceBoundary(100, index + 1),
        operationType: index === 2 ? "update" : "insert",
        ns: { coll: index === 2 ? "conversations" : "messages" },
        fullDocument: { _id: id, conversation: id, workspaceId: "workspace-1" },
        ...(index === 2
          ? {
              updateDescription: {
                updatedFields: { is_read_by_manager: true },
              },
            }
          : {}),
      }));
      mockReadCheckpoint.mockResolvedValue({
        state: "ready",
        generationMode: "cluster_time_v1",
        resumeToken: { token: "ready" },
      });
      mockClaimLease.mockResolvedValueOnce(activeLease());
      mockWatch.mockReturnValue(streamWithInitialChange(null, [...changes]));
      mockProjectionChangeConversationIds.mockReturnValue([
        { conversationId: id, workspaceId: "workspace-1" },
      ]);
      const failure = new Error("one source read failed");
      mockMaterializeRequestConversation.mockImplementation(async () => {
        if (fail) throw failure;
        return { row: { _id: id } };
      });
      const onFatal = jest.fn();
      const stop = await startProductionRequestsProjectionRuntime({
        signal: new AbortController().signal,
        onFatal,
      });
      await jest.advanceTimersByTimeAsync(10);
      if (fail) {
        expect(onFatal).toHaveBeenCalledWith(failure);
        await expect(stop()).rejects.toBe(failure);
        expect(mockCommitProjectedBatch).not.toHaveBeenCalled();
        expect(mockAdvanceIdleResumeToken).not.toHaveBeenCalled();
      } else {
        await stop();
        expect(mockCommitProjectedBatch).toHaveBeenCalledTimes(3);
        expect(mockMaterializeRequestConversation).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            readStateWatermarkMode: "advance_if_changed",
            sourceClusterTime: changes[2].clusterTime,
          })
        );
        expect(
          mockCommitProjectedBatch.mock.calls.map(
            ([input]) => input.progress.resumeToken
          )
        ).toEqual([changes[1]._id, changes[2]._id, changes[4]._id]);
      }
    }
  );

  it("advances an irrelevant update without rematerializing or enqueueing", async () => {
    const order: string[] = [];
    const resumeToken = { token: "irrelevant-message-update" };
    const clusterTime = sourceBoundary(1_776_000_000, 7);
    const change = {
      _id: resumeToken,
      clusterTime,
      operationType: "update",
      ns: { coll: "messages" },
      documentKey: { _id: "message-1" },
      fullDocument: {
        conversation: "conversation-1",
        workspaceId: "workspace-1",
      },
      updateDescription: {
        updatedFields: {
          delivery: "read",
          "mediaAnalysis.status": "completed",
        },
        removedFields: [],
        truncatedArrays: [],
      },
    };
    let resolvePendingRead: ((value: null) => void) | undefined;
    const stream = {
      close: jest.fn(async () => {
        resolvePendingRead?.(null);
      }),
      resumeToken: null,
      tryNext: jest
        .fn()
        .mockResolvedValueOnce(change)
        .mockImplementation(
          () =>
            new Promise<null>(resolve => {
              resolvePendingRead = resolve;
            })
        ),
    };
    const lease: MockLease = {
      ownerToken: "active-worker",
      fence: { value: "1" },
      claimedAt: new Date("2026-08-20T08:00:00.000Z"),
      expiresAt: new Date("2026-08-20T08:01:00.000Z"),
    };
    mockClaimLease.mockResolvedValueOnce(lease);
    mockWatch.mockReturnValue(stream);
    mockProjectionChangeConversationIds.mockReturnValue([
      {
        conversationId: "conversation-1",
        workspaceId: "workspace-1",
      },
    ]);
    mockMaterializeRequestConversation.mockResolvedValue({
      conversationId: "conversation-1",
      workspaceId: "workspace-1",
      row: { _id: "conversation-1" },
    });
    mockReserveBoundary.mockImplementation(async input => {
      order.push("reserve");
      return {
        resumeTokenDigest: input.resumeTokenDigest,
        generation: input.legacyGeneration,
        sourceClusterTime: input.sourceClusterTime,
      };
    });
    mockCommitProjectedBatch.mockImplementation(async input => {
      order.push("commit");
      return {
        lease: input.lease,
      };
    });

    const stop = await startProductionRequestsProjectionRuntime({
      signal: new AbortController().signal,
      ownerToken: "active-worker",
    });

    expect(mockMaterializeRequestConversation).not.toHaveBeenCalled();
    expect(mockCommitProjectedBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        lease,
        rows: [],
        boundary: expect.objectContaining({
          generation: expect.anything(),
          sourceClusterTime: clusterTime,
        }),
        progress: {
          kind: "change_stream_v1",
          resumeToken,
          clusterTime,
        },
        realtimeEnabled: true,
      }),
      expect.any(Object)
    );
    expect(order).toEqual(["reserve", "commit"]);
    await stop();
  });

  it.each([
    {
      label: "Conversation insert",
      operationType: "insert",
      collection: "conversations",
      fullDocument: { is_read_by_manager: false },
      expectedMode: "advance_if_changed",
    },
    {
      label: "Conversation replace with a canonical read-state change",
      operationType: "replace",
      collection: "conversations",
      fullDocumentBeforeChange: { is_read_by_manager: false },
      fullDocument: { is_read_by_manager: true },
      expectedMode: "advance_if_changed",
    },
    {
      label: "Conversation replace without a canonical read-state change",
      operationType: "replace",
      collection: "conversations",
      fullDocumentBeforeChange: { is_read_by_manager: true },
      fullDocument: { is_read_by_manager: true },
      expectedMode: "preserve",
    },
    {
      label: "Conversation update touching the exact field",
      operationType: "update",
      collection: "conversations",
      updateDescription: {
        updatedFields: { is_read_by_manager: true },
        removedFields: [],
      },
      expectedMode: "advance_if_changed",
    },
    {
      label: "Conversation update removing the exact field",
      operationType: "update",
      collection: "conversations",
      updateDescription: {
        updatedFields: {},
        removedFields: ["is_read_by_manager"],
      },
      expectedMode: "advance_if_changed",
    },
    {
      label: "unrelated Conversation update",
      operationType: "update",
      collection: "conversations",
      updateDescription: {
        updatedFields: { status: "open" },
        removedFields: [],
      },
      expectedMode: "preserve",
    },
    {
      label: "malformed Conversation update metadata",
      operationType: "update",
      collection: "conversations",
      updateDescription: { updatedFields: "invalid" },
      expectedMode: "preserve",
    },
    {
      label: "Conversation delete",
      operationType: "delete",
      collection: "conversations",
      fullDocumentBeforeChange: { is_read_by_manager: true },
      expectedMode: "preserve",
    },
    {
      label: "Message insert",
      operationType: "insert",
      collection: "messages",
      expectedMode: "preserve",
    },
    {
      label: "Chat update",
      operationType: "update",
      collection: "chats",
      updateDescription: {
        updatedFields: { title: "Changed" },
        removedFields: [],
      },
      expectedMode: "preserve",
    },
    {
      label: "User update",
      operationType: "update",
      collection: "users",
      updateDescription: {
        updatedFields: { firstName: "Changed" },
        removedFields: [],
      },
      expectedMode: "preserve",
    },
  ])("classifies $label from the raw change", async changeFixture => {
    const boundary = sourceBoundary(1_776_000_000, 7);
    const change = {
      _id: { token: changeFixture.label },
      clusterTime: boundary,
      operationType: changeFixture.operationType,
      ns: { coll: changeFixture.collection },
      documentKey: { _id: "65f000000000000000000001" },
      ...(changeFixture.fullDocument
        ? {
            fullDocument: {
              _id: "65f000000000000000000001",
              workspaceId: "workspace-1",
              ...changeFixture.fullDocument,
            },
          }
        : {}),
      ...(changeFixture.fullDocumentBeforeChange
        ? {
            fullDocumentBeforeChange: {
              _id: "65f000000000000000000001",
              workspaceId: "workspace-1",
              ...changeFixture.fullDocumentBeforeChange,
            },
          }
        : {}),
      ...(changeFixture.updateDescription
        ? { updateDescription: changeFixture.updateDescription }
        : {}),
    };
    const stream = streamWithInitialChange(change);
    const lease = activeLease();
    mockClaimLease.mockResolvedValueOnce(lease);
    mockWatch.mockReturnValue(stream);
    mockProjectionChangeConversationIds.mockReturnValue([
      {
        conversationId: "65f000000000000000000001",
        workspaceId: "workspace-1",
      },
    ]);
    mockMaterializeRequestConversation.mockResolvedValue({
      conversationId: "65f000000000000000000001",
      workspaceId: "workspace-1",
      row: { _id: "65f000000000000000000001" },
    });
    mockCommitProjectedBatch.mockImplementation(async input => ({
      lease: input.lease,
    }));

    const stop = await startProductionRequestsProjectionRuntime({
      signal: new AbortController().signal,
      ownerToken: "active-worker",
    });

    try {
      expect(mockMaterializeRequestConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceClusterTime: boundary,
          readStateWatermarkMode: changeFixture.expectedMode,
        })
      );
    } finally {
      await stop();
    }
  });

  it("causally enumerates dependency rows, releases the page session before yield, and propagates one boundary", async () => {
    const boundary = sourceBoundary(1_776_000_000, 8);
    const conversationId = new mongoose.Types.ObjectId(
      "65f000000000000000000001"
    );
    const change = {
      _id: { token: "chat-update" },
      clusterTime: boundary,
      operationType: "update",
      ns: { coll: "chats" },
      documentKey: { _id: "chat-1" },
      fullDocument: { _id: "chat-1", title: "Changed" },
      updateDescription: {
        updatedFields: { title: "Changed" },
        removedFields: [],
      },
    };
    const order: string[] = [];
    const enumerationSession = causalSession(order);
    const query = queryReturning(
      [{ _id: conversationId, workspaceId: "workspace-1" }],
      order
    );
    mockStartSession.mockImplementationOnce(async () => {
      order.push("start-session");
      return enumerationSession;
    });
    mockConversationFind.mockImplementation(() => {
      order.push("find");
      return query;
    });
    mockProjectionChangeConversationIds.mockReturnValue([]);
    mockMaterializeRequestConversation.mockImplementation(async input => {
      order.push("materialize");
      return {
        conversationId,
        workspaceId: "workspace-1",
        row: { _id: conversationId },
        input,
      };
    });
    mockCommitProjectedBatch.mockImplementation(async input => {
      order.push("commit");
      return {
        lease: input.lease,
      };
    });
    mockClaimLease.mockResolvedValueOnce(activeLease());
    mockWatch.mockReturnValue(streamWithInitialChange(change));

    const stop = await startProductionRequestsProjectionRuntime({
      signal: new AbortController().signal,
      ownerToken: "active-worker",
    });

    try {
      expect(enumerationSession.advanceOperationTime).toHaveBeenCalledWith(
        boundary
      );
      expect(query.session).toHaveBeenCalledWith(enumerationSession);
      expect(query.read).toHaveBeenCalledWith("primary");
      expect(query.readConcern).toHaveBeenCalledWith("majority");
      expect(enumerationSession.endSession).toHaveBeenCalledTimes(1);
      expect(order.indexOf("end-session")).toBeLessThan(
        order.indexOf("materialize")
      );
      expect(order.indexOf("materialize")).toBeLessThan(
        order.indexOf("commit")
      );
      expect(mockMaterializeRequestConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId,
          sourceClusterTime: boundary,
          readStateWatermarkMode: "preserve",
        })
      );
    } finally {
      await stop();
    }
  });

  it("performs no row or checkpoint-boundary commit when a direct causal source read fails", async () => {
    const failure = new Error("causal source read failed");
    const boundary = sourceBoundary(1_776_000_000, 9);
    const change = {
      _id: { token: "message-insert" },
      clusterTime: boundary,
      operationType: "insert",
      ns: { coll: "messages" },
      fullDocument: {
        conversation: "65f000000000000000000001",
        workspaceId: "workspace-1",
      },
    };
    mockClaimLease.mockResolvedValueOnce(activeLease());
    mockWatch.mockReturnValue(streamWithInitialChange(change));
    mockProjectionChangeConversationIds.mockReturnValue([
      {
        conversationId: "65f000000000000000000001",
        workspaceId: "workspace-1",
      },
    ]);
    mockMaterializeRequestConversation.mockRejectedValue(failure);

    await expect(
      startProductionRequestsProjectionRuntime({
        signal: new AbortController().signal,
        ownerToken: "active-worker",
      })
    ).rejects.toBe(failure);
    expect(mockCommitProjectedBatch).not.toHaveBeenCalled();
    expect(mockProjectionBulkWrite).not.toHaveBeenCalled();
    expect(mockOutboxUpdateOne).not.toHaveBeenCalled();
    expect(mockUpdateCheckpoint).not.toHaveBeenCalled();
  });
});

describe("runProductionRequestsProjectionActivation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockAdminCommand.mockResolvedValue({ setName: "rs0" });
    installHealthyInfrastructureMocks();
    mockCreateCollection.mockResolvedValue(undefined);
    mockCreateIndex.mockResolvedValue("ok");
    mockEnsureCheckpoint.mockResolvedValue(undefined);
    mockEnsureRealtimeEventIndexes.mockResolvedValue(undefined);
    mockReadCheckpoint.mockResolvedValue({ state: "backfilling" });
    mockClaimLease.mockResolvedValue(null);
    mockReleaseLease.mockResolvedValue(true);
    mockUpdateCheckpoint.mockResolvedValue(null);
    mockWatch.mockReset();
    mockMaterializeRequestConversation.mockReset();
    mockMaterializeRequestConversationPage.mockReset();
    mockProjectionChangeConversationIds.mockReset();
    mockCommitProjectedBatch.mockReset();
    mockConversationFind.mockReset();
    mockConversationCountDocuments.mockResolvedValue(0);
    mockProjectionCountDocuments.mockResolvedValue(0);
    mockProjectionFind.mockReturnValue({ toArray: async () => [] });
    mockProjectionBulkWrite.mockResolvedValue(undefined);
    mockProjectionDeleteMany.mockResolvedValue(undefined);
    mockOutboxUpdateOne.mockResolvedValue(undefined);
    mockStartSession.mockReset();
    mockStartSession.mockImplementation(async () => causalSession());
    resetGenerationMocks();
    installHealthyInfrastructureMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    {
      label: "fresh hello",
      boundary: sourceBoundary(1_776_000_100, 1),
      checkpointBoundary: null,
      expectsPersist: true,
    },
    {
      label: "resumed persisted checkpoint",
      boundary: sourceBoundary(1_776_000_000, 9),
      checkpointBoundary: sourceBoundary(1_776_000_000, 9),
      expectsPersist: false,
    },
  ])(
    "uses one exact nonzero $label boundary for stream and every backfill page",
    async ({ boundary, checkpointBoundary, expectsPersist }) => {
      const lease = activeLease("operator-worker");
      const checkpoint = {
        state: "backfilling",
        resumeToken: null,
        clusterTime: checkpointBoundary,
        backfillAfterId: null,
      };
      mockAdminCommand.mockResolvedValue({
        setName: "rs0",
        ...(checkpointBoundary ? {} : { operationTime: boundary }),
      });
      mockReadCheckpoint.mockResolvedValue(checkpoint);
      mockClaimLease.mockResolvedValueOnce(lease);
      const stream = {
        close: jest.fn(async () => undefined),
        resumeToken: null,
        tryNext: jest.fn(async () => null),
      };
      mockWatch.mockReturnValue(stream);
      mockMaterializeRequestConversationPage.mockResolvedValue({
        rows: [],
        projected: 0,
        lastId: null,
        hasMore: false,
      });
      mockConversationFind.mockReturnValue(queryReturning([]));

      await expect(
        runProductionRequestsProjectionActivation({
          ownerToken: "operator-worker",
          signal: new AbortController().signal,
        })
      ).resolves.toEqual({ status: "ready" });

      expect(mockWatch).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ startAtOperationTime: boundary })
      );
      expect(mockMaterializeRequestConversationPage).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceClusterTime: boundary,
          generation: expect.anything(),
        })
      );
      expect(mockReserveBoundary).toHaveBeenCalledWith(
        expect.objectContaining({
          lease,
          resumeTokenDigest: "backfill:start",
          sourceClusterTime: boundary,
        })
      );
      expect(mockReserveBoundary.mock.invocationCallOrder[0]).toBeLessThan(
        mockMaterializeRequestConversationPage.mock.invocationCallOrder[0] || 0
      );
      expect(mockCommitProjectedBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          boundary: expect.objectContaining({ sourceClusterTime: boundary }),
          progress: expect.objectContaining({ kind: "backfill_page_v1" }),
          realtimeEnabled: false,
        }),
        expect.any(Object)
      );
      if (expectsPersist) {
        expect(mockUpdateCheckpoint).toHaveBeenCalledWith(
          expect.objectContaining({ lease, clusterTime: boundary })
        );
      }
    }
  );

  it("rejects a persisted zero backfill boundary before opening the stream or reading rows", async () => {
    const zero = sourceBoundary(0, 0);
    mockReadCheckpoint.mockResolvedValue({
      state: "backfilling",
      resumeToken: null,
      clusterTime: zero,
      backfillAfterId: null,
    });
    mockClaimLease.mockResolvedValueOnce(activeLease("operator-worker"));
    mockWatch.mockReturnValue({
      close: jest.fn(async () => undefined),
      resumeToken: null,
      tryNext: jest.fn(async () => null),
    });
    mockMaterializeRequestConversationPage.mockResolvedValue({
      rows: [],
      projected: 0,
      lastId: null,
      hasMore: false,
    });
    mockConversationFind.mockReturnValue(queryReturning([]));

    await expect(
      runProductionRequestsProjectionActivation({
        ownerToken: "operator-worker",
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/nonzero BSON Timestamp/i);
    expect(mockWatch).not.toHaveBeenCalled();
    expect(mockMaterializeRequestConversationPage).not.toHaveBeenCalled();
  });

  it("replays a catching-up raw reservation before any backfill reservation", async () => {
    const boundary = sourceBoundary(1_776_000_000, 10);
    const rawToken = { _data: "raw-catching-up" };
    const lease = activeLease("operator-worker");
    const change = {
      _id: rawToken,
      clusterTime: boundary,
      operationType: "update",
      ns: { coll: "messages" },
      documentKey: { _id: "message-1" },
      fullDocument: {
        conversation: "conversation-1",
        workspaceId: "workspace-1",
      },
      updateDescription: {
        updatedFields: { delivery: "read" },
        removedFields: [],
        truncatedArrays: [],
      },
    };
    mockReadCheckpoint.mockResolvedValue({
      state: "catching_up",
      resumeToken: { _data: "prior-raw" },
      clusterTime: boundary,
      backfillAfterId: new mongoose.Types.ObjectId("65f000000000000000000001"),
      inFlightBoundary: {
        resumeTokenDigest: "raw:raw-catching-up",
        generation: mongoose.mongo.Long.fromNumber(101),
        sourceClusterTime: boundary,
      },
    });
    mockClaimLease.mockResolvedValueOnce(lease);
    mockWatch.mockReturnValue({
      close: jest.fn(async () => undefined),
      resumeToken: null,
      tryNext: jest.fn().mockResolvedValueOnce(change).mockResolvedValue(null),
    });
    mockMaterializeRequestConversationPage.mockResolvedValue({
      rows: [],
      projected: 0,
      lastId: null,
      hasMore: false,
    });
    mockConversationFind.mockReturnValue(queryReturning([]));

    await expect(
      runProductionRequestsProjectionActivation({
        ownerToken: "operator-worker",
        signal: new AbortController().signal,
      })
    ).resolves.toEqual({ status: "ready" });

    expect(mockReserveBoundary).toHaveBeenCalledTimes(1);
    expect(mockReserveBoundary).toHaveBeenCalledWith(
      expect.objectContaining({
        lease,
        resumeTokenDigest: "raw:raw-catching-up",
        sourceClusterTime: boundary,
      })
    );
    expect(mockMaterializeRequestConversationPage).not.toHaveBeenCalled();
    expect(mockCommitProjectedBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        progress: {
          kind: "change_stream_v1",
          resumeToken: rawToken,
          clusterTime: boundary,
        },
      }),
      expect.any(Object)
    );
  });

  it("advances a post-batch stream token only through the idle no-allocation path", async () => {
    const boundary = sourceBoundary(1_776_000_000, 11);
    const lease = activeLease("operator-worker");
    const postBatchToken = { _data: "post-batch-only" };
    mockReadCheckpoint.mockResolvedValue({
      state: "backfilling",
      resumeToken: null,
      clusterTime: boundary,
      backfillAfterId: null,
    });
    mockClaimLease.mockResolvedValueOnce(lease);
    mockWatch.mockReturnValue({
      close: jest.fn(async () => undefined),
      resumeToken: postBatchToken,
      tryNext: jest.fn(async () => null),
    });
    mockMaterializeRequestConversationPage.mockResolvedValue({
      rows: [],
      projected: 0,
      lastId: null,
      hasMore: false,
    });
    mockConversationFind.mockReturnValue(queryReturning([]));

    await expect(
      runProductionRequestsProjectionActivation({
        ownerToken: "operator-worker",
        signal: new AbortController().signal,
      })
    ).resolves.toEqual({ status: "ready" });

    expect(mockAdvanceIdleResumeToken).toHaveBeenCalledWith({
      lease,
      resumeToken: postBatchToken,
      now: expect.any(Date),
    });
    expect(mockAdvanceIdleResumeToken.mock.calls[0]?.[0]).not.toHaveProperty(
      "generation"
    );
  });

  it("preserves the bounded operator wait when another owner is still activating", async () => {
    const controller = new AbortController();
    const activation = runProductionRequestsProjectionActivation({
      ownerToken: "operator-worker",
      signal: controller.signal,
    });
    const observed = Promise.race([
      activation.then(
        () => ({ status: "resolved" as const }),
        error => ({
          status: "rejected" as const,
          message: error instanceof Error ? error.message : String(error),
        })
      ),
      new Promise<{ status: "pending" }>(resolve => {
        setTimeout(() => resolve({ status: "pending" }), 62_000);
      }),
    ]);

    await jest.advanceTimersByTimeAsync(62_000);
    const result = await observed;
    if (result.status === "pending") {
      controller.abort("test_cleanup");
      await jest.advanceTimersByTimeAsync(1_000);
      await activation.catch(() => undefined);
    }

    expect(result).toEqual({
      status: "rejected",
      message: "requests_projection_lease_unavailable",
    });
  });
});
