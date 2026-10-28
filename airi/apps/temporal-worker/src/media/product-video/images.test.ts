import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import sharp from "sharp";

import {
  backdropColor,
  backdropShares,
  cropAroundProduct,
  cutOutWithMask,
  frameDifferences,
  numberedGrid,
  productBox,
  rotateCutout,
  shotAround,
  tiltOf,
  turnAndPad,
  WHITE,
} from "./images";
import { boxInPixels } from "./locate";
import {
  chooseFrame,
  largestComponent,
  subtractMasks,
  type FrameCandidate,
  type Mask,
} from "./masks";
import {
  chooseBackdrop,
  exampleName,
  restorePrompt,
  restoreSize,
} from "./restore";

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
  // As filmed, with no plain backdrop: the edge comes from the mask alone.
  const png = await cutOutWithMask(await redSquare(), halfSizeMask);
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

  // On a plain backdrop, the edge follows the photo's own: this square's is
  // sharp, and stays exactly where it is.
  const onBackdrop = await cutOutWithMask(await redSquare(), halfSizeMask, {
    backdrop: WHITE,
  });
  const edge = await sharp(onBackdrop).raw().toBuffer();
  for (let x = 0; x < 48; x++) {
    const opacity = edge[(24 * 48 + x) * 4 + 3]!;
    assert.equal(opacity, x >= 4 && x < 44 ? 255 : 0, `x ${x}`);
  }
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
  assert.match(prompt, /openwork, that background shows through them/);
  assert.match(
    prompt,
    /plain, flat mid-grey background, the same grey everywhere/,
  );
  assert.match(
    restorePrompt("grey stone vase", "white"),
    /plain pure white background/,
  );
  assert.match(
    restorePrompt("white medal hanger", "charcoal"),
    /plain, flat dark charcoal background/,
  );
  assert.match(prompt, /Light it evenly from the front/);
});

test("restores on grey, unless the product has noticeable grey", () => {
  // A frosted white cup, a carved wooden panel, a dark table.
  assert.deepEqual(chooseBackdrop({ white: 0.8, grey: 0, dark: 0.02 }), {
    backdrop: "grey",
    holes: true,
  });
  assert.deepEqual(chooseBackdrop({ white: 0.01, grey: 0.005, dark: 0 }), {
    backdrop: "grey",
    holes: true,
  });
  assert.deepEqual(chooseBackdrop({ white: 0, grey: 0.01, dark: 0.5 }), {
    backdrop: "grey",
    holes: true,
  });
  // A white medal hanger as filmed, its shading grey: charcoal, holes cut.
  assert.deepEqual(chooseBackdrop({ white: 0.47, grey: 0.13, dark: 0.08 }), {
    backdrop: "charcoal",
    holes: true,
  });
  // A grey stone vase: white, with holes cut while it has little white.
  assert.deepEqual(chooseBackdrop({ white: 0.01, grey: 0.4, dark: 0.1 }), {
    backdrop: "white",
    holes: true,
  });
  // Grey and white both, and more dark: holes stay on white, so no part of
  // it is lost with them.
  assert.deepEqual(chooseBackdrop({ white: 0.3, grey: 0.4, dark: 0.5 }), {
    backdrop: "white",
    holes: false,
  });
  // Mostly white with some grey and more dark: grey stays the least risk.
  assert.deepEqual(chooseBackdrop({ white: 0.33, grey: 0.03, dark: 0.48 }), {
    backdrop: "grey",
    holes: true,
  });
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

// A white letter on Muse Image's charcoal, its outline soft like a real
// render's, and SAM's mask 2 px too big all round, as when its smaller mask
// is scaled back up.
test("reads opacity along the outline from colour, so no rim of backdrop shows", async () => {
  const charcoal = { r: 44, g: 43, b: 43 };
  const image = await sharp(
    await sharp({
      create: { width: 100, height: 100, channels: 3, background: charcoal },
    })
      .composite([
        {
          input: {
            create: {
              width: 40,
              height: 20,
              channels: 3,
              background: "#ececec",
            },
          },
          left: 30,
          top: 40,
        },
      ])
      .png()
      .toBuffer(),
  )
    .blur(0.7)
    .png()
    .toBuffer();
  const mask: Mask = {
    raster: new Uint8Array(44 * 24).fill(1),
    width: 44,
    height: 24,
    bounds: { left: 28, top: 38, right: 72, bottom: 62 },
    confidence: 0.9,
  };

  const png = await cutOutWithMask(image, mask, { backdrop: charcoal });

  const { data } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let visible = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! < 40) continue;
    visible++;
    // Every visible pixel is the letter's white, none the charcoal's grey.
    assert.ok(
      data[i]! > 200,
      `pixel ${i / 4} is ${data[i]} at opacity ${data[i + 3]}`,
    );
  }
  // And none of the letter is lost.
  assert.ok(visible >= 40 * 20, `${visible} visible pixels`);
});

test("measures how much of a product is white, grey and dark", async () => {
  const square = (background: string) =>
    sharp({ create: { width: 10, height: 10, channels: 4, background } })
      .png()
      .toBuffer();
  assert.deepEqual(await backdropShares(await square("#f2f2f0")), {
    white: 1,
    grey: 0,
    dark: 0,
  });
  assert.deepEqual(await backdropShares(await square("#8c8c8c")), {
    white: 0,
    grey: 1,
    dark: 0,
  });
  assert.deepEqual(await backdropShares(await square("#2b2b2b")), {
    white: 0,
    grey: 0,
    dark: 1,
  });
  assert.deepEqual(await backdropShares(await square("#e0115f")), {
    white: 0,
    grey: 0,
    dark: 0,
  });
  // Nothing opaque: nothing of any.
  assert.deepEqual(await backdropShares(await square("#20202000")), {
    white: 0,
    grey: 0,
    dark: 0,
  });
});

// A white 80×40 hanger with a 20×10 slot, restored on Muse's grey, and a
// 12×8 name plate printed in a grey close to the backdrop's; SAM's mask
// covers the slot and the plate along with the hanger.
test("lets the backdrop through the product's holes, and only with holes on", async () => {
  const image = await sharp({
    create: { width: 120, height: 80, channels: 3, background: "#8c8c8c" },
  })
    .composite([
      {
        input: {
          create: { width: 80, height: 40, channels: 3, background: "#f4f4f4" },
        },
        left: 20,
        top: 20,
      },
      {
        input: {
          create: { width: 20, height: 10, channels: 3, background: "#8c8c8c" },
        },
        left: 50,
        top: 35,
      },
      {
        input: {
          create: { width: 12, height: 8, channels: 3, background: "#979797" },
        },
        left: 26,
        top: 26,
      },
    ])
    .png()
    .toBuffer();
  const hanger: Mask = {
    raster: new Uint8Array(80 * 40).fill(1),
    width: 80,
    height: 40,
    bounds: { left: 20, top: 20, right: 100, bottom: 60 },
    confidence: 0.9,
  };
  const grey = { r: 140, g: 140, b: 140 };
  const alphaAt = async (png: Buffer, x: number, y: number) => {
    const { data, info } = await sharp(png)
      .raw()
      .toBuffer({ resolveWithObject: true });
    return data[(y * info.width + x) * 4 + 3]!;
  };

  const punched = await cutOutWithMask(image, hanger, {
    backdrop: grey,
    holes: true,
  });
  // The cut-out starts 4 px before the hanger: the slot's middle is at (44, 19).
  assert.equal(await alphaAt(punched, 44, 19), 0);
  assert.equal(await alphaAt(punched, 14, 19), 255);
  // The plate is 11 from the backdrop's grey on every pixel: printed, kept.
  assert.equal(await alphaAt(punched, 16, 14), 255);

  const filled = await cutOutWithMask(image, hanger, { backdrop: grey });
  assert.equal(await alphaAt(filled, 44, 19), 255);
});

// A white plate with a narrow gap, like a letter's counter, its backdrop
// shaded 6 darker than the rest: let through on charcoal, where a shadow
// barely changes the colour, but kept on grey, where 6 off is grey print.
// A warm dark print beside it, and neutral ones on a dark medal and on a
// bright gold one, all as close to charcoal, stay.
test("lets a shaded gap through on a dark backdrop, not on grey", async () => {
  const plate = async (backdrop: string, gap: string) =>
    sharp({
      create: { width: 120, height: 80, channels: 3, background: backdrop },
    })
      .composite([
        {
          input: {
            create: {
              width: 80,
              height: 40,
              channels: 3,
              background: "#f4f4f4",
            },
          },
          left: 20,
          top: 20,
        },
        {
          input: {
            create: { width: 6, height: 24, channels: 3, background: gap },
          },
          left: 57,
          top: 28,
        },
        {
          input: {
            create: {
              width: 12,
              height: 12,
              channels: 3,
              background: "#322b25",
            },
          },
          left: 30,
          top: 30,
        },
        // A dark medal with a neutral dark print on it, as close.
        {
          input: {
            create: {
              width: 16,
              height: 16,
              channels: 3,
              background: "#5a461e",
            },
          },
          left: 76,
          top: 30,
        },
        {
          input: {
            create: { width: 8, height: 8, channels: 3, background: "#262626" },
          },
          left: 80,
          top: 34,
        },
        {
          input: {
            create: {
              width: 12,
              height: 12,
              channels: 3,
              background: "#d2aa3c",
            },
          },
          left: 24,
          top: 44,
        },
        {
          input: {
            create: { width: 6, height: 6, channels: 3, background: "#262626" },
          },
          left: 27,
          top: 47,
        },
      ])
      .png()
      .toBuffer();
  const mask: Mask = {
    raster: new Uint8Array(80 * 40).fill(1),
    width: 80,
    height: 40,
    bounds: { left: 20, top: 20, right: 100, bottom: 60 },
    confidence: 0.9,
  };
  // In the cut-out that starts 4 px before the plate: the gap's middle, and
  // the prints'.
  const alphaAt = async (png: Buffer, x: number, y: number) => {
    const { data, info } = await sharp(png)
      .raw()
      .toBuffer({ resolveWithObject: true });
    return data[(y * info.width + x) * 4 + 3]!;
  };
  const gapAlpha = (png: Buffer) => alphaAt(png, 44, 24);

  const onCharcoal = await cutOutWithMask(
    await plate("#2c2b2b", "#262525"),
    mask,
    {
      backdrop: { r: 44, g: 43, b: 43 },
      holes: true,
    },
  );
  assert.equal(await gapAlpha(onCharcoal), 0);
  assert.equal(await alphaAt(onCharcoal, 20, 20), 255);
  assert.equal(await alphaAt(onCharcoal, 68, 22), 255);
  assert.equal(await alphaAt(onCharcoal, 14, 34), 255);

  const onGrey = await cutOutWithMask(await plate("#8c8c8c", "#868686"), mask, {
    backdrop: { r: 140, g: 140, b: 140 },
    holes: true,
  });
  assert.equal(await gapAlpha(onGrey), 255);
});

// A 300×60 bar on a transparent canvas, turned the way an owner holds a
// medal hanger at a slant.
const bar = async (degrees: number) =>
  sharp(
    await sharp({
      create: {
        width: 400,
        height: 400,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        {
          input: {
            create: {
              width: 300,
              height: 60,
              channels: 4,
              background: "#c8a165",
            },
          },
          left: 50,
          top: 170,
        },
      ])
      .png()
      .toBuffer(),
  )
    .rotate(degrees, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

test("finds how far a box-like product is turned, and levels it to the nearer axis", async () => {
  const slanted = await bar(30);
  const tilt = await tiltOf(slanted);
  assert.ok(tilt !== null && Math.abs(tilt - 30) <= 1.5, `tilt ${tilt}`);
  const level = await sharp(await rotateCutout(slanted, -tilt!)).metadata();
  assert.ok(level.width! > 3 * level.height!, `${level.width}×${level.height}`);

  // Turned 60°, it is nearer upright: levelled to vertical, a quarter turn
  // from horizontal that needs no redrawing.
  const steep = await bar(60);
  const steepTilt = await tiltOf(steep);
  assert.ok(
    steepTilt !== null && Math.abs(steepTilt + 30) <= 1.5,
    `tilt ${steepTilt}`,
  );
  const upright = await sharp(
    await rotateCutout(steep, -steepTilt!),
  ).metadata();
  assert.ok(
    upright.height! > 3 * upright.width!,
    `${upright.width}×${upright.height}`,
  );
});

test("leaves level products and shapes with no level alone", async () => {
  assert.equal(await tiltOf(await bar(0)), null);
  // A triangle fits a rectangle along any of its sides; a disc at any angle.
  const shape = (svg: string) =>
    sharp(Buffer.from(svg))
      .rotate(20, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
  assert.equal(
    await tiltOf(
      await shape(
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><polygon points="100,10 190,190 10,190" fill="#2a6"/></svg>',
      ),
    ),
    null,
  );
  assert.equal(
    await tiltOf(
      await shape(
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><circle cx="100" cy="100" r="90" fill="#2a6"/></svg>',
      ),
    ),
    null,
  );
});

test("takes a presenter in front of a product out of its mask", () => {
  // The product, 40×20 at (10, 10), sent at half size as SAM sends masks.
  const product: Mask = {
    raster: new Uint8Array(20 * 10).fill(1),
    width: 20,
    height: 10,
    bounds: { left: 10, top: 10, right: 50, bottom: 30 },
    confidence: 0.8,
  };
  // The presenter covers the product's right quarter and more.
  const presenter: Mask = {
    raster: new Uint8Array(30 * 40).fill(1),
    width: 30,
    height: 40,
    bounds: { left: 40, top: 0, right: 70, bottom: 40 },
    confidence: 0.9,
  };

  const left = subtractMasks(product, [presenter], 80, 50);
  assert.ok(left);
  assert.equal(left.kept, 0.75);
  assert.deepEqual(left.mask.bounds, {
    left: 10,
    top: 10,
    right: 40,
    bottom: 30,
  });
  assert.equal(left.mask.confidence, 0.8);
  assert.equal(left.mask.raster.length, 30 * 20);

  // SAM's product mask took in the presenter, top to bottom of the frame,
  // and its mask of her is a pixel narrower: the strip left along her edge
  // reaches both edges of the frame, unless her mask is grown first.
  const withPresenter: Mask = {
    raster: new Uint8Array(70 * 50).map((_, i) =>
      i % 70 < 40 && Math.floor(i / 70) >= 10 && Math.floor(i / 70) < 30
        ? 1
        : i % 70 >= 39
          ? 1
          : 0,
    ),
    width: 70,
    height: 50,
    bounds: { left: 10, top: 0, right: 80, bottom: 50 },
    confidence: 0.8,
  };
  const narrower: Mask = {
    ...presenter,
    raster: new Uint8Array(30 * 50).fill(1),
    height: 50,
    bounds: { left: 50, top: 0, right: 80, bottom: 50 },
  };
  const strip = subtractMasks(withPresenter, [narrower], 80, 50);
  assert.ok(strip);
  assert.deepEqual([strip.mask.bounds.top, strip.mask.bounds.bottom], [0, 50]);
  const cleaned = subtractMasks(withPresenter, [narrower], 80, 50, 2);
  assert.ok(cleaned);
  // The product loses the 2 px it shared an edge with her, and nothing else.
  assert.deepEqual(cleaned.mask.bounds, {
    left: 10,
    top: 10,
    right: 48,
    bottom: 30,
  });

  // Nothing left when the presenter covers all of it.
  assert.equal(
    subtractMasks(
      product,
      [{ ...presenter, bounds: { left: 0, top: 0, right: 80, bottom: 50 } }],
      80,
      50,
    ),
    null,
  );
});

// A white bar with a short 4 px leg below it, on Muse's grey; SAM's mask,
// made smaller than the image, covers the bar but not the leg.
test("refines a mask by colour, keeping thin parts SAM missed", async () => {
  const image = await sharp({
    create: { width: 120, height: 80, channels: 3, background: "#8c8c8c" },
  })
    .composite([
      {
        input: {
          create: { width: 60, height: 16, channels: 3, background: "#f6f6f6" },
        },
        left: 30,
        top: 20,
      },
      {
        input: {
          create: { width: 4, height: 8, channels: 3, background: "#f6f6f6" },
        },
        left: 58,
        top: 36,
      },
    ])
    .png()
    .toBuffer();
  const bar: Mask = {
    raster: new Uint8Array(30 * 8).fill(1),
    width: 30,
    height: 8,
    bounds: { left: 30, top: 20, right: 90, bottom: 36 },
    confidence: 0.9,
  };
  const grey = { r: 140, g: 140, b: 140 };
  const alphaAt = async (png: Buffer, x: number, y: number) => {
    const { data, info } = await sharp(png)
      .raw()
      .toBuffer({ resolveWithObject: true });
    return data[(y * info.width + x) * 4 + 3]!;
  };

  const refined = await cutOutWithMask(image, bar, {
    backdrop: grey,
    refine: true,
  });
  const { height } = await sharp(refined).metadata();
  // The leg is kept: the cut-out reaches below the bar, and it is opaque.
  assert.ok(height! > 16 + 8, `height ${height}`);
  assert.ok((await alphaAt(refined, 33, 24)) > 200);
  // The grey beside the leg is still background.
  assert.equal(await alphaAt(refined, 22, 24), 0);

  const plain = await cutOutWithMask(image, bar, { backdrop: grey });
  assert.equal((await sharp(plain).metadata()).height, 16 + 8);
});

test("turns a crop and gives it room for Muse Image to complete the product", async () => {
  const crop = await sharp({
    create: { width: 200, height: 100, channels: 3, background: "#d0b090" },
  })
    .jpeg()
    .toBuffer();

  const padded = await sharp(
    await turnAndPad(crop, { degrees: 0, pad: true }),
  ).metadata();
  assert.deepEqual([padded.width, padded.height], [260, 130]);
  assert.equal(padded.format, "jpeg");

  const turned = await sharp(
    await turnAndPad(crop, { degrees: 90, pad: false }),
  ).metadata();
  assert.deepEqual([turned.width, turned.height], [100, 200]);
});

test("writes an example name in the narration's language where lettering is hidden", () => {
  assert.equal(exampleName("Kazakh"), "Айбек Нұрланұлы");
  assert.equal(exampleName("kk"), "Айбек Нұрланұлы");
  assert.equal(exampleName("Russian"), "Алексей Смирнов");
  assert.equal(exampleName(null), "Anna Smith");
  // The hidden names of one family tree don't all read the same.
  assert.equal(exampleName("kk", 1), "Ерлан Асқарұлы");
  assert.equal(exampleName(null, 6), "Anna Smith");
  const prompt = restorePrompt("medal hanger", "grey", { completes: true });
  assert.match(prompt, /Never write garbled letters/);
  assert.match(prompt, /make it match the other end/);
  assert.doesNotMatch(restorePrompt("medal hanger"), /runs past the edges/);
  // With nothing hidden, no words are written in: a table's caption once
  // became a name on its leg.
  assert.doesNotMatch(prompt, /Айбек|its lettering is hidden/);

  const piece = (text: string, readable: boolean, personName = false) => ({
    where: "",
    text,
    readable,
    personName,
  });
  // A family tree, more names than Muse Spark lists: only the hidden ones
  // are written in, and the rest kept, so no name plate is dropped.
  const tree = restorePrompt("family tree panel", "grey", {
    lettering: [
      piece("АРҒЫН", true),
      piece("Әлібек", true, true),
      piece("Бозымбай", true, true),
      piece("Айбек Нұрланұлы", false, true),
      piece("Жәнібек", true, true),
      piece("Ерлан Асқарұлы", false, true),
    ],
  });
  assert.match(
    tree,
    /in place of any letters that show there: "Айбек Нұрланұлы"; "Ерлан Асқарұлы"\. Keep all its other lettering as it is\./,
  );
  assert.doesNotMatch(tree, /Әлібек|АРҒЫН/);
  // A clock's hidden maker mark, no name: written in, the rest kept.
  assert.match(
    restorePrompt("wall clock", "grey", {
      lettering: [piece("12", true), piece("Quartz", false)],
    }),
    /in place of any letters that show there: "Quartz"\. Keep all its other/,
  );
});
