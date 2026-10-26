import assert from "node:assert/strict";
import { test } from "node:test";
import type { SegmentationRecord } from "@meta-sam/parser";
import { summarizeTracks } from "./sam.ts";

const box = (objectId: string, frameIndex: number, size: number, confidence?: number): SegmentationRecord => ({
  kind: "box",
  order: 0,
  objectId,
  frame: { frameIndex },
  left: 0,
  top: 0,
  right: size,
  bottom: size,
  confidence,
});

test("one track per object id, with its biggest box as the best frame", () => {
  const tracks = summarizeTracks([box("2", 5, 40, 0.7), box("0", 0, 10, 0.5), box("0", 1, 30, 0.9), box("0", 2, 20)]);
  assert.deepEqual(
    tracks.map((t) => [t.objectId, t.frames, t.firstFrame, t.lastFrame, t.bestFrame, t.maxConfidence]),
    [
      ["0", 3, 0, 2, 1, 0.9],
      ["2", 1, 5, 5, 5, 0.7],
    ],
  );
});
