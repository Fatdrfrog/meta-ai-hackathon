import assert from "node:assert/strict";
import test from "node:test";

import {
  AD_FEED_FRAME,
  AD_FPS,
  AD_FRAME,
  AD_TRANSITION_SECONDS,
  coverCrop,
  FEED_SAFE,
  inside,
  overlapArea,
  placeSceneText,
  planTimeline,
  REELS_SAFE,
  shelfRow,
  type Rect,
} from "./layout";

// Sizes like the drawn layers: a two-line label, a long "from" price tag
// and a sticker.
const LABEL = { width: 500, height: 236 };
const TAG = { width: 400, height: 190 };
const WIDE_TAG = { width: 520, height: 190 };
const STICKER = { width: 560, height: 120 };

const PRODUCTS: Record<string, Rect> = {
  // Muse Image is asked to stand the product at about 45% of the height.
  centre: { x: 300, y: 560, w: 480, h: 760 },
  top: { x: 260, y: 270, w: 560, h: 520 },
  bottom: { x: 240, y: 900, w: 600, h: 700 },
  // Шежіре, a family-tree panel, fills most of the frame.
  tall: { x: 120, y: 200, w: 840, h: 1500 },
  wide: { x: 0, y: 500, w: 1080, h: 600 },
};

test("every word stays inside the Reels safe band, wherever the product is", () => {
  for (const [where, product] of Object.entries(PRODUCTS)) {
    for (const tag of [TAG, WIDE_TAG]) {
      for (const sticker of [null, STICKER]) {
        const placed = placeSceneText({
          safe: REELS_SAFE,
          product,
          label: LABEL,
          tag,
          sticker,
        });
        const rects = [placed.label, placed.tag, placed.sticker].filter(
          (rect): rect is Rect => rect !== null,
        );
        for (const rect of rects)
          assert.ok(
            inside(rect, REELS_SAFE),
            `${where}: ${JSON.stringify(rect)} leaves the safe band`,
          );
        // The label and the tag, shown together, never cover each other
        // (the sticker is shown before them, in the label's place).
        assert.equal(
          overlapArea(placed.label, placed.tag),
          0,
          `${where}: layers overlap`,
        );
      }
    }
  }
});

test("the words go above the product, or below a product that reaches the top", () => {
  const centred = placeSceneText({
    safe: REELS_SAFE,
    product: PRODUCTS.centre!,
    label: LABEL,
    tag: TAG,
  });
  assert.equal(centred.zone, "top");
  assert.deepEqual(centred.label, { x: 72, y: 276, w: 500, h: 236 });
  // Side by side: the tag at the right edge.
  assert.equal(centred.tag.x + centred.tag.w, REELS_SAFE.x + REELS_SAFE.w - 7);
  assert.equal(overlapArea(centred.label, PRODUCTS.centre!), 0);

  const high = placeSceneText({
    safe: REELS_SAFE,
    product: PRODUCTS.top!,
    label: LABEL,
    tag: TAG,
  });
  assert.equal(high.zone, "bottom");
  assert.equal(high.label.y + high.label.h, REELS_SAFE.y + REELS_SAFE.h - 7);

  // A panel that fills the frame meets the words anywhere: they stay at the
  // top, on opaque paper.
  const tall = placeSceneText({
    safe: REELS_SAFE,
    product: PRODUCTS.tall!,
    label: LABEL,
    tag: TAG,
  });
  assert.equal(tall.zone, "top");
});

test("a tag too wide to stand beside the label goes under it at the right; the sticker takes the label's place first", () => {
  const placed = placeSceneText({
    safe: REELS_SAFE,
    product: PRODUCTS.centre!,
    label: LABEL,
    tag: WIDE_TAG,
    sticker: STICKER,
  });
  assert.deepEqual(placed.sticker, { x: 72, y: 276, w: 560, h: 120 });
  assert.deepEqual(placed.label, { x: 72, y: 276, w: 500, h: 236 });
  assert.equal(placed.tag.x + placed.tag.w, REELS_SAFE.x + REELS_SAFE.w - 7);
  assert.equal(placed.tag.y, placed.label.y + placed.label.h + 24);
});

test("the 4:5 picture keeps its words inside its margins", () => {
  const crop = coverCrop({ width: 1280, height: 1920 }, AD_FEED_FRAME, {
    x: 0.3,
    y: 0.3,
    w: 0.4,
    h: 0.45,
  });
  const placed = placeSceneText({
    safe: FEED_SAFE,
    product: crop.product,
    label: LABEL,
    tag: TAG,
  });
  assert.ok(inside(placed.label, FEED_SAFE));
  assert.ok(inside(placed.tag, FEED_SAFE));
});

test("the cover crop keeps the product in the frame and aims the push-in at it", () => {
  // Muse Image's 2:3 scene, product a little left of centre.
  const crop = coverCrop({ width: 1280, height: 1920 }, AD_FRAME, {
    x: 0.2,
    y: 0.3,
    w: 0.4,
    h: 0.4,
  });
  assert.deepEqual(crop.resize, { width: 1280, height: 1920 });
  // The product's centre (512 px) is left of the frame's centre (540), so
  // the cut starts at the picture's left edge.
  assert.equal(crop.left, 0);
  assert.deepEqual(crop.product, { x: 256, y: 576, w: 512, h: 768 });
  assert.ok(Math.abs(crop.focus.x - 512 / 1080) < 1e-9);
  assert.ok(Math.abs(crop.focus.y - 0.5) < 1e-9);

  // A product at the right edge pulls the cut right, as far as it goes.
  const rightCrop = coverCrop({ width: 1280, height: 1920 }, AD_FRAME, {
    x: 0.8,
    y: 0.4,
    w: 0.2,
    h: 0.2,
  });
  assert.equal(rightCrop.left, 200);

  // No box: centred.
  const centred = coverCrop({ width: 1600, height: 1600 }, AD_FRAME, null);
  assert.deepEqual(centred.resize, { width: 1920, height: 1920 });
  assert.equal(centred.left, 420);
  assert.equal(centred.product, null);
  assert.deepEqual(centred.focus, { x: 0.5, y: 0.5 });

  // A box SAM gave outside the picture is clamped, or dropped when empty.
  assert.equal(
    coverCrop({ width: 1080, height: 1920 }, AD_FRAME, {
      x: 2,
      y: 0,
      w: 1,
      h: 1,
    }).product,
    null,
  );
});

test("products stand side by side on the plank, each in its own share of the row", () => {
  const row = shelfRow(
    [
      { width: 600, height: 900 },
      { width: 400, height: 600 },
      { width: 1200, height: 500 },
    ],
    { x: 80, w: 920 },
    1040,
    560,
  );
  assert.equal(row.length, 3);
  for (const rect of row) {
    assert.equal(rect.y + rect.h, 1040);
    assert.ok(rect.h <= 560);
    assert.ok(rect.x >= 80 && rect.x + rect.w <= 1000);
  }
  for (let i = 1; i < row.length; i++)
    assert.ok(row[i]!.x >= row[i - 1]!.x + row[i - 1]!.w);
});

const onFrame = (seconds: number) =>
  Math.abs(seconds * AD_FPS - Math.round(seconds * AD_FPS)) < 1e-6;

test("the timeline: 10 to 20 s, product scenes of 3 to 6 s, words inside their scenes", () => {
  const cases: Array<Array<number | null>> = [
    [null],
    [2.4],
    [null, null],
    [3.1, 4.2],
    [null, null, null],
    [5.2, 5.6, 5.9],
    [5.9, null, 1.2],
  ];
  for (const voices of cases) {
    const timeline = planTimeline(
      voices.map((voiceSeconds) => ({ voiceSeconds })),
    );
    const label = JSON.stringify(voices);
    assert.ok(
      timeline.totalSeconds >= 10,
      `${label} is ${timeline.totalSeconds} s`,
    );
    assert.ok(
      timeline.totalSeconds <= 20,
      `${label} is ${timeline.totalSeconds} s`,
    );
    assert.equal(timeline.scenes.length, voices.length + 2);
    assert.deepEqual(
      timeline.scenes.map((scene) => scene.kind),
      [...voices.map(() => "product"), "price_card", "ending"],
    );
    let previousEnd = 0;
    timeline.scenes.forEach((scene, index) => {
      assert.ok(
        onFrame(scene.start) && onFrame(scene.seconds),
        `${label} off the frames`,
      );
      if (index > 0) {
        // Each scene starts as the one before it cross-fades out.
        const overlap = previousEnd - scene.start;
        assert.ok(
          overlap >= AD_TRANSITION_SECONDS - 1e-9,
          `${label} overlap ${overlap}`,
        );
        assert.ok(overlap < AD_TRANSITION_SECONDS + 1 / AD_FPS + 1e-9);
      }
      previousEnd = scene.start + scene.seconds;
      if (scene.kind !== "product") {
        assert.equal(scene.seconds, 3);
        return;
      }
      assert.ok(scene.seconds >= 3 - 1e-9 && scene.seconds <= 6 + 1e-9);
      const voice = voices[scene.productIndex];
      if (voice === null) assert.equal(scene.voice, null);
      else {
        assert.ok(scene.voice);
        assert.ok(scene.voice.at >= scene.start);
        // The words end before the next scene starts fading in.
        assert.ok(
          scene.voice.at + scene.voice.seconds <=
            scene.start + scene.seconds - AD_TRANSITION_SECONDS + 1e-9,
        );
      }
    });
    assert.ok(Math.abs(previousEnd - timeline.totalSeconds) < 1e-9);
  }
});

test("the first scene's words stay as long as any scene's, after its sticker", () => {
  // The words come in at 1.9 s, after the sticker, instead of 0.3 s: the
  // paid gate's toy shelf (1.86 s of words) made a 3 s first scene whose
  // price was whole for a fifth of a second.
  for (const voices of [
    [1.86, 3.49],
    [null, null],
    [1.2],
    [0.8, 0.8, 0.8],
    [5.9, 5.9, 5.9],
  ]) {
    const timeline = planTimeline(
      voices.map((voiceSeconds) => ({ voiceSeconds })),
    );
    const first = timeline.scenes[0]!;
    const second = timeline.scenes[1]!;
    assert.ok(
      first.seconds >= 3 + 1.6 - 1e-9,
      `${JSON.stringify(voices)}: ${first.seconds} s`,
    );
    assert.ok(first.seconds <= 6 + 1e-9);
    // The others keep their own lengths.
    if (voices.length > 1 && voices[1] === null)
      assert.equal(second.seconds, 3.5);
    assert.ok(timeline.totalSeconds >= 10 && timeline.totalSeconds <= 20);
  }
});

test("a long ad gives back time evenly; a short one grows to 10 s", () => {
  const long = planTimeline([
    { voiceSeconds: 5.9 },
    { voiceSeconds: 5.9 },
    { voiceSeconds: 5.9 },
  ]);
  const lengths = long.scenes.slice(0, 3).map((scene) => scene.seconds);
  assert.ok(Math.max(...lengths) - Math.min(...lengths) < 1e-9);
  assert.ok(long.totalSeconds > 19.8);
  // The words are cut to fit the shorter scene.
  const first = long.scenes[0]!;
  assert.ok(
    first.kind === "product" && first.voice && first.voice.seconds < 5.9,
  );

  const short = planTimeline([{ voiceSeconds: null }]);
  assert.ok(short.totalSeconds >= 10 && short.totalSeconds < 10.2);
  assert.ok(short.scenes[0]!.seconds > 3.5);
});

test("the owner's zone puts the words at the top or the bottom, the sticker with them", () => {
  const centre = PRODUCTS.centre!;
  // Auto keeps v1's choice; the owner can move the words either way.
  const auto = placeSceneText({
    safe: REELS_SAFE,
    product: centre,
    label: LABEL,
    tag: TAG,
    sticker: STICKER,
  });
  const low = placeSceneText({
    safe: REELS_SAFE,
    product: centre,
    label: LABEL,
    tag: TAG,
    sticker: STICKER,
    zone: "bottom",
  });
  assert.equal(auto.zone, "top");
  assert.equal(low.zone, "bottom");
  assert.equal(low.label.y + low.label.h, REELS_SAFE.y + REELS_SAFE.h - 7);
  assert.equal(
    low.sticker!.y + low.sticker!.h,
    REELS_SAFE.y + REELS_SAFE.h - 7,
    "the sticker goes down with the words",
  );
  assert.equal(auto.sticker!.y, REELS_SAFE.y + 7);
  for (const rect of [low.label, low.tag, low.sticker!])
    assert.ok(inside(rect, REELS_SAFE), JSON.stringify(rect));

  // A product reaching the top: auto goes below it; the owner may still say top.
  const high = placeSceneText({
    safe: REELS_SAFE,
    product: PRODUCTS.top!,
    label: LABEL,
    tag: TAG,
    zone: "top",
  });
  assert.equal(high.zone, "top");
  assert.equal(high.label.y, REELS_SAFE.y + 7);
});

test("the overlap: whether the words cover the product, and the band that keeps it clear", () => {
  // The deer on the orteke table reached up into the words (paid gate G1).
  const reaching = placeSceneText({
    safe: REELS_SAFE,
    product: PRODUCTS.top!,
    label: LABEL,
    tag: TAG,
    zone: "top",
  });
  assert.deepEqual(reaching.textOverlap, { covers: true, suggested: "bottom" });
  // Below it, the words leave it clear.
  const below = placeSceneText({
    safe: REELS_SAFE,
    product: PRODUCTS.top!,
    label: LABEL,
    tag: TAG,
  });
  assert.equal(below.zone, "bottom");
  assert.deepEqual(below.textOverlap, { covers: false, suggested: null });
  // A product standing low, words at the bottom by the owner's choice: the top is clearer.
  const low = placeSceneText({
    safe: REELS_SAFE,
    product: PRODUCTS.bottom!,
    label: LABEL,
    tag: TAG,
    zone: "bottom",
  });
  assert.deepEqual(low.textOverlap, { covers: true, suggested: "top" });
  // A panel filling the frame is covered either way: no better band to suggest.
  const tall = placeSceneText({
    safe: REELS_SAFE,
    product: { x: 0, y: 0, w: 1080, h: 1920 },
    label: LABEL,
    tag: TAG,
  });
  assert.equal(tall.textOverlap?.covers, true);
  assert.equal(tall.textOverlap?.suggested, null);
  // Under 4% of the product's box isn't covering it.
  const touching = placeSceneText({
    safe: REELS_SAFE,
    product: { x: 300, y: 500, w: 480, h: 760 },
    label: LABEL,
    tag: TAG,
    zone: "top",
  });
  assert.equal(touching.textOverlap?.covers, false);
  // Without a box there's nothing to say.
  assert.equal(
    placeSceneText({ safe: REELS_SAFE, product: null, label: LABEL, tag: TAG })
      .textOverlap,
    null,
  );
});
