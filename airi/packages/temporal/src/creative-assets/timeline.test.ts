import assert from "node:assert/strict";
import test from "node:test";

import {
  CREATIVE_ASSET_TIMELINE_MAX_CAPTION_LENGTH,
  CREATIVE_ASSET_TIMELINE_MAX_CLIPS,
  CREATIVE_ASSET_TIMELINE_MAX_SOURCES,
  CREATIVE_ASSET_TIMELINE_PROBE_END_TOLERANCE_SECONDS,
  hasUnsupportedCreativeAssetTextCharacters,
  isCreativeAssetTimelineCaption,
  normalizeCreativeAssetTimeline,
  roundCreativeAssetTimelineSeconds,
  validateCreativeAssetTimeline,
  type CreativeAssetTimeline,
} from "./timeline";

function timeline(): CreativeAssetTimeline {
  return {
    duration: 3,
    clips: [
      {
        id: "clip-1",
        assetId: "asset-1",
        trackId: "V1",
        timelineStart: 0,
        sourceStart: 0,
        duration: 3,
      },
    ],
  };
}

test("shared timeline normalization preserves serialized order and input for existing fingerprints", () => {
  const input: CreativeAssetTimeline = {
    clips: [
      {
        caption: "Overlay",
        id: "z",
        assetId: "overlay",
        trackId: "V2",
        duration: 1.23456,
        sourceStart: 0.34567,
        timelineStart: 1.23456,
        effect: "chroma_key",
      },
      {
        id: "b",
        assetId: "second",
        trackId: "V1",
        timelineStart: 0.00049,
        sourceStart: 2.22249,
        duration: 1.23449,
      },
      {
        id: "a",
        assetId: "first",
        trackId: "V1",
        timelineStart: 0.0004,
        sourceStart: 1.11151,
        duration: 1.23456,
      },
    ],
    audioTrack: "V2",
    canvas: "9:16",
    duration: 3.45678,
  };
  const before = JSON.stringify(input);
  const result = normalizeCreativeAssetTimeline(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(
    JSON.stringify(result),
    '{"duration":3.457,"canvas":"9:16","audioTrack":"V2","clips":[{"id":"a","assetId":"first","trackId":"V1","timelineStart":0,"sourceStart":1.112,"duration":1.235},{"id":"b","assetId":"second","trackId":"V1","timelineStart":0,"sourceStart":2.222,"duration":1.234},{"caption":"Overlay","id":"z","assetId":"overlay","trackId":"V2","duration":1.235,"sourceStart":0.346,"timelineStart":1.235,"effect":"chroma_key"}]}',
  );
  assert.deepEqual(normalizeCreativeAssetTimeline(timeline()), timeline());
  assert.equal(roundCreativeAssetTimelineSeconds(2.22249), 2.222);
  assert.equal(roundCreativeAssetTimelineSeconds(1.11151), 1.112);
});

test("caption validation shares text safety while preserving legacy worker carriage returns", () => {
  assert.ok(
    isCreativeAssetTimelineCaption(
      "Coffee: 20% %{metadata:secret}; [out]\n\tҚазақ",
    ),
  );
  assert.ok(
    isCreativeAssetTimelineCaption(
      "x".repeat(CREATIVE_ASSET_TIMELINE_MAX_CAPTION_LENGTH),
    ),
  );
  assert.ok(
    !isCreativeAssetTimelineCaption(
      "x".repeat(CREATIVE_ASSET_TIMELINE_MAX_CAPTION_LENGTH + 1),
    ),
  );
  assert.ok(!isCreativeAssetTimelineCaption(42));
  for (const character of [
    "\u0000",
    "\u0008",
    "\u000b",
    "\u000c",
    "\u000e",
    "\u001f",
    "\u007f",
  ]) {
    assert.ok(hasUnsupportedCreativeAssetTextCharacters(character));
    assert.ok(
      hasUnsupportedCreativeAssetTextCharacters(character, {
        allowCarriageReturns: true,
      }),
    );
  }
  const input = timeline();
  input.clips[0]!.caption = "First\r\nSecond";
  assert.deepEqual(
    validateCreativeAssetTimeline(input).map((issue) => issue.path),
    [["clips", 0, "caption"]],
  );
  assert.deepEqual(
    validateCreativeAssetTimeline(input, { allowCarriageReturns: true }),
    [],
  );
});

test("HTTP millisecond and worker probe tolerances remain distinct without rounding the input", () => {
  const input = timeline();
  input.clips[0]!.duration = 3.001;
  assert.deepEqual(validateCreativeAssetTimeline(input), []);
  input.clips[0]!.duration = 3.0011;
  assert.deepEqual(
    validateCreativeAssetTimeline(input).map((issue) => issue.code),
    ["clip_end"],
  );
  const workerOptions = {
    clipEndToleranceSeconds:
      CREATIVE_ASSET_TIMELINE_PROBE_END_TOLERANCE_SECONDS,
  };
  input.clips[0]!.duration = 3.05;
  assert.deepEqual(validateCreativeAssetTimeline(input, workerOptions), []);
  input.clips[0]!.duration = 3.0501;
  assert.deepEqual(
    validateCreativeAssetTimeline(input, workerOptions).map(
      (issue) => issue.code,
    ),
    ["clip_end"],
  );
  input.duration = 7200;
  input.clips[0]!.duration = 7200.04;
  assert.deepEqual(validateCreativeAssetTimeline(input, workerOptions), []);
});

test("semantic validation accepts portable asset IDs and reports duplicate IDs and clip bounds by path", () => {
  const input = timeline();
  assert.deepEqual(validateCreativeAssetTimeline(input), []);
  input.clips.push({ ...input.clips[0]!, timelineStart: 1 });
  assert.deepEqual(validateCreativeAssetTimeline(input), [
    {
      code: "duplicate_clip_id",
      path: ["clips", 1, "id"],
      message: "Timeline clip ids must be unique",
    },
    {
      code: "clip_end",
      path: ["clips", 1, "duration"],
      message: "Timeline clip exceeds the render duration",
    },
  ]);
  input.clips[1]!.id = " clip-1 ";
  input.clips[1]!.timelineStart = 0;
  assert.deepEqual(validateCreativeAssetTimeline(input), []);
});

test("semantic validation rejects malformed data and finite number violations without throwing", () => {
  for (const input of [null, undefined, 1, [], "timeline"]) {
    assert.equal(validateCreativeAssetTimeline(input)[0]?.code, "timeline");
  }
  for (const [field, value, code] of [
    ["canvas", "16:9", "canvas"],
    ["audioTrack", "A1", "audio_track"],
    ["duration", Number.NaN, "duration"],
    ["duration", 0.24, "duration"],
    ["duration", 7200.001, "duration"],
    ["clips", [], "clip_count"],
    ["clips", null, "clip_count"],
  ] as const) {
    assert.equal(
      validateCreativeAssetTimeline({ ...timeline(), [field]: value })[0]?.code,
      code,
    );
  }
  for (const [field, value] of [
    ["id", " "],
    ["assetId", ""],
    ["trackId", "A1"],
    ["timelineStart", -1],
    ["sourceStart", Infinity],
    ["sourceStart", "0"],
    ["duration", 0.24],
    ["effect", "fade"],
    ["caption", null],
  ] as const) {
    assert.deepEqual(
      validateCreativeAssetTimeline({
        ...timeline(),
        clips: [{ ...timeline().clips[0], [field]: value }],
      })[0]?.path,
      ["clips", 0, field],
    );
  }
  assert.equal(
    validateCreativeAssetTimeline({ ...timeline(), clips: [null] })[0]?.code,
    "clip",
  );
});

test("shared source and clip budgets count unique assets and enforce maximum boundaries", () => {
  const input = timeline();
  input.clips = Array.from(
    { length: CREATIVE_ASSET_TIMELINE_MAX_CLIPS },
    (_, index) => ({ ...input.clips[0]!, id: `clip-${index}` }),
  );
  assert.deepEqual(validateCreativeAssetTimeline(input), []);
  input.clips.push({ ...input.clips[0]!, id: "overflow" });
  assert.equal(validateCreativeAssetTimeline(input)[0]?.code, "clip_count");
  input.clips = input.clips.slice(0, CREATIVE_ASSET_TIMELINE_MAX_SOURCES);
  input.clips.forEach((clip, index) => {
    clip.assetId = `asset-${index}`;
  });
  assert.deepEqual(validateCreativeAssetTimeline(input), []);
  input.clips.push({ ...input.clips[0]!, id: "new", assetId: "new" });
  assert.deepEqual(
    validateCreativeAssetTimeline(input).map((issue) => issue.code),
    ["source_count"],
  );
});

test("source budgets count Mongo casing aliases once without changing saved timeline bytes", () => {
  const input = timeline();
  input.clips = Array.from(
    { length: CREATIVE_ASSET_TIMELINE_MAX_SOURCES },
    (_, index) => ({
      ...input.clips[0]!,
      id: `clip-${index}`,
      assetId: `abcdefabcdefabcdef${index.toString(16).padStart(6, "0")}`,
    }),
  );
  input.clips.push({
    ...input.clips[0]!,
    id: "uppercase-alias",
    assetId: input.clips[0]!.assetId.toUpperCase(),
  });
  const saved = JSON.stringify(input);
  assert.deepEqual(validateCreativeAssetTimeline(input), []);
  assert.equal(JSON.stringify(input), saved);
  input.clips.push({
    ...input.clips[0]!,
    id: "new-source",
    assetId: "abcdefabcdefabcdef000014",
  });
  assert.deepEqual(
    validateCreativeAssetTimeline(input).map((issue) => issue.code),
    ["source_count"],
  );
});

test("source budgets retain case-sensitive identity for opaque non-Mongo IDs", () => {
  const input = timeline();
  input.clips = Array.from(
    { length: CREATIVE_ASSET_TIMELINE_MAX_SOURCES },
    (_, index) => ({
      ...input.clips[0]!,
      id: `clip-${index}`,
      assetId: `asset-${index}`,
    }),
  );
  input.clips.push({
    ...input.clips[0]!,
    id: "different-case",
    assetId: "ASSET-0",
  });
  assert.deepEqual(
    validateCreativeAssetTimeline(input).map((issue) => issue.code),
    ["source_count"],
  );
});
