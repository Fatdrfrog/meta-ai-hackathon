import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import sharp from "sharp";

import {
  backdropColor,
  cropAroundProduct,
  cutOutWithMask,
  frameDifferences,
  isMostlyLight,
  numberedGrid,
  productBox,
  shotAround,
  WHITE,
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
    backdrop: WHITE,
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
    backdrop: WHITE,
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
    { backdrop: WHITE },
  );

  assert.equal(await haloPixels(exact), 0);
  assert.equal(await haloPixels(generous), 0);
});

// A second SAM mask that adds a speck far from the product, the way joined
// masks left white specks beside a clock on the second test video.
const speckMask = (left: number, top: number, size: number): Mask => ({
  raster: new Uint8Array(size * size).fill(1),
  width: size,
  height: size,
  bounds: { left, top, right: left + size, bottom: top + size },
  confidence: 0.9,
});

test("drops stray pieces of joined masks and trims to the product", async () => {
  const png = await cutOutWithMask(
    await redSquare(),
    [halfSizeMask, speckMask(4, 4, 6), speckMask(84, 80, 5)],
    { backdrop: WHITE },
  );
  const { info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });

  assert.deepEqual([info.width, info.height], [48, 48]);
});

test("keeps both halves of a pair", async () => {
  const pair = await sharp({
    create: { width: 100, height: 100, channels: 3, background: "#ffffff" },
  })
    .composite(
      [10, 60].map((left) => ({
        input: {
          create: { width: 30, height: 30, channels: 3, background: "#ff0000" },
        },
        left,
        top: 30,
      })),
    )
    .png()
    .toBuffer();
  const png = await cutOutWithMask(
    pair,
    [speckMask(10, 30, 30), speckMask(60, 30, 30)],
    { backdrop: WHITE },
  );
  const { info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });

  assert.deepEqual([info.width, info.height], [88, 38]);
});

// Frame-to-frame differences shaped like the test videos': a still edited
// promo with a hard cut (the medal hanger's clip cut to the next scene at
// 0.21), and a hand-held video whose fast swing reached 0.16 among busy
// neighbours.
const still = (length: number) =>
  Array.from({ length }, (_, i) => (i === 0 ? 0 : 0.004 + (i % 3) * 0.002));

test("finds the shot a frame belongs to, splitting at hard cuts only", () => {
  const promo = still(34);
  promo[32] = 0.21;
  assert.deepEqual(shotAround(promo, 2), { first: 0, last: 31 });
  assert.deepEqual(shotAround(promo, 33), { first: 32, last: 33 });

  const handHeld = Array.from({ length: 40 }, (_, i) =>
    i === 0 ? 0 : 0.03 + (i % 4) * 0.02,
  );
  handHeld[20] = 0.13;
  handHeld[21] = 0.16;
  handHeld[22] = 0.12;
  assert.deepEqual(shotAround(handHeld, 5), { first: 0, last: 39 });
});

test("measures how much each frame differs from the one before", async (t) => {
  const frame = async (name: string, background: string) => {
    const path = await tempFile(t, name);
    await sharp({
      create: { width: 64, height: 64, channels: 3, background },
    })
      .jpeg()
      .toFile(path);
    return path;
  };
  const black = await frame("a.jpg", "#000000");
  const differences = await frameDifferences([
    black,
    await frame("b.jpg", "#000000"),
    await frame("c.jpg", "#ffffff"),
  ]);

  assert.equal(differences.length, 3);
  assert.deepEqual(differences.slice(0, 2), [0, 0]);
  assert.ok(differences[2]! > 0.95);
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
  assert.match(
    prompt,
    /captions, subtitles, prices, stickers or logos laid over the video/,
  );
  assert.match(prompt, /engraved or written on the product itself stays/);
  assert.match(prompt, /plain pure white background/);
  assert.match(
    restorePrompt("medal hanger", "grey"),
    /plain, flat mid-grey background, the same grey everywhere/,
  );
});

test("finds the product on a white background by what isn't white", async () => {
  assert.deepEqual(await productBox(await redSquare()), {
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
  assert.equal(await productBox(blank), null);
});

// A white medal hanger on Muse Image's grey: the product is told apart from
// the backdrop by colour, whatever the backdrop is.
const onGrey = () =>
  sharp({
    create: { width: 100, height: 100, channels: 3, background: "#8c8c8c" },
  })
    .composite([
      {
        input: {
          create: { width: 40, height: 20, channels: 3, background: "#f4f4f4" },
        },
        left: 20,
        top: 50,
      },
    ])
    .png()
    .toBuffer();

test("finds the product on any plain backdrop, and the backdrop's colour", async () => {
  const image = await onGrey();
  const grey = await backdropColor(image);

  assert.deepEqual(grey, { r: 140, g: 140, b: 140 });
  assert.deepEqual(await productBox(image, grey), {
    left: 20,
    top: 50,
    right: 60,
    bottom: 70,
  });
  // Grey is no product, but on white it would be.
  const blank = await sharp({
    create: { width: 20, height: 20, channels: 3, background: "#8c8c8c" },
  })
    .png()
    .toBuffer();
  assert.equal(await productBox(blank, grey), null);
  assert.notEqual(await productBox(blank, WHITE), null);
});

test("takes a grey backdrop back out of the edge pixels, not white", async () => {
  // Softened, like a real photo: edge pixels mix product and backdrop.
  const image = await sharp(await onGrey())
    .blur(1.5)
    .png()
    .toBuffer();
  const mask = {
    raster: new Uint8Array(20 * 10).fill(1),
    width: 20,
    height: 10,
    bounds: { left: 20, top: 50, right: 60, bottom: 70 },
    confidence: 0.9,
  };
  const png = await cutOutWithMask(image, mask, {
    backdrop: { r: 140, g: 140, b: 140 },
  });
  const { data } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  // Every visible pixel is the product's near-white, none the backdrop's grey.
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! < 40) continue;
    assert.ok(data[i]! > 200, `pixel ${i / 4} is ${data[i]}`);
  }
});

test("tells a mostly light product from a darker one", async () => {
  const square = (background: string) =>
    sharp({ create: { width: 10, height: 10, channels: 4, background } })
      .png()
      .toBuffer();
  assert.equal(await isMostlyLight(await square("#f2f2f0")), true);
  assert.equal(await isMostlyLight(await square("#e0115f")), false);
  assert.equal(await isMostlyLight(await square("#20202000")), false);
});
