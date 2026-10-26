import assert from "node:assert/strict";
import { test } from "node:test";
import { boxInPixels } from "./locate.ts";

test("a 0-1000 box becomes frame pixels, clamped to the frame", () => {
  assert.deepEqual(boxInPixels({ visible: true, x_min: 55, y_min: 210, x_max: 665, y_max: 1020 }, 720, 1280), {
    left: 40,
    top: 269,
    right: 479,
    bottom: 1280,
  });
});

test("a missing or tiny box gives nothing to track", () => {
  assert.equal(boxInPixels({ visible: false, x_min: 0, y_min: 0, x_max: 500, y_max: 500 }, 720, 1280), null);
  assert.equal(boxInPixels({ visible: true, x_min: 500, y_min: 500, x_max: 505, y_max: 505 }, 720, 1280), null);
});
