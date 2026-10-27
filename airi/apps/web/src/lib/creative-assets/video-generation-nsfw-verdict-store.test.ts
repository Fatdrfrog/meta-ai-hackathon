const mockUpdateOne = jest.fn();
const mockFindOne = jest.fn();
const mockFind = jest.fn();
const mockCreativeAssetUpdateMany = jest.fn();

jest.mock("@/models/video-generation-nsfw-verdict", () => ({
  VideoGenerationNsfwVerdict: {
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
    findOne: (...args: unknown[]) => mockFindOne(...args),
    find: (...args: unknown[]) => mockFind(...args),
  },
}));

jest.mock("@/models/creative-asset", () => ({
  CreativeAsset: {
    updateMany: (...args: unknown[]) => mockCreativeAssetUpdateMany(...args),
  },
}));

import {
  buildVideoGenerationNsfwVerdictId,
  findVideoGenerationNsfwVerdict,
  markVideoGenerationNsfwVerdictSweepCompleted,
  recordVideoGenerationNsfwVerdict,
  replayPendingVideoGenerationNsfwVerdictSweeps,
} from "./video-generation-nsfw-verdict-store";

function leanResult<T>(value: T) {
  const query = {
    read: jest.fn(),
    lean: jest.fn().mockResolvedValue(value),
  };
  query.read.mockReturnValue(query);
  return query;
}

function listResult<T>(value: T) {
  const query = {
    read: jest.fn(),
    sort: jest.fn(),
    limit: jest.fn(),
    lean: jest.fn().mockResolvedValue(value),
  };
  query.read.mockReturnValue(query);
  query.sort.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  return query;
}

describe("video generation NSFW verdict store", () => {
  const markerId = buildVideoGenerationNsfwVerdictId({
    workspaceId: "workspace-1",
    providerRequestId: "request-1",
  });
  const firstReceivedAt = new Date("2026-07-23T12:00:00.000Z");

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    mockCreativeAssetUpdateMany.mockResolvedValue({
      matchedCount: 1,
      modifiedCount: 1,
    });
    mockFind.mockReturnValue(listResult([]));
    mockFindOne.mockReturnValue(
      leanResult({
        _id: markerId,
        workspaceId: "workspace-1",
        provider: "higgsfield",
        providerRequestId: "request-1",
        verdict: "nsfw",
        sourceAssetId: "asset-1",
        sourceAttemptToken: "attempt-1",
        firstReceivedAt,
        lastReceivedAt: firstReceivedAt,
        sweepCompletedAt: null,
      })
    );
  });

  it("builds a stable tenant-scoped marker id", () => {
    expect(markerId).toBe(
      "4138e237ab320c2371764626d3561728999aad93298d7dfb3e4ea9b894200ed7"
    );
  });

  it("upserts one permanent tenant-scoped verdict for the source request", async () => {
    await recordVideoGenerationNsfwVerdict({
      workspaceId: "workspace-1",
      providerRequestId: "request-1",
      sourceAssetId: "asset-1",
      sourceAttemptToken: "attempt-1",
      receivedAt: firstReceivedAt,
    });

    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: markerId },
      {
        $setOnInsert: {
          _id: markerId,
          workspaceId: "workspace-1",
          provider: "higgsfield",
          providerRequestId: "request-1",
          verdict: "nsfw",
          sourceAssetId: "asset-1",
          sourceAttemptToken: "attempt-1",
          firstReceivedAt,
        },
        $set: {
          lastReceivedAt: firstReceivedAt,
          sweepCompletedAt: null,
        },
      },
      { upsert: true, writeConcern: { w: "majority" } }
    );
    expect(mockFindOne).toHaveBeenCalledWith({
      _id: markerId,
      workspaceId: "workspace-1",
      provider: "higgsfield",
      providerRequestId: "request-1",
      verdict: "nsfw",
    });
    const query = mockFindOne.mock.results[0]?.value;
    expect(query.read).toHaveBeenCalledWith("primary");
  });

  it("finds a verdict by request alias or durable ancestor attempt", async () => {
    await expect(
      findVideoGenerationNsfwVerdict({
        workspaceId: "workspace-1",
        providerRequestIds: ["request-1"],
        ancestors: [
          {
            assetId: "asset-1",
            attemptToken: "attempt-1",
          },
        ],
      })
    ).resolves.toMatchObject({
      _id: markerId,
      providerRequestId: "request-1",
      sourceAssetId: "asset-1",
      sourceAttemptToken: "attempt-1",
      firstReceivedAt,
    });

    expect(mockFindOne).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      provider: "higgsfield",
      verdict: "nsfw",
      $or: [
        { _id: { $in: [markerId] } },
        {
          sourceAssetId: "asset-1",
          sourceAttemptToken: "attempt-1",
        },
      ],
    });
    const query = mockFindOne.mock.results[0]?.value;
    expect(query.read).toHaveBeenCalledWith("primary");
  });

  it("does not issue an unbounded verdict query without lineage", async () => {
    await expect(
      findVideoGenerationNsfwVerdict({
        workspaceId: "workspace-1",
        providerRequestIds: [],
        ancestors: [],
      })
    ).resolves.toBeNull();

    expect(mockFindOne).not.toHaveBeenCalled();
  });

  it("marks a completed sweep with a majority write", async () => {
    const completedAt = new Date("2026-07-23T12:01:00.000Z");

    await markVideoGenerationNsfwVerdictSweepCompleted({
      markerId,
      workspaceId: "workspace-1",
      providerRequestId: "request-1",
      completedAt,
    });

    expect(mockUpdateOne).toHaveBeenCalledWith(
      {
        _id: markerId,
        workspaceId: "workspace-1",
        provider: "higgsfield",
        providerRequestId: "request-1",
        verdict: "nsfw",
      },
      {
        $set: {
          sweepCompletedAt: completedAt,
        },
      },
      {
        writeConcern: { w: "majority" },
      }
    );
  });

  it("replays a pending marker sweep and closes it only after the asset update", async () => {
    mockFind.mockReturnValue(
      listResult([
        {
          _id: markerId,
          workspaceId: "workspace-1",
          provider: "higgsfield",
          providerRequestId: "request-1",
          verdict: "nsfw",
          sourceAssetId: "asset-1",
          sourceAttemptToken: "attempt-1",
          firstReceivedAt,
          lastReceivedAt: firstReceivedAt,
          sweepCompletedAt: null,
        },
      ])
    );
    const now = new Date("2026-07-23T12:02:00.000Z");

    await expect(
      replayPendingVideoGenerationNsfwVerdictSweeps({ now, limit: 100 })
    ).resolves.toEqual({
      scanned: 1,
      completed: 1,
      failed: 0,
    });

    expect(mockFind).toHaveBeenCalledWith({
      provider: "higgsfield",
      verdict: "nsfw",
      sweepCompletedAt: null,
    });
    const query = mockFind.mock.results[0]?.value;
    expect(query.read).toHaveBeenCalledWith("primary");
    expect(query.sort).toHaveBeenCalledWith({ firstReceivedAt: 1, _id: 1 });
    expect(query.limit).toHaveBeenCalledWith(100);
    expect(mockCreativeAssetUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        status: { $in: ["queued", "in_progress", "complete", "failed"] },
        $or: expect.arrayContaining([
          {
            "generation.safetyAncestors": {
              $elemMatch: {
                assetId: "asset-1",
                attemptToken: "attempt-1",
              },
            },
          },
        ]),
      }),
      expect.any(Array)
    );
    expect(mockCreativeAssetUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockUpdateOne.mock.invocationCallOrder[0]!
    );
  });

  it("leaves a marker pending when its replay sweep fails", async () => {
    mockFind.mockReturnValue(
      listResult([
        {
          _id: markerId,
          workspaceId: "workspace-1",
          provider: "higgsfield",
          providerRequestId: "request-1",
          verdict: "nsfw",
          sourceAssetId: "asset-1",
          sourceAttemptToken: "attempt-1",
          firstReceivedAt,
          lastReceivedAt: firstReceivedAt,
          sweepCompletedAt: null,
        },
      ])
    );
    mockCreativeAssetUpdateMany.mockRejectedValueOnce(
      new Error("mongo unavailable")
    );

    await expect(
      replayPendingVideoGenerationNsfwVerdictSweeps({
        now: new Date("2026-07-23T12:02:00.000Z"),
        limit: 100,
      })
    ).resolves.toEqual({
      scanned: 1,
      completed: 0,
      failed: 1,
    });

    expect(mockUpdateOne).not.toHaveBeenCalled();
  });
});
