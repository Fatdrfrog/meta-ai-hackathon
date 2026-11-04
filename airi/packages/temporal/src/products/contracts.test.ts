import assert from "node:assert/strict";
import test from "node:test";

import {
  PRODUCT_AD_MOTIONS,
  PRODUCT_AD_STILL_KINDS,
  PRODUCT_AD_STILL_SET_MAX,
  PRODUCT_AD_STILL_SHAPES,
  PRODUCT_AD_STUDIO_COLOURWAYS,
  PRODUCT_AD_STUDIO_SWEEPS,
  PRODUCT_AD_MAX_PRODUCTS,
  productAdMotionOf,
} from "./contracts";

test("an ad from before motions, or with one this reader doesn't know, moves as the shelf ad", () => {
  assert.equal(productAdMotionOf(undefined), "shelf");
  assert.equal(productAdMotionOf(null), "shelf");
  assert.equal(productAdMotionOf("turntable"), "shelf");
  for (const motion of PRODUCT_AD_MOTIONS)
    assert.equal(productAdMotionOf(motion), motion);
});

test("every studio colourway has a sweep and an ink, none of them black", () => {
  assert.equal(PRODUCT_AD_STUDIO_COLOURWAYS.length, 5);
  for (const colourway of PRODUCT_AD_STUDIO_COLOURWAYS) {
    const sweep = PRODUCT_AD_STUDIO_SWEEPS[colourway];
    for (const colour of [sweep.top, sweep.bottom, sweep.ink]) {
      assert.match(colour, /^#[0-9a-f]{6}$/);
      assert.notEqual(colour, "#000000");
    }
  }
});

test("the most stills one render draws follows from the still shapes", () => {
  let most = 0;
  for (const kind of PRODUCT_AD_STILL_KINDS) {
    const shape = PRODUCT_AD_STILL_SHAPES[kind];
    const colourways =
      kind === "studio" ? PRODUCT_AD_STUDIO_COLOURWAYS.length : 1;
    const products = shape.perProduct ? PRODUCT_AD_MAX_PRODUCTS : 1;
    most += shape.formats.length * colourways * products;
  }
  assert.equal(most, PRODUCT_AD_STILL_SET_MAX);
});
