const mockFind = jest.fn();
const mockFindOne = jest.fn();
const mockSelect = jest.fn();
const mockLean = jest.fn();
jest.mock("@/models/creative-asset", () => ({
  CreativeAsset: {
    find: (...args: unknown[]) => mockFind(...args),
    findOne: (...args: unknown[]) => mockFindOne(...args),
  },
}));

import { validateTimelineSources } from "./sources";

const imageId = "64c13ab08edf48a008793cab";
const videoId = "64c13ab08edf48a008793cac";
const image = {
  _id: imageId,
  workspaceId: "ws",
  kind: "image",
  status: "complete",
  url: "gcs://bucket/image.png",
};
const video = {
  _id: videoId,
  workspaceId: "ws",
  kind: "video",
  status: "complete",
  url: "gcs://bucket/video.mp4",
  generation: { result: { durationSeconds: 8 } },
};
const timeline = {
  duration: 9,
  clips: [imageId, videoId, imageId].map((assetId, index) => ({
    id: `scene-${index}`,
    assetId,
    trackId: "V1" as const,
    timelineStart: index * 3,
    sourceStart: 0,
    duration: 3,
  })),
};

beforeEach(() => {
  jest.resetAllMocks();
  mockLean.mockResolvedValue([video, image]);
  mockSelect.mockReturnValue({ lean: mockLean });
  mockFind.mockReturnValue({ select: mockSelect });
  mockFindOne.mockImplementation(query => ({
    lean: async () => (query._id === imageId ? image : video),
  }));
});

test("loads unique workspace sources in one bounded projected query and restores scene order", async () => {
  const sources = await validateTimelineSources("ws", timeline);
  expect(mockFind).toHaveBeenCalledTimes(1);
  expect(mockFind).toHaveBeenCalledWith({
    _id: { $in: [imageId, videoId] },
    workspaceId: "ws",
  });
  expect(mockFindOne).not.toHaveBeenCalled();
  expect(mockSelect).toHaveBeenCalledWith({
    _id: 1,
    workspaceId: 1,
    kind: 1,
    status: 1,
    url: 1,
    "generation.result.durationSeconds": 1,
  });
  expect(sources.map(source => String(source._id))).toEqual([imageId, videoId]);
});

test.each([
  ["missing source", [image]],
  ["foreign source", [image, { ...video, workspaceId: "another-workspace" }]],
  ["unfinished source", [image, { ...video, status: "queued" }]],
  ["unreadable source", [image, { ...video, url: "" }]],
  ["wrong media kind", [image, { ...video, kind: "audio" }]],
])("rejects a %s without disclosing its details", async (_name, assets) => {
  mockLean.mockResolvedValue(assets);
  await expect(validateTimelineSources("ws", timeline)).rejects.toThrow(
    "Timeline clips require completed image or video assets in this workspace"
  );
});

test("checks every repeated image slot instead of checking only its first occurrence", async () => {
  await expect(
    validateTimelineSources("ws", {
      ...timeline,
      clips: timeline.clips.map((clip, index) => ({
        ...clip,
        sourceStart: index === 2 ? 1 : 0,
      })),
    })
  ).rejects.toThrow("Image clips must start at zero");
});

test("checks all video trims against known source duration", async () => {
  await expect(
    validateTimelineSources("ws", {
      ...timeline,
      clips: timeline.clips.map(clip => ({
        ...clip,
        sourceStart: clip.assetId === videoId ? 6 : 0,
      })),
    })
  ).rejects.toThrow("A selected video is too short for its scene");
});

test("matches accepted uppercase asset IDs to Mongo's lowercase ObjectId strings", async () => {
  const sources = await validateTimelineSources("ws", {
    ...timeline,
    clips: timeline.clips.map(clip => ({
      ...clip,
      assetId: clip.assetId.toUpperCase(),
    })),
  });
  expect(sources.map(source => String(source._id))).toEqual([imageId, videoId]);
});

test("deduplicates mixed-case source identities without changing reviewed timeline bytes", async () => {
  const mixed = {
    ...timeline,
    clips: timeline.clips.map((clip, index) => ({
      ...clip,
      assetId: index === 2 ? clip.assetId.toUpperCase() : clip.assetId,
    })),
  };
  const snapshot = JSON.stringify(mixed);
  const sources = await validateTimelineSources("ws", mixed);
  expect(mockFind).toHaveBeenCalledWith({
    _id: { $in: [imageId, videoId] },
    workspaceId: "ws",
  });
  expect(sources.map(source => String(source._id))).toEqual([imageId, videoId]);
  expect(JSON.stringify(mixed)).toBe(snapshot);
});
