import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { MetaModelApiError } from "@icecore/airi-runtime/meta-model-api";
import sharp from "sharp";

import type { ProductCutout } from "./cutout";
import {
  classifyImportError,
  ProductVideoImportFailure,
  runProductVideoImport,
  type ImportJobPorts,
  type NewDraftProduct,
  type ProductPhoto,
} from "./import-job";
import type { InventoryItem } from "./inventory";
import { ProductVideoError } from "./media";
import type { PresenterCutout } from "./presenter";

const TRANSCRIPT =
  "[1.0] Кукла Лол, бес мың теңге.\n[9.0] Кружка, бес жүз теңге.";

const item = (overrides: Partial<InventoryItem>): InventoryItem => ({
  name: "LOL doll",
  localName: "Кукла Лол",
  category: "toy",
  samPhrase: "blonde doll",
  price: 5000,
  currency: "KZT",
  priceQuote: "бес мың теңге",
  priceQuoteSeconds: 1,
  priceSource: "spoken",
  priceIsFrom: false,
  firstSeenSeconds: 0,
  clearestMomentSeconds: 2,
  doubt: null,
  ...overrides,
});

const INVENTORY = {
  language: "kk",
  presenter: null as { clearestMomentSeconds: number } | null,
  items: [
    item({}),
    item({
      name: "Frosted cup",
      localName: "Кружка",
      samPhrase: "frosted cup",
      price: 500,
      priceQuote: "бес жүз теңге",
      firstSeenSeconds: 8,
      clearestMomentSeconds: 9,
      doubt: "Is it 500 or 5000?",
    }),
    item({
      name: "Rooster",
      localName: "Әтеш",
      samPhrase: "white rooster",
      price: null,
      priceQuote: null,
      priceQuoteSeconds: null,
      priceSource: null,
      firstSeenSeconds: 20,
      clearestMomentSeconds: 22,
    }),
  ],
};

type FakeProduct = NewDraftProduct & {
  id: string;
  photo: ProductPhoto | { method: "pending" };
};

async function setUp(
  t: TestContext,
  options: {
    transcript?: string | null;
    products?: FakeProduct[];
    cutOut?: (name: string, workDir: string) => Promise<ProductCutout>;
    tracked?: boolean;
    /** When the inventory says someone presents the products. */
    presenterMoment?: number;
    /** The import's presenter as a previous run left it. */
    presenter?: { momentSeconds: number; photo: unknown } | null;
    cutOutPresenter?: (workDir: string) => Promise<PresenterCutout | null>;
  } = {},
) {
  const workDir = await mkdtemp(join(tmpdir(), "import-job-"));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const state = {
    import: {
      status: "queued" as const,
      stage: null as unknown,
      transcript: options.transcript ?? null,
      productDone: 0,
      costUsd: 0,
      presenter: options.presenter ?? null,
    } as Record<string, unknown>,
    products: [...(options.products ?? [])],
    stages: [] as unknown[],
  };
  const calls = {
    transcribe: 0,
    inventory: 0,
    cutOut: [] as string[],
    presenter: 0,
    emits: [] as string[],
    spend: [] as string[],
    saved: [] as string[],
  };

  const photoFile = async (dir: string, name: string, kind: "jpeg" | "png") => {
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    const image = sharp({
      create: {
        width: 40,
        height: 80,
        channels: 4,
        background: { r: 200, g: 30, b: 60, alpha: 1 },
      },
    });
    await (kind === "jpeg" ? image.jpeg() : image.png()).toFile(path);
    return path;
  };
  const defaultCutOut = async (
    _name: string,
    dir: string,
  ): Promise<ProductCutout> => ({
    method: "restored",
    frameTimeSeconds: 1.5,
    originalPath: await photoFile(dir, "original.jpg", "jpeg"),
    cutoutPath: await photoFile(dir, "cutout.png", "png"),
    samConfidence: 0.95,
    notes: [],
  });

  const ports: ImportJobPorts = {
    store: {
      async loadImport() {
        return {
          status: state.import.status as "queued",
          video: {
            bucket: "media",
            path: "workspaces/w1/creative-assets/video/a1/shelf.mov",
          },
          transcript: state.import.transcript as string | null,
          presenter: state.import.presenter
            ? {
                momentSeconds: (
                  state.import.presenter as { momentSeconds: number }
                ).momentSeconds,
                done: Boolean(
                  (state.import.presenter as { photo: unknown }).photo,
                ),
              }
            : null,
        };
      },
      async updateImport(set, inc) {
        Object.assign(state.import, set);
        if ("stage" in set) state.stages.push(set.stage);
        for (const [key, value] of Object.entries(inc ?? {}))
          state.import[key] = (state.import[key] as number) + (value as number);
      },
      async listProducts() {
        return state.products
          .sort((a, b) => a.importIndex - b.importIndex)
          .map((p) => ({
            id: p.id,
            englishName: p.englishName,
            samPhrase: p.samPhrase,
            videoWindow: p.videoWindow,
            photoMethod: p.photo.method,
          }));
      },
      async createProducts(drafts) {
        for (const draft of drafts) {
          if (state.products.some((p) => p.importIndex === draft.importIndex))
            continue;
          state.products.push({
            ...draft,
            id: `p${draft.importIndex}`,
            photo: { method: "pending" },
          });
        }
      },
      async savePhoto(productId, photo, notes) {
        const product = state.products.find((p) => p.id === productId)!;
        product.photo = photo;
        product.doubts.push(...notes);
      },
    },
    storage: {
      async downloadVideo() {},
      async savePhoto(productId, file) {
        calls.saved.push(`${productId}/${file.fileName}:${file.mimeType}`);
        return {
          bucket: "media",
          path: `photos/${productId}/${file.fileName}`,
        };
      },
      async savePresenterPhoto(file) {
        calls.saved.push(`presenter/${file.fileName}:${file.mimeType}`);
        return { bucket: "media", path: `photos/presenter/${file.fileName}` };
      },
    },
    spend:
      options.tracked === false
        ? null
        : {
            async reserve(operationId, provider, max) {
              calls.spend.push(`reserve ${operationId} ${provider} ${max}`);
              return { operationId };
            },
            async settle(reservation, actual) {
              calls.spend.push(
                `settle ${(reservation as { operationId: string }).operationId} ${actual}`,
              );
            },
          },
    async transcribe() {
      calls.transcribe++;
      return TRANSCRIPT;
    },
    async emit(reason, productId) {
      calls.emits.push(productId ? `${reason}:${productId}` : reason);
    },
    pulse() {},
    attempt: 1,
    workDir,
    prepare: async () => ({
      videoPath: join(workDir, "video.mp4"),
      audioPath: join(workDir, "narration.mp3"),
      durationSeconds: 30,
      width: 720,
      height: 1280,
    }),
    readInventory: async (_request, deps) => {
      calls.inventory++;
      deps?.onCost?.(0.04, "inventory");
      return {
        ...structuredClone(INVENTORY),
        presenter:
          options.presenterMoment === undefined
            ? null
            : { clearestMomentSeconds: options.presenterMoment },
      };
    },
    cutOut: async (request, deps) => {
      calls.cutOut.push(request.name);
      deps?.onCost?.(0.05, "restore photo");
      return (options.cutOut ?? defaultCutOut)(request.name, request.workDir);
    },
    cutOutPresenter: async (request, deps) => {
      calls.presenter++;
      // Products come first: the presenter is cut out after every photo.
      assert.equal(state.import.productDone, state.products.length);
      deps?.onCost?.(0.01, "find presenter");
      if (options.cutOutPresenter)
        return options.cutOutPresenter(request.workDir);
      return {
        frameTimeSeconds: 4.2,
        originalPath: await photoFile(request.workDir, "original.jpg", "jpeg"),
        cutoutPath: await photoFile(request.workDir, "cutout.png", "png"),
        cleaned: true,
      };
    },
  };
  return { ports, state, calls };
}

test("runs an import from video to products with photos, saving each step", async (t) => {
  const { ports, state, calls } = await setUp(t);

  const result = await runProductVideoImport(ports);

  assert.deepEqual(result, { productCount: 3 });
  assert.deepEqual(state.stages, [
    "preparing",
    "listening",
    "watching",
    "cutting",
    null,
  ]);
  assert.equal(state.import.status, "ready");
  assert.equal(state.import.transcript, TRANSCRIPT);
  assert.equal(state.import.language, "kk");
  assert.equal(state.import.productTotal, 3);
  assert.equal(state.import.productDone, 3);
  // Inventory $0.04 plus three products at $0.05.
  assert.ok(Math.abs((state.import.costUsd as number) - 0.19) < 1e-9);

  const [doll, cup, rooster] = state.products;
  assert.equal(doll!.name, "Кукла Лол");
  assert.equal(doll!.englishName, "LOL doll");
  assert.deepEqual(doll!.doubts, []);
  // The model's doubt first, then our own checks.
  assert.deepEqual(cup!.doubts, ["Is it 500 or 5000?"]);
  assert.deepEqual(rooster!.doubts, [
    "No price was said or shown for this product.",
  ]);
  assert.equal(doll!.priceSource, "spoken");
  assert.equal(doll!.priceIsFrom, false);
  assert.equal(rooster!.priceSource, null);
  // Nobody presents the products in this video.
  assert.equal(state.import.presenter, null);
  assert.equal(calls.presenter, 0);
  assert.deepEqual(doll!.videoWindow, { fromSeconds: 0, toSeconds: 8 });
  assert.deepEqual(doll!.photo, {
    method: "restored",
    original: { bucket: "media", path: "photos/p0/original.jpg" },
    frameTimeSeconds: 1.5,
    cutout: { bucket: "media", path: "photos/p0/cutout.png" },
    thumb: { bucket: "media", path: "photos/p0/thumb.webp" },
  });
  assert.ok(calls.saved.includes("p0/thumb.webp:image/webp"));

  assert.deepEqual(calls.emits.slice(0, 4), [
    "import",
    "import",
    "import",
    "products_found",
  ]);
  assert.deepEqual(calls.emits.filter((e) => e.startsWith("photo")).sort(), [
    "photo:p0",
    "photo:p1",
    "photo:p2",
  ]);
  assert.equal(calls.emits.at(-1), "import");

  // Each paid step reserves first and settles what it really cost.
  assert.deepEqual(calls.spend.slice(0, 4), [
    "reserve transcription:attempt-1 elevenlabs 100000",
    "settle transcription:attempt-1 100000",
    "reserve inventory:attempt-1 meta 300000",
    "settle inventory:attempt-1 40000",
  ]);
  assert.ok(calls.spend.includes("reserve product:p1:attempt-1 meta 150000"));
  assert.ok(calls.spend.includes("settle product:p1:attempt-1 50000"));
});

test("a retry resumes: no second transcription, inventory or photo for a finished product", async (t) => {
  const done: FakeProduct = {
    id: "p0",
    importIndex: 0,
    name: "Кукла Лол",
    englishName: "LOL doll",
    category: "toy",
    price: 5000,
    currency: "KZT",
    priceQuote: null,
    priceSource: "spoken",
    priceIsFrom: false,
    samPhrase: "blonde doll",
    doubts: [],
    videoWindow: { fromSeconds: 0, toSeconds: 8 },
    photo: { method: "restored" },
  };
  const pending: FakeProduct = {
    ...done,
    id: "p1",
    importIndex: 1,
    englishName: "Frosted cup",
    photo: { method: "pending" },
  };
  const { ports, state, calls } = await setUp(t, {
    transcript: TRANSCRIPT,
    products: [done, pending],
  });
  ports.attempt = 2;

  await runProductVideoImport(ports);

  assert.equal(calls.transcribe, 0);
  assert.equal(calls.inventory, 0);
  assert.deepEqual(calls.cutOut, ["Frosted cup"]);
  assert.deepEqual(calls.spend, [
    "reserve product:p1:attempt-2 meta 150000",
    "settle product:p1:attempt-2 50000",
  ]);
  assert.equal(state.import.status, "ready");
});

test("a product its video can't give a photo is noted, and the others carry on", async (t) => {
  const { ports, state } = await setUp(t, {
    cutOut: async (name, dir) => {
      if (name === "Frosted cup")
        throw new ProductVideoError(
          "no_frames",
          "No frames between 8s and 20s",
        );
      return {
        method: "tracked",
        frameTimeSeconds: 3,
        originalPath: await sharp({
          create: { width: 20, height: 20, channels: 3, background: "#123456" },
        })
          .jpeg()
          .toFile(join(dir, "..", `${name}.jpg`))
          .then(() => join(dir, "..", `${name}.jpg`)),
        cutoutPath: null,
        samConfidence: null,
        notes: [
          "The photo couldn't be cleaned up, so the hand may still show.",
        ],
      };
    },
  });
  await mkdir(join(ports.workDir, "products"), { recursive: true });

  await runProductVideoImport(ports);

  const [doll, cup] = state.products;
  assert.equal(cup!.photo.method, "none");
  assert.deepEqual(
    cup!.doubts.at(-1),
    "The photo couldn't be made from the video.",
  );
  // A filmed photo without a cut-out still gets its shelf copy, from the original.
  assert.equal(doll!.photo.method, "tracked");
  assert.ok("thumb" in doll!.photo && doll!.photo.thumb);
  assert.ok(!("cutout" in doll!.photo));
  assert.deepEqual(doll!.doubts, [
    "The photo couldn't be cleaned up, so the hand may still show.",
  ]);
  assert.equal(state.import.productDone, 3);
  assert.equal(state.import.status, "ready");
});

test("a failure a retry may fix stops the run, keeping finished photos and the unknown cost reserved", async (t) => {
  const { ports, state, calls } = await setUp(t, {
    cutOut: async (name, dir) => {
      if (name === "Rooster")
        throw new MetaModelApiError({
          kind: "server",
          transient: true,
          message: "502",
        });
      return {
        method: "restored",
        frameTimeSeconds: 1,
        originalPath: await sharp({
          create: { width: 10, height: 10, channels: 3, background: "#fff" },
        })
          .jpeg()
          .toFile(join(dir, "..", `${name}.jpg`))
          .then(() => join(dir, "..", `${name}.jpg`)),
        cutoutPath: null,
        samConfidence: 1,
        notes: [],
      };
    },
  });
  await mkdir(join(ports.workDir, "products"), { recursive: true });

  await assert.rejects(runProductVideoImport(ports), /502/);

  assert.notEqual(state.import.status, "ready");
  assert.equal(
    state.products.filter((p) => p.photo.method !== "pending").length,
    2,
  );
  assert.ok(calls.spend.includes("settle product:p2:attempt-1 null"));
});

test("without tracked spend nothing is reserved; a missing upload is reported, not retried", async (t) => {
  const untracked = await setUp(t, { tracked: false });
  await runProductVideoImport(untracked.ports);
  assert.deepEqual(untracked.calls.spend, []);

  const missing = await setUp(t);
  missing.ports.storage.downloadVideo = async () => {
    throw new Error("No such object");
  };
  await assert.rejects(
    runProductVideoImport(missing.ports),
    (error: unknown) =>
      error instanceof ProductVideoImportFailure &&
      error.code === "video_missing" &&
      !error.retryable,
  );
});

test("a finished import does nothing again", async (t) => {
  const { ports, state, calls } = await setUp(t);
  state.import.status = "ready";
  ports.store.loadImport = async () => ({
    status: "ready",
    video: { bucket: "b", path: "p" },
    transcript: TRANSCRIPT,
    presenter: { momentSeconds: 4, done: false },
  });

  await runProductVideoImport(ports);

  assert.equal(
    calls.transcribe + calls.inventory + calls.cutOut.length + calls.presenter,
    0,
  );
  assert.deepEqual(calls.emits, []);
});

test("errors map to what the owner sees and whether to retry", () => {
  const cases: Array<[unknown, string, boolean]> = [
    [new ProductVideoError("video_too_long", "301 s"), "video_too_long", false],
    [
      new ProductVideoError("video_unreadable", "bad"),
      "video_unreadable",
      false,
    ],
    [
      Object.assign(new Error("limit"), { code: "workspace_ai_spend_limit" }),
      "spend_limit",
      false,
    ],
    [
      new MetaModelApiError({
        kind: "rate_limit",
        transient: true,
        message: "slow",
      }),
      "failed",
      true,
    ],
    [
      new MetaModelApiError({ kind: "auth", transient: false, message: "key" }),
      "failed",
      false,
    ],
    [
      Object.assign(new Error("stt"), { info: { transient: false } }),
      "failed",
      false,
    ],
    [new Error("socket hang up"), "failed", true],
  ];
  for (const [error, code, retryable] of cases) {
    const failure = classifyImportError(error);
    assert.equal(failure.code, code, String(error));
    assert.equal(failure.retryable, retryable, String(error));
  }
});

test("cuts out the person presenting the products after the photos, and saves them on the import", async (t) => {
  const { ports, state, calls } = await setUp(t, { presenterMoment: 4 });

  await runProductVideoImport(ports);

  assert.equal(state.import.status, "ready");
  assert.equal(calls.presenter, 1);
  assert.deepEqual(state.import.presenter, {
    momentSeconds: 4,
    photo: {
      original: { bucket: "media", path: "photos/presenter/original.jpg" },
      cutout: { bucket: "media", path: "photos/presenter/cutout.png" },
      thumb: { bucket: "media", path: "photos/presenter/thumb.webp" },
      frameTimeSeconds: 4.2,
    },
  });
  assert.ok(calls.saved.includes("presenter/thumb.webp:image/webp"));
  assert.ok(calls.spend.includes("reserve presenter:attempt-1 meta 50000"));
  assert.ok(calls.spend.includes("settle presenter:attempt-1 10000"));
});

test("a presenter who can't be cut out is dropped, and the import still finishes", async (t) => {
  const missing = await setUp(t, {
    presenterMoment: 4,
    cutOutPresenter: async () => null,
  });
  await runProductVideoImport(missing.ports);
  assert.equal(missing.state.import.status, "ready");
  assert.equal(missing.state.import.presenter, null);

  const failing = await setUp(t, {
    presenterMoment: 4,
    cutOutPresenter: async () => {
      throw new ProductVideoError("no_frames", "No frames at 4s");
    },
  });
  await runProductVideoImport(failing.ports);
  assert.equal(failing.state.import.status, "ready");
  assert.equal(failing.state.import.presenter, null);
});

test("a retry cuts out only the presenter a previous run didn't finish", async (t) => {
  const done: FakeProduct = {
    id: "p0",
    importIndex: 0,
    name: "Кукла Лол",
    englishName: "LOL doll",
    category: "toy",
    price: 5000,
    currency: "KZT",
    priceQuote: null,
    priceSource: "spoken",
    priceIsFrom: false,
    samPhrase: "blonde doll",
    doubts: [],
    videoWindow: { fromSeconds: 0, toSeconds: 8 },
    photo: { method: "restored" },
  };
  const { ports, state, calls } = await setUp(t, {
    transcript: TRANSCRIPT,
    products: [done],
    presenter: { momentSeconds: 6, photo: null },
  });
  state.import.productDone = 1;

  await runProductVideoImport(ports);

  assert.equal(calls.inventory, 0);
  assert.deepEqual(calls.cutOut, []);
  assert.equal(calls.presenter, 1);
  assert.equal(
    (state.import.presenter as { momentSeconds: number }).momentSeconds,
    6,
  );
});
