import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";

import type { Pcm } from "./audio";
import { composeAd, type ComposeProduct } from "./compose";
import { exactScene } from "./layers";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const cutout = (color: string) =>
  sharp({
    create: {
      width: 300,
      height: 500,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="500"><rect x="40" y="40" width="220" height="420" fill="${color}"/></svg>`,
        ),
      },
    ])
    .png()
    .toBuffer();

/** A second and a half of a tone, like a line read in a voice. */
const line = (): Pcm => {
  const samples = new Int16Array(48000 * 1.5);
  for (let i = 0; i < samples.length; i++)
    samples[i] = Math.round(6000 * Math.sin((2 * Math.PI * 220 * i) / 48000));
  return { samples, sampleRate: 48000 };
};

async function product(
  productId: string,
  overrides: Partial<ComposeProduct> = {},
): Promise<ComposeProduct> {
  const cut = await cutout(productId === "p1" ? "#3b82f6" : "#e5e7eb");
  const exact = await exactScene(cut);
  return {
    productId,
    name: productId === "p1" ? "Кукла Лол" : "Кружка",
    priceText: "5 000 ₸",
    cutout: cut,
    picture: exact.image,
    box: exact.box,
    caption: "Балаңызға керемет сыйлық",
    voice: null,
    ...overrides,
  };
}

test(
  "the plan records each scene's voice-over and its line, and the words' overlap per product",
  { skip: hasFfmpeg ? false : "ffmpeg is not installed" },
  async (t) => {
    const workDir = await mkdtemp(join(tmpdir(), "product-ad-compose-"));
    t.after(() => rm(workDir, { recursive: true, force: true, maxRetries: 5 }));
    const composed = await composeAd({
      products: [
        await product("p1", {
          voice: line(),
          spoken: "Балаңызға керемет сыйлық, бес мың теңге.",
        }),
        // A product standing high, its words forced to the top over it.
        await product("p2", {
          box: { x: 0.2, y: 0.15, w: 0.6, h: 0.35 },
          textZone: "top",
        }),
      ],
      sticker: "Жаңа тауар",
      priceCardTitle: "Біздің бағалар",
      ending: "WhatsApp-қа жазыңыз",
      shopName: "Demo Shop",
      phone: null,
      presenter: null,
      workDir,
    });
    // The new words' line and where the voice track places it.
    const voiced = composed.timeline.scenes[0]!;
    assert.equal(voiced.kind, "product");
    assert.deepEqual(composed.plan.scenes[0]!.voice, {
      line: "Балаңызға керемет сыйлық, бес мың теңге.",
      ...(voiced.kind === "product" ? voiced.voice : null),
    });
    assert.ok(composed.plan.scenes[0]!.voice!.seconds > 1.4);
    // A silent scene, the price card and the ending carry none.
    assert.equal(composed.plan.scenes[1]!.voice, null);
    assert.equal(composed.plan.scenes[2]!.voice, undefined);
    // The track the render maps as the video's sound.
    assert.ok(composed.plan.voice);
    assert.deepEqual(composed.textOverlap, [
      { covers: false, suggested: null },
      { covers: true, suggested: "bottom" },
    ]);
  },
);

test("a recording's scene carries its placement without a line", async (t) => {
  if (!hasFfmpeg) return t.skip("ffmpeg is not installed");
  const workDir = await mkdtemp(join(tmpdir(), "product-ad-compose-"));
  t.after(() => rm(workDir, { recursive: true, force: true, maxRetries: 5 }));
  const composed = await composeAd({
    products: [await product("p1", { voice: line() })],
    sticker: "",
    priceCardTitle: "Біздің бағалар",
    ending: "WhatsApp-қа жазыңыз",
    shopName: "Demo Shop",
    phone: null,
    presenter: null,
    workDir,
  });
  assert.equal(composed.plan.scenes[0]!.voice!.line, null);
});

// ---------------------------------------------------------------------------
// Studio v3: the motions.

const filmedFrame = () =>
  sharp({
    create: { width: 300, height: 520, channels: 3, background: "#7a6a5a" },
  })
    .jpeg()
    .toBuffer();

async function composeWith(
  t: { after: (fn: () => Promise<void>) => void },
  motion: unknown,
  products: ComposeProduct[],
  sticker = "Жаңа тауар",
) {
  const workDir = await mkdtemp(join(tmpdir(), "product-ad-compose-"));
  t.after(() => rm(workDir, { recursive: true, force: true, maxRetries: 5 }));
  return composeAd({
    products,
    sticker,
    priceCardTitle: "Біздің бағалар",
    ending: "WhatsApp-қа жазыңыз",
    shopName: "Demo Shop",
    phone: null,
    presenter: null,
    workDir,
    motion: motion as never,
  });
}

test("shelf, an absent or an unknown motion: v2's scenes, the poster at 1.2 s", async (t) => {
  if (!hasFfmpeg) return t.skip("ffmpeg is not installed");
  for (const motion of [undefined, "shelf", "spin"]) {
    const composed = await composeWith(t, motion, [
      await product("p1", { original: await filmedFrame(), made: true }),
    ]);
    const scene = composed.plan.scenes[0]!;
    assert.equal(scene.opening, undefined, String(motion));
    assert.equal(scene.subject, undefined);
    assert.equal(scene.blur, undefined);
    assert.equal(scene.zoomTo, 1.06);
    assert.equal(composed.posterSeconds, 1.2);
  }
});

test("Filmed → Sold: each product with a filmed frame opens on it, circle first and wipes after; one without keeps the shelf scene", async (t) => {
  if (!hasFfmpeg) return t.skip("ffmpeg is not installed");
  const original = await filmedFrame();
  const composed = await composeWith(t, "filmed_sold", [
    await product("p1", { original }),
    await product("p2", { original: null }),
    await product("p3", { original }),
  ]);
  const [first, second, third] = composed.plan.scenes;
  assert.equal(first!.opening!.transition, "circleopen");
  assert.equal(first!.opening!.seconds, 1.2);
  assert.equal(second!.opening, undefined);
  assert.equal(third!.opening!.transition, "wiperight");
  // The filmed frame is cut to the 9:16 frame.
  const meta = await sharp(first!.opening!.background).metadata();
  assert.deepEqual([meta.width, meta.height], [1080, 1920]);
  // The scenes with a filmed frame are longer by it; the one without isn't.
  const shelf = await composeWith(t, "shelf", [
    await product("p1"),
    await product("p2"),
    await product("p3"),
  ]);
  assert.ok(first!.seconds >= shelf.plan.scenes[0]!.seconds);
  assert.ok(Math.abs(second!.seconds - shelf.plan.scenes[1]!.seconds) < 0.04);
  assert.ok(
    Math.abs(third!.seconds - shelf.plan.scenes[2]!.seconds - 1.2) < 0.04,
  );
  assert.ok(composed.timeline.totalSeconds <= 20);
  // The poster: just past the circle, while the sticker is in.
  assert.ok(Math.abs(composed.posterSeconds! - 1.58) < 1e-9);
  // With no sticker, once the words are in.
  const quiet = await composeWith(
    t,
    "filmed_sold",
    [await product("p1", { original })],
    "",
  );
  assert.ok(Math.abs(quiet.posterSeconds! - 2.55) < 1e-9);
});

test("Float: the cut-out and its shadow are layers of their own over a still wall, the words beside the product", async (t) => {
  if (!hasFfmpeg) return t.skip("ffmpeg is not installed");
  const composed = await composeWith(t, "float", [
    await product("p1"),
    await product("p2"),
  ]);
  for (const scene of composed.plan.scenes.slice(0, 2)) {
    assert.equal(scene.zoomTo, 1);
    assert.equal(scene.subject!.motion, "float");
    const subject = scene.subject!.layer;
    const shadow = scene.subject!.shadow!;
    const meta = await sharp(subject.path).metadata();
    assert.deepEqual(
      [meta.width, meta.height],
      [subject.width, subject.height],
    );
    // The shadow lies under the product, centred.
    assert.ok(
      Math.abs(shadow.x + shadow.width / 2 - (subject.x + subject.width / 2)) <=
        1,
    );
    assert.ok(shadow.y > subject.y + subject.height - 40);
    // The wall has no product in it: the layer is the product.
    const wall = await sharp(scene.background).metadata();
    assert.deepEqual([wall.width, wall.height], [1080, 1920]);
  }
  // The price card and the ending don't move.
  assert.equal(composed.plan.scenes[2]!.subject, undefined);
  assert.equal(composed.plan.scenes[3]!.subject, undefined);
  assert.deepEqual(
    composed.textOverlap.map((overlap) => overlap?.covers),
    [false, false],
  );
});

test("Pop: a made scene is blurred behind the cut-out where SAM found it; the exact still's product pops over the studio sweep", async (t) => {
  if (!hasFfmpeg) return t.skip("ffmpeg is not installed");
  const made = await sharp({
    create: { width: 1280, height: 1920, channels: 3, background: "#d6c3a4" },
  })
    .png()
    .toBuffer();
  const box = { x: 0.3, y: 0.35, w: 0.4, h: 0.45 };
  const composed = await composeWith(t, "pop", [
    await product("p1", { picture: made, box, made: true }),
    await product("p2", { made: false }),
  ]);
  const [scene, exact] = composed.plan.scenes;
  assert.equal(scene!.blur, 26);
  assert.equal(scene!.zoomTo, 1.03);
  assert.equal(scene!.subject!.motion, "pop");
  assert.equal(scene!.subject!.shadow, null);
  // The padded layer is centred on the box's centre (the product fitted in it).
  const layer = scene!.subject!.layer;
  const centre = {
    x: layer.x + layer.width / 2,
    y: layer.y + layer.height / 2,
  };
  assert.ok(Math.abs(centre.x - (box.x + box.w / 2) * 1080) < 3, `${centre.x}`);
  assert.ok(Math.abs(centre.y - (box.y + box.h / 2) * 1920) < 3, `${centre.y}`);
  // The exact still: no blur, the sweep behind.
  assert.equal(exact!.blur, undefined);
  assert.equal(exact!.subject!.motion, "pop");
  assert.equal(composed.posterSeconds, 1.2);
});
