import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { SegmentationMaskRecord } from "@icecore/airi-runtime/meta-sam";
import { WorkspaceAiSpendError } from "@icecore/airi-runtime/workspace-ai-spend";
import type { ProductAdFileRef, ProductAdScript } from "@icecore/temporal";
import sharp from "sharp";

import {
  classifyAdError,
  ProductAdFailure,
  removeWorkDir,
  runProductAd,
  type AdJobPorts,
  type AdRecord,
} from "./ad-job";
import { writeWav, type Pcm } from "./audio";
import type { composeAd } from "./compose";
import { AdTooBigError } from "./render";
import type { AdSpendAllowance } from "./spend";

const png = (width: number, height: number, color: string) =>
  sharp({ create: { width, height, channels: 4, background: color } })
    .png()
    .toBuffer();

/** A product cut-out: a coloured block on transparency. */
const cutout = async (color: string) =>
  sharp({
    create: {
      width: 400,
      height: 600,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: await png(240, 480, color), left: 80, top: 60 }])
    .png()
    .toBuffer();

const GOOD_SCRIPT = {
  sticker: "Жаңа тауар",
  scenes: [
    {
      productId: "p1",
      caption: "Балаңызға керемет сыйлық",
      setting: "playroom_shelf",
    },
    {
      productId: "p2",
      caption: "Таңғы шайға арналған",
      setting: "oak_table_window",
    },
  ],
  priceCardTitle: "Біздің бағалар",
  ending: "WhatsApp-қа жазыңыз",
  postIntro: "Сөремізде жаңа тауарлар бар.",
  ctwa: {
    headline: "Жаңа тауарлар",
    primaryText: "Ұнағанын таңдап, WhatsApp-қа жазыңыз.",
    greeting: "Сәлеметсіз бе!",
    questions: [
      "Жеткізу бар ма?",
      "Қай жерде орналасқансыз?",
      "Басқа түсі бар ма?",
    ],
  },
};

function baseAd(overrides: Partial<AdRecord> = {}): AdRecord {
  return {
    status: "making",
    renderNo: 1,
    language: "Kazakh",
    wordsCode: "kk",
    idea: { kind: "new", text: null },
    voice: "own",
    presenter: null,
    ending: { phone: null, shopName: "Demo Shop" },
    products: ["p1", "p2"].map((productId) => ({
      productId,
      importId: "imp1",
      name: productId === "p1" ? "Кукла Лол" : "Кружка",
      englishName: productId === "p1" ? "LOL doll" : "Cup",
      priceText: productId === "p1" ? "5 000 ₸" : "500 ₸",
      priceQuote: "бес мың теңге",
      cutout: { bucket: "b", path: `${productId}/cutout.png` },
      original: { bucket: "b", path: `${productId}/original.jpg` },
      clip: { bucket: "b", path: `${productId}/clip.mp4` },
      samPhrase: productId === "p1" ? "doll" : "cup",
      description: productId === "p1" ? "blonde doll" : "frosted cup",
    })),
    script: null,
    scenes: [],
    stills: { status: null, feed: null },
    costMicros: 0,
    ...overrides,
  };
}

/** Sets a dotted path, the way Mongo's $set does. */
function setPath(target: Record<string, any>, path: string, value: unknown) {
  const keys = path.split(".");
  let at = target;
  for (const key of keys.slice(0, -1)) at = at[key] ??= {};
  at[keys.at(-1)!] = structuredClone(value);
}

type Harness = {
  ports: AdJobPorts;
  doc: Record<string, any>;
  files: Map<string, Buffer>;
  voices: Map<string, Buffer>;
  ops: string[];
  settled: Array<[string, number | null]>;
  muse: {
    scenes: number;
    checks: number;
    sam: number;
    script: number;
    isolate: number;
  };
  rendered: number;
};

async function harness(
  t: TestContext,
  options: {
    ad?: AdRecord;
    mode?: "make" | "render";
    renderNo?: number;
    refuse?: (
      operationId: string,
    ) => "workspace_ai_spend_limit" | "own_ai_source_required" | null;
    allowance?: Partial<AdSpendAllowance>;
    /** Muse Spark's verdicts per product description, in order; "same" after them. */
    checks?: Record<string, boolean[]>;
    isolate?: boolean;
    missing?: string[];
  } = {},
): Promise<Harness> {
  const workDir = await mkdtemp(join(tmpdir(), "product-ad-job-"));
  t.after(() => rm(workDir, { recursive: true, force: true, maxRetries: 5 }));
  const doc: Record<string, any> = structuredClone(options.ad ?? baseAd());
  const files = new Map<string, Buffer>([
    ["p1/cutout.png", await cutout("#3b82f6")],
    ["p2/cutout.png", await cutout("#e5e7eb")],
    [
      "p1/original.jpg",
      await sharp(await png(300, 400, "#777777"))
        .jpeg()
        .toBuffer(),
    ],
    [
      "p2/original.jpg",
      await sharp(await png(300, 400, "#999999"))
        .jpeg()
        .toBuffer(),
    ],
  ]);
  for (const path of options.missing ?? []) files.delete(path);
  const voices = new Map<string, Buffer>();
  const ops: string[] = [];
  const settled: Array<[string, number | null]> = [];
  const muse = { scenes: 0, checks: 0, sam: 0, script: 0, isolate: 0 };
  const checks = new Map(
    Object.entries(options.checks ?? {}).map(([product, verdicts]) => [
      product,
      [...verdicts],
    ]),
  );
  let saved = 0;
  const h: Harness = {
    doc,
    files,
    voices,
    ops,
    settled,
    muse,
    rendered: 0,
    ports: undefined as never,
  };
  h.ports = {
    store: {
      async loadAd() {
        return structuredClone(doc) as AdRecord;
      },
      async updateAd(set, inc) {
        if (doc.renderNo !== (options.renderNo ?? 1)) return false;
        for (const [path, value] of Object.entries(set))
          setPath(doc, path, value);
        for (const [path, value] of Object.entries(inc ?? {}))
          doc[path] = (doc[path] ?? 0) + (value ?? 0);
        return true;
      },
      async loadSources(productIds) {
        return productIds.map((productId) => ({
          productId,
          transcript: "[1.0] Кукла Лол, бес мың теңге.",
          clipWindow: null,
          video: null,
        }));
      },
    },
    storage: {
      async download(ref, destination) {
        const file = files.get(ref.path);
        if (!file)
          throw Object.assign(new Error("No such object"), { code: 404 });
        await writeFile(destination, file);
      },
      async save(file) {
        const path = `saved/${saved++}-${file.fileName}`;
        files.set(path, file.buffer);
        return { bucket: "b", path };
      },
      async loadVoice(productId, destination) {
        const voice = voices.get(productId);
        if (!voice) return false;
        await writeFile(destination, voice);
        return true;
      },
      async saveVoice(productId, flac) {
        voices.set(productId, flac);
      },
    },
    spend: {
      async allowance() {
        return {
          includedActions: 100,
          remainingActions: 5,
          spendLimitReached: false,
          spendRemainingMicros: 900_000,
          trialEnded: false,
          ...options.allowance,
        };
      },
      async reserve(operationId) {
        const refused = options.refuse?.(operationId);
        if (refused) throw new WorkspaceAiSpendError(refused);
        ops.push(operationId);
        return { operationId };
      },
      async settle(reservation, actual) {
        settled.push([
          (reservation as { operationId: string }).operationId,
          actual,
        ]);
      },
    },
    isolate:
      options.isolate === false
        ? null
        : async (wav) => {
            muse.isolate++;
            return wav;
          },
    isolationCostMicros: (seconds) => Math.ceil(seconds) * 2000,
    mode: options.mode ?? "make",
    renderNo: options.renderNo ?? 1,
    attempt: 1,
    workDir,
    pulse: () => undefined,
    now: () => new Date("2026-11-02T10:00:00Z"),
    askMuse: (async (
      _request: unknown,
      deps: { onCost?: (usd: number, what: string) => void },
    ) => {
      muse.script++;
      deps.onCost?.(0.016, "ad script");
      return GOOD_SCRIPT;
    }) as never,
    sceneDeps: {
      editMetaImage: async () => {
        muse.scenes++;
        return {
          image: await png(1280, 1920, "#d6c3a4"),
          mimeType: "image/png",
          costUsd: 0.01,
        };
      },
      checkSameProduct: async (request, deps) => {
        muse.checks++;
        deps?.onCost?.(0.004, "same product check");
        const same = checks.get(request.product)?.shift() ?? true;
        return { same, difference: same ? null : "The colour differs." };
      },
      segmentMetaImage: async () => {
        muse.sam++;
        return {
          result: {
            records: [
              {
                kind: "mask",
                order: 0,
                objectId: "0",
                identity: "0",
                revision: 0,
                mask: { encoding: "one_bit", payload: "", width: 1, height: 1 },
                bounds: { left: 320, top: 600, right: 960, bottom: 1500 },
                confidence: 0.9,
              } satisfies SegmentationMaskRecord,
            ],
          } as never,
          costUsd: 0.0025,
        };
      },
    },
    compose: (async (input) => ({
      plan: { scenes: [], starts: [], totalSeconds: 13.9, voice: null },
      timeline: { scenes: [], totalSeconds: 13.9 },
      status: await sharp(await png(108, 192, "#ffffff"))
        .jpeg()
        .toBuffer(),
      feed: await sharp(await png(108, 135, "#ffffff"))
        .jpeg()
        .toBuffer(),
      // Keep what it was given, for the assertions.
      ...({ input } as object),
    })) as typeof composeAd,
    render: async (_plan, outPath) => {
      h.rendered++;
      await writeFile(outPath, Buffer.from("mp4"));
      return { bytes: 3, size: { width: 1080, height: 1920 }, crf: 21, ms: 5 };
    },
    poster: async (_video, outPath) => {
      await writeFile(outPath, Buffer.from("jpg"));
    },
  };
  return h;
}

/** A clip with sound for each product, so "own voice" has words to polish. */
async function withClips(h: Harness, t: TestContext) {
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  } catch {
    t.skip("ffmpeg is not installed");
    return false;
  }
  const dir = await mkdtemp(join(tmpdir(), "product-ad-clip-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const samples = new Int16Array(48000 * 3);
  for (let i = 0; i < samples.length; i++)
    if (i > 12000 && i < 120000)
      samples[i] = Math.round(8000 * Math.sin((2 * Math.PI * 200 * i) / 48000));
  const pcm: Pcm = { samples, sampleRate: 48000 };
  const wav = join(dir, "voice.wav");
  await writeFile(wav, writeWav(pcm));
  const clip = join(dir, "clip.mp4");
  execFileSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=gray:s=64x64:d=3:r=10",
    "-i",
    wav,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    clip,
  ]);
  const bytes = await readFile(clip);
  h.files.set("p1/clip.mp4", bytes);
  h.files.set("p2/clip.mp4", bytes);
  return true;
}

test("a whole ad: every paid call reserved and settled under the ad's action, in order", async (t) => {
  const h = await harness(t);
  if (!(await withClips(h, t))) return;
  const result = await runProductAd(h.ports);
  assert.deepEqual(result, { status: "ready" });
  // One script call, a scene and a check per product, SAM per Muse scene,
  // one isolator call for all the words; each operation unique to the run.
  assert.deepEqual(h.ops.sort(), [
    "check:p1:a1:r1:t1",
    "check:p2:a1:r1:t1",
    "sam:p1:r1:t1",
    "sam:p2:r1:t1",
    "scene:p1:a1:r1:t1",
    "scene:p2:a1:r1:t1",
    "script:a1:r1:t1",
    "voice:r1:t1",
  ]);
  assert.equal(h.settled.length, h.ops.length);
  assert.ok(h.settled.every(([, actual]) => actual !== null && actual >= 0));
  assert.equal(h.muse.isolate, 1);
  assert.equal(h.doc.status, "ready");
  assert.equal(h.doc.step, null);
  assert.equal(h.doc.script.edited, false);
  assert.deepEqual(
    h.doc.scenes.map((scene: any) => [
      scene.productId,
      scene.method,
      Boolean(scene.box),
    ]),
    [
      ["p1", "muse", true],
      ["p2", "muse", true],
    ],
  );
  // 0.016 + 2 x (0.01 + 0.004 + 0.0025) + the isolator.
  assert.ok(
    h.doc.costMicros >= 49_000 && h.doc.costMicros < 70_000,
    String(h.doc.costMicros),
  );
  assert.ok(h.doc.stills.status && h.doc.stills.feed);
  assert.equal(h.doc.render.renderNo, 1);
  assert.equal(h.doc.render.seconds, 13.9);
  assert.equal(
    h.voices.size,
    2,
    "the polished words are kept for later renders",
  );
  for (const step of ["script", "pictures", "framing", "video"])
    assert.ok(h.doc.timings[step].finishedAt, `${step} has no finish time`);
});

test("the isolator failing is logged, and the owner's words are denoised instead", async (t) => {
  const h = await harness(t);
  if (!(await withClips(h, t))) return;
  h.ports.isolate = async () => {
    throw new Error(
      "Audio duration is 3.8 seconds, which is below the minimum of 4.6 seconds.",
    );
  };
  const logged: Array<[string, Record<string, unknown>]> = [];
  h.ports.log = (event, fields) => logged.push([event, fields]);
  await runProductAd(h.ports);
  assert.equal(h.doc.status, "ready");
  assert.deepEqual(logged, [
    [
      "products.ad_voice_isolation_skipped",
      {
        reason: "call_failed",
        detail:
          "Audio duration is 3.8 seconds, which is below the minimum of 4.6 seconds.",
      },
    ],
  ]);
  assert.equal(h.voices.size, 2, "the denoised words are kept");
});

test("the exact stills and the Status picture are saved before any picture is paid for", async (t) => {
  const h = await harness(t, {
    refuse: (op) =>
      op.startsWith("scene:") ? "workspace_ai_spend_limit" : null,
  });
  h.ports.isolate = null;
  h.doc.voice = "none";
  await runProductAd(h.ports);
  assert.ok(h.doc.stills.status, "the Status picture exists");
  assert.deepEqual(
    h.doc.scenes.map((scene: any) => [
      scene.method,
      Boolean(scene.exact),
      Boolean(scene.box),
    ]),
    [
      ["exact", true, true],
      ["exact", true, true],
    ],
  );
  // A refusal mid-run leaves exact photos, and the ad still finishes.
  assert.equal(h.doc.status, "ready");
  assert.equal(h.muse.scenes, 0);
});

test("a mismatch twice leaves the exact photo for that product only", async (t) => {
  const h = await harness(t, { checks: { "blonde doll": [false, false] } });
  h.doc.voice = "none";
  await runProductAd(h.ports);
  const methods = Object.fromEntries(
    h.doc.scenes.map((scene: any) => [scene.productId, scene.method]),
  );
  assert.deepEqual(methods, { p1: "exact", p2: "muse" });
  assert.equal(h.muse.scenes, 3);
  // The exact photo keeps its own box; only the Muse scene was framed.
  assert.equal(h.muse.sam, 1);
});

test("the first reservation refused: the ad fails with the import's own reason", async (t) => {
  for (const [code, allowance, expected] of [
    ["workspace_ai_spend_limit", {}, "spend_limit"],
    ["own_ai_source_required", { trialEnded: true }, "trial_ended"],
    ["own_ai_source_required", { remainingActions: 0 }, "ai_actions_used"],
  ] as const) {
    const h = await harness(t, { refuse: () => code, allowance });
    h.doc.voice = "none";
    await assert.rejects(runProductAd(h.ports), (error: unknown) => {
      assert.ok(error instanceof ProductAdFailure);
      assert.equal(error.code, expected);
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(h.muse.script, 0);
  }
});

test("refused after the action started: the script is the code's own, the ad finishes", async (t) => {
  const h = await harness(t, {
    ad: baseAd({ costMicros: 16_000, voice: "none" }),
    refuse: () => "workspace_ai_spend_limit",
  });
  await runProductAd(h.ports);
  assert.equal(h.doc.status, "ready");
  assert.equal(h.doc.script.sticker, "Сөремізде жаңа тауар");
  assert.equal(h.muse.script, 0);
});

test("a retried run pays for nothing saved; a render run calls no model at all", async (t) => {
  const first = await harness(t);
  if (!(await withClips(first, t))) return;
  await runProductAd(first.ports);
  const saved = structuredClone(first.doc);

  // The same run retried after a crash in the render: nothing paid again.
  const retried = await harness(t, {
    ad: { ...(saved as AdRecord), status: "making", renderNo: 1 },
  });
  for (const [key, value] of first.files) retried.files.set(key, value);
  for (const [key, value] of first.voices) retried.voices.set(key, value);
  await runProductAd(retried.ports);
  assert.deepEqual(retried.ops, []);
  assert.equal(retried.muse.isolate, 0);
  assert.equal(retried.rendered, 1);

  // The owner edits a caption: render 2, no reservation, no model call.
  const edited: ProductAdScript = {
    ...saved.script,
    edited: true,
    sticker: "Тек бүгін",
  };
  const render = await harness(t, {
    ad: {
      ...(saved as AdRecord),
      status: "making",
      renderNo: 2,
      script: edited,
    },
    mode: "render",
    renderNo: 2,
  });
  for (const [key, value] of first.files) render.files.set(key, value);
  for (const [key, value] of first.voices) render.voices.set(key, value);
  await runProductAd(render.ports);
  assert.deepEqual(render.ops, []);
  assert.deepEqual(render.muse, {
    scenes: 0,
    checks: 0,
    sam: 0,
    script: 0,
    isolate: 0,
  });
  assert.equal(render.doc.status, "ready");
  assert.equal(render.doc.render.renderNo, 2);
  assert.equal(render.doc.script.sticker, "Тек бүгін");
  assert.match(render.doc.render.video.path, /r2-ad\.mp4$/);
});

test("a render run without kept words is silent rather than paying", async (t) => {
  const h = await harness(t, {
    ad: baseAd({ script: { ...GOOD_SCRIPT, edited: true } as ProductAdScript }),
    mode: "render",
  });
  let given: Parameters<typeof composeAd>[0] | null = null;
  const compose = h.ports.compose!;
  h.ports.compose = async (input, deps) => {
    given = input;
    return compose(input, deps);
  };
  await runProductAd(h.ports);
  assert.deepEqual(h.ops, []);
  assert.ok(given);
  assert.ok(
    (given as Parameters<typeof composeAd>[0]).products.every(
      (product) => product.voice === null,
    ),
  );
  // Exact stills are drawn for a render that finds none saved.
  assert.equal(h.doc.scenes.length, 2);
});

test("a newer run took over: this one stops without writing", async (t) => {
  const h = await harness(t, { renderNo: 1, ad: baseAd({ renderNo: 2 }) });
  assert.deepEqual(await runProductAd(h.ports), { status: "superseded" });
  assert.equal(h.doc.status, "making");
});

test("a shop's name the fonts can't draw isn't given to Muse Spark to write", async (t) => {
  const h = await harness(t, {
    ad: baseAd({
      voice: "none",
      ending: { phone: "+7 000 000 00 00", shopName: "Цветы 🌸" },
    }),
  });
  const questions: string[] = [];
  const ask = h.ports.askMuse!;
  h.ports.askMuse = (async (request, deps, options) => {
    questions.push((request as { question: string }).question);
    return ask(request, deps, options);
  }) as typeof ask;
  await runProductAd(h.ports);
  assert.equal(questions.length, 1);
  assert.doesNotMatch(questions[0]!, /The shop is called/);
  assert.doesNotMatch(questions[0]!, /🌸/);
  assert.equal(h.doc.status, "ready");
});

test("a product's cut-out gone from storage fails the ad as photo_missing", async (t) => {
  const h = await harness(t, { missing: ["p2/cutout.png"] });
  await assert.rejects(runProductAd(h.ports), (error: unknown) => {
    assert.ok(error instanceof ProductAdFailure);
    assert.equal(error.code, "photo_missing");
    assert.equal(error.retryable, false);
    return true;
  });
});

test("a missing cut-out fails the ad only once the other products' files are written", async (t) => {
  const h = await harness(t, { missing: ["p2/cutout.png"] });
  const download = h.ports.storage.download;
  h.ports.storage.download = async (ref, destination, maxBytes) => {
    // A storage round trip: p1's files land after p2's is found missing.
    if (ref.path.startsWith("p1/"))
      await new Promise((resolve) => setTimeout(resolve, 30));
    return download(ref, destination, maxBytes);
  };
  await assert.rejects(runProductAd(h.ports), ProductAdFailure);
  const atFailure = (await readdir(h.ports.workDir)).sort();
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Nothing lands in the folder after the run ended, while the activity
  // removes it (the deploy's worker tests failed on ENOTEMPTY here).
  assert.deepEqual((await readdir(h.ports.workDir)).sort(), atFailure);
});

test("removing the work folder never changes how the run ended", async () => {
  const errors: unknown[] = [];
  const busy = Object.assign(new Error("directory not empty"), {
    code: "ENOTEMPTY",
  });
  await removeWorkDir("unused", (error) => errors.push(error), (async () => {
    throw busy;
  }) as typeof rm);
  assert.deepEqual(errors, [busy]);

  const dir = await mkdtemp(join(tmpdir(), "product-ad-clean-"));
  await writeFile(join(dir, "ad.mp4"), "mp4");
  await removeWorkDir(dir);
  await assert.rejects(readdir(dir), { code: "ENOENT" });
});

test("errors map to what the owner sees, and whether a retry can help", () => {
  assert.equal(classifyAdError(new AdTooBigError(17_000_000)).code, "too_big");
  assert.equal(classifyAdError(new AdTooBigError(17_000_000)).retryable, false);
  assert.equal(
    classifyAdError(new WorkspaceAiSpendError("workspace_ai_spend_limit")).code,
    "spend_limit",
  );
  const policy = classifyAdError(
    new WorkspaceAiSpendError("workspace_ai_policy_unavailable"),
  );
  assert.deepEqual([policy.code, policy.retryable], ["failed", true]);
  const ffmpeg = classifyAdError(new Error("ffmpeg exited with code 1"));
  assert.deepEqual([ffmpeg.code, ffmpeg.retryable], ["failed", true]);
});

// The ad's own file refs are plain bucket and path pairs.
const _ref: ProductAdFileRef = { bucket: "b", path: "p" };
void _ref;
