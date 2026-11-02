import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { MetaModelApiError } from "@icecore/airi-runtime/meta-model-api";
import { WorkspaceAiSpendError } from "@icecore/airi-runtime/workspace-ai-spend";
import sharp from "sharp";

import type { ProductCutout } from "./cutout";
import {
  classifyImportError,
  ProductVideoImportFailure,
  runProductVideoImport,
  type ClipWindow,
  type ImportJobPorts,
  type NewDraftOption,
  type NewDraftProduct,
  type ProductPhoto,
  type SpendUnit,
  type StoredFileRef,
} from "./import-job";
import type {
  InventoryItem,
  InventoryOption,
  ProductInventory,
} from "./inventory";
import { ProductVideoError } from "./media";
import type { PresenterCutout } from "./presenter";

const TRANSCRIPT =
  "[1.0] Кукла Лол, бес мың теңге.\n[9.0] Кружка, бес жүз теңге.";

const option = (
  description: string,
  firstSeenSeconds: number,
  clearestMomentSeconds: number,
): InventoryOption => ({
  description,
  samPhrase: description,
  firstSeenSeconds,
  clearestMomentSeconds,
});

const item = (overrides: Partial<InventoryItem>): InventoryItem => ({
  name: "LOL doll",
  localName: "Кукла Лол",
  nameSource: "spoken",
  category: "toy",
  price: 5000,
  currency: "KZT",
  priceQuote: "бес мың теңге",
  priceQuoteSeconds: 1,
  priceSource: "spoken",
  priceIsFrom: false,
  options: [option("blonde doll", 0, 2)],
  featuredOption: 0,
  doubt: null,
  ...overrides,
});

const INVENTORY: ProductInventory = {
  language: "kk",
  presenter: null,
  items: [
    item({}),
    item({
      name: "Frosted cup",
      localName: "Кружка",
      price: 500,
      priceQuote: "бес жүз теңге",
      priceQuoteSeconds: 9,
      options: [option("frosted cup", 8, 9)],
      doubt: "Is it 500 or 5000?",
    }),
    item({
      name: "Rooster",
      localName: "Әтеш",
      price: null,
      priceQuote: null,
      priceQuoteSeconds: null,
      priceSource: null,
      options: [option("white rooster", 20, 22)],
    }),
  ],
};

/** A video showing `count` products, one design each, a few seconds apart. */
const shelfOf = (count: number): ProductInventory => ({
  ...INVENTORY,
  items: Array.from({ length: count }, (_, i) =>
    item({
      name: `Toy ${i}`,
      localName: `Ойыншық ${i}`,
      options: [option(`toy ${i}`, i * 5, i * 5 + 1)],
    }),
  ),
});

type FakeOption = NewDraftOption & {
  photo: ProductPhoto | { method: "pending" };
  notes: string[];
};
type FakeProduct = Omit<NewDraftProduct, "options" | "clip"> & {
  id: string;
  options: FakeOption[];
  clip: (ClipWindow & { video?: StoredFileRef }) | null;
};

/** A product a previous run saved, with one option in the given state. */
const savedProduct = (
  importIndex: number,
  englishName: string,
  photo: FakeOption["photo"],
): FakeProduct => ({
  id: `p${importIndex}`,
  importIndex,
  name: englishName,
  englishName,
  nameSource: "spoken",
  category: "toy",
  price: 5000,
  currency: "KZT",
  priceQuote: null,
  priceSource: "spoken",
  priceIsFrom: false,
  doubts: [],
  featuredOption: 0,
  options: [
    {
      description: englishName,
      samPhrase: englishName,
      videoWindow: { fromSeconds: 0, toSeconds: 8 },
      photo,
      notes: [],
    },
  ],
  clip: { fromSeconds: 0.7, toSeconds: 4 },
});

async function photoFile(dir: string, name: string, kind: "jpeg" | "png") {
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
}

async function restoredCutout(dir: string): Promise<ProductCutout> {
  return {
    method: "restored",
    frameTimeSeconds: 1.5,
    originalPath: await photoFile(dir, "original.jpg", "jpeg"),
    cutoutPath: await photoFile(dir, "cutout.png", "png"),
    samConfidence: 0.95,
    straightenedDegrees: 0,
    notes: [],
  };
}

const ACTION_LIMIT_MICROS = 500_000;

type LedgerOptions = {
  /** The company's AI spending limit, and what it had committed before the import. */
  companyLimitMicros?: number;
  committedMicros?: number;
  /** The plan's included AI actions, and how many were used before the import. */
  includedActions?: number;
  usedActions?: number;
  /** A free company whose trial is over. */
  trialEnded?: boolean;
  /** Whether the allowance reports the spend left, as later versions of airi do; this copy's doesn't. */
  reportsSpendLeft?: boolean;
};

/**
 * The workspace's AI ledger as reserve_workspace_ai_spend and
 * settle_workspace_ai_spend keep it. A reservation first admits its action,
 * counting one included action, unless none are left, the free trial has
 * ended or the company's limit is reached: then it's own_ai_source_required,
 * and nothing is kept. The allowance's projection knows nothing of the trial,
 * as get_workspace_text_ai_allowance doesn't; the import reads it alongside.
 * Unless asked to, it doesn't report the spend left either. An admitted
 * action stays admitted. A reservation past the company's limit or the
 * action's $0.50 cap is refused. Nothing is kept for a refused reservation,
 * so the same operation can be reserved again later. A settlement replaces
 * the reservation with the actual cost, overruns included; an unknown cost
 * keeps it. Units map to actions as the activity maps them within one
 * workflow run.
 */
function fakeLedger(attempt: () => number, options: LedgerOptions = {}) {
  const limit = options.companyLimitMicros ?? 25_000_000;
  const included = options.includedActions ?? 500;
  const ledger = {
    committed: options.committedMicros ?? 0,
    used: options.usedActions ?? 0,
    trialEnded: options.trialEnded ?? false,
    actions: new Map<
      string,
      { committed: number; operations: Map<string, number> }
    >(),
    log: [] as string[],
  };
  const actionOf = (unit: SpendUnit) =>
    unit.kind === "read"
      ? `read:${attempt()}`
      : `photo:${unit.productId}:${unit.optionIndex}`;
  const spend: ImportJobPorts["spend"] = {
    async allowance() {
      return {
        includedActions: included,
        remainingActions: Math.max(0, included - ledger.used),
        spendLimitReached: ledger.committed >= limit,
        spendRemainingMicros: options.reportsSpendLeft
          ? Math.max(0, limit - ledger.committed)
          : null,
        trialEnded: ledger.trialEnded,
      };
    },
    async reserve(unit, operationId, provider, max) {
      const actionId = actionOf(unit);
      let action = ledger.actions.get(actionId);
      if (!action) {
        if (
          ledger.used >= included ||
          ledger.trialEnded ||
          ledger.committed >= limit
        ) {
          ledger.log.push(
            `refuse ${actionId} ${operationId} own_ai_source_required`,
          );
          throw new WorkspaceAiSpendError("own_ai_source_required");
        }
        ledger.used++;
        action = { committed: 0, operations: new Map() };
        ledger.actions.set(actionId, action);
      }
      if (action.operations.has(operationId))
        throw new WorkspaceAiSpendError("workspace_ai_operation_replayed");
      if (
        ledger.committed + max > limit ||
        action.committed + max > ACTION_LIMIT_MICROS
      ) {
        ledger.log.push(
          `refuse ${actionId} ${operationId} workspace_ai_spend_limit`,
        );
        throw new WorkspaceAiSpendError("workspace_ai_spend_limit");
      }
      action.operations.set(operationId, max);
      action.committed += max;
      ledger.committed += max;
      ledger.log.push(`reserve ${actionId} ${operationId} ${provider} ${max}`);
      return { actionId, operationId };
    },
    async settle(reservation, actual) {
      const { actionId, operationId } = reservation as {
        actionId: string;
        operationId: string;
      };
      ledger.log.push(`settle ${actionId} ${operationId} ${actual}`);
      if (actual === null) return;
      const action = ledger.actions.get(actionId)!;
      const change = actual - action.operations.get(operationId)!;
      action.committed += change;
      ledger.committed += change;
    },
  };
  return { ledger, spend };
}

async function setUp(
  t: TestContext,
  options: {
    transcript?: string | null;
    products?: FakeProduct[];
    inventory?: ProductInventory;
    /** What reading the video costs, in dollars. */
    inventoryUsd?: number;
    /** How reading the video fails, one attempt after another, and what each failure had reported spending. */
    inventoryFailures?: Array<{ error: Error; reportedUsd?: number }>;
    /** A photo's cut-out; the default reports $0.05 and restores it. */
    cutOut?: (
      name: string,
      workDir: string,
      onCost: (usd: number) => void,
    ) => Promise<ProductCutout>;
    /** When the inventory says someone presents the products. */
    presenterMoment?: number;
    /** The import's presenter as a previous run left it. */
    presenter?: { momentSeconds: number; photo: unknown } | null;
    cutOutPresenter?: (workDir: string) => Promise<PresenterCutout | null>;
    /** How cutting a review clip fails, by product id. */
    clipFails?: Record<string, Error>;
    /** Whether the video has sound. */
    audio?: boolean;
    /** How long the video is, in seconds. */
    durationSeconds?: number;
    /** A video sent on WhatsApp, not yet copied to storage. */
    whatsapp?: boolean;
    /** How fetching it from WhatsApp fails. */
    whatsappFails?: Error;
    ledger?: LedgerOptions;
  } = {},
) {
  const workDir = await mkdtemp(join(tmpdir(), "import-job-"));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const state = {
    import: {
      status: "queued" as const,
      stage: null as unknown,
      transcript: options.transcript ?? null,
      photoDone: 0,
      costUsd: 0,
      presenter: options.presenter ?? null,
      video: options.whatsapp
        ? null
        : {
            bucket: "media",
            path: "workspaces/w1/creative-assets/video/a1/shelf.mov",
          },
    } as Record<string, unknown>,
    products: [...(options.products ?? [])],
    stages: [] as unknown[],
  };
  const calls = {
    transcribe: 0,
    inventory: 0,
    cutOut: [] as string[],
    languages: [] as Array<string | null>,
    presenter: 0,
    emits: [] as string[],
    saved: [] as string[],
    clips: [] as Array<{
      productId: string;
      soundPath: string | null;
      window: ClipWindow;
    }>,
    downloads: [] as string[],
  };
  const inventoryFailures = [...(options.inventoryFailures ?? [])];
  const { ledger, spend } = fakeLedger(() => ports.attempt, options.ledger);

  const ports: ImportJobPorts = {
    store: {
      async loadImport() {
        return {
          status: state.import.status as "queued",
          video: state.import.video as { bucket: string; path: string } | null,
          whatsapp: options.whatsapp
            ? {
                sourceId: "airi-source",
                workspaceId: "airi-workspace",
                conversationId: "c1",
                messageId: "m1",
                mediaId: "wamid-media-1",
                mimeType: "video/mp4",
              }
            : null,
          transcript: state.import.transcript as string | null,
          language: (state.import.language as string | undefined) ?? null,
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
            options: p.options.map((o, index) => ({
              index,
              description: o.description,
              samPhrase: o.samPhrase,
              videoWindow: o.videoWindow,
              photoMethod: o.photo.method,
            })),
            clip: p.clip && {
              fromSeconds: p.clip.fromSeconds,
              toSeconds: p.clip.toSeconds,
              saved: Boolean(p.clip.video),
            },
          }));
      },
      async createProducts(drafts) {
        for (const draft of drafts) {
          if (state.products.some((p) => p.importIndex === draft.importIndex))
            continue;
          state.products.push({
            ...draft,
            id: `p${draft.importIndex}`,
            options: draft.options.map((o) => ({
              ...o,
              photo: { method: "pending" },
              notes: [],
            })),
          });
        }
      },
      async savePhoto(productId, optionIndex, photo, notes) {
        const product = state.products.find((p) => p.id === productId)!;
        product.options[optionIndex]!.photo = photo;
        product.options[optionIndex]!.notes.push(...notes);
      },
      async saveClip(productId, video) {
        const product = state.products.find((p) => p.id === productId)!;
        product.clip = { ...product.clip!, video };
      },
    },
    storage: {
      async downloadVideo(video) {
        calls.downloads.push(`storage:${video.path}`);
      },
      async fetchWhatsAppVideo(video) {
        calls.downloads.push(`whatsapp:${video.mediaId}`);
        if (options.whatsappFails) throw options.whatsappFails;
        return { bucket: "media", path: "videos/whatsapp-video.mp4" };
      },
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
      async saveClip(productId, file) {
        calls.saved.push(`${productId}/${file.fileName}:${file.mimeType}`);
        return { bucket: "media", path: `clips/${productId}/${file.fileName}` };
      },
    },
    spend,
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
      audioPath:
        options.audio === false ? null : join(workDir, "narration.mp3"),
      durationSeconds: options.durationSeconds ?? 30,
      width: 720,
      height: 1280,
    }),
    extractClip: async (source, window, outPath) => {
      const productId = basename(outPath, ".mp4");
      calls.clips.push({ productId, soundPath: source.soundPath, window });
      const failure = options.clipFails?.[productId];
      if (failure) throw failure;
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, "mp4");
    },
    readInventory: async (_request, deps) => {
      calls.inventory++;
      const failure = inventoryFailures.shift();
      if (failure) {
        if (failure.reportedUsd)
          deps?.onCost?.(failure.reportedUsd, "inventory");
        throw failure.error;
      }
      deps?.onCost?.(options.inventoryUsd ?? 0.04, "inventory");
      return {
        ...structuredClone(options.inventory ?? INVENTORY),
        presenter:
          options.presenterMoment === undefined
            ? null
            : { clearestMomentSeconds: options.presenterMoment },
      };
    },
    cutOut: async (request, deps) => {
      calls.cutOut.push(request.name);
      calls.languages.push(request.language ?? null);
      const onCost = (usd: number) => deps?.onCost?.(usd, "restore photo");
      if (options.cutOut)
        return options.cutOut(request.name, request.workDir, onCost);
      onCost(0.05);
      return restoredCutout(request.workDir);
    },
    cutOutPresenter: async (request, deps) => {
      calls.presenter++;
      // Products come first: the presenter is cut out after every photo.
      assert.equal(
        state.import.photoDone,
        state.products.reduce((total, p) => total + p.options.length, 0),
      );
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
  return { ports, state, calls, ledger };
}

/** The options whose photos weren't made. */
const pendingPhotos = (products: FakeProduct[]) =>
  products.flatMap((p) =>
    p.options.filter((o) => o.photo.method === "pending").map(() => p.id),
  );

test("runs an import from video to products with photos, saving each step", async (t) => {
  const { ports, state, calls, ledger } = await setUp(t);

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
  assert.equal(state.import.photosStopped, null);
  assert.equal(state.import.transcript, TRANSCRIPT);
  assert.equal(state.import.language, "kk");
  assert.equal(state.import.productTotal, 3);
  assert.equal(state.import.photoTotal, 3);
  assert.equal(state.import.photoDone, 3);
  // Inventory $0.04 plus three photos at $0.05.
  assert.ok(Math.abs((state.import.costUsd as number) - 0.19) < 1e-9);

  const [doll, cup, rooster] = state.products;
  assert.equal(doll!.name, "Кукла Лол");
  assert.equal(doll!.englishName, "LOL doll");
  assert.equal(doll!.nameSource, "spoken");
  assert.deepEqual(doll!.doubts, []);
  // The model's doubt first, then our own checks, each with what it's about.
  assert.deepEqual(cup!.doubts, [
    { about: "price", text: "Is it 500 or 5000?" },
  ]);
  assert.deepEqual(rooster!.doubts, [
    { about: "price", text: "No price was said or shown for this product." },
  ]);
  assert.equal(doll!.priceSource, "spoken");
  assert.equal(doll!.priceIsFrom, false);
  assert.equal(rooster!.priceSource, null);
  // Nobody presents the products in this video.
  assert.equal(state.import.presenter, null);
  assert.equal(calls.presenter, 0);
  assert.equal(doll!.featuredOption, 0);
  assert.deepEqual(doll!.options[0]!.videoWindow, {
    fromSeconds: 0,
    toSeconds: 8,
  });
  assert.deepEqual(doll!.options[0]!.photo, {
    method: "restored",
    original: { bucket: "media", path: "photos/p0/option-0-original.jpg" },
    frameTimeSeconds: 1.5,
    straightenedDegrees: 0,
    cutout: { bucket: "media", path: "photos/p0/option-0-cutout.png" },
    thumb: { bucket: "media", path: "photos/p0/option-0-thumb.webp" },
  });
  assert.ok(calls.saved.includes("p0/option-0-thumb.webp:image/webp"));

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

  // Each paid step reserves first and settles what it really cost: the steps
  // that read the video in one AI action, each photo in its own.
  assert.deepEqual(ledger.log.slice(0, 4), [
    "reserve read:1 transcription:attempt-1 elevenlabs 3667",
    "settle read:1 transcription:attempt-1 1834",
    "reserve read:1 inventory:attempt-1 meta 139000",
    "settle read:1 inventory:attempt-1 40000",
  ]);
  assert.ok(
    ledger.log.includes("reserve photo:p1:0 photo:attempt-1 meta 150000"),
  );
  assert.ok(ledger.log.includes("settle photo:p1:0 photo:attempt-1 50000"));
  assert.equal(ledger.used, 4);
  // Lettering Muse can't read gets an example in the narration's language.
  assert.deepEqual(calls.languages, ["kk", "kk", "kk"]);
});

test("five photos made four at a time each fit their own AI action", async (t) => {
  // In production, one action for the whole import refused the third photo:
  // two $0.15 reservations after the read steps had filled its $0.50 cap.
  const { ports, state, ledger } = await setUp(t, { inventory: shelfOf(5) });

  await runProductVideoImport(ports);

  assert.equal(state.import.status, "ready");
  assert.equal(state.import.photosStopped, null);
  assert.equal(state.import.photoDone, 5);
  assert.deepEqual(pendingPhotos(state.products), []);
  assert.ok(!ledger.log.some((line) => line.startsWith("refuse")));
  // Reading the video, and one action per photo.
  assert.deepEqual([...ledger.actions.keys()].sort(), [
    "photo:p0:0",
    "photo:p1:0",
    "photo:p2:0",
    "photo:p3:0",
    "photo:p4:0",
    "read:1",
  ]);
  assert.equal(ledger.used, 6);
});

test("an import of 60 photos finishes when the company's limit allows it", async (t) => {
  const designs = Array.from({ length: 8 }, (_, i) =>
    option(`design ${i}`, 0, 1),
  );
  const { ports, state, ledger } = await setUp(t, {
    inventory: {
      ...INVENTORY,
      items: Array.from({ length: 8 }, (_, i) =>
        item({ name: `Panel ${i}`, options: designs }),
      ),
    },
    ledger: { companyLimitMicros: 4_000_000 },
  });

  await runProductVideoImport(ports);

  assert.equal(state.import.status, "ready");
  assert.equal(state.import.photosStopped, null);
  assert.equal(state.import.photoDone, 60);
  assert.equal(ledger.used, 61);
  // $0.04 to read it and $0.05 a photo, under the company's $4.
  assert.equal(ledger.committed, 1_834 + 40_000 + 60 * 50_000);
});

test("when the company's limit stops the photos, the products, the photos made and the clips are kept", async (t) => {
  // Room for the read steps and two photos' $0.15 reservations, not three.
  // Each photo costs all it reserved, so settling leaves no room for another.
  const { ports, state, calls, ledger } = await setUp(t, {
    inventory: shelfOf(5),
    presenterMoment: 4,
    ledger: { companyLimitMicros: 400_000 },
    cutOut: async (_name, dir, onCost) => {
      onCost(0.15);
      return restoredCutout(dir);
    },
  });
  // What the page is told while each review clip is cut.
  const stopsAtClips: unknown[] = [];
  const extractClip = ports.extractClip!;
  ports.extractClip = async (...args) => {
    stopsAtClips.push(state.import.photosStopped);
    return extractClip(...args);
  };

  const result = await runProductVideoImport(ports);

  assert.deepEqual(result, { productCount: 5 });
  assert.equal(state.import.status, "ready");
  assert.equal(state.import.stage, null);
  assert.equal(state.import.productCount, 5);
  assert.ok(state.import.finishedAt instanceof Date);
  assert.equal(state.import.photosStopped, "spend_limit");
  // The two photos being made when the limit was met finished; the rest
  // wait for a later run.
  assert.equal(state.import.photoDone, 2);
  assert.deepEqual(pendingPhotos(state.products), ["p2", "p3", "p4"]);
  assert.ok(
    ledger.log.includes(
      "refuse photo:p2:0 photo:attempt-1 workspace_ai_spend_limit",
    ),
  );
  // The photos reserve in turn: after a refusal, the ones waiting never
  // reach the ledger, so they use up no included action.
  assert.ok(!ledger.log.some((line) => line.includes("photo:p3:0")));
  assert.ok(!ledger.log.some((line) => line.includes("photo:p4:0")));
  assert.equal(ledger.used, 4);
  // This copy's allowance doesn't report the spend left, so once the two
  // photos had settled, another pass asked the ledger again. Refused with
  // no photo made, that pass is the stop. The refused photo's action stayed
  // admitted, so asking again counted no included action.
  assert.equal((await ports.spend.allowance()).spendRemainingMicros, null);
  assert.deepEqual(
    ledger.log.filter((line) => line.startsWith("refuse")),
    Array(2).fill("refuse photo:p2:0 photo:attempt-1 workspace_ai_spend_limit"),
  );
  // Review clips cost no AI: every product gets one, and the page already
  // knows the photos stopped while they're cut.
  assert.equal(calls.clips.length, 5);
  assert.deepEqual(stopsAtClips, Array(5).fill("spend_limit"));
  // The presenter costs AI, so waits too.
  assert.equal(calls.presenter, 0);
  assert.deepEqual(state.import.presenter, { momentSeconds: 4, photo: null });
  assert.equal(calls.emits.at(-1), "import");
});

test("a photo refused admission while the import's own reservations held the limit is made once they settle lower", async (t) => {
  // Three photos' $0.15 reservations fill the limit exactly, so the fourth
  // photo's action isn't admitted. Once they settle at $0.05 each, the
  // company is far under its limit, and the photos left are made.
  const { ports, state, ledger } = await setUp(t, {
    inventory: shelfOf(5),
    ledger: { companyLimitMicros: 1_834 + 40_000 + 3 * 150_000 },
  });

  await runProductVideoImport(ports);

  const refusal = ledger.log.indexOf(
    "refuse photo:p3:0 photo:attempt-1 own_ai_source_required",
  );
  assert.ok(refusal >= 0);
  // Nothing was kept for the refusal, so the same operation reserves again.
  assert.ok(
    ledger.log.indexOf("reserve photo:p3:0 photo:attempt-1 meta 150000") >
      refusal,
  );
  assert.equal(state.import.status, "ready");
  assert.equal(state.import.photosStopped, null);
  assert.equal(state.import.photoDone, 5);
  assert.deepEqual(pendingPhotos(state.products), []);
  // Reading the video and five photos: the refusal counted no action.
  assert.equal(ledger.used, 6);
  assert.equal(ledger.committed, 1_834 + 40_000 + 5 * 50_000);
});

test("photos the import's own reservations crowded out don't say the limit was reached while spend is left", async (t) => {
  // $0.45 of a Pro company's limit is left when six photos start. Three
  // $0.15 reservations fill it: the fourth photo isn't admitted. With $0.50
  // left, it's admitted and its reservation refused instead. Either way,
  // once the three settle at $0.05 each, $0.30 or $0.35 is left, and the
  // allowance card says so.
  for (const [left, code] of [
    [450_000, "own_ai_source_required"],
    [500_000, "workspace_ai_spend_limit"],
  ] as const) {
    const { ports, state, ledger } = await setUp(t, {
      inventory: shelfOf(6),
      ledger: { companyLimitMicros: 1_834 + 40_000 + left },
    });

    await runProductVideoImport(ports);

    assert.ok(
      ledger.log.includes(`refuse photo:p3:0 photo:attempt-1 ${code}`),
      code,
    );
    assert.equal(state.import.status, "ready");
    assert.equal(state.import.photosStopped, null, code);
    assert.equal(state.import.photoDone, 6);
    assert.deepEqual(pendingPhotos(state.products), []);
    assert.equal(ledger.used, 7);
    assert.equal(ledger.committed, 1_834 + 40_000 + 6 * 50_000);
    assert.equal((await ports.spend.allowance()).spendLimitReached, false);
  }
});

test("photos stop at the limit once what is left can't hold a photo's reservation", async (t) => {
  // An allowance that reports the spend left, as later versions of airi do.
  // $0.32 is left when five photos start. Each pass ends when the ledger
  // refuses a photo's reservation past the ones being made, and the next
  // starts once they settle: two photos, then one, then one. Then $0.12 is
  // left. That isn't the limit, but a photo reserves $0.15.
  const { ports, state, ledger } = await setUp(t, {
    inventory: shelfOf(5),
    ledger: {
      companyLimitMicros: 1_834 + 40_000 + 320_000,
      reportsSpendLeft: true,
    },
  });

  await runProductVideoImport(ports);

  assert.equal(state.import.status, "ready");
  assert.equal(state.import.photosStopped, "spend_limit");
  assert.equal(state.import.photoDone, 4);
  assert.deepEqual(pendingPhotos(state.products), ["p4"]);
  assert.deepEqual(
    ledger.log.filter((line) => line.startsWith("refuse")),
    [
      "refuse photo:p2:0 photo:attempt-1 workspace_ai_spend_limit",
      "refuse photo:p3:0 photo:attempt-1 workspace_ai_spend_limit",
      "refuse photo:p4:0 photo:attempt-1 workspace_ai_spend_limit",
    ],
  );
  // No pass was tried that the ledger could only refuse.
  const allowance = await ports.spend.allowance();
  assert.equal(allowance.spendLimitReached, false);
  assert.equal(allowance.spendRemainingMicros, 120_000);
  // Reading the video and five photos' actions: p4's, admitted before its
  // reservation was refused, stays admitted.
  assert.equal(ledger.used, 6);
});

test("when the free trial ends while photos are made, the photos stop and say so", async (t) => {
  const { ports, state, ledger } = await setUp(t, {
    inventory: shelfOf(5),
  });
  const cutOut = ports.cutOut!;
  ports.cutOut = async (...args) => {
    // The trial ends as the first photos are being made.
    ledger.trialEnded = true;
    return cutOut(...args);
  };

  await runProductVideoImport(ports);

  assert.equal(state.import.status, "ready");
  assert.equal(state.import.photosStopped, "trial_ended");
  assert.ok(
    ledger.log.some((line) =>
      line.endsWith("photo:attempt-1 own_ai_source_required"),
    ),
  );
  assert.ok(pendingPhotos(state.products).length > 0);
});

test("when the included AI actions run out, the photos stop and say so", async (t) => {
  // Three actions left: reading the video and two photos.
  const { ports, state, ledger } = await setUp(t, {
    inventory: shelfOf(5),
    ledger: { includedActions: 100, usedActions: 97 },
  });

  await runProductVideoImport(ports);

  assert.equal(state.import.status, "ready");
  assert.equal(state.import.photosStopped, "ai_actions_used");
  assert.equal(state.import.photoDone, 2);
  assert.deepEqual(pendingPhotos(state.products), ["p2", "p3", "p4"]);
  assert.ok(
    ledger.log.includes(
      "refuse photo:p2:0 photo:attempt-1 own_ai_source_required",
    ),
  );
  assert.equal(ledger.used, 100);
});

test("a workspace that can't pay for AI now fails for good before its video is downloaded", async (t) => {
  for (const [ledger, code] of [
    [{ includedActions: 100, usedActions: 100 }, "ai_actions_used"],
    [
      { companyLimitMicros: 1_000_000, committedMicros: 1_000_000 },
      "spend_limit",
    ],
    // A free company past its trial, with most of its actions left: the
    // allowance's projection alone would let it start.
    [{ includedActions: 100, usedActions: 3, trialEnded: true }, "trial_ended"],
    [
      { includedActions: 100, usedActions: 100, trialEnded: true },
      "trial_ended",
    ],
    // The limit is named when it stops it with anything else.
    [
      {
        includedActions: 100,
        usedActions: 100,
        companyLimitMicros: 1_000_000,
        committedMicros: 1_200_000,
        trialEnded: true,
      },
      "spend_limit",
    ],
  ] as const) {
    const { ports, state, calls } = await setUp(t, { ledger });

    await assert.rejects(
      runProductVideoImport(ports),
      (error: unknown) =>
        error instanceof ProductVideoImportFailure &&
        error.code === code &&
        !error.retryable,
    );
    assert.deepEqual(calls.downloads, []);
    assert.deepEqual(state.stages, []);
  }
});

test("a read step the ledger refuses fails the import for good, naming what stopped it", async (t) => {
  // $0.002 short of the limit: allowed to start, then refused the
  // transcription's reservation.
  const nearLimit = await setUp(t, {
    ledger: { companyLimitMicros: 1_000_000, committedMicros: 998_000 },
  });
  await assert.rejects(
    runProductVideoImport(nearLimit.ports),
    (error: unknown) =>
      error instanceof ProductVideoImportFailure &&
      error.code === "spend_limit" &&
      !error.retryable,
  );
  assert.equal(nearLimit.calls.transcribe, 0);

  // Another import used the last included action, or the free trial ended,
  // after this one was allowed to start.
  for (const [ledger, code] of [
    [{ includedActions: 100, usedActions: 100 }, "ai_actions_used"],
    [{ includedActions: 100, usedActions: 3, trialEnded: true }, "trial_ended"],
  ] as const) {
    const raced = await setUp(t, { ledger });
    const projected = raced.ports.spend.allowance;
    let first = true;
    raced.ports.spend.allowance = async () => {
      if (!first) return projected();
      first = false;
      return {
        includedActions: 100,
        remainingActions: 1,
        spendLimitReached: false,
        spendRemainingMicros: 500_000,
        trialEnded: false,
      };
    };
    await assert.rejects(
      runProductVideoImport(raced.ports),
      (error: unknown) =>
        error instanceof ProductVideoImportFailure &&
        error.code === code &&
        !error.retryable,
    );
    assert.deepEqual(raced.ledger.log, [
      "refuse read:1 transcription:attempt-1 own_ai_source_required",
    ]);
  }
});

test("transcription reserves Scribe's price by the minute started and settles it for the narration's length", async (t) => {
  const { ports, ledger } = await setUp(t, { durationSeconds: 95 });

  await runProductVideoImport(ports);

  // $0.22 an hour: two minutes reserved, 95 s settled.
  assert.deepEqual(ledger.log.slice(0, 2), [
    "reserve read:1 transcription:attempt-1 elevenlabs 7334",
    "settle read:1 transcription:attempt-1 5806",
  ]);
});

test("a retry reads the video in a new AI action, which the first attempt's unknown cost can't fill", async (t) => {
  // The longest video: its inventory reservation twice wouldn't fit one action.
  const { ports, state, ledger } = await setUp(t, {
    durationSeconds: 300,
    inventoryFailures: [
      {
        error: new MetaModelApiError({
          kind: "server",
          transient: true,
          message: "Meta Model API answered 504",
        }),
      },
    ],
  });

  await assert.rejects(runProductVideoImport(ports), /504/);
  assert.deepEqual(ledger.log, [
    "reserve read:1 transcription:attempt-1 elevenlabs 18334",
    "settle read:1 transcription:attempt-1 18334",
    "reserve read:1 inventory:attempt-1 meta 382000",
    // It may have been billed: the whole reservation is kept.
    "settle read:1 inventory:attempt-1 null",
  ]);
  assert.equal(ledger.actions.get("read:1")!.committed, 400_334);

  ports.attempt = 2;
  await runProductVideoImport(ports);

  assert.equal(state.import.status, "ready");
  assert.ok(
    ledger.log.includes("reserve read:2 inventory:attempt-2 meta 382000"),
  );
  assert.ok(ledger.log.includes("settle read:2 inventory:attempt-2 40000"));
  assert.ok(!ledger.log.some((line) => line.startsWith("refuse")));
});

test("the read steps of the longest video fit in one AI action with the presenter", async (t) => {
  const { ports, calls, ledger } = await setUp(t, {
    durationSeconds: 300,
    presenterMoment: 4,
  });

  await runProductVideoImport(ports);

  assert.equal(calls.presenter, 1);
  const reserved = ledger.log
    .filter((line) => line.startsWith("reserve read:1"))
    .reduce((total, line) => total + Number(line.split(" ").at(-1)), 0);
  assert.ok(reserved <= ACTION_LIMIT_MICROS, String(reserved));
  assert.ok(
    ledger.log.includes("reserve read:1 presenter:attempt-1 meta 50000"),
  );
});

test("a failed step settles the cost it reported, unless a call may have been billed unreported", async (t) => {
  // Muse's answer came, and was priced, but wasn't valid JSON.
  const unreadable = await setUp(t, {
    inventoryFailures: [
      {
        error: new MetaModelApiError({
          kind: "server",
          transient: true,
          code: "invalid_json",
          message: "Muse Spark's product list wasn't valid JSON",
        }),
        reportedUsd: 0.03,
      },
    ],
  });
  await assert.rejects(runProductVideoImport(unreadable.ports), /valid JSON/);
  assert.ok(
    unreadable.ledger.log.includes("settle read:1 inventory:attempt-1 30000"),
  );

  // A frame went wrong after the photo's model calls had answered.
  const broken = await setUp(t, {
    cutOut: async (name, dir, onCost) => {
      onCost(0.05);
      if (name === "frosted cup")
        throw new Error("Input buffer contains unsupported image format");
      return restoredCutout(dir);
    },
  });
  await assert.rejects(
    runProductVideoImport(broken.ports),
    /unsupported image format/,
  );
  assert.ok(
    broken.ledger.log.includes("settle photo:p1:0 photo:attempt-1 50000"),
  );
});

test("a request the provider turned away with a 4xx settles the cost reported before it", async (t) => {
  // Muse refused the request itself: nothing ran, so nothing more was billed.
  const rejected = await setUp(t, {
    inventoryFailures: [
      {
        error: new MetaModelApiError({
          kind: "invalid_request",
          transient: false,
          status: 400,
          message: "Meta Model API answered 400",
        }),
        reportedUsd: 0.03,
      },
    ],
  });
  await assert.rejects(runProductVideoImport(rejected.ports), /400/);
  assert.ok(
    rejected.ledger.log.includes("settle read:1 inventory:attempt-1 30000"),
  );

  // Still rate limited after the client's own retries: a retry of the import
  // may get through, and this attempt's reservation isn't held for it.
  const limited = await setUp(t, {
    cutOut: async (name, dir, onCost) => {
      onCost(0.02);
      if (name === "frosted cup")
        throw new MetaModelApiError({
          kind: "rate_limit",
          transient: true,
          status: 429,
          message: "Meta Model API answered 429",
        });
      return restoredCutout(dir);
    },
  });
  await assert.rejects(runProductVideoImport(limited.ports), /429/);
  assert.ok(
    limited.ledger.log.includes("settle photo:p1:0 photo:attempt-1 20000"),
  );
});

test("photographs every option of a product shown in several designs", async (t) => {
  const { ports, state, calls } = await setUp(t, {
    inventory: {
      ...INVENTORY,
      items: [
        item({
          name: "Family tree panel",
          localName: "Шежіре",
          nameSource: "on_screen",
          price: 15500,
          priceIsFrom: true,
          options: [
            option("round tree-of-life panel", 2, 3),
            option("star-shaped plaque", 6, 6.5),
          ],
          featuredOption: 1,
        }),
      ],
    },
  });

  await runProductVideoImport(ports);

  const [panel] = state.products;
  assert.equal(panel!.nameSource, "on_screen");
  assert.equal(panel!.featuredOption, 1);
  assert.deepEqual(
    panel!.options.map((o) => o.description),
    ["round tree-of-life panel", "star-shaped plaque"],
  );
  // Each design is filmed in its own stretch, and photographed by its words.
  assert.deepEqual(panel!.options[0]!.videoWindow, {
    fromSeconds: 2,
    toSeconds: 6,
  });
  assert.deepEqual([...calls.cutOut].sort(), [
    "round tree-of-life panel",
    "star-shaped plaque",
  ]);
  assert.ok(panel!.options.every((o) => o.photo.method === "restored"));
  assert.ok(calls.saved.includes("p0/option-1-cutout.png:image/png"));
  assert.equal(state.import.productTotal, 1);
  assert.equal(state.import.photoTotal, 2);
  assert.equal(state.import.photoDone, 2);
});

test("leaves options past the photo cap out, keeping an import's cost bounded", async (t) => {
  // Eight products of eight designs: 64 options, four more than the cap.
  const designs = Array.from({ length: 8 }, (_, i) =>
    option(`design ${i}`, 0, 1),
  );
  const { ports, state } = await setUp(t, {
    inventory: {
      ...INVENTORY,
      items: Array.from({ length: 8 }, (_, i) =>
        item({ name: `Panel ${i}`, options: designs, featuredOption: 7 }),
      ),
    },
  });

  await runProductVideoImport(ports);

  assert.equal(state.import.photoTotal, 60);
  const last = state.products.at(-1)!;
  assert.equal(last.options.length, 4);
  // Its featured option was left out: the first stands in.
  assert.equal(last.featuredOption, 0);
});

test("a retry resumes: no second transcription, inventory or photo for a finished option", async (t) => {
  const { ports, state, calls, ledger } = await setUp(t, {
    transcript: TRANSCRIPT,
    products: [
      savedProduct(0, "LOL doll", { method: "restored" }),
      savedProduct(1, "Frosted cup", { method: "pending" }),
    ],
  });
  // The first attempt's photos stopped, and it failed cutting the clips.
  state.import.photosStopped = "spend_limit";
  ports.attempt = 2;
  const stopsAtPhotos: unknown[] = [];
  const cutOut = ports.cutOut!;
  ports.cutOut = async (...args) => {
    stopsAtPhotos.push(state.import.photosStopped);
    return cutOut(...args);
  };

  await runProductVideoImport(ports);

  assert.equal(calls.transcribe, 0);
  assert.equal(calls.inventory, 0);
  assert.deepEqual(calls.cutOut, ["Frosted cup"]);
  // The photo's action is the same in every attempt of the run.
  assert.deepEqual(ledger.log, [
    "reserve photo:p1:0 photo:attempt-2 meta 150000",
    "settle photo:p1:0 photo:attempt-2 50000",
  ]);
  assert.equal(state.import.status, "ready");
  // Its stop no longer held once this attempt began making photos.
  assert.deepEqual(stopsAtPhotos, [null]);
  assert.equal(state.import.photosStopped, null);
});

test("an option its video can't give a photo is noted, and the others carry on", async (t) => {
  const { ports, state, ledger } = await setUp(t, {
    cutOut: async (name, dir) => {
      if (name === "frosted cup")
        throw new ProductVideoError(
          "no_frames",
          "No frames between 8s and 20s",
        );
      await mkdir(dir, { recursive: true });
      const originalPath = join(dir, "original.jpg");
      await sharp({
        create: { width: 20, height: 20, channels: 3, background: "#123456" },
      })
        .jpeg()
        .toFile(originalPath);
      return {
        method: "tracked",
        frameTimeSeconds: 3,
        originalPath,
        cutoutPath: null,
        samConfidence: null,
        straightenedDegrees: 0,
        notes: [
          "The photo couldn't be cleaned up, so the hand may still show.",
        ],
      };
    },
  });

  await runProductVideoImport(ports);

  const [doll, cup] = state.products;
  assert.equal(cup!.options[0]!.photo.method, "none");
  assert.deepEqual(cup!.options[0]!.notes, [
    "The photo couldn't be made from the video.",
  ]);
  // It failed before any paid call: nothing was spent.
  assert.ok(ledger.log.includes("settle photo:p1:0 photo:attempt-1 0"));
  // A filmed photo without a cut-out still gets its shelf copy, from the original.
  const dollPhoto = doll!.options[0]!.photo;
  assert.equal(dollPhoto.method, "tracked");
  assert.ok("thumb" in dollPhoto && dollPhoto.thumb);
  assert.ok(!("cutout" in dollPhoto));
  // A photo's notes stay with its option; the product's doubts are about it.
  assert.deepEqual(doll!.options[0]!.notes, [
    "The photo couldn't be cleaned up, so the hand may still show.",
  ]);
  assert.deepEqual(doll!.doubts, []);
  assert.equal(state.import.photoDone, 3);
  assert.equal(state.import.status, "ready");
});

test("a failure a retry may fix stops the run, keeping finished photos and the unknown cost reserved", async (t) => {
  const { ports, state, ledger } = await setUp(t, {
    cutOut: async (name, dir) => {
      if (name === "white rooster")
        throw new MetaModelApiError({
          kind: "server",
          transient: true,
          message: "502",
        });
      await mkdir(dir, { recursive: true });
      const originalPath = join(dir, "original.jpg");
      await sharp({
        create: { width: 10, height: 10, channels: 3, background: "#fff" },
      })
        .jpeg()
        .toFile(originalPath);
      return {
        method: "restored",
        frameTimeSeconds: 1,
        originalPath,
        cutoutPath: null,
        samConfidence: 1,
        straightenedDegrees: 0,
        notes: [],
      };
    },
  });

  await assert.rejects(runProductVideoImport(ports), /502/);

  assert.notEqual(state.import.status, "ready");
  assert.equal(
    state.products.filter((p) => p.options[0]!.photo.method !== "pending")
      .length,
    2,
  );
  assert.ok(ledger.log.includes("settle photo:p2:0 photo:attempt-1 null"));
});

test("a missing upload is reported, not retried", async (t) => {
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
  const { ports, state, calls, ledger } = await setUp(t);
  state.import.status = "ready";
  ports.store.loadImport = async () => ({
    status: "ready",
    video: { bucket: "b", path: "p" },
    whatsapp: null,
    transcript: TRANSCRIPT,
    language: "kk",
    presenter: { momentSeconds: 4, done: false },
  });

  await runProductVideoImport(ports);

  assert.equal(
    calls.transcribe + calls.inventory + calls.cutOut.length + calls.presenter,
    0,
  );
  assert.deepEqual(calls.emits, []);
  assert.deepEqual(ledger.log, []);
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
      new WorkspaceAiSpendError("own_ai_source_required"),
      "ai_actions_used",
      false,
    ],
    // The ledger or the allowance couldn't be checked: a retry may.
    [
      new WorkspaceAiSpendError("workspace_ai_policy_unavailable"),
      "failed",
      true,
    ],
    [
      Object.assign(new Error("AI allowance could not be verified."), {
        code: "workspace_ai_policy_unavailable",
      }),
      "failed",
      true,
    ],
    // A retry reserves under new operation ids.
    [
      new WorkspaceAiSpendError("workspace_ai_operation_replayed"),
      "failed",
      true,
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
  const { ports, state, calls, ledger } = await setUp(t, {
    presenterMoment: 4,
  });

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
  // In the same action as the other steps that read the video.
  assert.ok(
    ledger.log.includes("reserve read:1 presenter:attempt-1 meta 50000"),
  );
  assert.ok(ledger.log.includes("settle read:1 presenter:attempt-1 10000"));
});

test("a presenter the ledger refuses waits, and the import is ready without them", async (t) => {
  // Reading the video cost more than it reserved; the ledger keeps the
  // overrun, which leaves its action no room for the presenter.
  const { ports, state, calls, ledger } = await setUp(t, {
    presenterMoment: 4,
    inventoryUsd: 0.46,
  });

  await runProductVideoImport(ports);

  assert.ok(ledger.log.includes("settle read:1 inventory:attempt-1 460000"));
  assert.ok(
    ledger.log.includes(
      "refuse read:1 presenter:attempt-1 workspace_ai_spend_limit",
    ),
  );
  assert.equal(calls.presenter, 0);
  assert.equal(state.import.status, "ready");
  assert.equal(state.import.photosStopped, null);
  assert.deepEqual(state.import.presenter, { momentSeconds: 4, photo: null });
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
  const { ports, state, calls } = await setUp(t, {
    transcript: TRANSCRIPT,
    products: [savedProduct(0, "LOL doll", { method: "restored" })],
    presenter: { momentSeconds: 6, photo: null },
  });
  state.import.photoDone = 1;

  await runProductVideoImport(ports);

  assert.equal(calls.inventory, 0);
  assert.deepEqual(calls.cutOut, []);
  assert.equal(calls.presenter, 1);
  assert.equal(
    (state.import.presenter as { momentSeconds: number }).momentSeconds,
    6,
  );
});

test("cuts each product's review clip after its photos, with the video's own sound", async (t) => {
  const { ports, state, calls } = await setUp(t);

  await runProductVideoImport(ports);

  const sourcePath = join(ports.workDir, "source");
  assert.deepEqual(calls.clips, [
    // The doll's price is said in the first sentence, which runs to the next.
    {
      productId: "p0",
      soundPath: sourcePath,
      window: { fromSeconds: 0.7, toSeconds: 6.7 },
    },
    // The cup's sentence is the last one: 6 s at most.
    {
      productId: "p1",
      soundPath: sourcePath,
      window: { fromSeconds: 8.7, toSeconds: 14.7 },
    },
    // No price was said for the rooster: 4 s around its clearest moment.
    {
      productId: "p2",
      soundPath: sourcePath,
      window: { fromSeconds: 20, toSeconds: 24 },
    },
  ]);
  assert.ok(calls.saved.includes("p0/clip.mp4:video/mp4"));
  assert.deepEqual(state.products[0]!.clip, {
    fromSeconds: 0.7,
    toSeconds: 6.7,
    video: { bucket: "media", path: "clips/p0/clip.mp4" },
  });
  assert.equal(state.import.status, "ready");
});

test("a video without sound gets silent review clips", async (t) => {
  const { ports, calls } = await setUp(t, { audio: false });

  await runProductVideoImport(ports);

  assert.equal(calls.clips.length, 3);
  assert.ok(calls.clips.every((clip) => clip.soundPath === null));
});

test("a retry cuts only the review clips a previous run didn't save", async (t) => {
  const done = savedProduct(0, "LOL doll", { method: "restored" });
  done.clip = {
    fromSeconds: 0.7,
    toSeconds: 4,
    video: { bucket: "media", path: "clips/p0/clip.mp4" },
  };
  const { ports, calls } = await setUp(t, {
    transcript: TRANSCRIPT,
    products: [done, savedProduct(1, "Frosted cup", { method: "restored" })],
  });

  await runProductVideoImport(ports);

  assert.deepEqual(
    calls.clips.map((clip) => clip.productId),
    ["p1"],
  );
});

test("a clip ffmpeg can't make is left out; any other failure is retried", async (t) => {
  const broken = await setUp(t, {
    clipFails: { p1: new Error("ffmpeg exited with code 1: Invalid data") },
  });

  await runProductVideoImport(broken.ports);

  assert.equal(broken.state.import.status, "ready");
  assert.equal(broken.state.products[1]!.clip!.video, undefined);
  assert.ok(broken.state.products[2]!.clip!.video);

  const stuck = await setUp(t, {
    clipFails: { p0: new Error("ffmpeg timed out after 300000 ms") },
  });
  await assert.rejects(runProductVideoImport(stuck.ports), /timed out/);
  assert.equal(stuck.state.import.status, "processing");
});

test("a video sent on WhatsApp is fetched once and kept, so a retry reads the copy", async (t) => {
  const first = await setUp(t, { whatsapp: true });

  await runProductVideoImport(first.ports);

  assert.deepEqual(first.calls.downloads, ["whatsapp:wamid-media-1"]);
  assert.deepEqual(first.state.import.video, {
    bucket: "media",
    path: "videos/whatsapp-video.mp4",
  });
  assert.equal(first.state.import.status, "ready");

  // Its copy saved, a later run never goes back to WhatsApp.
  const retry = await setUp(t, { whatsapp: true });
  retry.state.import.video = {
    bucket: "media",
    path: "videos/whatsapp-video.mp4",
  };
  await runProductVideoImport(retry.ports);
  assert.deepEqual(retry.calls.downloads, [
    "storage:videos/whatsapp-video.mp4",
  ]);
});

test("a WhatsApp video that can't be fetched is retried, not given up on", async (t) => {
  const { ports, calls } = await setUp(t, {
    whatsapp: true,
    whatsappFails: new Error("Meta answered 500"),
  });

  await assert.rejects(
    runProductVideoImport(ports),
    (error: unknown) =>
      error instanceof ProductVideoImportFailure &&
      error.code === "video_missing" &&
      error.retryable &&
      /fetched from WhatsApp: Meta answered 500/.test(error.message),
  );
  assert.equal(calls.transcribe, 0);
});
