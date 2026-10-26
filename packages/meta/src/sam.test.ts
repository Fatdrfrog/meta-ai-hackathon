import assert from "node:assert/strict";
import { test } from "node:test";
import type { SegmentationRecord } from "@meta-sam/parser";
import { bestMask, summarizeTracks } from "./sam.ts";

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

const mask = (objectId: string, size: number, confidence?: number): SegmentationRecord => ({
  kind: "mask",
  order: 0,
  objectId,
  identity: objectId,
  revision: 0,
  mask: { encoding: "lossless", payload: "", width: size, height: size },
  bounds: { left: 0, top: 0, right: size, bottom: size },
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

test("the best mask is the most confident one, the larger on a tie", () => {
  assert.equal(bestMask([mask("0", 50, 0.6), mask("1", 10, 0.9), mask("2", 20, 0.9)])?.objectId, "2");
  assert.equal(bestMask([box("0", 0, 10)]), undefined);
});
