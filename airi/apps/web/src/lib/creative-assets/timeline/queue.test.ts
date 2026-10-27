const mockFindOne = jest.fn();
const mockFind = jest.fn();
const mockCreate = jest.fn();
const mockStart = jest.fn();
const mockDescribe = jest.fn();
const mockFindOneAndUpdate = jest.fn();
jest.mock("@/models/creative-asset", () => ({
  CreativeAsset: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    find: (...args: unknown[]) => mockFind(...args),
    create: (...args: unknown[]) => mockCreate(...args),
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
  },
}));
jest.mock("@/lib/temporal/creative-asset-edits", () => ({
  startCreativeAssetEditWorkflow: (...args: unknown[]) => mockStart(...args),
}));

import { timelineFingerprint, queueTimelineRender } from "./queue";

const assetId = "64c13ab08edf48a008793cab";
const outputAssetId = "64c13ab08edf48a008793cad";
const timeline = {
  duration: 3,
  clips: [
    {
      id: "hook",
      assetId,
      trackId: "V1" as const,
      timelineStart: 0,
      sourceStart: 0,
      duration: 3,
    },
  ],
};
const source = {
  _id: assetId,
  workspaceId: "ws",
  kind: "image",
  status: "complete",
  url: "https://storage.example.com/product.png",
};
const output = {
  _id: outputAssetId,
  workspaceId: "ws",
  source: "edited",
  provider: "airi",
  sourceAssetId: assetId,
  modelId: "airi-timeline-render-v1",
  status: "queued",
  providerPayload: { referenceVideoPlanId: "plan" },
  editFingerprint: "reference-plan:plan",
};
const input = {
  workspaceId: "ws",
  userId: "user",
  sourceAssetId: assetId,
  timeline,
  title: "Product",
  outputAssetId,
  planId: "plan",
};

beforeEach(() => {
  jest.resetAllMocks();
  mockFindOne.mockImplementation(query => ({
    lean: () => Promise.resolve(query._id === assetId ? source : null),
  }));
  mockFind.mockReturnValue({ select: () => ({ lean: async () => [source] }) });
  mockCreate.mockResolvedValue(output);
  mockStart.mockResolvedValue({
    duplicate: false,
    handle: { describe: mockDescribe },
  });
  mockDescribe.mockResolvedValue({ status: { name: "RUNNING" } });
  mockFindOneAndUpdate.mockImplementation((_query, update) => ({
    lean: async () => ({ ...output, ...update.$set }),
  }));
});

it("preserves and fingerprints canvas, captions and selected audio", () => {
  const portrait = {
    ...timeline,
    canvas: "9:16" as const,
    audioTrack: "V2" as const,
    clips: timeline.clips.map(clip => ({ ...clip, caption: "Exact caption" })),
  };
  expect(timelineFingerprint(portrait)).not.toEqual(
    timelineFingerprint(timeline)
  );
  expect(timelineFingerprint({ ...timeline, audioTrack: "V2" })).not.toEqual(
    timelineFingerprint(timeline)
  );
});

it("creates one reserved output and dispatches only the reviewed timeline", async () => {
  const result = await queueTimelineRender(input);
  expect(result.duplicate).toBe(false);
  expect(mockCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      _id: expect.anything(),
      workspaceId: "ws",
      editFingerprint: "reference-plan:plan",
    })
  );
  expect(mockStart).toHaveBeenCalledWith({
    workspaceId: "ws",
    sourceAssetId: assetId,
    outputAssetId,
    operation: "timeline_render",
    timeline,
  });
});

it("rejects malformed source IDs at the queue boundary before any database query", async () => {
  await expect(
    queueTimelineRender({
      ...input,
      timeline: {
        ...timeline,
        clips: timeline.clips.map(clip => ({ ...clip, assetId: "invalid" })),
      },
    })
  ).rejects.toThrow();
  expect(mockFind).not.toHaveBeenCalled();
  expect(mockFindOne).not.toHaveBeenCalled();
  expect(mockCreate).not.toHaveBeenCalled();
});

it("rejects a clip that exceeds the end tolerance after millisecond normalization before loading assets", async () => {
  await expect(
    queueTimelineRender({
      ...input,
      timeline: {
        duration: 1.00049,
        clips: [
          { ...timeline.clips[0], timelineStart: 0.50051, duration: 0.50051 },
        ],
      },
    })
  ).rejects.toThrow("Timeline clip exceeds the render duration");
  expect(mockFind).not.toHaveBeenCalled();
  expect(mockFindOne).not.toHaveBeenCalled();
  expect(mockCreate).not.toHaveBeenCalled();
});

it("rejects an offset that becomes infinite during normalization before loading assets", async () => {
  await expect(
    queueTimelineRender({
      ...input,
      timeline: {
        duration: 1,
        clips: [{ ...timeline.clips[0], sourceStart: 1e307, duration: 1 }],
      },
    })
  ).rejects.toThrow();
  expect(mockFind).not.toHaveBeenCalled();
  expect(mockFindOne).not.toHaveBeenCalled();
  expect(mockCreate).not.toHaveBeenCalled();
});

it("reuses queued output after an ambiguous workflow start without creating another", async () => {
  mockStart.mockRejectedValueOnce(new Error("deadline exceeded"));
  await expect(queueTimelineRender(input)).rejects.toThrow("deadline exceeded");
  mockFindOne.mockImplementation(query => ({
    lean: () => Promise.resolve(query._id === assetId ? source : output),
  }));
  await expect(queueTimelineRender(input)).resolves.toMatchObject({
    duplicate: true,
  });
  expect(mockCreate).toHaveBeenCalledTimes(1);
  expect(mockStart).toHaveBeenCalledTimes(2);
});

it("returns terminal outputs without restarting and rejects a reserved output collision", async () => {
  mockFindOne.mockImplementation(query => ({
    lean: () =>
      Promise.resolve(
        query._id === assetId ? source : { ...output, status: "failed" }
      ),
  }));
  await expect(queueTimelineRender(input)).resolves.toMatchObject({
    asset: { status: "failed" },
  });
  expect(mockStart).not.toHaveBeenCalled();
  mockFindOne.mockImplementation(query => ({
    lean: () =>
      Promise.resolve(
        query._id === assetId
          ? source
          : { ...output, editFingerprint: "different" }
      ),
  }));
  await expect(queueTimelineRender(input)).rejects.toThrow("does not match");
});

it("also resumes an existing editor timeline after an ambiguous dispatch", async () => {
  const legacyInput = {
    workspaceId: "ws",
    userId: "user",
    sourceAssetId: assetId,
    timeline,
    title: "Timeline export",
  };
  mockFindOne.mockImplementation(query => ({
    lean: () => Promise.resolve(query._id === assetId ? source : output),
  }));
  await expect(queueTimelineRender(legacyInput)).resolves.toMatchObject({
    duplicate: true,
  });
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockStart).toHaveBeenCalledWith(
    expect.objectContaining({ outputAssetId })
  );
});

it("fails a recreated reserved output when its deterministic workflow has already closed", async () => {
  let outputReads = 0;
  mockFindOne.mockImplementation(query => ({
    lean: async () =>
      query._id === assetId ? source : ++outputReads === 1 ? null : output,
  }));
  mockStart.mockResolvedValue({
    duplicate: true,
    handle: { describe: mockDescribe },
  });
  mockDescribe.mockResolvedValue({ status: { name: "COMPLETED" } });
  const result = await queueTimelineRender(input);
  expect(result).toMatchObject({
    duplicate: true,
    asset: {
      status: "failed",
      error: expect.stringMatching(/new video plan/i),
    },
  });
  expect(mockCreate).toHaveBeenCalledTimes(1);
  expect(mockStart).toHaveBeenCalledTimes(1);
  expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
    expect.objectContaining({
      _id: outputAssetId,
      workspaceId: "ws",
      status: { $in: ["queued", "in_progress"] },
    }),
    { $set: expect.objectContaining({ status: "failed" }) },
    { new: true }
  );
});

it("keeps a running duplicate workflow pending", async () => {
  mockFindOne.mockImplementation(query => ({
    lean: async () => (query._id === assetId ? source : output),
  }));
  mockStart.mockResolvedValue({
    duplicate: true,
    handle: { describe: mockDescribe },
  });
  await expect(queueTimelineRender(input)).resolves.toMatchObject({
    asset: { status: "queued" },
    duplicate: true,
  });
  expect(mockDescribe).toHaveBeenCalledTimes(1);
  expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
});

it.each(["complete", "failed"])(
  "preserves the worker's %s result when a duplicate workflow closes before the asset reload",
  async status => {
    let outputReads = 0;
    mockFindOne.mockImplementation(query => ({
      lean: async () =>
        query._id === assetId
          ? source
          : { ...output, status: ++outputReads === 1 ? "queued" : status },
    }));
    mockStart.mockResolvedValue({
      duplicate: true,
      handle: { describe: mockDescribe },
    });
    mockDescribe.mockResolvedValue({ status: { name: "COMPLETED" } });
    await expect(queueTimelineRender(input)).resolves.toMatchObject({
      asset: { status },
    });
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  }
);

it("preserves a worker completion that wins the conditional failure update", async () => {
  let outputReads = 0;
  mockFindOne.mockImplementation(query => ({
    lean: async () =>
      query._id === assetId
        ? source
        : { ...output, status: ++outputReads <= 2 ? "queued" : "complete" },
  }));
  mockFindOneAndUpdate.mockReturnValue({ lean: async () => null });
  mockStart.mockResolvedValue({
    duplicate: true,
    handle: { describe: mockDescribe },
  });
  mockDescribe.mockResolvedValue({ status: { name: "COMPLETED" } });
  await expect(queueTimelineRender(input)).resolves.toMatchObject({
    asset: { status: "complete" },
  });
  expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
});

it("does not turn an unavailable workflow description into a terminal asset failure", async () => {
  mockFindOne.mockImplementation(query => ({
    lean: async () => (query._id === assetId ? source : output),
  }));
  mockStart.mockResolvedValue({
    duplicate: true,
    handle: { describe: mockDescribe },
  });
  mockDescribe.mockRejectedValue(new Error("Temporal unavailable"));
  await expect(queueTimelineRender(input)).rejects.toThrow(
    "Temporal unavailable"
  );
  expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  expect(mockCreate).not.toHaveBeenCalled();
});
