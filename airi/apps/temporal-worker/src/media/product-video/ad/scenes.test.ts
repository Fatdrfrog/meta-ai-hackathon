import assert from "node:assert/strict";
import test from "node:test";
import { MetaModelApiError } from "@icecore/airi-runtime/meta-model-api";
import type { SegmentationMaskRecord } from "@icecore/airi-runtime/meta-sam";
import type { ProductAdStoredScene } from "@icecore/temporal";
import sharp from "sharp";

import { AD_FRAME, coverCrop, placeSceneText, REELS_SAFE } from "./layout";
import {
  frameScene,
  makeMuseScene,
  MAX_SCENE_ATTEMPTS,
  scenePrompt,
  wholeProductBox,
  type SceneDeps,
  type SceneProduct,
} from "./scenes";
import { AdSpendRefusal, type PaidCall } from "./spend";

const png = (width: number, height: number, color: string) =>
  sharp({ create: { width, height, channels: 4, background: color } })
    .png()
    .toBuffer();

async function product(): Promise<SceneProduct> {
  return {
    productId: "doll",
    description: "blonde doll in a blue dress",
    samPhrase: "doll",
    cutout: await png(300, 600, "#3b82f6"),
    original: await sharp(await png(320, 480, "#888888"))
      .jpeg()
      .toBuffer(),
  };
}

const fresh = (): ProductAdStoredScene => ({
  productId: "doll",
  exact: { bucket: "b", path: "exact-doll.jpg" },
  muse: null,
  method: "exact",
  check: null,
  box: { x: 0.3, y: 0.3, w: 0.4, h: 0.33 },
  attempts: 0,
});

/** The ledger as the scenes meet it: each paid call, in order, by operation. */
function ledger(refuse: (operation: string) => boolean = () => false) {
  const operations: string[] = [];
  const paid: PaidCall = async (operation, _provider, _max, step) => {
    if (refuse(operation)) throw new AdSpendRefusal("workspace_ai_spend_limit");
    operations.push(operation);
    return (await step(() => undefined)).value;
  };
  return { operations, paid };
}

function job(
  deps: SceneDeps,
  paid: PaidCall,
): {
  saves: ProductAdStoredScene[];
  stored: string[];
  job: Parameters<typeof makeMuseScene>[3];
} {
  const saves: ProductAdStoredScene[] = [];
  const stored: string[] = [];
  return {
    saves,
    stored,
    job: {
      paid,
      deps,
      save: async (scene) => {
        saves.push(scene);
      },
      storeScene: async (productId, attempt) => {
        stored.push(`${productId}:${attempt}`);
        return { bucket: "b", path: `scene-${productId}-a${attempt}.jpg` };
      },
    },
  };
}

/** Muse Image answering with a scene, or refusing; Muse Spark judging it. */
function models(answers: {
  scenes: Array<"scene" | "refuse" | "outage">;
  checks: Array<{ same: boolean; difference: string | null }>;
}) {
  const prompts: string[] = [];
  let scene = 0;
  let check = 0;
  const deps: SceneDeps = {
    editMetaImage: async (request) => {
      prompts.push(request.prompt);
      const answer = answers.scenes[scene++] ?? "scene";
      if (answer === "refuse")
        throw new MetaModelApiError({
          kind: "invalid_request",
          transient: false,
          status: 400,
          code: "content_policy_violation",
          message: "The request was refused by the safety system",
        });
      if (answer === "outage")
        throw new MetaModelApiError({
          kind: "server",
          transient: true,
          status: 502,
          message: "502",
        });
      return {
        image: await png(1280, 1920, "#d9c7a8"),
        mimeType: "image/png",
        costUsd: 0.01,
      };
    },
    checkSameProduct: async () =>
      answers.checks[check++] ?? { same: true, difference: null },
  };
  return { deps, prompts };
}

test("the scene prompt places the product in its setting and keeps the top third empty", () => {
  const prompt = scenePrompt("playroom_shelf", "blonde doll", null);
  assert.match(
    prompt,
    /Place this exact blonde doll unchanged on a white shelf in a bright children's playroom/,
  );
  assert.match(
    prompt,
    /upper part of the picture, above the product, a calm, out-of-focus wall/,
  );
  // The paid gate: "half of its width" put products up into the words and
  // past the 9:16 cut's sides, and a figure on a table still reached the
  // words; the whole product, what stands on it too, takes half the height.
  assert.match(
    prompt,
    /including anything that stands on it, in the lower half/,
  );
  assert.match(prompt, /about half of the picture's height/);
  assert.match(prompt, /empty space on its left and right/);
  assert.doesNotMatch(prompt, /half of its width/);
  assert.match(prompt, /Add no text, prices/);
  assert.doesNotMatch(prompt, /last picture/);
  assert.match(
    scenePrompt("gift_table", "doll", "The dress is red, not blue."),
    /The last picture changed the product: The dress is red, not blue\. Keep that exactly/,
  );
});

test("a scene that passes the check is kept: one Muse Image and one Muse Spark call", async () => {
  const { deps } = models({
    scenes: ["scene"],
    checks: [{ same: true, difference: null }],
  });
  const { operations, paid } = ledger();
  const { saves, stored, job: sceneJob } = job(deps, paid);
  const outcome = await makeMuseScene(
    await product(),
    "playroom_shelf",
    fresh(),
    sceneJob,
  );
  assert.deepEqual(operations, ["scene:doll:a1", "check:doll:a1"]);
  assert.equal(outcome.scene.method, "muse");
  assert.deepEqual(outcome.scene.muse, {
    bucket: "b",
    path: "scene-doll-a1.jpg",
  });
  assert.equal(
    outcome.scene.box,
    null,
    "framing finds the box in the new picture",
  );
  assert.equal(outcome.scene.attempts, 1);
  assert.ok(outcome.picture);
  assert.deepEqual(stored, ["doll:1"]);
  // The attempt was saved before its call.
  assert.equal(saves[0]!.attempts, 1);
  assert.equal(saves[0]!.muse, null);
});

test("a refusal leaves the exact still, with no check and no retry", async () => {
  const { deps } = models({ scenes: ["refuse"], checks: [] });
  const { operations, paid } = ledger();
  const { stored, job: sceneJob } = job(deps, paid);
  const outcome = await makeMuseScene(
    await product(),
    "gift_table",
    fresh(),
    sceneJob,
  );
  assert.deepEqual(operations, ["scene:doll:a1"]);
  assert.equal(outcome.scene.method, "exact");
  assert.equal(outcome.scene.muse, null);
  assert.deepEqual(
    outcome.scene.box,
    fresh().box,
    "the exact still keeps its box",
  );
  assert.deepEqual(stored, []);
});

test("a mismatch gets one retry with the difference named, then the exact still", async () => {
  const { deps, prompts } = models({
    scenes: ["scene", "scene"],
    checks: [
      { same: false, difference: "The logo reads 'web umm'." },
      { same: false, difference: "The cup is taller." },
    ],
  });
  const { operations, paid } = ledger();
  const { stored, job: sceneJob } = job(deps, paid);
  const outcome = await makeMuseScene(
    await product(),
    "oak_table_window",
    fresh(),
    sceneJob,
  );
  assert.deepEqual(operations, [
    "scene:doll:a1",
    "check:doll:a1",
    "scene:doll:a2",
    "check:doll:a2",
  ]);
  assert.match(
    prompts[1]!,
    /The last picture changed the product: The logo reads 'web umm'\./,
  );
  assert.equal(outcome.scene.method, "exact");
  assert.equal(outcome.scene.attempts, MAX_SCENE_ATTEMPTS);
  assert.deepEqual(outcome.scene.check, {
    same: false,
    difference: "The cup is taller.",
  });
  assert.deepEqual(stored, []);
});

test("a mismatch, then a scene that passes: the second is used", async () => {
  const { deps } = models({
    scenes: ["scene", "scene"],
    checks: [
      { same: false, difference: "The dress is red." },
      { same: true, difference: null },
    ],
  });
  const { paid } = ledger();
  const { stored, job: sceneJob } = job(deps, paid);
  const outcome = await makeMuseScene(
    await product(),
    "playroom_shelf",
    fresh(),
    sceneJob,
  );
  assert.equal(outcome.scene.method, "muse");
  assert.equal(outcome.scene.attempts, 2);
  assert.deepEqual(stored, ["doll:2"]);
});

test("an outage counts as a try; the next one may pass", async () => {
  const { deps } = models({
    scenes: ["outage", "scene"],
    checks: [{ same: true, difference: null }],
  });
  const { operations, paid } = ledger();
  const outcome = await makeMuseScene(
    await product(),
    "linen_shelf",
    fresh(),
    job(deps, paid).job,
  );
  assert.deepEqual(operations, [
    "scene:doll:a1",
    "scene:doll:a2",
    "check:doll:a2",
  ]);
  assert.equal(outcome.scene.method, "muse");
});

test("a reservation the ledger refuses leaves the exact still and says so", async () => {
  const { deps } = models({ scenes: ["scene"], checks: [] });
  const { operations, paid } = ledger((operation) =>
    operation.startsWith("check:"),
  );
  const outcome = await makeMuseScene(
    await product(),
    "stone_counter",
    fresh(),
    job(deps, paid).job,
  );
  assert.deepEqual(operations, ["scene:doll:a1"]);
  assert.equal(outcome.scene.method, "exact");
  assert.ok(outcome.refused instanceof AdSpendRefusal);
});

test("a retried run pays for nothing saved: a kept scene, or the tries used up", async () => {
  const { deps } = models({ scenes: [], checks: [] });
  const { operations, paid } = ledger();
  const kept = await makeMuseScene(
    await product(),
    "playroom_shelf",
    {
      ...fresh(),
      method: "muse",
      muse: { bucket: "b", path: "scene-doll-a1.jpg" },
      attempts: 1,
    },
    job(deps, paid).job,
  );
  assert.equal(kept.scene.method, "muse");
  const usedUp = await makeMuseScene(
    await product(),
    "playroom_shelf",
    {
      ...fresh(),
      attempts: MAX_SCENE_ATTEMPTS,
      check: { same: false, difference: "x" },
    },
    job(deps, paid).job,
  );
  assert.equal(usedUp.scene.method, "exact");
  assert.deepEqual(operations, []);

  // One try left: it is the second, with the saved difference.
  const second = models({
    scenes: ["scene"],
    checks: [{ same: true, difference: null }],
  });
  const resumed = ledger();
  await makeMuseScene(
    await product(),
    "playroom_shelf",
    {
      ...fresh(),
      attempts: 1,
      check: { same: false, difference: "The bow is missing." },
    },
    job(second.deps, resumed.paid).job,
  );
  assert.deepEqual(resumed.operations, ["scene:doll:a2", "check:doll:a2"]);
  assert.match(second.prompts[0]!, /The bow is missing\./);
});

const maskRecord = (bounds: {
  left: number;
  top: number;
  right: number;
  bottom: number;
}) =>
  ({
    kind: "mask",
    order: 0,
    objectId: "0",
    identity: "0",
    revision: 0,
    mask: { encoding: "one_bit", payload: "", width: 1, height: 1 },
    bounds,
    confidence: 0.9,
  }) satisfies SegmentationMaskRecord;

test("SAM's box becomes fractions of the picture; nothing, or a sliver, is no box", async () => {
  const picture = await png(1280, 1920, "#ccbbaa");
  const costs: number[] = [];
  const sam =
    (records: SegmentationMaskRecord[]): SceneDeps["segmentMetaImage"] =>
    async () => ({ result: { records } as never, costUsd: 0.0025 });
  const box = await frameScene(picture, "doll", {
    segmentMetaImage: sam([
      maskRecord({ left: 320, top: 480, right: 960, bottom: 1440 }),
    ]),
    onCost: (usd) => costs.push(usd),
  });
  assert.deepEqual(box, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  assert.deepEqual(costs, [0.0025]);
  assert.equal(
    await frameScene(picture, "doll", { segmentMetaImage: sam([]) }),
    null,
  );
  assert.equal(
    await frameScene(picture, "doll", {
      segmentMetaImage: sam([
        maskRecord({ left: 0, top: 0, right: 20, bottom: 1900 }),
      ]),
    }),
    null,
  );
});

test("a box SAM drew round part of the product grows up to the cut-out's whole shape", async () => {
  // The paid gate's orteke table: SAM boxed the table top, not the deer
  // standing on it, so the words' band above looked free.
  const picture = await png(1280, 1920, "#ccbbaa");
  const tableTop = maskRecord({ left: 340, top: 600, right: 940, bottom: 900 });
  const sam: SceneDeps["segmentMetaImage"] = async () => ({
    result: { records: [tableTop] } as never,
    costUsd: 0.0025,
  });
  // The cut-out is the table with its deer: 650 px tall at 600 wide.
  const shape = { width: 600, height: 650 };
  const grown = await frameScene(
    picture,
    "small carved wooden dancing table",
    { segmentMetaImage: sam },
    undefined,
    shape,
  );
  assert.ok(grown);
  // Up from the same bottom, to the shape's height at the box's width.
  assert.equal(Math.round(grown.y * 1920), 250);
  assert.equal(Math.round((grown.y + grown.h) * 1920), 900);
  assert.equal(grown.x, 340 / 1280);
  assert.equal(grown.w, 600 / 1280);

  // So the words leave the band the deer stands in, for the clear one below.
  const zoneFor = (box: NonNullable<typeof grown>) =>
    placeSceneText({
      safe: REELS_SAFE,
      product: coverCrop({ width: 1280, height: 1920 }, AD_FRAME, box).product,
      label: { width: 500, height: 236 },
      tag: { width: 400, height: 190 },
    }).zone;
  const sams = await frameScene(picture, "table", { segmentMetaImage: sam });
  assert.equal(zoneFor(sams!), "top");
  assert.equal(zoneFor(grown), "bottom");

  // A box of the whole product, or no shape known, stays as SAM drew it.
  const box = { x: 0.25, y: 0.3, w: 0.5, h: 0.4 };
  const size = { width: 1280, height: 1920 };
  assert.deepEqual(wholeProductBox(box, size, null), box);
  assert.deepEqual(
    wholeProductBox(box, size, { width: 640, height: 800 }),
    box,
  );
  // Never past the picture's top.
  assert.equal(wholeProductBox(box, size, { width: 100, height: 1000 }).y, 0);
});
