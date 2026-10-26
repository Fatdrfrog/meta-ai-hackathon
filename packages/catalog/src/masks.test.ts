import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseFrame, largestComponent, subtractMask, touchesEdge, type FrameCandidate, type Mask } from "./masks.ts";

const mask = (rows: string[], left = 0, top = 0, confidence = 0.9): Mask => {
  const width = rows[0]!.length;
  return {
    raster: Uint8Array.from(rows.join("").split(""), (c) => (c === "#" ? 1 : 0)),
    width,
    height: rows.length,
    bounds: { left, top, right: left + width, bottom: top + rows.length },
    confidence,
  };
};
const show = (m: Mask) => Array.from({ length: m.height }, (_, y) => [...m.raster.slice(y * m.width, (y + 1) * m.width)].map((v) => (v ? "#" : ".")).join(""));

test("specks are dropped and the share says how whole the mask was", () => {
  const { mask: kept, share } = largestComponent(mask(["##..#", "##...", "....."]));
  assert.deepEqual(show(kept), ["##...", "##...", "....."]);
  assert.equal(share, 4 / 5);
});

test("pieces touching only at a corner are separate", () => {
  assert.equal(largestComponent(mask(["#.", ".#"])).share, 0.5);
});

test("a hand mask placed elsewhere in the frame clears only the overlap", () => {
  const product = mask(["####", "####"], 10, 20);
  const hand = mask(["##", "##"], 12, 21);
  assert.deepEqual(show(subtractMask(product, hand)), ["####", "##.."]);
});

test("a mask at the frame's edge counts as cut off", () => {
  assert.ok(touchesEdge({ left: 0, top: 50, right: 100, bottom: 200 }, 720, 1280));
  assert.ok(!touchesEdge({ left: 40, top: 50, right: 600, bottom: 1200 }, 720, 1280));
});

const candidate = (frameIndex: number, area: number, sharpness: number, extra: Partial<FrameCandidate> = {}): FrameCandidate => ({
  frameIndex,
  mask: mask(["#"], 0, 0, 0.9),
  share: 1,
  area,
  touchesEdge: false,
  sharpness,
  ...extra,
});

test("a sharp close-up of a detail loses to a whole view", () => {
  // The doll's face alone was the sharpest frame; the whole doll must win.
  const face = candidate(50, 300, 9);
  const whole = candidate(14, 1000, 5);
  assert.equal(chooseFrame([face, whole])?.frameIndex, 14);
});

test("cut-off and broken views are skipped while a whole one exists", () => {
  const cutOff = candidate(1, 1200, 9, { touchesEdge: true });
  const broken = candidate(2, 1100, 9, { share: 0.6 });
  const whole = candidate(3, 900, 4);
  assert.equal(chooseFrame([cutOff, broken, whole])?.frameIndex, 3);
});

test("among whole views the sharpest wins, and nothing comes from nothing", () => {
  assert.equal(chooseFrame([candidate(1, 1000, 3), candidate(2, 950, 6)])?.frameIndex, 2);
  assert.equal(chooseFrame([]), undefined);
});
