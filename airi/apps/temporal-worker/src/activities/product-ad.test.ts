import assert from "node:assert/strict";
import test from "node:test";
import type { ProductAdStoredScene } from "@icecore/temporal";

import { recordAdRunFailure, type AdFailureModel } from "./product-ad";

const AD = "6ae43246b2009b6f5799236e";
const AT = new Date("2026-11-03T12:00:00Z");
const INPUT = { adId: AD, workspaceId: "ws1", renderNo: 3 };

/** product_ads as recordAdRunFailure meets it: one document, each update kept. */
function model(doc: Record<string, unknown> | null) {
  const updates: Array<{
    filter: Record<string, unknown>;
    set: Record<string, any>;
  }> = [];
  const finds: Array<Record<string, unknown>> = [];
  const fake = {
    findOne(filter: Record<string, unknown>) {
      finds.push(filter);
      const found =
        doc &&
        doc.status !== "ready" &&
        doc.renderNo === filter.renderNo &&
        filter._id === AD &&
        filter.workspaceId === "ws1"
          ? structuredClone(doc)
          : null;
      return { select: () => ({ lean: async () => found }) };
    },
    async updateOne(
      filter: Record<string, unknown>,
      update: { $set: Record<string, any> },
    ) {
      updates.push({ filter, set: update.$set });
      return { matchedCount: 1 };
    },
  };
  return { finds, updates, ProductAd: fake as unknown as AdFailureModel };
}

const ref = (path: string) => ({ bucket: "b", path });

/** A scene whose "New picture" press was still running. */
const pressedScene = (): ProductAdStoredScene => ({
  productId: "p1",
  exact: ref("exact-p1.jpg"),
  muse: null,
  method: "exact",
  check: null,
  box: { x: 0.1, y: 0.4, w: 0.8, h: 0.33 },
  attempts: 2,
  redo: {
    requestId: "press-1",
    renderNo: 3,
    from: {
      muse: ref("scene-p1-a1.jpg"),
      box: { x: 0.2, y: 0.5, w: 0.5, h: 0.4 },
      method: "muse",
      check: { same: true, difference: null },
    },
    outcome: null,
    reason: null,
  },
});

const otherScene = (): ProductAdStoredScene => ({
  productId: "p2",
  exact: ref("exact-p2.jpg"),
  muse: ref("scene-p2-a1.jpg"),
  method: "muse",
  check: { same: true, difference: null },
  box: { x: 0.2, y: 0.5, w: 0.5, h: 0.4 },
  attempts: 1,
});

test("a failed New picture run leaves the ad ready, its scene given back, and says why", async () => {
  const { updates, ProductAd } = model({
    status: "making",
    renderNo: 3,
    runKind: "scene",
    render: { renderNo: 2 },
    errorCode: null,
    scenes: [pressedScene(), otherScene()],
  });
  const left = await recordAdRunFailure(
    ProductAd,
    INPUT,
    { code: "too_big", message: "The video is 17000000 bytes" },
    () => AT,
  );
  assert.equal(left, "ready");
  assert.equal(updates.length, 1);
  const { filter, set } = updates[0]!;
  // Only this run's render, and never an ad already ready.
  assert.deepEqual(filter, {
    _id: AD,
    workspaceId: "ws1",
    renderNo: 3,
    status: { $ne: "ready" },
  });
  assert.equal(set.status, "ready");
  assert.equal(set.step, null);
  assert.equal(set.errorCode, null);
  assert.deepEqual(set.lastRun, {
    renderNo: 3,
    kind: "scene",
    outcome: "failed",
    errorCode: "too_big",
    message: "The video is 17000000 bytes",
    at: AT,
  });
  const [p1, p2] = set.scenes as ProductAdStoredScene[];
  assert.equal(p1!.redo!.outcome, "unavailable");
  assert.deepEqual(
    [p1!.muse, p1!.box, p1!.method, p1!.check],
    [
      ref("scene-p1-a1.jpg"),
      { x: 0.2, y: 0.5, w: 0.5, h: 0.4 },
      "muse",
      { same: true, difference: null },
    ],
  );
  assert.deepEqual(p2, otherScene());
});

test("a New picture run stopped by AI turned off ends its press as ai_disabled, not an outage", async () => {
  const { updates, ProductAd } = model({
    status: "making",
    renderNo: 3,
    runKind: "scene",
    render: { renderNo: 2 },
    errorCode: null,
    scenes: [pressedScene(), otherScene()],
  });
  assert.equal(
    await recordAdRunFailure(
      ProductAd,
      INPUT,
      { code: "ai_disabled", message: "AI is turned off for this company" },
      () => AT,
    ),
    "ready",
  );
  const { set } = updates[0]!;
  assert.equal(set.lastRun.errorCode, "ai_disabled");
  const [p1, p2] = set.scenes as ProductAdStoredScene[];
  assert.equal(p1!.redo!.outcome, "ai_disabled");
  // The scene still gets its earlier picture back.
  assert.deepEqual(p1!.muse, ref("scene-p1-a1.jpg"));
  assert.deepEqual(p2, otherScene());
});

test("a failed Update or voice run leaves the ad ready, its scenes untouched", async () => {
  for (const runKind of ["render", "voice"]) {
    const { updates, ProductAd } = model({
      status: "making",
      renderNo: 3,
      runKind,
      render: { renderNo: 2 },
      scenes: [otherScene()],
    });
    assert.equal(
      await recordAdRunFailure(
        ProductAd,
        INPUT,
        { code: null, message: "ffmpeg exited with code 1" },
        () => AT,
      ),
      "ready",
    );
    assert.equal(updates[0]!.set.status, "ready");
    assert.equal(updates[0]!.set.lastRun.kind, runKind);
    assert.equal(updates[0]!.set.lastRun.errorCode, "failed");
    assert.ok(!("scenes" in updates[0]!.set));
  }
});

test("a failed first make fails the ad, as before; a code recorded earlier is kept", async () => {
  const first = model({
    status: "making",
    renderNo: 3,
    render: null,
    errorCode: null,
    scenes: [],
  });
  assert.equal(
    await recordAdRunFailure(
      first.ProductAd,
      INPUT,
      { code: "photo_missing", message: "Cup's cut-out photo is gone" },
      () => AT,
    ),
    "failed",
  );
  assert.deepEqual(
    {
      status: first.updates[0]!.set.status,
      errorCode: first.updates[0]!.set.errorCode,
      errorMessage: first.updates[0]!.set.errorMessage,
      lastRun: first.updates[0]!.set.lastRun.outcome,
    },
    {
      status: "failed",
      errorCode: "photo_missing",
      errorMessage: "Cup's cut-out photo is gone",
      lastRun: "failed",
    },
  );
  // The workflow's fail activity after the activity recorded its code.
  const after = model({
    status: "failed",
    renderNo: 3,
    runKind: "make",
    render: null,
    errorCode: "spend_limit",
    scenes: [],
  });
  await recordAdRunFailure(
    after.ProductAd,
    INPUT,
    { code: null, message: "Activity task failed" },
    () => AT,
  );
  assert.equal(after.updates[0]!.set.errorCode, "spend_limit");
  // An edit run on an ad that somehow has no video fails it too.
  const noVideo = model({
    status: "making",
    renderNo: 3,
    runKind: "render",
    render: null,
    scenes: [],
  });
  assert.equal(
    await recordAdRunFailure(noVideo.ProductAd, INPUT, {
      code: null,
      message: "x",
    }),
    "failed",
  );
});

test("an ad already ready, or moved on to a newer run, is left alone", async () => {
  for (const doc of [
    { status: "ready", renderNo: 3, runKind: "scene", render: {} },
    { status: "making", renderNo: 4, runKind: "scene", render: {} },
  ]) {
    const { updates, ProductAd } = model(doc);
    assert.equal(
      await recordAdRunFailure(ProductAd, INPUT, {
        code: "failed",
        message: "x",
      }),
      null,
    );
    assert.deepEqual(updates, []);
  }
});

test("the failure's words are cut to what the ad keeps", async () => {
  const { updates, ProductAd } = model({
    status: "making",
    renderNo: 3,
    runKind: "render",
    render: {},
    scenes: [],
  });
  await recordAdRunFailure(ProductAd, INPUT, {
    code: "failed",
    message: "x".repeat(900),
  });
  assert.equal(updates[0]!.set.lastRun.message.length, 500);
});
