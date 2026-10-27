import {
  CREATIVE_ASSET_TIMELINE_MAX_SOURCES,
  normalizeCreativeAssetTimeline,
} from "@icecore/temporal";
import { timelineRenderSchema, timelineSchema } from "./schema";

const assetId = "64c13ab08edf48a008793cab";
const clip = {
  id: "hook",
  assetId,
  trackId: "V1" as const,
  timelineStart: 0,
  sourceStart: 0,
  caption: "Exact caption",
  duration: 3,
};
const timeline = {
  duration: 3,
  canvas: "9:16" as const,
  audioTrack: "V2" as const,
  clips: [clip],
};

test("preserves transport stripping, trimmed IDs, and the field order used by persisted fingerprints", () => {
  const { duration, ...remainingClip } = clip;
  const parsed = timelineSchema.parse({
    ...timeline,
    injected: "ignored",
    clips: [{ duration, injected: "ignored", ...remainingClip, id: " hook " }],
  });
  expect(parsed).toEqual(timeline);
  expect(Object.keys(parsed.clips[0])).toEqual([
    "id",
    "assetId",
    "trackId",
    "timelineStart",
    "sourceStart",
    "caption",
    "duration",
  ]);
  expect(normalizeCreativeAssetTimeline(parsed)).toEqual(timeline);
});

test("shared semantic validation retains duplicate-ID and end-duration API paths", () => {
  const parsed = timelineSchema.safeParse({
    ...timeline,
    clips: [clip, { ...clip, timelineStart: 1 }],
  });
  expect(parsed.success).toBe(false);
  if (parsed.success) return;
  expect(parsed.error.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: ["clips", 1, "id"],
        message: "Timeline clip ids must be unique",
      }),
      expect.objectContaining({
        path: ["clips", 1, "duration"],
        message: "Timeline clip exceeds the render duration",
      }),
    ])
  );
});

test("rejects unsupported text while preserving literal display punctuation and newlines", () => {
  expect(
    timelineSchema.safeParse({
      ...timeline,
      clips: [{ ...clip, caption: "Offer: 20%\nVisit us" }],
    }).success
  ).toBe(true);
  expect(
    timelineSchema.safeParse({
      ...timeline,
      clips: [{ ...clip, caption: "First\rsecond" }],
    }).success
  ).toBe(false);
  expect(timelineSchema.safeParse({ ...timeline, canvas: "bad" }).success).toBe(
    false
  );
});

test("counts mixed-case Mongo IDs by physical source at the render limit", () => {
  const clips = Array.from(
    { length: CREATIVE_ASSET_TIMELINE_MAX_SOURCES },
    (_, index) => ({
      ...clip,
      id: `clip-${index}`,
      assetId: `abcdefabcdefabcdef${index.toString(16).padStart(6, "0")}`,
    })
  );
  clips.push({
    ...clips[0],
    id: "uppercase-alias",
    assetId: clips[0].assetId.toUpperCase(),
  });
  const value = { ...timeline, clips };
  const saved = JSON.stringify(value);
  expect(timelineSchema.safeParse(value).success).toBe(true);
  const render = timelineRenderSchema.parse(value);
  expect(
    render.clips.find(item => item.id === "uppercase-alias")?.assetId
  ).toBe(clips[0].assetId.toUpperCase());
  expect(JSON.stringify(value)).toBe(saved);
  expect(
    timelineSchema.safeParse({
      ...value,
      clips: [
        ...clips,
        { ...clip, id: "new-source", assetId: "abcdefabcdefabcdef000014" },
      ],
    }).success
  ).toBe(false);
});
