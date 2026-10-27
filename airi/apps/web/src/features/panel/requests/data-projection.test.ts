import mongoose from "mongoose";

const mockConnectDB = jest.fn();
const mockReadCheckpoint = jest.fn();
const mockReadActivationDecision = jest.fn();
const mockVisibilityGate = jest.fn();
const mockProjectionFind = jest.fn();
const mockProjectionSort = jest.fn();
const mockProjectionSkip = jest.fn();
const mockProjectionLimit = jest.fn();
const mockProjectionToArray = jest.fn();
const mockProjectionAggregate = jest.fn();
const mockCountDocuments = jest.fn();
const mockDistinct = jest.fn();
const mockFindOne = jest.fn();
const mockBulkWrite = jest.fn();
const mockMessageAggregate = jest.fn();
const mockMessageFind = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/requests-projection/checkpoint", () => ({
  readRequestsProjectionCheckpoint: (...args: unknown[]) =>
    mockReadCheckpoint(...args),
}));

jest.mock("@/lib/requests-projection/activation", () => ({
  readRequestsProjectionActivationDecision: (...args: unknown[]) =>
    mockReadActivationDecision(...args),
}));

jest.mock("@/lib/limits/company-limits", () => ({
  getCompanyConversationVisibilityGate: (...args: unknown[]) =>
    mockVisibilityGate(...args),
  toPublicLimitPayload: (value: unknown) => value,
}));

jest.mock("@/models/request-list-item", () => ({
  RequestListItem: {
    collection: {
      find: (...args: unknown[]) => mockProjectionFind(...args),
      aggregate: (...args: unknown[]) => mockProjectionAggregate(...args),
      countDocuments: (...args: unknown[]) => mockCountDocuments(...args),
      distinct: (...args: unknown[]) => mockDistinct(...args),
      findOne: (...args: unknown[]) => mockFindOne(...args),
      bulkWrite: (...args: unknown[]) => mockBulkWrite(...args),
    },
  },
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    aggregate: (...args: unknown[]) => mockMessageAggregate(...args),
    find: (...args: unknown[]) => mockMessageFind(...args),
  },
}));

import { assertRequestListItemPayload } from "@/lib/requests-projection/contract";
import { cache } from "@/lib/cache";
import { RequestListItem } from "@/models/request-list-item";

import { formatConversationToRequest } from "./formatting";
import {
  assertRequestsProjectionReady,
  buildProjectionListQuery,
  getRequestsData,
  mapRequestProjectionRow,
  planGatePayload,
} from "./data-projection";

type ProjectionRow = Parameters<typeof mapRequestProjectionRow>[0];

const id = new mongoose.Types.ObjectId("65f000000000000000000001");
const date = new Date("2026-08-19T10:00:00.000Z");
const sourceWatermark = new mongoose.mongo.Timestamp({ t: 12, i: 3 });
const readStateWatermark = new mongoose.mongo.Timestamp({ t: 11, i: 9 });
const workspaceId = "123e4567-e89b-12d3-a456-426614174000";

function projectionRow(overrides: Partial<ProjectionRow> = {}): ProjectionRow {
  return {
    _id: id,
    workspaceId: "workspace-1",
    schemaVersion: 1,
    projectedAt: date,
    deletedAt: null,
    channel: "whatsapp",
    status: "open",
    category: "Support",
    internalLabels: ["priority"],
    rename: "Customer",
    createdAt: date,
    sortAt: date,
    displayAt: date,
    recentMessages: [
      {
        _id: "message-1",
        text: "Hello",
        date,
        direction: "inbound",
      },
    ],
    unreadGeneration: mongoose.mongo.Long.ONE,
    hasAiriReply: false,
    isBestPractice: false,
    slaDueAt: date,
    profileSearchText: "customer",
    projection: {
      status: "ready",
      generation: mongoose.mongo.Long.fromString("9223372036854775807"),
      fence: mongoose.mongo.Long.ONE,
      sourceWatermark,
      readStateWatermark,
    },
    ...overrides,
  };
}

function corruptProjectionGeneration(): mongoose.mongo.Long {
  const generation = mongoose.mongo.Long.fromNumber(17);
  Object.defineProperty(generation, "toString", {
    value: () => "01",
  });
  return generation;
}

function indexedProjectionRow(
  index: number,
  overrides: Partial<ProjectionRow> = {}
): ProjectionRow {
  const rowId = new mongoose.Types.ObjectId(
    index.toString(16).padStart(24, "0")
  );
  return projectionRow({
    _id: rowId,
    workspaceId,
    channel: undefined,
    projection: {
      ...projectionRow().projection,
      generation: mongoose.mongo.Long.fromNumber(index),
    },
    ...overrides,
  });
}

function sourceSupabaseClient(options: { fail?: boolean } = {}) {
  return {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        in: jest.fn(() => ({
          eq: jest.fn(async () => {
            if (options.fail) throw new Error("source_enrichment_failed");
            return { data: [], error: null };
          }),
        })),
      })),
    })),
  } as never;
}

function configureNormalizedOwner(rows: ProjectionRow[] = []) {
  mockConnectDB.mockResolvedValue(undefined);
  mockReadCheckpoint.mockResolvedValue({ state: "ready" });
  mockReadActivationDecision.mockResolvedValue({
    listWatermarkMode: "strict_persisted",
    capability: "ready",
  });
  mockVisibilityGate.mockResolvedValue(null);
  mockProjectionToArray.mockResolvedValue(rows);
  mockProjectionLimit.mockImplementation(() => ({
    toArray: mockProjectionToArray,
  }));
  mockProjectionSkip.mockImplementation(() => ({ limit: mockProjectionLimit }));
  mockProjectionSort.mockImplementation(() => ({ skip: mockProjectionSkip }));
  mockProjectionFind.mockImplementation(() => ({ sort: mockProjectionSort }));
  mockCountDocuments.mockResolvedValue(rows.length);
  mockDistinct.mockResolvedValue([]);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("Requests message search execution budget", () => {
  const searchParams = {
    searchType: "message_within_chat",
    searchQuery: "hello.*",
  };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const fallback = {
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    configureNormalizedOwner();
    mockMessageAggregate.mockReset();
    mockMessageFind.mockReset().mockReturnValue(fallback);
    fallback.exec.mockReset().mockResolvedValue([{ conversation: id }]);
    jest.spyOn(cache, "get").mockResolvedValue(null);
    jest.spyOn(cache, "set").mockResolvedValue(undefined);
    jest.spyOn(Date, "now").mockReturnValue(1_000_000);
  });
  afterEach(() => jest.restoreAllMocks());

  it("bounds Search and keeps successful empty results empty without regex fallback", async () => {
    mockMessageAggregate.mockReturnValue({ exec: async () => [] });
    const result = await getRequestsData(workspaceId, searchParams);
    expect(mockMessageAggregate.mock.calls[0][1]).toMatchObject({
      maxTimeMS: 5_000,
      signal: expect.any(AbortSignal),
    });
    expect(mockMessageFind).not.toHaveBeenCalled();
    expect(mockProjectionFind.mock.calls[0][0]._id).toEqual({ $in: [] });
    expect(result.data).toEqual([]);
  });

  it("gives escaped regex only the Search budget remainder and keeps projection IDs deduplicated", async () => {
    mockMessageAggregate.mockReturnValue({
      exec: async () => {
        jest.mocked(Date.now).mockReturnValue(1_002_000);
        throw new Error("Search index unavailable");
      },
    });
    fallback.exec.mockResolvedValue([
      { conversation: id },
      { conversation: id },
    ]);
    await getRequestsData(workspaceId, searchParams);
    expect(mockMessageFind).toHaveBeenCalledWith(
      { workspaceId, text: { $regex: /hello\.\*/i } },
      undefined,
      {
        maxTimeMS: 3_000,
        signal: mockMessageAggregate.mock.calls[0][1].signal,
      }
    );
    expect(fallback.select).toHaveBeenCalledWith("conversation");
    expect(fallback.limit).toHaveBeenCalledWith(500);
    expect(mockProjectionFind.mock.calls[0][0]._id.$in.map(String)).toEqual([
      id.toHexString(),
    ]);
  });

  it.each([
    { name: "AbortError", metadata: { name: "AbortError" } },
    { name: "TimeoutError", metadata: { name: "TimeoutError" } },
    { name: "Mongo code 50", metadata: { code: 50 } },
    { name: "MaxTimeMSExpired", metadata: { codeName: "MaxTimeMSExpired" } },
    { name: "ExceededTimeLimit", metadata: { codeName: "ExceededTimeLimit" } },
    {
      name: "MongoOperationTimeoutError",
      metadata: { name: "MongoOperationTimeoutError" },
    },
    {
      name: "MongoNetworkTimeoutError",
      metadata: { name: "MongoNetworkTimeoutError" },
    },
  ])(
    "does not retry $name from Search as an expensive regex",
    async ({ metadata }) => {
      const error = Object.assign(new Error("deadline"), metadata);
      mockMessageAggregate.mockReturnValue({
        exec: async () => {
          throw error;
        },
      });
      await expect(getRequestsData(workspaceId, searchParams)).rejects.toBe(
        error
      );
      expect(mockMessageFind).not.toHaveBeenCalled();
      expect(mockProjectionFind).not.toHaveBeenCalled();
    }
  );

  it("does not grant fallback a fresh budget after Search consumed the deadline", async () => {
    mockMessageAggregate.mockReturnValue({
      exec: async () => {
        jest.mocked(Date.now).mockReturnValue(1_005_000);
        throw new Error("Search index unavailable");
      },
    });
    await expect(
      getRequestsData(workspaceId, searchParams)
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(mockMessageFind).not.toHaveBeenCalled();
    expect(mockProjectionFind).not.toHaveBeenCalled();
  });

  it("stops waiting for Search when its shared deadline aborts without starting fallback", async () => {
    const pending = deferred<unknown[]>();
    const controller = new AbortController();
    const reason = new DOMException("deadline", "TimeoutError");
    jest.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    mockMessageAggregate.mockReturnValue({ exec: () => pending.promise });
    let settled = false;
    const result = getRequestsData(workspaceId, searchParams).then(
      value => {
        settled = true;
        return { value };
      },
      error => {
        settled = true;
        return { error };
      }
    );
    try {
      await flush();
      controller.abort(reason);
      await flush();
      expect(settled).toBe(true);
      expect(await result).toEqual({ error: reason });
      expect(mockMessageFind).not.toHaveBeenCalled();
      expect(mockProjectionFind).not.toHaveBeenCalled();
    } finally {
      pending.resolve([]);
      await result;
    }
  });

  it("propagates fallback timeout instead of returning a misleading empty page", async () => {
    const timeout = Object.assign(new Error("regex deadline"), { code: 50 });
    mockMessageAggregate.mockReturnValue({
      exec: async () => {
        throw new Error("Search unavailable");
      },
    });
    fallback.exec.mockRejectedValue(timeout);
    await expect(getRequestsData(workspaceId, searchParams)).rejects.toBe(
      timeout
    );
    expect(mockProjectionFind).not.toHaveBeenCalled();
  });
});

describe("projection-only Requests serving", () => {
  it("builds one indexed list query without legacy lookup stages", () => {
    const query = buildProjectionListQuery({
      workspaceId: "workspace-1",
      channel: "whatsapp",
      status: "open",
      category: "Support",
      internalLabel: "priority",
      unread: true,
      airiReplied: true,
      page: 1,
      limit: 25,
    });

    expect(query.filter).toEqual({
      workspaceId: "workspace-1",
      deletedAt: null,
      "projection.status": "ready",
      channel: "whatsapp",
      status: "open",
      category: "Support",
      internalLabels: "priority",
      unreadGeneration: { $type: "long" },
      hasAiriReply: true,
    });
    expect(query.sort).toEqual({ sortAt: -1, _id: -1 });
    expect(query.skip).toBe(0);
    expect(query.limit).toBe(25);
    expect(JSON.stringify(query)).not.toContain("$lookup");
  });

  it("matches phone digits and escaped profile text for the matching search modes", () => {
    const phone = buildProjectionListQuery({
      workspaceId: "workspace-1",
      searchType: "phone_number",
      searchQuery: "+7 (701) 000",
    });
    expect(phone.filter.phoneDigits).toEqual({ $regex: /7701000/ });

    for (const searchQuery of ["+7 1", "abc"]) {
      expect(
        buildProjectionListQuery({
          workspaceId: "workspace-1",
          searchType: "phone_number",
          searchQuery,
        }).filter
      ).not.toHaveProperty("phoneDigits");
    }

    const profile = buildProjectionListQuery({
      workspaceId: "workspace-1",
      searchType: "profile_name",
      searchQuery: " a.b ",
    });
    expect(profile.filter.profileSearchText).toEqual({ $regex: /a\.b/i });
    expect(profile.filter).not.toHaveProperty("phoneDigits");
  });

  it("maps one bounded projection row to the existing Requests wire shape", () => {
    const row = mapRequestProjectionRow(projectionRow(), {
      watermarkMode: "strict_persisted",
    });

    expect(row._id).toBe(id.toHexString());
    expect(row).toMatchObject({
      projectionGeneration: "9223372036854775807",
      readStateWatermark: "0000000b00000009",
      lastMessageText: "Hello",
    });
    for (const field of ["sourceWatermark", "lastMessageId", "projectedAt"]) {
      expect(row).not.toHaveProperty(field);
    }
    expect(row.internal_labels).toEqual(["priority"]);
    expect(row.is_read_by_manager).toBe(false);
    expect(row.messages?.[0]).toMatchObject({ text: "Hello" });
    expect(row.messages).toHaveLength(1);
  });

  it("maps the maximum signed BSON Long generation as exact decimal", () => {
    expect(
      mapRequestProjectionRow(projectionRow(), {
        watermarkMode: "strict_persisted",
      }).projectionGeneration
    ).toBe("9223372036854775807");
  });

  it.each([
    ["zero", mongoose.mongo.Long.ZERO],
    ["negative", mongoose.mongo.Long.NEG_ONE],
    ["non-canonical", corruptProjectionGeneration()],
  ])("fails closed for a %s BSON Long generation", (_label, generation) => {
    expect(() =>
      mapRequestProjectionRow(
        projectionRow({
          projection: {
            ...projectionRow().projection,
            generation,
          },
        }),
        { watermarkMode: "strict_persisted" }
      )
    ).toThrow(/projection generation/i);
  });

  it("reconstructs the existing Instagram thread wire shape from the bounded preview", () => {
    const raw = mapRequestProjectionRow(
      projectionRow({
        channel: "instagram",
        recentMessages: [],
        instagram: {
          commentTimestamp: date,
          isReply: true,
          isHidden: false,
          likeCount: 3,
          mediaType: "IMAGE",
          mediaTimestamp: date,
          mediaCaption: "Post",
          mediaPreviewUrl: "https://example.com/preview.jpg",
          mediaPermalink: "https://instagram.com/p/example",
          mediaShortcode: "example",
          mediaAuthorUsername: "brand",
        },
      }),
      { watermarkMode: "strict_persisted" }
    );

    const formatted = formatConversationToRequest(raw);
    expect(formatted).toMatchObject({
      id: id.toHexString(),
      projectionGeneration: "9223372036854775807",
      readStateWatermark: "0000000b00000009",
      dateValue: date.toISOString(),
    });
    expect(formatted).not.toHaveProperty("_id");
    expect(formatted.isInstagramCommentThread).toBe(true);
    expect(formatted.instagramMeta).toEqual({
      isReply: true,
      isHidden: false,
      likeCount: 3,
      mediaType: "IMAGE",
      mediaProductType: undefined,
      mediaCaption: "Post",
      mediaPreviewUrl: "https://example.com/preview.jpg",
      mediaAuthorUsername: "brand",
    });
  });

  it("emits null instead of placeholder text for missing summary, category and action", () => {
    const formatted = formatConversationToRequest(
      mapRequestProjectionRow(projectionRow(), {
        watermarkMode: "strict_persisted",
      })
    );

    expect(formatted).toMatchObject({
      request: null,
      category: null,
      action: null,
      lastMessageText: "Hello",
      airiLastReplied: false,
    });

    const email = formatConversationToRequest(
      mapRequestProjectionRow(
        projectionRow({
          channel: "email",
          subject: "Order 42",
          classification: { summary: "Refund", category: "Billing" },
        }),
        { watermarkMode: "strict_persisted" }
      )
    );
    expect(email).toMatchObject({
      request: "Order 42",
      category: "Billing",
      action: null,
    });
  });

  it.each([
    [new mongoose.mongo.Timestamp({ t: 0, i: 0 }), "0000000000000000"],
    [new mongoose.mongo.Timestamp({ t: 12, i: 3 }), "0000000c00000003"],
    [
      new mongoose.mongo.Timestamp({ t: 0x80000000, i: 0xffffffff }),
      "80000000ffffffff",
    ],
    [
      new mongoose.mongo.Timestamp({ t: 0xffffffff, i: 0xffffffff }),
      "ffffffffffffffff",
    ],
  ])("encodes unsigned BSON Timestamp words as %s", (watermark, expected) => {
    const row = projectionRow({
      projection: {
        ...projectionRow().projection,
        readStateWatermark: watermark,
      },
    });

    expect(
      mapRequestProjectionRow(row, { watermarkMode: "strict_persisted" })
    ).toMatchObject({ readStateWatermark: expected });
  });

  it("fails strict mapping when readStateWatermark is absent or not a native Timestamp", () => {
    for (const invalid of [
      undefined,
      "0000000000000000",
      0,
      mongoose.mongo.Long.ZERO,
    ]) {
      const projection = {
        ...projectionRow().projection,
        readStateWatermark: invalid,
      };
      if (invalid === undefined) delete projection.readStateWatermark;

      expect(() =>
        mapRequestProjectionRow(projectionRow({ projection }), {
          watermarkMode: "strict_persisted",
        })
      ).toThrow("requests_projection_watermark_not_ready");
    }
  });

  it("maps an absent legacy read-state watermark to zero without persistence or mutation", () => {
    const findOne = jest.spyOn(RequestListItem.collection, "findOne");

    try {
      const projection = { ...projectionRow().projection };
      delete projection.readStateWatermark;
      const row = projectionRow({ projection });
      const projectionBefore = { ...projection };

      expect(
        mapRequestProjectionRow(row, {
          watermarkMode: "pre_migration_legacy_list",
        })
      ).toMatchObject({ readStateWatermark: "0000000000000000" });
      expect(projection).toEqual(projectionBefore);
      expect(() => assertRequestListItemPayload(row as never)).toThrow(
        /readStateWatermark.*BSON Timestamp/i
      );
      expect(findOne).not.toHaveBeenCalled();
    } finally {
      findOne.mockRestore();
    }
  });

  it("fails closed when legacy compatibility sees a present invalid readStateWatermark", () => {
    for (const invalid of [
      null,
      "0000000000000000",
      0,
      mongoose.mongo.Long.ZERO,
    ]) {
      const projection = {
        ...projectionRow().projection,
        readStateWatermark: invalid,
      };

      expect(() =>
        mapRequestProjectionRow(projectionRow({ projection }), {
          watermarkMode: "pre_migration_legacy_list",
        })
      ).toThrow("requests_projection_watermark_not_ready");
    }
  });

  it("fails closed until the singleton checkpoint is ready", () => {
    expect(() => assertRequestsProjectionReady(null)).toThrow(
      "requests_projection_not_ready"
    );
    expect(() =>
      assertRequestsProjectionReady({ state: "backfilling" })
    ).toThrow("requests_projection_not_ready");
    expect(() =>
      assertRequestsProjectionReady({ state: "ready" })
    ).not.toThrow();
  });
});

describe("Requests projection metadata cache concurrency", () => {
  const checkpointKey = "requests_projection_checkpoint";
  const activationKey = "requests_projection_activation_decision";
  const readyCheckpoint = { state: "ready" };
  const readyActivation = {
    listWatermarkMode: "strict_persisted",
    capability: "ready",
  };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));

  beforeEach(() => {
    jest.clearAllMocks();
    configureNormalizedOwner();
    jest.replaceProperty(process, "env", {
      ...process.env,
      NODE_ENV: "production",
    });
    jest.spyOn(cache, "get").mockResolvedValue(null);
    jest.spyOn(cache, "set").mockResolvedValue(undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it("shares checkpoint and activation work across simultaneous ordinary cache misses", async () => {
    const checkpoint = deferred<typeof readyCheckpoint>();
    const activation = deferred<typeof readyActivation>();
    mockReadCheckpoint.mockReturnValue(checkpoint.promise);
    mockReadActivationDecision.mockReturnValue(activation.promise);
    const requests = [
      getRequestsData(workspaceId, {}),
      getRequestsData(workspaceId, {}),
    ];

    try {
      await flush();
      expect(mockReadCheckpoint).toHaveBeenCalledTimes(1);
      expect(mockReadActivationDecision).toHaveBeenCalledTimes(1);
      expect(mockProjectionFind).not.toHaveBeenCalled();
      checkpoint.resolve(readyCheckpoint);
      await flush();
      expect(mockReadActivationDecision).toHaveBeenCalledTimes(1);
      expect(mockProjectionFind).not.toHaveBeenCalled();
      activation.resolve(readyActivation);
      const responses = await Promise.all(requests);
      expect(responses.map(response => response.data)).toEqual([[], []]);
      expect(cache.set).toHaveBeenCalledWith(
        checkpointKey,
        readyCheckpoint,
        60
      );
      expect(cache.set).toHaveBeenCalledWith(
        activationKey,
        readyActivation,
        60
      );
      expect(cache.set).toHaveBeenCalledTimes(2);
    } finally {
      checkpoint.resolve(readyCheckpoint);
      activation.resolve(readyActivation);
      await Promise.allSettled(requests);
    }
  });

  it("rejects all waiters on activation failure and retries the next request", async () => {
    const activation = deferred<typeof readyActivation>();
    const error = new Error("physical_evidence_failed");
    mockReadActivationDecision.mockReturnValueOnce(activation.promise);
    const requests = Promise.allSettled([
      getRequestsData(workspaceId, {}),
      getRequestsData(workspaceId, {}),
    ]);
    try {
      await flush();
      activation.reject(error);
      expect(await requests).toEqual([
        { status: "rejected", reason: error },
        { status: "rejected", reason: error },
      ]);
      expect(mockProjectionFind).not.toHaveBeenCalled();
      await expect(getRequestsData(workspaceId, {})).resolves.toMatchObject({
        data: [],
      });
      expect(mockReadActivationDecision).toHaveBeenCalledTimes(2);
    } finally {
      activation.reject(error);
      await requests;
    }
  });

  it("keeps explicit bypass fresh while an ordinary checkpoint read is pending", async () => {
    const checkpoint = deferred<typeof readyCheckpoint>();
    mockReadCheckpoint.mockReturnValueOnce(checkpoint.promise);
    const ordinary = getRequestsData(workspaceId, {});
    try {
      await flush();
      const cacheReadsBeforeBypass = jest.mocked(cache.get).mock.calls.length;
      const cacheWritesBeforeBypass = jest.mocked(cache.set).mock.calls.length;
      await expect(
        getRequestsData(workspaceId, {}, undefined, { bypassCache: true })
      ).resolves.toMatchObject({ data: [] });
      expect(mockReadCheckpoint).toHaveBeenCalledTimes(2);
      expect(cache.get).toHaveBeenCalledTimes(cacheReadsBeforeBypass);
      expect(cache.set).toHaveBeenCalledTimes(cacheWritesBeforeBypass);
    } finally {
      checkpoint.resolve(readyCheckpoint);
      await ordinary;
    }
  });

  it("releases completed work when cache reads and writes are unavailable", async () => {
    jest.mocked(cache.get).mockRejectedValue(new Error("cache_unavailable"));
    jest.mocked(cache.set).mockRejectedValue(new Error("cache_unavailable"));
    await expect(getRequestsData(workspaceId, {})).resolves.toMatchObject({
      data: [],
    });
    await expect(getRequestsData(workspaceId, {})).resolves.toMatchObject({
      data: [],
    });
    expect(mockReadCheckpoint).toHaveBeenCalledTimes(2);
    expect(mockReadActivationDecision).toHaveBeenCalledTimes(2);
  });

  it("uses cached metadata without a live readiness read", async () => {
    jest
      .mocked(cache.get)
      .mockResolvedValueOnce(readyCheckpoint)
      .mockResolvedValueOnce(readyActivation);
    await expect(getRequestsData(workspaceId, {})).resolves.toMatchObject({
      data: [],
    });
    expect(mockReadCheckpoint).not.toHaveBeenCalled();
    expect(mockReadActivationDecision).not.toHaveBeenCalled();
  });

  it("preserves direct uncached reads in the test environment", async () => {
    jest.replaceProperty(process, "env", { ...process.env, NODE_ENV: "test" });
    await Promise.all([
      getRequestsData(workspaceId, {}),
      getRequestsData(workspaceId, {}),
    ]);
    expect(mockReadCheckpoint).toHaveBeenCalledTimes(2);
    expect(mockReadActivationDecision).toHaveBeenCalledTimes(2);
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it.each(["hit", "miss"] as const)(
    "shares remote metadata reads across simultaneous cache %s requests",
    async outcome => {
      const checkpoint = deferred<typeof readyCheckpoint | null>();
      const activation = deferred<typeof readyActivation | null>();
      jest
        .mocked(cache.get)
        .mockImplementation(key =>
          key === checkpointKey ? checkpoint.promise : activation.promise
        );
      const requests = [
        getRequestsData(workspaceId, {}),
        getRequestsData(workspaceId, {}),
      ];

      try {
        await flush();
        expect(jest.mocked(cache.get).mock.calls.map(([key]) => key)).toEqual([
          checkpointKey,
          activationKey,
        ]);
        expect(mockReadCheckpoint).not.toHaveBeenCalled();
        expect(mockReadActivationDecision).not.toHaveBeenCalled();
        expect(mockProjectionFind).not.toHaveBeenCalled();
        checkpoint.resolve(outcome === "hit" ? readyCheckpoint : null);
        activation.resolve(outcome === "hit" ? readyActivation : null);
        expect(
          (await Promise.all(requests)).map(response => response.data)
        ).toEqual([[], []]);
        expect(mockReadCheckpoint).toHaveBeenCalledTimes(
          outcome === "hit" ? 0 : 1
        );
        expect(mockReadActivationDecision).toHaveBeenCalledTimes(
          outcome === "hit" ? 0 : 1
        );
        await expect(getRequestsData(workspaceId, {})).resolves.toMatchObject({
          data: [],
        });
        expect(cache.get).toHaveBeenCalledTimes(4);
      } finally {
        checkpoint.resolve(readyCheckpoint);
        activation.resolve(readyActivation);
        await Promise.allSettled(requests);
      }
    }
  );
});

describe("Requests list pipeline ordering", () => {
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));

  beforeEach(() => {
    jest.clearAllMocks();
    configureNormalizedOwner();
    jest.spyOn(cache, "get").mockResolvedValue(null);
    jest.spyOn(cache, "set").mockResolvedValue(undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it("keeps count-only requests free of row and source reads while awaiting dimensions and count", async () => {
    configureNormalizedOwner([
      indexedProjectionRow(1, { channel: "whatsapp", sourceId: "source-1" }),
    ]);
    const count = deferred<number>();
    const dimensions = deferred<string[]>();
    mockCountDocuments.mockReturnValueOnce(count.promise);
    mockDistinct.mockReturnValue(dimensions.promise);
    const supabase = sourceSupabaseClient();
    let settled = false;
    const response = getRequestsData(workspaceId, { limit: 2 }, supabase, {
      countOnly: true,
      includeChannels: true,
    }).then(result => {
      settled = true;
      return result;
    });

    try {
      await flush();
      expect(mockProjectionFind).not.toHaveBeenCalled();
      expect((supabase as { from: jest.Mock }).from).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      count.resolve(5);
      await flush();
      expect(settled).toBe(false);
      dimensions.resolve([]);
      await expect(response).resolves.toMatchObject({
        data: [],
        pagination: { totalCount: 5, totalPages: 3, hasNextPage: true },
        availableChannels: [],
        availableCategories: [],
      });
    } finally {
      count.resolve(5);
      dimensions.resolve([]);
      await Promise.allSettled([response]);
    }
  });

  it("starts both metadata reads only after Mongo connects and waits for both before row access", async () => {
    const connection = deferred<void>();
    const checkpoint = deferred<{ state: string }>();
    const activation = deferred<{
      listWatermarkMode: string;
      capability: string;
    }>();
    mockConnectDB.mockReturnValueOnce(connection.promise);
    mockReadCheckpoint.mockReturnValueOnce(checkpoint.promise);
    mockReadActivationDecision.mockReturnValueOnce(activation.promise);
    const response = getRequestsData(workspaceId, {});

    try {
      await flush();
      expect(mockReadCheckpoint).not.toHaveBeenCalled();
      expect(mockReadActivationDecision).not.toHaveBeenCalled();
      connection.resolve();
      await flush();
      expect(mockReadCheckpoint).toHaveBeenCalledTimes(1);
      expect(mockReadActivationDecision).toHaveBeenCalledTimes(1);
      expect(mockProjectionFind).not.toHaveBeenCalled();
      activation.resolve({
        listWatermarkMode: "strict_persisted",
        capability: "ready",
      });
      await flush();
      expect(mockProjectionFind).not.toHaveBeenCalled();
      checkpoint.resolve({ state: "ready" });
      await expect(response).resolves.toMatchObject({ data: [] });
    } finally {
      connection.resolve();
      checkpoint.resolve({ state: "ready" });
      activation.resolve({
        listWatermarkMode: "strict_persisted",
        capability: "ready",
      });
      await Promise.allSettled([response]);
    }
  });

  it.each(["read_failure", "not_ready"] as const)(
    "keeps checkpoint %s authoritative when overlapping activation has already failed",
    async outcome => {
      const checkpoint = deferred<{ state: string }>();
      const checkpointError = new Error("checkpoint_read_failed");
      mockReadCheckpoint.mockReturnValueOnce(checkpoint.promise);
      mockReadActivationDecision.mockRejectedValueOnce(
        new Error("activation_read_failed")
      );
      const response = Promise.allSettled([getRequestsData(workspaceId, {})]);

      try {
        await flush();
        expect(mockReadActivationDecision).toHaveBeenCalledTimes(1);
        expect(mockProjectionFind).not.toHaveBeenCalled();
        if (outcome === "read_failure") checkpoint.reject(checkpointError);
        else checkpoint.resolve({ state: "backfilling" });
        const [result] = await response;
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") {
          expect(result.reason.message).toBe(
            outcome === "read_failure"
              ? "checkpoint_read_failed"
              : "requests_projection_not_ready"
          );
        }
        expect(mockProjectionFind).not.toHaveBeenCalled();
        expect(mockCountDocuments).not.toHaveBeenCalled();
        expect(mockDistinct).not.toHaveBeenCalled();
      } finally {
        checkpoint.resolve({ state: "ready" });
        await response;
      }
    }
  );

  it.each([
    { exactCount: true, expectedCount: 5, expectedFetchLimit: 1 },
    { exactCount: false, expectedCount: 2, expectedFetchLimit: 2 },
  ])(
    "enriches the final page while dimensions and exact-count=$exactCount work remain pending",
    async ({ exactCount, expectedCount, expectedFetchLimit }) => {
      const first = indexedProjectionRow(1, {
        channel: "whatsapp",
        sourceId: "source-1",
      });
      const probe = indexedProjectionRow(2, {
        channel: "whatsapp",
        sourceId: "probe-source",
      });
      configureNormalizedOwner(exactCount ? [first] : [first, probe]);
      const count = deferred<number>();
      const channels = deferred<string[]>();
      const categories = deferred<string[]>();
      mockCountDocuments.mockReturnValueOnce(count.promise);
      mockDistinct.mockImplementation(field =>
        field === "channel" ? channels.promise : categories.promise
      );
      const source = deferred<{
        data: Array<{ id: string; credentials: unknown }>;
        error: null;
      }>();
      const selectSources = jest.fn(() => source.promise);
      const sourceIds = jest.fn(() => ({ eq: selectSources }));
      const supabase = {
        from: jest.fn(() => ({ select: jest.fn(() => ({ in: sourceIds })) })),
      };
      let settled = false;
      // The unread view is the one list read that counts exactly.
      const response = getRequestsData(
        workspaceId,
        { limit: 1, unread: exactCount },
        supabase as never,
        { includeChannels: true }
      ).then(result => {
        settled = true;
        return result;
      });

      try {
        await flush();
        expect(sourceIds).toHaveBeenCalledWith("id", ["source-1"]);
        expect(selectSources).toHaveBeenCalledWith("type", "whatsapp");
        expect(mockProjectionLimit).toHaveBeenCalledWith(expectedFetchLimit);
        expect(mockCountDocuments).toHaveBeenCalledTimes(exactCount ? 1 : 0);
        expect(settled).toBe(false);
        source.resolve({
          data: [
            { id: "source-1", credentials: { phone_number_id: "phone-1" } },
          ],
          error: null,
        });
        await flush();
        expect(settled).toBe(false);
        count.resolve(5);
        channels.resolve(["whatsapp"]);
        categories.resolve(["Support"]);
        const result = await response;
        expect(result.data.map(row => row._id)).toEqual([
          first._id.toHexString(),
        ]);
        expect(result.data[0].sourceInfo).toEqual({
          phone_number_id: "phone-1",
        });
        expect(result.pagination).toEqual({
          page: 1,
          limit: 1,
          totalCount: expectedCount,
          totalPages: expectedCount,
          hasNextPage: true,
          hasPrevPage: false,
        });
        expect(result.availableChannels).toEqual(["whatsapp"]);
        expect(result.availableCategories).toEqual(["Support"]);
      } finally {
        count.resolve(5);
        channels.resolve([]);
        categories.resolve([]);
        source.resolve({ data: [], error: null });
        await Promise.allSettled([response]);
      }
    }
  );
});

describe("Requests WhatsApp source cache writes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(cache, "get").mockResolvedValue(null);
    jest.spyOn(cache, "set").mockResolvedValue(undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it("reuses cached absence for an existing source without adding public source metadata", async () => {
    configureNormalizedOwner([
      indexedProjectionRow(1, {
        channel: "whatsapp",
        sourceId: "empty-source",
      }),
    ]);
    const stored = new Map<string, unknown>();
    jest
      .mocked(cache.get)
      .mockImplementation(async key => stored.get(key) ?? null);
    jest.mocked(cache.set).mockImplementation(async (key, value) => {
      stored.set(key, value);
    });
    const selectSources = jest.fn().mockResolvedValue({
      data: [{ id: "empty-source", credentials: {} }],
      error: null,
    });
    const supabase = {
      from: jest.fn(() => ({
        select: jest.fn(() => ({ in: jest.fn(() => ({ eq: selectSources })) })),
      })),
    };

    const first = await getRequestsData(workspaceId, {}, supabase as never);
    const second = await getRequestsData(workspaceId, {}, supabase as never);

    expect(first.data[0]).not.toHaveProperty("sourceInfo");
    expect(second.data[0]).not.toHaveProperty("sourceInfo");
    expect(selectSources).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledWith(
      "icecore:whatsapp_source_info:empty-source",
      {},
      600
    );
  });

  it("keeps retrying a source omitted by the provider rather than caching its absence", async () => {
    configureNormalizedOwner([
      indexedProjectionRow(1, {
        channel: "whatsapp",
        sourceId: "missing-source",
      }),
    ]);
    const supabase = sourceSupabaseClient();
    const first = await getRequestsData(workspaceId, {}, supabase);
    const second = await getRequestsData(workspaceId, {}, supabase);

    expect(first.data[0]).not.toHaveProperty("sourceInfo");
    expect(second.data[0]).not.toHaveProperty("sourceInfo");
    expect((supabase as { from: jest.Mock }).from).toHaveBeenCalledTimes(2);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it.each([
    { outcome: "succeeds", rejectSecondWrite: false },
    { outcome: "fails", rejectSecondWrite: true },
  ])(
    "starts all missing-source writes together and waits for them when one write $outcome",
    async ({ rejectSecondWrite }) => {
      const sourceIds = ["source-1", "source-2", "source-1", "source-3"];
      configureNormalizedOwner(
        sourceIds.map((sourceId, index) =>
          indexedProjectionRow(index + 1, { channel: "whatsapp", sourceId })
        )
      );
      const firstInfo = {
        display_phone_number: "+77010000001",
        phone_number_id: "phone-1",
      };
      const secondInfo = { phone_number_id: "phone-2" };
      const selectSources = jest.fn().mockResolvedValue({
        data: [
          {
            id: "source-1",
            credentials: { ...firstInfo, access_token: "server-only-secret" },
          },
          { id: "source-2", credentials: secondInfo },
          { id: "source-3", credentials: {} },
        ],
        error: null,
      });
      const sourceIdFilter = jest.fn(() => ({ eq: selectSources }));
      const sourceFields = jest.fn(() => ({ in: sourceIdFilter }));
      const sourceTable = jest.fn(() => ({ select: sourceFields }));
      const writes = [deferred<void>(), deferred<void>(), deferred<void>()];
      jest
        .mocked(cache.set)
        .mockImplementationOnce(() => writes[0].promise)
        .mockImplementationOnce(() => writes[1].promise)
        .mockImplementationOnce(() => writes[2].promise);
      let settled = false;
      const response = getRequestsData(workspaceId, {}, {
        from: sourceTable,
      } as never).then(result => {
        settled = true;
        return result;
      });

      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(cache.set).toHaveBeenCalledTimes(3);
        expect(settled).toBe(false);
        expect(sourceTable).toHaveBeenCalledTimes(1);
        expect(sourceTable).toHaveBeenCalledWith("sources");
        expect(sourceFields).toHaveBeenCalledWith("id, credentials");
        expect(sourceIdFilter).toHaveBeenCalledTimes(1);
        expect(sourceIdFilter).toHaveBeenCalledWith("id", [
          "source-1",
          "source-2",
          "source-3",
        ]);
        expect(selectSources).toHaveBeenCalledWith("type", "whatsapp");
        expect(cache.set).toHaveBeenCalledWith(
          "icecore:whatsapp_source_info:source-1",
          firstInfo,
          600
        );
        expect(cache.set).toHaveBeenCalledWith(
          "icecore:whatsapp_source_info:source-2",
          secondInfo,
          600
        );
        expect(cache.set).toHaveBeenCalledWith(
          "icecore:whatsapp_source_info:source-3",
          {},
          600
        );

        writes[0].resolve();
        if (rejectSecondWrite) {
          writes[1].reject(new Error("cache_write_unavailable"));
        } else {
          writes[1].resolve();
        }
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(settled).toBe(false);
        writes[2].resolve();

        const result = await response;
        expect(result.data.map(row => row.chat?.sourceId)).toEqual(sourceIds);
        expect(result.data.map(row => row.sourceInfo)).toEqual([
          firstInfo,
          secondInfo,
          firstInfo,
          undefined,
        ]);
      } finally {
        writes.forEach(write => write.resolve());
        await Promise.allSettled([response]);
      }
    }
  );
});

describe("Requests filter-option cache visibility", () => {
  const cacheKey = `icecore:workspace_channels_categories:${workspaceId}`;
  const firstId = indexedProjectionRow(10)._id.toHexString();
  const secondId = indexedProjectionRow(11)._id.toHexString();
  let stored: Map<string, unknown>;

  function setScope(visibleConversationIds: string[] | null) {
    mockVisibilityGate.mockResolvedValue({
      visibleConversationIds,
      hiddenConversationCount: 0,
      reason: null,
      limit: { kind: "conversation" },
    });
  }

  function readDimensions(params: Parameters<typeof getRequestsData>[1] = {}) {
    return getRequestsData(workspaceId, params, sourceSupabaseClient(), {
      includeChannels: true,
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockDistinct.mockReset();
    configureNormalizedOwner();
    stored = new Map();
    jest
      .spyOn(cache, "get")
      .mockImplementation(async key => stored.get(key) ?? null);
    jest.spyOn(cache, "set").mockImplementation(async (key, value) => {
      stored.set(key, value);
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it("returns dimensions for the current plan scope after a different scope populated the workspace entry", async () => {
    mockDistinct
      .mockResolvedValueOnce(["whatsapp"])
      .mockResolvedValueOnce(["Support"])
      .mockResolvedValueOnce(["telegram"])
      .mockResolvedValueOnce(["Sales"]);
    setScope([firstId]);
    const first = await readDimensions();
    setScope([secondId]);
    const second = await readDimensions();

    expect(first.availableChannels).toEqual(["whatsapp"]);
    expect(first.availableCategories).toEqual(["Support"]);
    expect(second.availableChannels).toEqual(["telegram"]);
    expect(second.availableCategories).toEqual(["Sales"]);
    expect(stored.size).toBe(1);
    expect([...stored.keys()]).toEqual([cacheKey]);
    expect(
      jest.mocked(cache.set).mock.calls.map(([key, , ttl]) => [key, ttl])
    ).toEqual([
      [cacheKey, 300],
      [cacheKey, 300],
    ]);
  });

  it("reuses dimensions for reordered duplicate IDs with normalized ObjectId casing", async () => {
    mockDistinct
      .mockResolvedValueOnce(["whatsapp"])
      .mockResolvedValueOnce(["Support"]);
    setScope([firstId, secondId]);
    await readDimensions();
    setScope([secondId, firstId.toUpperCase(), firstId]);
    const reused = await readDimensions();

    expect(reused.availableChannels).toEqual(["whatsapp"]);
    expect(reused.availableCategories).toEqual(["Support"]);
    expect(mockDistinct).toHaveBeenCalledTimes(2);
    expect(cache.set).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      firstScope: null,
      secondScope: [] as string[],
      firstChannels: ["whatsapp"],
      secondChannels: [],
    },
    {
      firstScope: [] as string[],
      secondScope: null,
      firstChannels: [],
      secondChannels: ["whatsapp"],
    },
  ])(
    "keeps all-conversation and zero-conversation scopes distinct %#",
    async fixture => {
      mockDistinct
        .mockResolvedValueOnce(fixture.firstChannels)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(fixture.secondChannels)
        .mockResolvedValueOnce([]);
      setScope(fixture.firstScope);
      await readDimensions();
      setScope(fixture.secondScope);
      const second = await readDimensions();

      expect(second.availableChannels).toEqual(fixture.secondChannels);
      expect(mockDistinct).toHaveBeenCalledTimes(4);
    }
  );

  it("refills legacy workspace metadata that has no visibility scope", async () => {
    stored.set(cacheKey, {
      channels: ["hidden-channel"],
      categories: ["Hidden"],
    });
    mockDistinct
      .mockResolvedValueOnce(["whatsapp"])
      .mockResolvedValueOnce(["Support"]);
    setScope([firstId]);

    const response = await readDimensions();

    expect(response.availableChannels).toEqual(["whatsapp"]);
    expect(response.availableCategories).toEqual(["Support"]);
    expect(mockDistinct).toHaveBeenCalledTimes(2);
  });

  it.each(["conversation_ids", "message_search"] as const)(
    "keeps a %s subset out of the normal plan-scope cache",
    async subset => {
      mockDistinct
        .mockResolvedValueOnce(["telegram", "whatsapp"])
        .mockResolvedValueOnce(["Sales", "Support"])
        .mockResolvedValueOnce(["whatsapp"])
        .mockResolvedValueOnce(["Support"]);
      setScope([firstId, secondId]);
      await readDimensions();
      mockMessageAggregate.mockReturnValueOnce({
        exec: jest.fn().mockResolvedValue([{ conversation: firstId }]),
      });
      const params =
        subset === "conversation_ids"
          ? { conversationIds: [firstId] }
          : { searchType: "message_within_chat", searchQuery: "hello" };
      const narrowed = await readDimensions(params);

      expect(narrowed.availableChannels).toEqual(["whatsapp"]);
      expect(narrowed.availableCategories).toEqual(["Support"]);
      expect(cache.get).toHaveBeenCalledTimes(1);
      expect(cache.set).toHaveBeenCalledTimes(1);
      const normal = await readDimensions();
      expect(normal.availableChannels).toEqual(["telegram", "whatsapp"]);
      expect(normal.availableCategories).toEqual(["Sales", "Support"]);
      expect(mockDistinct).toHaveBeenCalledTimes(4);
    }
  );

  it("preserves each response and later scope validation when an earlier scope finishes last", async () => {
    const firstChannels = deferred<string[]>();
    const firstCategories = deferred<string[]>();
    mockDistinct.mockImplementation((field, filter) => {
      const ids = filter._id.$in.map((value: mongoose.Types.ObjectId) =>
        value.toHexString()
      );
      if (ids.includes(firstId)) {
        return field === "channel"
          ? firstChannels.promise
          : firstCategories.promise;
      }
      return Promise.resolve(field === "channel" ? ["telegram"] : ["Sales"]);
    });
    setScope([firstId]);
    const first = readDimensions();

    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      setScope([secondId]);
      const second = await readDimensions();
      expect(second.availableChannels).toEqual(["telegram"]);
      expect(second.availableCategories).toEqual(["Sales"]);
      firstChannels.resolve(["whatsapp"]);
      firstCategories.resolve(["Support"]);
      const earlier = await first;
      expect(earlier.availableChannels).toEqual(["whatsapp"]);
      expect(earlier.availableCategories).toEqual(["Support"]);
      const later = await readDimensions();
      expect(later.availableChannels).toEqual(["telegram"]);
      expect(later.availableCategories).toEqual(["Sales"]);
    } finally {
      firstChannels.resolve([]);
      firstCategories.resolve([]);
      await Promise.allSettled([first]);
    }
  });
});

describe("Requests plan gate banner payload", () => {
  const freeLimit = (overrides: Record<string, unknown> = {}) => ({
    subscriptionType: "free",
    trialExpired: false,
    conversationLimit: 500,
    conversationCount: 500,
    conversationExhausted: true,
    hiddenConversationCount: 0,
    ...overrides,
  });

  it("keeps the banner at the free cap even though nothing is hidden yet", () => {
    // 500 of 500: new chats are refused on every channel, WhatsApp included.
    expect(
      planGatePayload({
        limit: freeLimit() as never,
        visibleConversationIds: [],
        hiddenConversationCount: 0,
        reason: null,
      })
    ).toEqual({
      hiddenCount: 0,
      reason: "conversation_limit",
      limit: freeLimit(),
    });
  });

  it("shows no banner below the cap or for an unlimited plan", () => {
    expect(planGatePayload(null)).toBeUndefined();
    for (const limit of [
      freeLimit({ conversationCount: 499, conversationExhausted: false }),
      freeLimit({
        subscriptionType: "pro",
        conversationLimit: null,
        conversationExhausted: false,
      }),
    ]) {
      expect(
        planGatePayload({
          limit: limit as never,
          visibleConversationIds: null,
          hiddenConversationCount: 0,
          reason: null,
        })
      ).toBeUndefined();
    }
  });

  it("keeps the hidden-count and trial-expired banners unchanged", () => {
    expect(
      planGatePayload({
        limit: freeLimit({ conversationCount: 512 }) as never,
        visibleConversationIds: [],
        hiddenConversationCount: 12,
        reason: "conversation_limit",
      })
    ).toMatchObject({ hiddenCount: 12, reason: "conversation_limit" });
    expect(
      planGatePayload({
        limit: freeLimit({ trialExpired: true }) as never,
        visibleConversationIds: [],
        hiddenConversationCount: 500,
        reason: "trial_expired",
      })
    ).toMatchObject({ hiddenCount: 500, reason: "trial_expired" });
  });
});
