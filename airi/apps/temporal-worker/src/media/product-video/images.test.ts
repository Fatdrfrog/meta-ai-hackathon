import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import sharp from "sharp";

import {
  cropAroundProduct,
  cutOutWithMask,
  nonWhiteBox,
  numberedGrid,
} from "./images";
import { boxInPixels } from "./locate";
import {
  chooseFrame,
  largestComponent,
  type FrameCandidate,
  type Mask,
} from "./masks";
import { restorePrompt, restoreSize } from "./restore";

// A 100×100 white image with a red 40×40 square at (30, 30), and SAM's mask
// of it at half size, the way SAM sends masks smaller than their bounds.
const redSquare = () =>
  sharp({
    create: { width: 100, height: 100, channels: 3, background: "#ffffff" },
  })
    .composite([
      {
        input: {
          create: { width: 40, height: 40, channels: 3, background: "#ff0000" },
        },
        left: 30,
        top: 30,
      },
    ])
    .png()
    .toBuffer();
const halfSizeMask: Mask = {
  raster: new Uint8Array(20 * 20).fill(1),
  width: 20,
  height: 20,
  bounds: { left: 30, top: 30, right: 70, bottom: 70 },
  confidence: 0.9,
};

test("cuts out with smooth edges, trimmed to the product", async () => {
  const png = await cutOutWithMask(await redSquare(), halfSizeMask, {
    whiteBackground: true,
  });
  const { data, info } = await sharp(png)
    .raw()
    .toBuffer({ resolveWithObject: true });

  assert.equal(info.channels, 4);
  assert.deepEqual([info.width, info.height], [48, 48]);
  const alphas = new Set<number>();
  for (let i = 3; i < data.length; i += 4) alphas.add(data[i]!);
  assert.ok(alphas.has(0) && alphas.has(255));
  assert.ok(
    [...alphas].some((a) => a > 0 && a < 255),
    "edges are soft, not on/off",
  );
  const centre = (24 * 48 + 24) * 4;
  assert.deepEqual([...data.subarray(centre, centre + 4)], [255, 0, 0, 255]);
});

// Pixels that would show as a pale ring on a dark background: visible, and
// white rather than the product's red.
async function haloPixels(png: Buffer): Promise<number> {
  const { data } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (
      data[i + 3]! > 40 &&
      Math.min(data[i]!, data[i + 1]!, data[i + 2]!) > 180
    )
      count++;
  }
  return count;
}

test("leaves no white ring, even when SAM's mask is a pixel too big", async () => {
  const exact = await cutOutWithMask(await redSquare(), halfSizeMask, {
    whiteBackground: true,
  });
  const generous = await cutOutWithMask(
    await redSquare(),
    {
      ...halfSizeMask,
      raster: new Uint8Array(42 * 42).fill(1),
      width: 42,
      height: 42,
      bounds: { left: 29, top: 29, right: 71, bottom: 71 },
    },
    { whiteBackground: true },
  );

  assert.equal(await haloPixels(exact), 0);
  assert.equal(await haloPixels(generous), 0);
});

async function tempFile(t: TestContext, name: string) {
  const dir = await mkdtemp(join(tmpdir(), "product-images-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, name);
}

test("crops the product with room around it, inside the frame", async (t) => {
  const framePath = await tempFile(t, "frame.jpg");
  await sharp(await redSquare())
    .jpeg()
    .toFile(framePath);

  const { image, box } = await cropAroundProduct(framePath, {
    left: 5,
    top: 30,
    right: 70,
    bottom: 70,
  });

  assert.deepEqual(box, { left: 0, top: 24, right: 80, bottom: 76 });
  const meta = await sharp(image).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ["jpeg", 80, 52]);
});

test("numbers frames in a grid", async (t) => {
  const path = await tempFile(t, "frame.jpg");
  await sharp({
    create: { width: 36, height: 64, channels: 3, background: "#123456" },
  })
    .jpeg()
    .toFile(path);
  const grid = await numberedGrid([path, path, path, path, path]);
  const meta = await sharp(grid).metadata();
  assert.deepEqual([meta.width, meta.height], [4 * 360, 2 * 640]);

  // A landscape video gets landscape tiles, not its middle third.
  const wide = await tempFile(t, "wide.jpg");
  await sharp({
    create: { width: 64, height: 36, channels: 3, background: "#654321" },
  })
    .jpeg()
    .toFile(wide);
  const wideGrid = await sharp(await numberedGrid([wide, wide])).metadata();
  assert.deepEqual([wideGrid.width, wideGrid.height], [2 * 640, 360]);
});

test("keeps the largest piece of a mask", () => {
  const raster = new Uint8Array([1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 0, 0]);
  const { mask, share } = largestComponent({
    ...halfSizeMask,
    raster,
    width: 4,
    height: 3,
  });
  assert.deepEqual([...mask.raster], [1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0]);
  assert.equal(share, 4 / 5);
});

test("chooses a whole, big, sharp view of the product", () => {
  const candidate = (
    frameIndex: number,
    area: number,
    sharpness: number,
    overrides: Partial<FrameCandidate> = {},
  ): FrameCandidate => ({
    frameIndex,
    mask: halfSizeMask,
    share: 1,
    area,
    touchesEdge: false,
    sharpness,
    ...overrides,
  });

  const best = chooseFrame([
    // Sharpest of all, but cut off by the frame's edge.
    candidate(0, 1000, 9, { touchesEdge: true }),
    // A sharp close-up of one detail: under 70% of the biggest whole view.
    candidate(1, 600, 8),
    candidate(2, 1000, 3),
    candidate(3, 900, 5),
    // In two pieces.
    candidate(4, 1000, 7, { share: 0.6 }),
  ]);
  assert.equal(best?.frameIndex, 3);
  assert.equal(chooseFrame([]), undefined);
});

test("turns Muse's 0-1000 box into pixels, dropping specks", () => {
  const box = { visible: true, x_min: 100, y_min: 250, x_max: 600, y_max: 750 };
  assert.deepEqual(boxInPixels(box, 720, 1280), {
    left: 72,
    top: 320,
    right: 432,
    bottom: 960,
  });
  assert.equal(boxInPixels({ ...box, visible: false }, 720, 1280), null);
  assert.equal(boxInPixels({ ...box, x_max: 105 }, 720, 1280), null);
});

test("asks Muse Image for the crop's shape and an honest restore", () => {
  assert.equal(restoreSize(720, 1079), "1024x1536");
  assert.equal(restoreSize(720, 784), "1024x1024");
  assert.equal(restoreSize(1280, 720), "1536x1024");
  const prompt = restorePrompt("LOL doll");
  assert.match(prompt, /Remove the person's hand/);
  assert.match(prompt, /do not retouch, beautify or idealise it/);
});

test("finds the product on a white background by what isn't white", async () => {
  assert.deepEqual(await nonWhiteBox(await redSquare()), {
    left: 30,
    top: 30,
    right: 70,
    bottom: 70,
  });
  const blank = await sharp({
    create: { width: 20, height: 20, channels: 3, background: "#ffffff" },
  })
    .png()
    .toBuffer();
  assert.equal(await nonWhiteBox(blank), null);
});
