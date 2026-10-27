const mockConnectDB = jest.fn(async () => undefined);
const mockEnsureCheckpoint = jest.fn(async (_now?: Date) => undefined);
const mockEnsureRealtimeIndexes = jest.fn(async () => undefined);
const mockEnsureRuntimeInfrastructure = jest.fn(async () => ({
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
    conversation: true as const,
    message: true as const,
    chat: true as const,
    user: true as const,
  },
  canaryContractVersion: 1 as const,
  approvedCardinalityCap: 10_000_000 as const,
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: () => mockConnectDB(),
}));

jest.mock("@/lib/requests-projection/checkpoint", () => {
  const actual = jest.requireActual(
    "@/lib/requests-projection/checkpoint"
  ) as typeof import("@/lib/requests-projection/checkpoint");
  return {
    ...actual,
    ensureRequestsProjectionCheckpoint: (now: Date) =>
      mockEnsureCheckpoint(now),
  };
});

jest.mock("@/models/realtime-event", () => {
  const actual = jest.requireActual(
    "@/models/realtime-event"
  ) as typeof import("@/models/realtime-event");
  return {
    ...actual,
    ensureRealtimeEventIndexes: () => mockEnsureRealtimeIndexes(),
  };
});

jest.mock("@/lib/requests-projection/activation", () => {
  const actual = jest.requireActual(
    "@/lib/requests-projection/activation"
  ) as typeof import("@/lib/requests-projection/activation");
  return {
    ...actual,
    ensureRequestsProjectionInfrastructure: () =>
      mockEnsureRuntimeInfrastructure(),
  };
});

import mongoose from "mongoose";

import {
  REQUESTS_PROJECTION_OUTBOX_INDEX_DEFINITIONS,
  REQUESTS_PROJECTION_ROW_INDEX_DEFINITIONS,
  deriveRequestsProjectionProvisionReceiptDigest,
} from "./activation";
import {
  REQUESTS_PROJECTION_DB_MAX_TIME_MS,
  REQUESTS_PROJECTION_HARD_CARDINALITY_LIMIT,
  REQUESTS_PROJECTION_MAX_COMMIT_TIME_MS,
  REQUESTS_PROJECTION_MAX_UPDATED_ROWS_PER_SECOND,
  REQUESTS_PROJECTION_MIGRATION_PAGE_SIZE,
  REQUESTS_PROJECTION_RUN_BUDGET_MS,
  REQUESTS_PROJECTION_STOP_STARTING_PAGE_RESERVE_MS,
  REQUESTS_PROJECTION_TRANSACTION_TIMEOUT_MS,
  REQUESTS_PROJECTION_VERIFY_PAGE_SIZE,
  buildRequestsProjectionWatermarkMigrationSet,
  countRequestsProjectionRowsWithinHardLimit,
  migrateRequestsProjectionWatermarks,
  parseRequestsProjectionCollectionUuid,
  provisionRequestsProjectionInfrastructure,
  verifyRequestsProjectionForOperator,
} from "./provisioning";
import Chat from "@/models/chat";
import {
  Conversation,
  CONVERSATION_REQUESTS_DEPENDENCY_INDEXES,
} from "@/models/conversation";
import Message from "@/models/message";
import { RealtimeEvent } from "@/models/realtime-event";
import {
  REQUESTS_PROJECTION_CHECKPOINT_ID,
  RequestsProjectionCheckpoint,
} from "@/models/requests-projection-checkpoint";
import { RequestListItem } from "@/models/request-list-item";
import User from "@/models/user";

type FakeRow = {
  _id: mongoose.Types.ObjectId;
  projection: Record<string, unknown>;
};

function indexDocument(definition: {
  keys: Readonly<Record<string, 1 | -1>>;
  options: Readonly<Record<string, unknown>>;
}) {
  return {
    key: { ...definition.keys },
    ...definition.options,
  };
}

function createFakeMongo(
  input: {
    rows?: FakeRow[];
    rowCollectionAbsent?: boolean;
    countOverride?: number;
    breakCanaryImages?: boolean;
    failCanaryDrop?: boolean;
    replaceRequestListUuidOnMetadataRead?: number;
    replaceRequestListUuidAfterFirstIndex?: boolean;
    replaceRequestListUuidOnFenceInsert?: number;
    replaceCanaryUuidOnMetadataRead?: number;
    concurrentCompletion?: "equal" | "conflict";
    sourceImagesEnabled?: boolean;
  } = {}
) {
  const names = {
    requestListItem: RequestListItem.collection.collectionName,
    checkpoint: RequestsProjectionCheckpoint.collection.collectionName,
    realtimeOutbox: RealtimeEvent.collection.collectionName,
    conversation: Conversation.collection.collectionName,
    message: Message.collection.collectionName,
    chat: Chat.collection.collectionName,
    user: User.collection.collectionName,
  };
  const sourceNames = [
    names.conversation,
    names.message,
    names.chat,
    names.user,
  ];
  const uuidByName = new Map<string, Buffer>();
  const metadataByName = new Map<string, Record<string, unknown>>();
  const indexesByName = new Map<string, Array<Record<string, unknown>>>([
    [
      names.realtimeOutbox,
      REQUESTS_PROJECTION_OUTBOX_INDEX_DEFINITIONS.map(indexDocument),
    ],
  ]);
  const rows = input.rows || [];
  const checkpoint: Record<string, unknown> = {
    _id: REQUESTS_PROJECTION_CHECKPOINT_ID,
    schemaVersion: 2,
    state: "ready",
    watermarkMigrationProgress: null,
    watermarkMigrationCompletedAt: null,
    watermarkMigrationReceipt: null,
    provisionReceipt: null,
  };
  const createIndexCalls: Array<{
    name: string;
    keys: Record<string, unknown>;
    options: Record<string, unknown>;
  }> = [];
  const countCalls: Array<{
    filter: Record<string, unknown>;
    options: Record<string, unknown>;
  }> = [];
  const commandCalls: Array<Record<string, unknown>> = [];
  const createCollectionCalls: string[] = [];
  const droppedCollections: string[] = [];
  const customerWrites: string[] = [];
  const transactionOptions: Array<Record<string, unknown>> = [];
  const bulkWriteCalls: unknown[][] = [];
  const findOneCalls: Array<{
    name: string;
    filter: Record<string, unknown>;
    options?: Record<string, unknown>;
  }> = [];
  const updateOneCalls: Array<{
    name: string;
    filter: Record<string, unknown>;
    update: Record<string, unknown>;
    options?: Record<string, unknown>;
  }> = [];
  const insertOneCalls: Array<{
    name: string;
    document: Record<string, unknown>;
    options?: Record<string, unknown>;
  }> = [];
  const deleteOneCalls: Array<{
    name: string;
    filter: Record<string, unknown>;
    options?: Record<string, unknown>;
  }> = [];
  const sentinelDocuments = new Map<string, Record<string, unknown>>();
  const serverTime = new Date("2026-08-20T12:00:00.000Z");
  let nextUuidByte = 1;
  let requestListMetadataReads = 0;
  let canaryMetadataReads = 0;
  let requestListIndexCreates = 0;
  let fenceInserts = 0;

  const addMetadata = (name: string, imageEnabled = false) => {
    const uuid = Buffer.alloc(16, nextUuidByte);
    nextUuidByte += 1;
    uuidByName.set(name, uuid);
    metadataByName.set(name, {
      name,
      info: { uuid: { sub_type: 4, buffer: uuid } },
      options: imageEnabled
        ? { changeStreamPreAndPostImages: { enabled: true } }
        : {},
    });
    indexesByName.set(name, indexesByName.get(name) || []);
  };

  const replaceUuid = (name: string) => {
    const metadata = metadataByName.get(name);
    if (!metadata) return;
    const uuid = Buffer.alloc(16, nextUuidByte);
    nextUuidByte += 1;
    uuidByName.set(name, uuid);
    metadata.info = { uuid: { sub_type: 4, buffer: uuid } };
  };

  for (const name of Object.values(names)) {
    if (name !== names.requestListItem || !input.rowCollectionAbsent) {
      addMetadata(
        name,
        Boolean(input.sourceImagesEnabled && sourceNames.includes(name))
      );
    }
  }

  const canaryDocuments = new Map<string, Record<string, unknown>>();
  const canaryChanges = new Map<string, Array<Record<string, unknown>>>();

  const collection = (name: string) => ({
    bulkWrite: jest.fn(async (operations: unknown[]) => {
      bulkWriteCalls.push(operations);
      let modifiedCount = 0;
      for (const operation of operations as Array<{
        updateOne: {
          filter: { _id: mongoose.Types.ObjectId };
          update: { $set: Record<string, unknown> };
        };
      }>) {
        const row = rows.find(candidate =>
          candidate._id.equals(operation.updateOne.filter._id)
        );
        if (!row) continue;
        for (const [field, value] of Object.entries(
          operation.updateOne.update.$set
        )) {
          const [, child] = field.split(".");
          if (child) row.projection[child] = value;
        }
        modifiedCount += 1;
      }
      return { modifiedCount };
    }),
    countDocuments: jest.fn(
      async (
        filter: Record<string, unknown>,
        options: Record<string, unknown>
      ) => {
        countCalls.push({ filter, options });
        return input.countOverride ?? rows.length;
      }
    ),
    createIndex: jest.fn(
      async (
        keys: Record<string, unknown>,
        options: Record<string, unknown>
      ) => {
        createIndexCalls.push({ name, keys, options });
        if (name === names.requestListItem) {
          requestListIndexCreates += 1;
          if (
            input.replaceRequestListUuidAfterFirstIndex &&
            requestListIndexCreates === 1
          ) {
            replaceUuid(name);
          }
        }
        const persistedOptions = { ...options };
        delete persistedOptions.background;
        const index = { key: { ...keys }, ...persistedOptions };
        const indexes = indexesByName.get(name) || [];
        const existing = indexes.findIndex(
          candidate => candidate.name === persistedOptions.name
        );
        if (existing >= 0) indexes[existing] = index;
        else indexes.push(index);
        indexesByName.set(name, indexes);
        return String(persistedOptions.name);
      }
    ),
    drop: jest.fn(async () => {
      if (
        input.failCanaryDrop &&
        name.startsWith("requests_projection_image_canary_v1_")
      ) {
        throw new Error("drop failed");
      }
      droppedCollections.push(name);
      metadataByName.delete(name);
      return true;
    }),
    find: jest.fn((filter: Record<string, unknown>) => {
      let limit = Number.MAX_SAFE_INTEGER;
      const after = (
        filter._id as { $gt?: mongoose.Types.ObjectId } | undefined
      )?.$gt;
      const result = rows
        .filter(row => !after || row._id.toHexString() > after.toHexString())
        .sort((left, right) =>
          left._id.toHexString().localeCompare(right._id.toHexString())
        );
      const cursor: {
        sort: jest.Mock;
        limit: jest.Mock;
        toArray: jest.Mock;
      } = {
        sort: jest.fn(() => cursor),
        limit: jest.fn((value: number) => {
          limit = value;
          return cursor;
        }),
        toArray: jest.fn(async () => result.slice(0, limit)),
      };
      return cursor;
    }),
    findOne: jest.fn(
      async (
        filter: Record<string, unknown>,
        options?: Record<string, unknown>
      ) => {
        findOneCalls.push({ name, filter, options });
        if (name === names.checkpoint && filter._id === checkpoint._id) {
          return checkpoint;
        }
        return canaryDocuments.get(name) || null;
      }
    ),
    insertOne: jest.fn(
      async (
        document: Record<string, unknown>,
        options?: Record<string, unknown>
      ) => {
        insertOneCalls.push({ name, document, options });
        if (sourceNames.includes(name)) customerWrites.push(name);
        if (name === names.requestListItem) {
          fenceInserts += 1;
          sentinelDocuments.set(String(document._id), { ...document });
          if (input.replaceRequestListUuidOnFenceInsert === fenceInserts) {
            replaceUuid(name);
          }
          return { acknowledged: true, insertedId: document._id };
        }
        canaryDocuments.set(name, { ...document });
        canaryChanges.set(name, [
          {
            operationType: "insert",
            fullDocument: { ...document },
          },
        ]);
        return { acknowledged: true };
      }
    ),
    listIndexes: jest.fn(() => ({
      toArray: jest.fn(async () => indexesByName.get(name) || []),
    })),
    deleteOne: jest.fn(
      async (
        filter: Record<string, unknown>,
        options?: Record<string, unknown>
      ) => {
        deleteOneCalls.push({ name, filter, options });
        if (name !== names.requestListItem) return { deletedCount: 0 };
        const deleted = sentinelDocuments.delete(String(filter._id));
        return { deletedCount: deleted ? 1 : 0 };
      }
    ),
    updateOne: jest.fn(
      async (
        filter: Record<string, unknown>,
        update: { $set?: Record<string, unknown> },
        options?: Record<string, unknown>
      ) => {
        updateOneCalls.push({ name, filter, update, options });
        if (sourceNames.includes(name)) customerWrites.push(name);
        if (name === names.checkpoint) {
          Object.assign(checkpoint, update.$set || {});
          return { matchedCount: 1, modifiedCount: 1 };
        }
        const before = { ...(canaryDocuments.get(name) || {}) };
        const after = { ...before, ...(update.$set || {}) };
        canaryDocuments.set(name, after);
        canaryChanges.get(name)?.push({
          operationType: "update",
          fullDocumentBeforeChange: input.breakCanaryImages ? null : before,
          fullDocument: after,
        });
        return { matchedCount: 1, modifiedCount: 1 };
      }
    ),
    watch: jest.fn(() => ({
      close: jest.fn(async () => undefined),
      tryNext: jest.fn(async () => canaryChanges.get(name)?.shift() || null),
    })),
  });

  const db = {
    admin: jest.fn(() => ({
      command: jest.fn(async () => ({ setName: "rs0", localTime: serverTime })),
    })),
    collection: jest.fn((name: string) => collection(name)),
    command: jest.fn(async (command: Record<string, unknown>) => {
      commandCalls.push(command);
      const name = String(command.collMod || "");
      const metadata = metadataByName.get(name);
      if (metadata) {
        metadata.options = {
          changeStreamPreAndPostImages: { enabled: true },
        };
      }
      return { ok: 1 };
    }),
    createCollection: jest.fn(
      async (
        name: string,
        options?: { changeStreamPreAndPostImages?: { enabled?: boolean } }
      ) => {
        createCollectionCalls.push(name);
        addMetadata(
          name,
          options?.changeStreamPreAndPostImages?.enabled === true
        );
        return collection(name);
      }
    ),
    listCollections: jest.fn(({ name }: { name: string }) => ({
      next: jest.fn(async () => {
        if (name === names.requestListItem) {
          requestListMetadataReads += 1;
          if (
            input.replaceRequestListUuidOnMetadataRead ===
            requestListMetadataReads
          ) {
            replaceUuid(name);
          }
        }
        if (name.startsWith("requests_projection_image_canary_v1_")) {
          canaryMetadataReads += 1;
          if (input.replaceCanaryUuidOnMetadataRead === canaryMetadataReads) {
            replaceUuid(name);
          }
        }
        return metadataByName.get(name) || null;
      }),
    })),
  };

  const install = () => {
    Object.defineProperty(mongoose.connection, "db", {
      configurable: true,
      value: db,
    });
    jest.spyOn(mongoose, "startSession").mockImplementation(async () => {
      const session = {
        endSession: jest.fn(async () => undefined),
        withTransaction: jest.fn(
          async (
            work: () => Promise<void>,
            options: Record<string, unknown>
          ) => {
            transactionOptions.push(options);
            if (input.concurrentCompletion && transactionOptions.length === 2) {
              const progress = checkpoint.watermarkMigrationProgress as Record<
                string,
                number
              >;
              const provisionReceipt = checkpoint.provisionReceipt as Record<
                string,
                unknown
              >;
              const completedAt =
                input.concurrentCompletion === "equal"
                  ? serverTime
                  : new Date(serverTime.getTime() + 1);
              checkpoint.watermarkMigrationCompletedAt = completedAt;
              checkpoint.watermarkMigrationReceipt = {
                schemaVersion: 1,
                contractVersion: 1,
                collectionUuids: provisionReceipt.collectionUuids,
                rowIndexDigest: provisionReceipt.rowIndexDigest,
                outboxIndexDigest: provisionReceipt.outboxIndexDigest,
                provisionReceiptDigest:
                  deriveRequestsProjectionProvisionReceiptDigest(
                    provisionReceipt
                  ),
                approvedCardinalityCap: 10_000_000,
                preflightCardinality: progress.preflightCardinality,
                scanned: progress.scanned,
                matched: progress.matched,
                updated: progress.updated,
                missingAfter: 0,
                invalidAfter: 0,
                verifiedAt: completedAt,
                completedAt,
              };
              checkpoint.watermarkMigrationProgress = null;
            }
            await work();
          }
        ),
      };
      return session as unknown as mongoose.ClientSession;
    });
  };

  return {
    names,
    rows,
    checkpoint,
    db,
    install,
    uuidByName,
    metadataByName,
    createIndexCalls,
    countCalls,
    commandCalls,
    createCollectionCalls,
    droppedCollections,
    customerWrites,
    transactionOptions,
    bulkWriteCalls,
    findOneCalls,
    updateOneCalls,
    insertOneCalls,
    deleteOneCalls,
    sentinelDocuments,
  };
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe("Requests projection provisioning boundaries", () => {
  it("freezes the bounded serial migration contract", () => {
    expect({
      hardCap: REQUESTS_PROJECTION_HARD_CARDINALITY_LIMIT,
      migrationPage: REQUESTS_PROJECTION_MIGRATION_PAGE_SIZE,
      verifyPage: REQUESTS_PROJECTION_VERIFY_PAGE_SIZE,
      updatedRowsPerSecond: REQUESTS_PROJECTION_MAX_UPDATED_ROWS_PER_SECOND,
      runBudget: REQUESTS_PROJECTION_RUN_BUDGET_MS,
      stopReserve: REQUESTS_PROJECTION_STOP_STARTING_PAGE_RESERVE_MS,
      dbMaxTime: REQUESTS_PROJECTION_DB_MAX_TIME_MS,
      transactionTimeout: REQUESTS_PROJECTION_TRANSACTION_TIMEOUT_MS,
      maxCommitTime: REQUESTS_PROJECTION_MAX_COMMIT_TIME_MS,
    }).toEqual({
      hardCap: 10_000_000,
      migrationPage: 250,
      verifyPage: 1_000,
      updatedRowsPerSecond: 500,
      runBudget: 2_700_000,
      stopReserve: 30_000,
      dbMaxTime: 15_000,
      transactionTimeout: 25_000,
      maxCommitTime: 10_000,
    });
  });

  it("serializes only subtype-4 sixteen-byte collection UUIDs", () => {
    expect(
      parseRequestsProjectionCollectionUuid({
        sub_type: 4,
        buffer: Buffer.from("00112233445566778899aabbccddeeff", "hex"),
      })
    ).toBe("00112233445566778899aabbccddeeff");
    expect(() =>
      parseRequestsProjectionCollectionUuid({
        sub_type: 3,
        buffer: Buffer.alloc(16),
      })
    ).toThrow(/uuid/i);
    expect(() =>
      parseRequestsProjectionCollectionUuid({
        sub_type: 4,
        buffer: Buffer.alloc(15),
      })
    ).toThrow(/uuid/i);
  });

  it("uses the exact capped _id count and fails closed above the cap", async () => {
    const countDocuments = jest
      .fn()
      .mockResolvedValueOnce(10_000_000)
      .mockResolvedValueOnce(10_000_001);
    const collection = { countDocuments };

    await expect(
      countRequestsProjectionRowsWithinHardLimit(collection)
    ).resolves.toBe(10_000_000);
    expect(countDocuments).toHaveBeenNthCalledWith(
      1,
      {},
      { hint: "_id_", limit: 10_000_001, maxTimeMS: 15_000 }
    );
    await expect(
      countRequestsProjectionRowsWithinHardLimit(collection)
    ).rejects.toThrow(/cardinality|shadow/i);
  });

  it("sets only missing watermarks to native Timestamp zero", () => {
    const nativePeer = new (
      jest.requireActual("mongoose") as typeof import("mongoose")
    ).mongo.Timestamp({
      t: 12,
      i: 3,
    });

    const bothMissing = buildRequestsProjectionWatermarkMigrationSet({
      projection: {},
    });
    expect(Object.keys(bothMissing || {}).sort()).toEqual([
      "projection.readStateWatermark",
      "projection.sourceWatermark",
    ]);
    expect(bothMissing?.["projection.sourceWatermark"]?.toBigInt()).toBe(
      BigInt(0)
    );
    expect(bothMissing?.["projection.readStateWatermark"]?.toBigInt()).toBe(
      BigInt(0)
    );

    expect(
      buildRequestsProjectionWatermarkMigrationSet({
        projection: { sourceWatermark: nativePeer },
      })
    ).toEqual({
      "projection.readStateWatermark": expect.objectContaining({}),
    });
    expect(
      buildRequestsProjectionWatermarkMigrationSet({
        projection: {
          sourceWatermark: "corrupt-present",
          readStateWatermark: nativePeer,
        },
      })
    ).toBeNull();
  });
});

describe("Requests projection privileged operator ownership", () => {
  it("provisions exact indexes, source images, isolated canary, and immutable evidence", async () => {
    const fake = createFakeMongo({ rows: [] });
    fake.install();
    const expectedUuid = fake.uuidByName
      .get(fake.names.requestListItem)!
      .toString("hex");

    await expect(
      provisionRequestsProjectionInfrastructure({
        expectedCollectionUuid: expectedUuid,
        approvedCardinalityCap: 10_000_000,
      })
    ).resolves.toEqual({ status: "ready", collectionUuid: expectedUuid });

    expect(fake.countCalls[0]).toEqual({
      filter: {},
      options: { hint: "_id_", limit: 10_000_001, maxTimeMS: 15_000 },
    });
    expect(
      fake.createIndexCalls.filter(
        call => call.name === fake.names.requestListItem
      )
    ).toHaveLength(9);
    expect(
      fake.createIndexCalls
        .filter(call => call.name === fake.names.requestListItem)
        .map(call => ({ keys: call.keys, name: call.options.name }))
    ).toEqual(
      REQUESTS_PROJECTION_ROW_INDEX_DEFINITIONS.map(definition => ({
        keys: definition.keys,
        name: definition.options.name,
      }))
    );
    expect(mockEnsureRealtimeIndexes).toHaveBeenCalledTimes(1);
    expect(
      fake.createIndexCalls
        .filter(call => call.name === fake.names.conversation)
        .map(call => ({ keys: call.keys, name: call.options.name }))
    ).toEqual(
      CONVERSATION_REQUESTS_DEPENDENCY_INDEXES.map(({ keys, options }) => ({
        keys,
        name: options.name,
      }))
    );
    expect(
      fake.commandCalls.filter(command =>
        [
          fake.names.conversation,
          fake.names.message,
          fake.names.chat,
          fake.names.user,
        ].includes(String(command.collMod))
      )
    ).toHaveLength(4);
    expect(
      fake.commandCalls.filter(command =>
        String(command.collMod || "").startsWith(
          "requests_projection_image_canary_v1_"
        )
      )
    ).toHaveLength(0);
    expect(fake.customerWrites).toEqual([]);
    expect(fake.droppedCollections).toHaveLength(1);
    expect(fake.droppedCollections[0]).toMatch(
      /^requests_projection_image_canary_v1_[0-9a-f]{12}$/
    );
    expect(fake.checkpoint.provisionReceipt).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        contractVersion: 1,
        approvedCardinalityCap: 10_000_000,
        preflightCardinality: 0,
        canaryContractVersion: 1,
      })
    );
    expect(JSON.stringify(fake.checkpoint.provisionReceipt)).not.toMatch(
      /expire|ttl|cursor|tenant|conversationId|content/i
    );

    const originalReceipt = fake.checkpoint.provisionReceipt;
    fake.db.admin.mockReturnValue({
      command: jest.fn(async () => ({
        setName: "rs0",
        localTime: new Date("2026-08-20T12:01:00.000Z"),
      })),
    });
    await expect(
      provisionRequestsProjectionInfrastructure({
        expectedCollectionUuid: expectedUuid,
        approvedCardinalityCap: 10_000_000,
      })
    ).resolves.toEqual({ status: "ready", collectionUuid: expectedUuid });
    expect(fake.checkpoint.provisionReceipt).toBe(originalReceipt);
  });

  it("skips source collMod when change-stream images are already enabled", async () => {
    const fake = createFakeMongo({ rows: [], sourceImagesEnabled: true });
    fake.install();
    const expectedUuid = fake.uuidByName
      .get(fake.names.requestListItem)!
      .toString("hex");

    await expect(
      provisionRequestsProjectionInfrastructure({
        expectedCollectionUuid: expectedUuid,
        approvedCardinalityCap: 10_000_000,
      })
    ).resolves.toEqual({ status: "ready", collectionUuid: expectedUuid });

    expect(
      fake.commandCalls.filter(command =>
        [
          fake.names.conversation,
          fake.names.message,
          fake.names.chat,
          fake.names.user,
        ].includes(String(command.collMod))
      )
    ).toHaveLength(0);
    expect(fake.checkpoint.provisionReceipt).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        canaryContractVersion: 1,
      })
    );
  });

  it("fails the exact cardinality gate before index, image, or receipt mutation", async () => {
    const fake = createFakeMongo({ countOverride: 10_000_001 });
    fake.install();
    const expectedUuid = fake.uuidByName
      .get(fake.names.requestListItem)!
      .toString("hex");

    await expect(
      provisionRequestsProjectionInfrastructure({
        expectedCollectionUuid: expectedUuid,
        approvedCardinalityCap: 10_000_000,
      })
    ).rejects.toThrow(/cardinality|shadow/i);

    expect(fake.createIndexCalls).toEqual([]);
    expect(fake.commandCalls).toEqual([]);
    expect(fake.checkpoint.provisionReceipt).toBeNull();
  });

  it("rejects a recreated target on the authoritative UUID reread before counting", async () => {
    const fake = createFakeMongo({
      replaceRequestListUuidOnMetadataRead: 2,
    });
    fake.install();
    const expectedUuid = Buffer.alloc(16, 1).toString("hex");

    await expect(
      provisionRequestsProjectionInfrastructure({
        expectedCollectionUuid: expectedUuid,
        approvedCardinalityCap: 10_000_000,
      })
    ).rejects.toThrow(/uuid/i);

    expect(fake.countCalls).toEqual([]);
    expect(fake.createIndexCalls).toEqual([]);
    expect(fake.checkpoint.provisionReceipt).toBeNull();
  });

  it("stops after index-phase UUID drift before images or canary mutation", async () => {
    const fake = createFakeMongo({
      replaceRequestListUuidAfterFirstIndex: true,
    });
    fake.install();
    const expectedUuid = Buffer.alloc(16, 1).toString("hex");

    await expect(
      provisionRequestsProjectionInfrastructure({
        expectedCollectionUuid: expectedUuid,
        approvedCardinalityCap: 10_000_000,
      })
    ).rejects.toThrow(/uuid/i);

    expect(fake.commandCalls).toEqual([]);
    expect(fake.droppedCollections).toEqual([]);
    expect(fake.checkpoint.provisionReceipt).toBeNull();
  });

  it("cleans the exact temporary canary and writes no receipt on image failure", async () => {
    const fake = createFakeMongo({ breakCanaryImages: true });
    fake.install();
    const expectedUuid = fake.uuidByName
      .get(fake.names.requestListItem)!
      .toString("hex");

    await expect(
      provisionRequestsProjectionInfrastructure({
        expectedCollectionUuid: expectedUuid,
        approvedCardinalityCap: 10_000_000,
      })
    ).rejects.toThrow(/canary/i);

    expect(fake.droppedCollections).toHaveLength(1);
    expect(fake.checkpoint.provisionReceipt).toBeNull();
    expect(fake.customerWrites).toEqual([]);
  });

  it("fails closed and writes no receipt when the temporary canary cannot be dropped", async () => {
    const fake = createFakeMongo({ failCanaryDrop: true });
    fake.install();
    const expectedUuid = fake.uuidByName
      .get(fake.names.requestListItem)!
      .toString("hex");

    await expect(
      provisionRequestsProjectionInfrastructure({
        expectedCollectionUuid: expectedUuid,
        approvedCardinalityCap: 10_000_000,
      })
    ).rejects.toThrow(/canary|cleanup|drop/i);
    expect(fake.checkpoint.provisionReceipt).toBeNull();
  });

  it("never drops a replacement that took the temporary canary name", async () => {
    const fake = createFakeMongo({ replaceCanaryUuidOnMetadataRead: 3 });
    fake.install();
    const expectedUuid = fake.uuidByName
      .get(fake.names.requestListItem)!
      .toString("hex");

    await expect(
      provisionRequestsProjectionInfrastructure({
        expectedCollectionUuid: expectedUuid,
        approvedCardinalityCap: 10_000_000,
      })
    ).rejects.toThrow(/canary|uuid/i);

    expect(fake.droppedCollections).toEqual([]);
    expect(fake.checkpoint.provisionReceipt).toBeNull();
  });

  it("bootstraps literal absent once and returns the reread exact UUID", async () => {
    const fake = createFakeMongo({ rowCollectionAbsent: true, rows: [] });
    fake.install();

    const result = await provisionRequestsProjectionInfrastructure({
      expectedCollectionUuid: "absent",
      approvedCardinalityCap: 10_000_000,
    });

    expect(fake.createCollectionCalls).toContain(fake.names.requestListItem);
    expect(result).toEqual({
      status: "ready",
      collectionUuid: fake.uuidByName
        .get(fake.names.requestListItem)!
        .toString("hex"),
    });
    expect(fake.countCalls[0]?.options).toEqual({
      hint: "_id_",
      limit: 10_000_001,
      maxTimeMS: 15_000,
    });
  });
});

describe("Requests projection resumable watermark migration", () => {
  it("commits one serial page, throttles committed rows, verifies independently, and latches atomically", async () => {
    const preserved = new mongoose.mongo.Timestamp({ t: 12, i: 3 });
    const fake = createFakeMongo({
      rows: [
        {
          _id: new mongoose.Types.ObjectId("000000000000000000000001"),
          projection: {},
        },
        {
          _id: new mongoose.Types.ObjectId("000000000000000000000002"),
          projection: { sourceWatermark: preserved },
        },
      ],
    });
    fake.install();
    const expectedUuid = fake.uuidByName
      .get(fake.names.requestListItem)!
      .toString("hex");
    await provisionRequestsProjectionInfrastructure({
      expectedCollectionUuid: expectedUuid,
      approvedCardinalityCap: 10_000_000,
    });
    const sleep = jest.fn(async (_milliseconds: number) => undefined);

    await expect(
      migrateRequestsProjectionWatermarks({
        expectedCollectionUuid: expectedUuid,
        approvedCardinalityCap: 10_000_000,
        monotonicNow: () => 0,
        sleep,
      })
    ).resolves.toEqual({
      status: "ready",
      collectionUuid: expectedUuid,
      preflightCardinality: 2,
      scanned: 2,
      matched: 2,
      updated: 2,
      missingAfter: 0,
      invalidAfter: 0,
    });

    expect(sleep).toHaveBeenCalledWith(4);
    expect(fake.rows[1]?.projection.sourceWatermark).toBe(preserved);
    expect(fake.rows[0]?.projection.sourceWatermark).toBeInstanceOf(
      mongoose.mongo.Timestamp
    );
    expect(fake.rows[0]?.projection.readStateWatermark).toBeInstanceOf(
      mongoose.mongo.Timestamp
    );
    expect(fake.transactionOptions).toEqual([
      {
        timeoutMS: 25_000,
        maxCommitTimeMS: 10_000,
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        readPreference: "primary",
      },
      {
        timeoutMS: 25_000,
        maxCommitTimeMS: 10_000,
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        readPreference: "primary",
      },
    ]);
    const transactionalCheckpointFinds = fake.findOneCalls.filter(
      call => call.name === fake.names.checkpoint && call.options?.session
    );
    expect(transactionalCheckpointFinds.length).toBeGreaterThan(0);
    expect(
      transactionalCheckpointFinds.every(
        call => call.options?.maxTimeMS === 15_000
      )
    ).toBe(true);
    const transactionalCheckpointUpdates = fake.updateOneCalls.filter(
      call => call.name === fake.names.checkpoint && call.options?.session
    );
    expect(transactionalCheckpointUpdates.length).toBeGreaterThan(0);
    expect(
      transactionalCheckpointUpdates.every(
        call => call.options?.maxTimeMS === 15_000
      )
    ).toBe(true);
    const targetFenceInserts = fake.insertOneCalls.filter(
      call => call.name === fake.names.requestListItem
    );
    const targetFenceDeletes = fake.deleteOneCalls.filter(
      call => call.name === fake.names.requestListItem
    );
    expect(targetFenceInserts).toHaveLength(2);
    expect(targetFenceDeletes).toHaveLength(2);
    expect(
      [...targetFenceInserts, ...targetFenceDeletes].every(
        call => call.options?.maxTimeMS === 15_000 && call.options?.session
      )
    ).toBe(true);
    expect(
      (fake.db.listCollections as jest.Mock).mock.calls.every(
        ([, options]) =>
          options?.nameOnly === false && options?.maxTimeMS === 15_000
      )
    ).toBe(true);
    expect(fake.sentinelDocuments.size).toBe(0);
    expect(fake.checkpoint.watermarkMigrationCompletedAt).toBeInstanceOf(Date);
    expect(fake.checkpoint.watermarkMigrationProgress).toBeNull();
    expect(fake.checkpoint.watermarkMigrationReceipt).toEqual(
      expect.objectContaining({
        missingAfter: 0,
        invalidAfter: 0,
        completedAt: fake.checkpoint.watermarkMigrationCompletedAt,
      })
    );
    expect(
      JSON.stringify(fake.checkpoint.watermarkMigrationReceipt)
    ).not.toMatch(/nextAfterId|cursor|tenant|conversationId|content/i);

    const mutationCounts = {
      indexes: fake.createIndexCalls.length,
      commands: fake.commandCalls.length,
      bulkWrites: fake.bulkWriteCalls.length,
    };
    await expect(
      verifyRequestsProjectionForOperator({
        expectedCollectionUuid: expectedUuid,
      })
    ).resolves.toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        contractVersion: 1,
        status: "ready",
        collectionUuid: expectedUuid,
        provisionReceiptDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        migrationReceiptDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        verifiedAt: "2026-08-20T12:00:00.000Z",
      })
    );
    expect({
      indexes: fake.createIndexCalls.length,
      commands: fake.commandCalls.length,
      bulkWrites: fake.bulkWriteCalls.length,
    }).toEqual(mutationCounts);
  });

  it("keeps progress and writes no completion evidence when verification finds a wrong type", async () => {
    const fake = createFakeMongo({
      rows: [
        {
          _id: new mongoose.Types.ObjectId("000000000000000000000001"),
          projection: {
            sourceWatermark: "corrupt-present",
            readStateWatermark: new mongoose.mongo.Timestamp({ t: 1, i: 1 }),
          },
        },
      ],
    });
    fake.install();
    const expectedUuid = fake.uuidByName
      .get(fake.names.requestListItem)!
      .toString("hex");
    await provisionRequestsProjectionInfrastructure({
      expectedCollectionUuid: expectedUuid,
      approvedCardinalityCap: 10_000_000,
    });

    await expect(
      migrateRequestsProjectionWatermarks({
        expectedCollectionUuid: expectedUuid,
        approvedCardinalityCap: 10_000_000,
        monotonicNow: () => 0,
        sleep: async () => undefined,
      })
    ).resolves.toEqual({
      status: "not_ready",
      collectionUuid: expectedUuid,
      missingAfter: 0,
      invalidAfter: 1,
    });

    expect(fake.checkpoint.watermarkMigrationProgress).toEqual(
      expect.objectContaining({ state: "running", scanned: 1 })
    );
    expect(fake.checkpoint.watermarkMigrationCompletedAt).toBeNull();
    expect(fake.checkpoint.watermarkMigrationReceipt).toBeNull();
  });

  it("stops before a new page at the per-run reserve and leaves resumable progress", async () => {
    const fake = createFakeMongo({
      rows: [
        {
          _id: new mongoose.Types.ObjectId("000000000000000000000001"),
          projection: {},
        },
      ],
    });
    fake.install();
    const expectedUuid = fake.uuidByName
      .get(fake.names.requestListItem)!
      .toString("hex");
    await provisionRequestsProjectionInfrastructure({
      expectedCollectionUuid: expectedUuid,
      approvedCardinalityCap: 10_000_000,
    });
    const ticks = [0, 2_670_000];

    await expect(
      migrateRequestsProjectionWatermarks({
        expectedCollectionUuid: expectedUuid,
        approvedCardinalityCap: 10_000_000,
        monotonicNow: () => ticks.shift() ?? 2_670_000,
        sleep: async () => undefined,
      })
    ).resolves.toEqual({
      status: "incomplete_resumable",
      collectionUuid: expectedUuid,
    });

    expect(fake.bulkWriteCalls).toEqual([]);
    expect(fake.checkpoint.watermarkMigrationProgress).toEqual(
      expect.objectContaining({ state: "running", nextAfterId: null })
    );
    expect(fake.checkpoint.watermarkMigrationReceipt).toBeNull();
  });

  it("aborts a migration page when the target UUID changes under its transaction fence", async () => {
    const fake = createFakeMongo({
      rows: [
        {
          _id: new mongoose.Types.ObjectId("000000000000000000000001"),
          projection: {},
        },
      ],
      replaceRequestListUuidOnFenceInsert: 1,
    });
    fake.install();
    const expectedUuid = Buffer.alloc(16, 1).toString("hex");
    await provisionRequestsProjectionInfrastructure({
      expectedCollectionUuid: expectedUuid,
      approvedCardinalityCap: 10_000_000,
    });

    await expect(
      migrateRequestsProjectionWatermarks({
        expectedCollectionUuid: expectedUuid,
        approvedCardinalityCap: 10_000_000,
        monotonicNow: () => 0,
        sleep: async () => undefined,
      })
    ).rejects.toThrow(/uuid/i);

    expect(fake.rows[0]?.projection).toEqual({});
    expect(fake.checkpoint.watermarkMigrationProgress).toEqual(
      expect.objectContaining({ scanned: 0, collectionUuid: expectedUuid })
    );
    expect(fake.checkpoint.watermarkMigrationReceipt).toBeNull();
    expect(
      fake.insertOneCalls.filter(
        call => call.name === fake.names.requestListItem
      )
    ).toHaveLength(1);
    expect(
      fake.deleteOneCalls.filter(
        call => call.name === fake.names.requestListItem
      )
    ).toHaveLength(1);
    expect(fake.sentinelDocuments.size).toBe(0);
  });

  it("holds a zero-row target fence through completion and rejects UUID drift before the latch", async () => {
    const fake = createFakeMongo({
      rows: [],
      replaceRequestListUuidOnFenceInsert: 2,
    });
    fake.install();
    const expectedUuid = Buffer.alloc(16, 1).toString("hex");
    await provisionRequestsProjectionInfrastructure({
      expectedCollectionUuid: expectedUuid,
      approvedCardinalityCap: 10_000_000,
    });

    await expect(
      migrateRequestsProjectionWatermarks({
        expectedCollectionUuid: expectedUuid,
        approvedCardinalityCap: 10_000_000,
        monotonicNow: () => 0,
        sleep: async () => undefined,
      })
    ).rejects.toThrow(/uuid/i);

    expect(
      fake.insertOneCalls.filter(
        call => call.name === fake.names.requestListItem
      )
    ).toHaveLength(2);
    expect(
      fake.deleteOneCalls.filter(
        call => call.name === fake.names.requestListItem
      )
    ).toHaveLength(2);
    expect(fake.sentinelDocuments.size).toBe(0);
    expect(fake.checkpoint.watermarkMigrationCompletedAt).toBeNull();
    expect(fake.checkpoint.watermarkMigrationReceipt).toBeNull();
    expect(fake.checkpoint.watermarkMigrationProgress).toEqual(
      expect.objectContaining({
        state: "running",
        collectionUuid: expectedUuid,
      })
    );
  });

  it("returns resumable when the budget expires during independent verification", async () => {
    const watermark = new mongoose.mongo.Timestamp({ t: 1, i: 1 });
    const fake = createFakeMongo({
      rows: [
        {
          _id: new mongoose.Types.ObjectId("000000000000000000000001"),
          projection: {
            sourceWatermark: watermark,
            readStateWatermark: watermark,
          },
        },
      ],
    });
    fake.install();
    const expectedUuid = fake.uuidByName
      .get(fake.names.requestListItem)!
      .toString("hex");
    await provisionRequestsProjectionInfrastructure({
      expectedCollectionUuid: expectedUuid,
      approvedCardinalityCap: 10_000_000,
    });
    const ticks = [0, 0, 0, 2_670_000];

    await expect(
      migrateRequestsProjectionWatermarks({
        expectedCollectionUuid: expectedUuid,
        approvedCardinalityCap: 10_000_000,
        monotonicNow: () => ticks.shift() ?? 2_670_000,
        sleep: async () => undefined,
      })
    ).resolves.toEqual({
      status: "incomplete_resumable",
      collectionUuid: expectedUuid,
    });

    expect(fake.checkpoint.watermarkMigrationProgress).toEqual(
      expect.objectContaining({ state: "running", scanned: 1 })
    );
    expect(fake.checkpoint.watermarkMigrationCompletedAt).toBeNull();
    expect(fake.checkpoint.watermarkMigrationReceipt).toBeNull();
  });

  it.each([
    ["equal", "ready"],
    ["conflict", "conflict"],
  ] as const)(
    "handles a concurrent %s immutable completion as %s",
    async (concurrentCompletion, outcome) => {
      const fake = createFakeMongo({ rows: [], concurrentCompletion });
      fake.install();
      const expectedUuid = fake.uuidByName
        .get(fake.names.requestListItem)!
        .toString("hex");
      await provisionRequestsProjectionInfrastructure({
        expectedCollectionUuid: expectedUuid,
        approvedCardinalityCap: 10_000_000,
      });

      const migration = migrateRequestsProjectionWatermarks({
        expectedCollectionUuid: expectedUuid,
        approvedCardinalityCap: 10_000_000,
        monotonicNow: () => 0,
        sleep: async () => undefined,
      });
      if (outcome === "ready") {
        await expect(migration).resolves.toEqual(
          expect.objectContaining({
            status: "ready",
            collectionUuid: expectedUuid,
          })
        );
        const persistedReceipt = fake.checkpoint.watermarkMigrationReceipt;
        expect(persistedReceipt).toEqual(
          expect.objectContaining({
            completedAt: fake.checkpoint.watermarkMigrationCompletedAt,
          })
        );
        expect(
          fake.updateOneCalls.filter(
            call =>
              call.name === fake.names.checkpoint &&
              (call.update.$set as Record<string, unknown> | undefined)
                ?.watermarkMigrationReceipt
          )
        ).toEqual([]);
      } else {
        await expect(migration).rejects.toThrow(/completion|conflict/i);
      }
    }
  );
});
