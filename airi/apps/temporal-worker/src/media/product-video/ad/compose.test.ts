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
