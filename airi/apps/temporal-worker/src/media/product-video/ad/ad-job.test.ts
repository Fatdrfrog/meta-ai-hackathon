import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { MetaModelApiError } from "@icecore/airi-runtime/meta-model-api";
import type { SegmentationMaskRecord } from "@icecore/airi-runtime/meta-sam";
import { WorkspaceAiSpendError } from "@icecore/airi-runtime/workspace-ai-spend";
import type { ProductAdFileRef, ProductAdScript } from "@icecore/temporal";
import sharp from "sharp";

import {
  classifyAdError,
  ProductAdFailure,
  removeWorkDir,
  runProductAd,
  SCRIPT_MAX_COST_MICROS,
  SCRIPT_MAX_OUTPUT_TOKENS,
  scriptResponse,
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
    stockVoiceId: null,
    voiceOver: null,
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
    place: number;
  };
  rendered: number;
  /** What the stills were asked to draw, per run. */
  stillsAsked: Array<Record<string, unknown>>;
  /** When each poster was taken. */
  posterAt: Array<number | undefined>;
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
    /** Any other error a reservation throws (the company's AI switch). */
    reserveError?: (operationId: string) => Error | null;
    allowance?: Partial<AdSpendAllowance>;
    /** Muse Spark's verdicts per product description, in order; "same" after them. */
    checks?: Record<string, boolean[]>;
    isolate?: boolean;
    missing?: string[];
    /** Muse Spark's reading of a described place. */
    place?: unknown;
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
  const muse = {
    scenes: 0,
    checks: 0,
    sam: 0,
    script: 0,
    isolate: 0,
    place: 0,
  };
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
    stillsAsked: [],
    posterAt: [],
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
        const thrown = options.reserveError?.(operationId);
        if (thrown) throw thrown;
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
      request: { purpose?: string },
      deps: { onCost?: (usd: number, what: string) => void },
    ) => {
      if (request.purpose === "ad place") {
        muse.place++;
        // An error in its place is Muse Spark's answer failing.
        if (options.place instanceof Error) throw options.place;
        deps.onCost?.(0.002, "ad place");
        return options.place ?? { ok: true, place: "a place", reason: "none" };
      }
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
      textOverlap: input.products.map((product) =>
        product.textZone === "bottom"
          ? { covers: false, suggested: null }
          : { covers: true, suggested: "bottom" as const },
      ),
      // Keep what it was given, for the assertions.
      ...({ input } as object),
    })) as typeof composeAd,
    render: async (_plan, outPath) => {
      h.rendered++;
      await writeFile(outPath, Buffer.from("mp4"));
      return { bytes: 3, size: { width: 1080, height: 1920 }, crf: 21, ms: 5 };
    },
    poster: async (_video, outPath, _deps, atSeconds) => {
      h.posterAt.push(atSeconds);
      await writeFile(outPath, Buffer.from("jpg"));
    },
    stills: async (input) => {
      h.stillsAsked.push(input as unknown as Record<string, unknown>);
      const image = Buffer.from("still");
      return [
        {
          kind: "room",
          format: "feed",
          productId: "p1",
          colourway: null,
          image,
        },
        {
          kind: "studio",
          format: "feed",
          productId: "p1",
          colourway: "sage",
          image,
        },
        {
          kind: "collection",
          format: "feed",
          productId: null,
          colourway: null,
          image,
        },
      ];
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

test("new words that can't be read fall back to the recording, and the ad says why", async (t) => {
  const h = await harness(t, { ad: baseAd({ voice: "clone" }) });
  if (!(await withClips(h, t))) return;
  await runProductAd(h.ports);
  assert.equal(h.doc.status, "ready");
  // voice.ts reads nothing yet: the owner's own clips stand in, polished.
  assert.equal(h.muse.isolate, 1);
  assert.deepEqual(h.doc.voiceResult, { used: "own", fallback: "unavailable" });
  assert.equal(h.doc.voiceOver, null);
});

test("new words with no recording to fall back to leave the ad silent, and say why", async (t) => {
  const h = await harness(t, { ad: baseAd({ voice: "stock" }) });
  await runProductAd(h.ports);
  assert.equal(h.doc.status, "ready");
  assert.equal(h.muse.isolate, 0);
  assert.deepEqual(h.doc.voiceResult, {
    used: "none",
    fallback: "unavailable",
  });
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
    place: 0,
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

test("the script call may write SCRIPT_MAX_OUTPUT_TOKENS, past ask-muse's 3 000", async () => {
  const sent: unknown[] = [];
  const create = scriptResponse((async (request: unknown) => {
    sent.push(request);
    return { status: "completed", output: [] };
  }) as never);
  await create(
    { model: "muse", input: [], max_output_tokens: 3000 } as never,
    undefined,
  );
  assert.equal(SCRIPT_MAX_OUTPUT_TOKENS, 6000);
  assert.deepEqual(sent, [
    { model: "muse", input: [], max_output_tokens: SCRIPT_MAX_OUTPUT_TOKENS },
  ]);
  // Its reservation still covers the most it can write, with 8k tokens in.
  assert.ok(
    SCRIPT_MAX_OUTPUT_TOKENS * 4.25 + 8000 * 1.25 <= SCRIPT_MAX_COST_MICROS,
  );
});

test("the script's Muse Spark call gets the roomier Responses call; the place's doesn't need it", async (t) => {
  const h = await harness(t, { ad: baseAd({ voice: "none" }) });
  const seen: Array<{ purpose: string; create: unknown }> = [];
  const ask = h.ports.askMuse!;
  h.ports.askMuse = (async (request, deps, options) => {
    seen.push({
      purpose: (request as { purpose: string }).purpose,
      create: (deps as { createMetaResponse?: unknown }).createMetaResponse,
    });
    return ask(request, deps, options);
  }) as typeof ask;
  await runProductAd(h.ports);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.purpose, "ad script");
  assert.equal(typeof seen[0]!.create, "function");
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
  // The company turned AI off: its own code, never retried, by the code
  // alone (the web host's error class isn't this realm's), wrapped or not.
  const off = classifyAdError({ code: "workspace_ai_disabled" });
  assert.deepEqual([off.code, off.retryable], ["ai_disabled", false]);
  const wrapped = classifyAdError(
    new Error("Activity failed", {
      cause: Object.assign(new Error("AI is disabled for this company."), {
        code: "workspace_ai_disabled",
      }),
    }),
  );
  assert.deepEqual([wrapped.code, wrapped.retryable], ["ai_disabled", false]);
});

test("a company that turned AI off: the ad fails as ai_disabled, before any model is paid", async (t) => {
  const h = await harness(t, {
    reserveError: () =>
      Object.assign(new Error("AI is disabled for this company."), {
        code: "workspace_ai_disabled",
      }),
  });
  h.doc.voice = "none";
  const error = await runProductAd(h.ports).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  assert.ok(error, "the run must not finish");
  const failure = classifyAdError(error);
  assert.deepEqual([failure.code, failure.retryable], ["ai_disabled", false]);
  assert.equal(h.muse.script, 0);
  assert.equal(h.muse.scenes, 0);
  assert.deepEqual(h.ops, []);
});

// The ad's own file refs are plain bucket and path pairs.
const _ref: ProductAdFileRef = { bucket: "b", path: "p" };
void _ref;

// ---------------------------------------------------------------------------
// Studio v2: edit runs.

/** A whole first make, silent, so its saved state can be edited. */
async function afterFirstMake(t: TestContext) {
  const first = await harness(t, { ad: baseAd({ voice: "none" }) });
  await runProductAd(first.ports);
  assert.equal(first.doc.status, "ready");
  return first;
}

/**
 * The ad as the web leaves it after a "New picture" press on p1: render 2,
 * a scene run, p1 back on its exact still with the press's `redo`.
 */
function pressed(
  saved: Record<string, any>,
  place: Record<string, unknown>,
  scene: Record<string, unknown> = {},
): AdRecord {
  const p1 = saved.scenes[0];
  return {
    ...(structuredClone(saved) as AdRecord),
    status: "making",
    renderNo: 2,
    runKind: "scene",
    scenes: [
      {
        ...structuredClone(p1),
        method: "exact",
        muse: null,
        check: null,
        box: p1.exactBox,
        place: { setting: null, words: null, englishPlace: null, ...place },
        redo: {
          requestId: "press-1",
          renderNo: 2,
          from: {
            muse: p1.muse,
            box: p1.box,
            method: p1.method,
            check: p1.check,
          },
          outcome: null,
          reason: null,
        },
        ...scene,
      },
      structuredClone(saved.scenes[1]),
    ],
  };
}

/** A harness on the first make's files. */
async function next(
  t: TestContext,
  first: Harness,
  options: Parameters<typeof harness>[1],
) {
  const h = await harness(t, options);
  for (const [key, value] of first.files) h.files.set(key, value);
  for (const [key, value] of first.voices) h.voices.set(key, value);
  return h;
}

test("a first make keeps each passed picture with its place, and records the run", async (t) => {
  const first = await afterFirstMake(t);
  const p1 = first.doc.scenes[0];
  assert.equal(p1.pictures.length, 1);
  assert.deepEqual(p1.pictures[0].ref, p1.muse);
  assert.deepEqual(
    p1.pictures[0].box,
    p1.box,
    "framing boxed the kept picture",
  );
  assert.equal(
    p1.pictures[0].place,
    "a white shelf in a bright children's playroom",
  );
  assert.deepEqual(p1.place, {
    setting: "playroom_shelf",
    words: null,
    englishPlace: null,
  });
  assert.ok(p1.exactBox, "the exact still's box is kept beside it");
  assert.deepEqual(first.doc.lastRun, {
    renderNo: 1,
    kind: "make",
    outcome: "ready",
    errorCode: null,
    message: null,
    at: new Date("2026-11-02T10:00:00Z"),
  });
  // The words' overlap is saved with the video it describes.
  assert.deepEqual(p1.textOverlap, { covers: true, suggested: "bottom" });
});

test("a New picture press pays only for its scene, and keeps the earlier picture", async (t) => {
  const first = await afterFirstMake(t);
  const h = await next(t, first, {
    ad: pressed(first.doc, { setting: "stone_counter" }),
    renderNo: 2,
  });
  await runProductAd(h.ports);
  // p1 had one Muse Image call: this press's first try is its second.
  assert.deepEqual(h.ops.sort(), [
    "check:p1:a2:r2:t1",
    "sam:p1:r2:t1",
    "scene:p1:a2:r2:t1",
  ]);
  assert.equal(h.muse.script, 0);
  const p1 = h.doc.scenes[0];
  assert.equal(p1.method, "muse");
  assert.match(p1.muse.path, /scene-p1-a2\.jpg$/);
  assert.ok(p1.box);
  assert.equal(p1.allowance, 3);
  assert.equal(p1.redo.allowance, 3);
  assert.equal(p1.redo.outcome, "new");
  assert.deepEqual(
    p1.pictures.map((picture: any) => [picture.place, Boolean(picture.box)]),
    [
      ["a white shelf in a bright children's playroom", true],
      ["a pale stone counter", true],
    ],
  );
  // p2 is untouched and paid nothing.
  assert.deepEqual(h.doc.scenes[1], {
    ...first.doc.scenes[1],
    textOverlap: h.doc.scenes[1].textOverlap,
  });
  assert.equal(h.doc.status, "ready");
  assert.equal(h.doc.render.renderNo, 2);
  assert.equal(h.doc.lastRun.kind, "scene");
  assert.equal(h.doc.lastRun.outcome, "ready");
  assert.ok(h.doc.timings.framing.finishedAt);
});

test("a press whose picture fails the check gives the scene back its picture", async (t) => {
  const first = await afterFirstMake(t);
  const h = await next(t, first, {
    ad: pressed(first.doc, { setting: "gift_table" }),
    renderNo: 2,
    checks: { "blonde doll": [false, false] },
  });
  await runProductAd(h.ports);
  assert.deepEqual(h.ops.sort(), [
    "check:p1:a2:r2:t1",
    "check:p1:a3:r2:t1",
    "scene:p1:a2:r2:t1",
    "scene:p1:a3:r2:t1",
  ]);
  const before = first.doc.scenes[0];
  const p1 = h.doc.scenes[0];
  assert.equal(p1.redo.outcome, "kept_check");
  assert.deepEqual(
    [p1.method, p1.muse, p1.box, p1.check],
    [before.method, before.muse, before.box, before.check],
  );
  assert.equal(p1.pictures.length, 1);
  // The video still renders, with any free changes that went in.
  assert.equal(h.doc.status, "ready");
  assert.equal(h.doc.render.renderNo, 2);
});

test("a press the ledger refuses ends as no_budget, the scene as it was", async (t) => {
  const first = await afterFirstMake(t);
  const h = await next(t, first, {
    ad: pressed(first.doc, { setting: "linen_shelf" }),
    renderNo: 2,
    refuse: (op) =>
      op.startsWith("scene:") ? "workspace_ai_spend_limit" : null,
  });
  await runProductAd(h.ports);
  const p1 = h.doc.scenes[0];
  assert.equal(p1.redo.outcome, "no_budget");
  assert.deepEqual(p1.muse, first.doc.scenes[0].muse);
  assert.equal(h.doc.status, "ready");
});

test("Describe a place: Muse Spark reads it once, and Muse Image sets the product there", async (t) => {
  const first = await afterFirstMake(t);
  const h = await next(t, first, {
    ad: pressed(first.doc, { words: "киіз үйдегі кілемде" }),
    renderNo: 2,
    place: { ok: true, place: "a felt rug inside a yurt", reason: "none" },
  });
  await runProductAd(h.ports);
  assert.equal(h.muse.place, 1);
  assert.ok(h.ops.includes("place:p1:p2:r2:t1"), h.ops.join());
  const p1 = h.doc.scenes[0];
  assert.equal(p1.place.englishPlace, "a felt rug inside a yurt");
  assert.equal(p1.redo.outcome, "new");
  assert.equal(p1.pictures.at(-1).place, "a felt rug inside a yurt");
});

test("a described place Muse Spark refuses ends the press before any picture is paid for", async (t) => {
  const first = await afterFirstMake(t);
  const h = await next(t, first, {
    ad: pressed(first.doc, { words: "a woman holding it" }),
    renderNo: 2,
    place: { ok: false, place: "", reason: "people" },
  });
  await runProductAd(h.ports);
  assert.equal(h.muse.scenes, 0);
  assert.deepEqual(h.ops, ["place:p1:p2:r2:t1"]);
  const p1 = h.doc.scenes[0];
  assert.deepEqual(
    [p1.redo.outcome, p1.redo.reason],
    ["place_refused", "people"],
  );
  assert.deepEqual(p1.muse, first.doc.scenes[0].muse);
  assert.equal(h.doc.status, "ready");
  assert.ok(h.doc.timings.pictures.finishedAt, "the press's step ended");
});

test("a retried press never raises its allowance twice", async (t) => {
  const first = await afterFirstMake(t);
  // The press's last try was made (attempts at its allowance) when the run
  // crashed; the retry finds the raise recorded.
  const ad = pressed(
    first.doc,
    { setting: "stone_counter" },
    {
      attempts: 3,
      allowance: 3,
      check: { same: false, difference: "The dress is red." },
    },
  );
  ad.scenes[0]!.redo!.allowance = 3;
  const h = await next(t, first, { ad, renderNo: 2 });
  await runProductAd(h.ports);
  assert.deepEqual(h.ops, []);
  assert.equal(h.doc.scenes[0].redo.outcome, "kept_check");
  assert.equal(h.doc.scenes[0].allowance, 3);
});

test("an ad from before keeps the picture a press replaces, to pick again", async (t) => {
  const first = await afterFirstMake(t);
  const saved = structuredClone(first.doc);
  delete saved.scenes[0].pictures;
  // The web writes the pressed chip into the script, and the setting the
  // replaced picture was made in onto the press.
  saved.script.scenes[0].setting = "stone_counter";
  const ad = pressed(saved, { setting: "stone_counter" });
  ad.scenes[0]!.redo!.from.setting = "playroom_shelf";
  const h = await next(t, first, { ad, renderNo: 2 });
  await runProductAd(h.ports);
  assert.deepEqual(
    h.doc.scenes[0].pictures.map((picture: any) => picture.ref),
    [first.doc.scenes[0].muse, h.doc.scenes[0].muse],
  );
  // Each picture is named by the place it shows.
  assert.deepEqual(
    h.doc.scenes[0].pictures.map((picture: any) => picture.place),
    ["a white shelf in a bright children's playroom", "a pale stone counter"],
  );
});

test("a described place Muse Spark refuses outright ends as a refused place, not an outage", async (t) => {
  const first = await afterFirstMake(t);
  const h = await next(t, first, {
    ad: pressed(first.doc, { words: "something Muse Spark won't touch" }),
    renderNo: 2,
    place: new MetaModelApiError({
      kind: "invalid_request",
      transient: false,
      code: "refusal",
      message: "The model refused to answer",
    }),
  });
  await runProductAd(h.ports);
  const p1 = h.doc.scenes[0];
  assert.deepEqual(
    [p1.redo.outcome, p1.redo.reason],
    ["place_refused", "unclear"],
  );
  assert.equal(h.muse.scenes, 0);
  assert.deepEqual(p1.muse, first.doc.scenes[0].muse);
  assert.equal(h.doc.status, "ready");

  // Meta down is still "try again in a minute".
  const down = await next(t, first, {
    ad: pressed(first.doc, { words: "a felt rug inside a yurt" }),
    renderNo: 2,
    place: new MetaModelApiError({
      kind: "server",
      transient: true,
      message: "Service unavailable",
    }),
  });
  await runProductAd(down.ports);
  assert.equal(down.doc.scenes[0].redo.outcome, "unavailable");
});

test("a voice run back to the recording or no voice clears the old voice's fallback", async (t) => {
  const first = await afterFirstMake(t);
  for (const voice of ["own", "none"] as const) {
    const h = await next(t, first, {
      ad: {
        ...(structuredClone(first.doc) as AdRecord),
        status: "making",
        renderNo: 2,
        runKind: "voice",
        voice,
        stockVoiceId: null,
        voiceResult: { used: "own", fallback: "no_voice" },
      } as AdRecord,
      renderNo: 2,
    });
    await runProductAd(h.ports);
    assert.equal(h.doc.status, "ready", voice);
    assert.equal(h.doc.voiceResult, null, voice);
  }
});

test("Update renders the exact photo where asked, with its box, worked out for ads from before", async (t) => {
  const first = await afterFirstMake(t);
  const saved = structuredClone(first.doc);
  const exactBox = saved.scenes[0].exactBox;
  saved.scenes[0].useExact = true;
  delete saved.scenes[0].exactBox;
  saved.scenes[1].textZone = "bottom";
  const h = await next(t, first, {
    ad: {
      ...(saved as AdRecord),
      status: "making",
      renderNo: 2,
      runKind: "render",
    },
    mode: "render",
    renderNo: 2,
  });
  let given: Parameters<typeof composeAd>[0] | null = null;
  const compose = h.ports.compose!;
  h.ports.compose = async (input, deps) => {
    given = input;
    return compose(input, deps);
  };
  await runProductAd(h.ports);
  assert.deepEqual(h.ops, []);
  const products = (given as unknown as Parameters<typeof composeAd>[0])
    .products;
  assert.ok(
    products[0]!.picture.equals(h.files.get(saved.scenes[0].exact.path)!),
    "the exact still, not Muse Image's scene",
  );
  assert.deepEqual(products[0]!.box, exactBox);
  assert.deepEqual(
    h.doc.scenes[0].exactBox,
    exactBox,
    "kept for the next press",
  );
  // The zone reaches compose, and the overlap comes back with the video.
  assert.deepEqual(
    products.map((product) => product.textZone),
    ["auto", "bottom"],
  );
  assert.deepEqual(h.doc.scenes[1].textOverlap, {
    covers: false,
    suggested: null,
  });
  assert.equal(h.doc.lastRun.kind, "render");
});

test("a voice run pays for no scene and no words, even a scene left without its picture", async (t) => {
  const first = await afterFirstMake(t);
  const saved = structuredClone(first.doc);
  // p2 kept its exact still after a refusal in the first make.
  Object.assign(saved.scenes[1], {
    method: "exact",
    muse: null,
    box: saved.scenes[1].exactBox,
    attempts: 0,
  });
  const h = await next(t, first, {
    ad: {
      ...(saved as AdRecord),
      status: "making",
      renderNo: 2,
      runKind: "voice",
      voice: "stock",
      stockVoiceId: "airi-1",
    },
    renderNo: 2,
  });
  await runProductAd(h.ports);
  assert.deepEqual(h.ops, []);
  assert.deepEqual(
    [h.muse.scenes, h.muse.checks, h.muse.sam, h.muse.script],
    [0, 0, 0, 0],
  );
  assert.equal(h.doc.scenes[1].method, "exact");
  assert.equal(h.doc.status, "ready");
  assert.equal(h.doc.lastRun.kind, "voice");
});

// ---------------------------------------------------------------------------
// Studio v3: motions and stills.

/** Wraps the harness's compose to keep what each run gave it. */
function keepComposeInput(h: Harness) {
  const inner = h.ports.compose!;
  const given: Array<Parameters<typeof composeAd>[0]> = [];
  h.ports.compose = async (input, deps) => {
    given.push(input);
    return inner(input, deps);
  };
  return given;
}

test("a run saves its stills by the contract's names and writes the stillSet top-level, with this render's number", async (t) => {
  const h = await harness(t, {
    ad: baseAd({ renderNo: 3, voice: "none" }),
    renderNo: 3,
  });
  const result = await runProductAd(h.ports);
  assert.deepEqual(result, { status: "ready" });
  assert.equal(h.doc.stillSet.renderNo, 3);
  assert.deepEqual(
    h.doc.stillSet.items.map((item: Record<string, unknown>) => ({
      ...item,
      ref: {
        ...(item.ref as object),
        path: String((item.ref as { path: string }).path).replace(
          /^saved\/\d+-/,
          "",
        ),
      },
    })),
    [
      {
        kind: "room",
        format: "feed",
        productId: "p1",
        colourway: null,
        ref: { bucket: "b", path: "3-room-feed-p1-x.jpg" },
      },
      {
        kind: "studio",
        format: "feed",
        productId: "p1",
        colourway: "sage",
        ref: { bucket: "b", path: "3-studio-feed-p1-sage.jpg" },
      },
      {
        kind: "collection",
        format: "feed",
        productId: null,
        colourway: null,
        ref: { bucket: "b", path: "3-collection-feed-all-x.jpg" },
      },
    ],
  );
  for (const item of h.doc.stillSet.items)
    assert.deepEqual(h.files.get(item.ref.path), Buffer.from("still"));
  // v2's two pictures are written as before, whole, beside it.
  assert.deepEqual(Object.keys(h.doc.stills).sort(), ["feed", "status"]);
  assert.ok(h.doc.stills.status && h.doc.stills.feed);
  // The stills are drawn from the same products and words as the video.
  const asked = h.stillsAsked[0]!;
  assert.equal(asked.sticker, GOOD_SCRIPT.sticker);
  assert.equal(asked.priceCardTitle, GOOD_SCRIPT.priceCardTitle);
  assert.equal(asked.ending, GOOD_SCRIPT.ending);
  assert.equal(asked.shopName, "Demo Shop");
  assert.deepEqual(
    (asked.products as Array<{ productId: string; priceText: string }>).map(
      (product) => [product.productId, product.priceText],
    ),
    h.doc.products.map((product: { productId: string; priceText: string }) => [
      product.productId,
      product.priceText,
    ]),
  );
});

test("the ad's motion, each product's filmed frame and whether its scene is made reach the video", async (t) => {
  const h = await harness(t, {
    ad: baseAd({ voice: "none", motion: "filmed_sold" }),
  });
  const given = keepComposeInput(h);
  await runProductAd(h.ports);
  const input = given[0]!;
  assert.equal(input.motion, "filmed_sold");
  for (const product of input.products) {
    // The item as filmed, as the import saved it.
    assert.ok(Buffer.isBuffer(product.original), product.productId);
    // Muse Image's scene passed its check: the picture is made.
    assert.equal(product.made, true, product.productId);
  }
  // The poster is taken where compose says, at 1.2 s when it doesn't say.
  assert.deepEqual(h.posterAt, [1.2]);
});

test("an ad from before motions, or with one this worker doesn't know, renders as the shelf; an exact photo isn't made", async (t) => {
  for (const motion of [undefined, "spin"]) {
    const h = await harness(t, {
      ad: baseAd({
        voice: "none",
        ...(motion ? { motion: motion as never } : {}),
      }),
      checks: { "blonde doll": [false, false, false, false] },
      missing: ["p2/original.jpg"],
    });
    const given = keepComposeInput(h);
    await runProductAd(h.ports);
    const input = given[0]!;
    assert.equal(input.motion, "shelf");
    const [p1, p2] = input.products;
    // The doll failed every check: its scene is the exact photo.
    assert.equal(p1!.made, false);
    assert.equal(p2!.made, true);
    // The cup's filmed frame is gone from storage: it has none.
    assert.equal(p2!.original, null);
  }
});

test("compose's poster time is the one the poster is taken at", async (t) => {
  const h = await harness(t, {
    ad: baseAd({ voice: "none", motion: "filmed_sold" }),
  });
  const inner = h.ports.compose!;
  h.ports.compose = async (input, deps) => ({
    ...(await inner(input, deps)),
    posterSeconds: 1.58,
  });
  await runProductAd(h.ports);
  assert.deepEqual(h.posterAt, [1.58]);
});

test("stills that can't be drawn never fail the video: no stillSet, and the run says why", async (t) => {
  const h = await harness(t, { ad: baseAd({ voice: "none" }) });
  const logged: Array<[string, Record<string, unknown>]> = [];
  h.ports.log = (event, fields) => logged.push([event, fields]);
  h.ports.stills = async () => {
    throw new Error("Pango is out of fonts");
  };
  const result = await runProductAd(h.ports);
  assert.deepEqual(result, { status: "ready" });
  assert.equal(h.doc.status, "ready");
  assert.ok(h.doc.render?.video);
  assert.equal(h.doc.stillSet, undefined);
  assert.deepEqual(logged, [
    ["products.ad_stills_failed", { error: "Pango is out of fonts" }],
  ]);
});

test("no stills drawn leaves an earlier render's stillSet as it was: the page shows it with that render only", async (t) => {
  const earlier = { renderNo: 1, items: [] };
  const h = await harness(t, {
    ad: {
      ...baseAd({ voice: "none", renderNo: 2 }),
      stillSet: earlier,
    } as AdRecord,
    renderNo: 2,
  });
  h.ports.stills = async () => [];
  await runProductAd(h.ports);
  assert.deepEqual(h.doc.stillSet, earlier);
});
