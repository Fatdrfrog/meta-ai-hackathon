import "server-only";
import { logger } from "@/lib/logger";
import {
  adWordsIssues,
  applyAdWords,
  oneLine,
  sameAdWords,
} from "@/lib/products/ad-request";
import { productImportSpend } from "@/lib/products/import-spend";
import {
  productPhotoUrl,
  withProductPhotoUrls,
} from "@/lib/products/photo-urls";
import {
  SHOP_WORDS,
  buyerPrice,
  shopWords,
  type ShopWords,
} from "@/lib/products/shop-words";
import {
  PRODUCT_AD_STEPS,
  productAdLettersSupported,
  type ProductAdAdmissionStop,
  type ProductAdBrief,
  type ProductAdCreateRequest,
  type ProductAdProductProblem,
  type ProductAdRecord,
  type ProductAdUpdateRequest,
  type ProductShopWordsCode,
  type StoredFileRef,
} from "@/lib/products/types";
import { startProductAdWorkflow } from "@/lib/temporal/product-ad";
import { getWhatsAppWorkspaceContext } from "@/lib/whatsapp/get-workspace-context";
import {
  ProductAd,
  type IProductAd,
  type ProductAdSnapshot,
} from "@/models/product-ad";
import { ProductVideoImport } from "@/models/product-video-import";
import { WorkspaceProduct } from "@/models/workspace-product";
import {
  buildProductAdActionId,
  buildProductAdWorkflowId,
  type ProductAdMode,
} from "@icecore/temporal";
import mongoose from "mongoose";

// Video ads made from shelf products: the brief's checks (eligibility, the
// letters the ad's fonts draw, admission to the AI ledger), the snapshot of
// the products when the ad is made, starting each run of its workflow, and
// the ad as the page reads it, with its post text. The worker makes the rest.
// What the API takes is checked in ad-request.ts.

const cutTo = (value: string, max: number) =>
  Array.from(value).slice(0, max).join("").trim();

// ---------------------------------------------------------------------------
// The picked products, read from the shelf.

type FileRow = Partial<StoredFileRef> | null | undefined;

const storedRef = (ref: FileRow): StoredFileRef | null =>
  ref?.bucket && ref.path ? { bucket: ref.bucket, path: ref.path } : null;

type ProductRow = {
  _id: unknown;
  name?: string | null;
  englishName?: string | null;
  price?: number | null;
  currency?: string | null;
  priceIsFrom?: boolean | null;
  priceQuote?: string | null;
  importId?: unknown;
  featuredOption?: number | null;
  options?: Array<{
    description?: string | null;
    samPhrase?: string | null;
    photo?: { cutout?: FileRow; thumb?: FileRow; original?: FileRow } | null;
  }>;
  clip?: { video?: FileRow } | null;
};

const PRODUCT_FIELDS =
  "name englishName price currency priceIsFrom priceQuote importId featuredOption options.description options.samPhrase options.photo.cutout options.photo.thumb options.photo.original clip.video";

/** A picked product as an ad reads it from the shelf. */
export type AdShelfProduct = {
  id: string;
  importId: string | null;
  name: string;
  englishName: string | null;
  price: number | null;
  currency: string | null;
  priceIsFrom: boolean;
  priceQuote: string | null;
  /** The featured option's transparent cut-out, its small copy, and the item as filmed. */
  cutout: StoredFileRef | null;
  thumb: StoredFileRef | null;
  original: StoredFileRef | null;
  /** The owner saying its price, with sound. */
  clip: StoredFileRef | null;
  samPhrase: string;
  description: string;
};

/** The person who presents the products in a video, cut out at import. */
type AdPresenterPhoto = { cutout: StoredFileRef; thumb: StoredFileRef | null };

const filled = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

function toShelfProduct(row: ProductRow): AdShelfProduct {
  const options = row.options ?? [];
  const featured =
    typeof row.featuredOption === "number" &&
    Number.isInteger(row.featuredOption) &&
    row.featuredOption >= 0 &&
    row.featuredOption < options.length
      ? row.featuredOption
      : 0;
  const option = options[featured];
  const englishName = filled(row.englishName);
  return {
    id: String(row._id),
    importId: row.importId ? String(row.importId) : null,
    name: filled(row.name) ?? "",
    englishName,
    price:
      typeof row.price === "number" && Number.isFinite(row.price)
        ? row.price
        : null,
    currency: filled(row.currency),
    priceIsFrom: row.priceIsFrom === true,
    priceQuote: filled(row.priceQuote),
    cutout: storedRef(option?.photo?.cutout),
    thumb: storedRef(option?.photo?.thumb),
    original: storedRef(option?.photo?.original),
    clip: storedRef(row.clip?.video),
    // SAM 3.1 finds it by its noun phrase; older imports have none, and its
    // English name is the next best thing.
    samPhrase: cutTo(filled(option?.samPhrase) ?? englishName ?? "", 80),
    description: cutTo(filled(option?.description) ?? "", 120),
  };
}

/**
 * Why a product can't be in an ad, or null when it can: it needs its cut-out
 * photo, which every scene is made from, and a price, which code draws.
 */
export function adProductProblem(
  product: Pick<AdShelfProduct, "cutout" | "price">
): ProductAdProductProblem | null {
  if (!product.cutout) return "no_photo";
  if (product.price === null) return "no_price";
  return null;
}

/**
 * The picked products that are on the shelf (published, this workspace's),
 * in the order picked; how many aren't; the language the owner spoke in the
 * newest of their videos that names one; and the person presenting in the
 * newest of them cut out.
 */
export async function loadAdShelf(
  workspaceId: string,
  productIds: readonly string[]
): Promise<{
  products: AdShelfProduct[];
  missing: number;
  language: string | null;
  presenter: AdPresenterPhoto | null;
}> {
  const rows = await WorkspaceProduct.find({
    workspaceId,
    status: "published",
    _id: { $in: productIds },
  })
    .select(PRODUCT_FIELDS)
    .lean<ProductRow[]>();
  const byId = new Map(rows.map(row => [String(row._id), row]));
  const products = productIds.flatMap(id => {
    const row = byId.get(id);
    return row ? [toShelfProduct(row)] : [];
  });
  const importIds = [
    ...new Set(products.flatMap(product => product.importId ?? [])),
  ];
  const imports = importIds.length
    ? await ProductVideoImport.find({ workspaceId, _id: { $in: importIds } })
        .sort({ createdAt: -1 })
        .select("language presenter.photo createdAt")
        .lean<
          Array<{
            language?: string | null;
            presenter?: {
              photo?: { cutout?: FileRow; thumb?: FileRow } | null;
            } | null;
          }>
        >()
    : [];
  let presenter: AdPresenterPhoto | null = null;
  for (const entry of imports) {
    const cutout = storedRef(entry.presenter?.photo?.cutout);
    if (!cutout) continue;
    presenter = { cutout, thumb: storedRef(entry.presenter?.photo?.thumb) };
    break;
  }
  return {
    products,
    missing: productIds.length - products.length,
    language:
      imports.map(entry => filled(entry.language)).find(Boolean) ?? null,
    presenter,
  };
}

/** A product as the ad shows it, with its price written by code in the buyers' words. */
export function adSnapshot(
  product: AdShelfProduct,
  words: ShopWords
): ProductAdSnapshot {
  return {
    productId: product.id,
    importId: product.importId,
    name: product.name,
    englishName: product.englishName,
    priceText: buyerPrice(product, words) ?? "",
    priceQuote: product.priceQuote,
    cutout: product.cutout,
    thumb: product.thumb,
    original: product.original,
    clip: product.clip,
    samPhrase: product.samPhrase,
    description: product.description,
  };
}

/**
 * The texts an ad would draw that its fonts can't: product names and
 * prices, and the owner's own words for the idea. Empty when every one is
 * Latin or Cyrillic. The shop's name isn't one: the worker leaves a name its
 * fonts can't draw off the ending (productAdShopName), and the owner can't
 * rename the workspace from Products.
 */
export function adUnsupportedTexts(params: {
  products: ReadonlyArray<{ name: string; priceText: string | null }>;
  ideaText: string | null;
}): string[] {
  const texts = [
    ...params.products.flatMap(product => [
      product.name,
      product.priceText ?? "",
    ]),
    params.ideaText ?? "",
  ];
  return texts.filter(entry => entry && !productAdLettersSupported(entry));
}

/**
 * What stops the workspace paying for an ad's AI action now, by the rules
 * the import admits by: the company's spending limit first (it stops every
 * plan), then the free trial, then the plan's included actions. An action
 * already admitted needs no included action left. Null when nothing does.
 */
export async function adAdmissionStop(
  workspaceId: string,
  options: { admitted?: boolean } = {}
): Promise<ProductAdAdmissionStop | null> {
  const allowance = await productImportSpend.allowance(workspaceId);
  if (allowance.spendLimitReached) return "spend_limit";
  if (allowance.trialEnded) return "trial_ended";
  if (
    !options.admitted &&
    allowance.includedActions !== null &&
    allowance.remainingActions === 0
  )
    return "ai_actions_used";
  return null;
}

/** The workspace's name, as the ad writes it for the shop; "" without one. */
async function shopName(workspaceId: string): Promise<string> {
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const { data } = await supabaseAdmin
    .from("workspaces")
    .select("name")
    .eq("id", workspaceId)
    .maybeSingle();
  const name = (data as { name?: unknown } | null)?.name;
  return typeof name === "string" ? cutTo(oneLine(name), 160) : "";
}

/**
 * How buyers reach the shop at the ad's end: the connected WhatsApp number
 * as Meta displays it, and the shop's name, which stands in without one.
 */
export async function adEnding(
  workspaceId: string
): Promise<{ phone: string | null; shopName: string }> {
  const [whatsapp, name] = await Promise.all([
    getWhatsAppWorkspaceContext(workspaceId, {
      requireCredentials: false,
    }).catch(() => null),
    shopName(workspaceId).catch(() => ""),
  ]);
  const credentials = whatsapp?.context?.credentials;
  const phone =
    credentials?.accessToken && credentials.displayPhoneNumber
      ? cutTo(oneLine(credentials.displayPhoneNumber), 32)
      : null;
  return { phone: phone || null, shopName: name };
}

/** What the brief for these products starts from. */
export async function loadProductAdBrief(
  workspaceId: string,
  productIds: readonly string[]
): Promise<ProductAdBrief> {
  const [shelf, ending, blocked] = await Promise.all([
    loadAdShelf(workspaceId, productIds),
    adEnding(workspaceId),
    // The press asks again; a brief that can't tell doesn't block it.
    adAdmissionStop(workspaceId).catch(() => null),
  ]);
  const words = shopWords(shelf.language);
  return withProductPhotoUrls(async () => {
    const presenterUrl = shelf.presenter
      ? await productPhotoUrl(
          workspaceId,
          shelf.presenter.thumb ?? shelf.presenter.cutout
        )
      : null;
    return {
      products: await Promise.all(
        shelf.products.map(async product => ({
          productId: product.id,
          name: product.name,
          englishName: product.englishName,
          priceText: buyerPrice(product, words),
          imageUrl: await productPhotoUrl(
            workspaceId,
            product.thumb ?? product.cutout
          ),
          problem: adProductProblem(product),
          hasVoice: product.clip !== null,
        }))
      ),
      missing: shelf.missing,
      language: shelf.language,
      wordsCode: words.code,
      // The owner ticks that this person agreed while looking at them.
      presenter: presenterUrl ? { imageUrl: presenterUrl } : null,
      ending,
      blocked,
    };
  });
}

// ---------------------------------------------------------------------------
// The ad as the page reads it.

/** "Pictures made with AI.", in the post's language, when a scene is Muse Image's. */
const AI_PICTURES_NOTE: Record<ProductShopWordsCode, string> = {
  kk: "Суреттерді AI жасаған.",
  ru: "Изображения созданы с помощью ИИ.",
  en: "Pictures made with AI.",
};

/**
 * The post to share the ad with, composed by code: Muse Spark's opening, a
 * "name — price" line per product with the price drawn from the shelf, the
 * call to the shop's WhatsApp, and a note when a picture is Muse Image's.
 */
export function adPostText(
  ad: Pick<IProductAd, "script" | "products" | "scenes" | "ending"> & {
    wordsCode: ProductShopWordsCode | null;
  }
): string | null {
  if (!ad.script) return null;
  const prices = ad.products
    .map(product => `${product.name} — ${product.priceText}`)
    .join("\n");
  const contact = ad.ending.phone
    ? `WhatsApp: ${ad.ending.phone}`
    : ad.ending.shopName.trim();
  const call = [ad.script.ending.trim(), contact].filter(Boolean).join("\n");
  const aiNote = ad.scenes.some(scene => scene.method === "muse")
    ? AI_PICTURES_NOTE[ad.wordsCode ?? "en"]
    : "";
  return [ad.script.postIntro.trim(), prices, call, aiNote]
    .filter(Boolean)
    .join("\n\n");
}

const toIso = (value: unknown): string | null =>
  value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString()
    : null;

/**
 * The ad's links: "ad" for the studio, every one; "list" for the made list,
 * which shows a poster and the products, so scene pictures and stills stay
 * unsigned there.
 */
type AdLinks = "ad" | "list";

/** The ad as the page reads it; call inside withProductPhotoUrls. */
async function toAdRecord(
  workspaceId: string,
  doc: IProductAd,
  links: AdLinks
): Promise<ProductAdRecord> {
  const sign = (ref: FileRow) => productPhotoUrl(workspaceId, ref);
  const full = links === "ad";
  const timings: ProductAdRecord["timings"] = {};
  for (const step of PRODUCT_AD_STEPS) {
    const startedAt = toIso(doc.timings?.[step]?.startedAt);
    if (startedAt)
      timings[step] = {
        startedAt,
        finishedAt: toIso(doc.timings?.[step]?.finishedAt),
      };
  }
  const render = doc.render;
  const [
    products,
    scenes,
    videoUrl,
    posterUrl,
    statusUrl,
    feedUrl,
    presenterUrl,
  ] = await Promise.all([
    Promise.all(
      doc.products.map(async product => ({
        productId: product.productId,
        name: product.name,
        englishName: product.englishName ?? null,
        priceText: product.priceText,
        imageUrl: await sign(product.thumb ?? product.cutout),
      }))
    ),
    Promise.all(
      (doc.scenes ?? []).map(async scene => ({
        productId: scene.productId,
        method: scene.method,
        imageUrl: full
          ? await sign(scene.method === "muse" ? scene.muse : scene.exact)
          : null,
        checked:
          scene.method === "muse" &&
          Boolean(scene.muse) &&
          scene.check?.same === true,
      }))
    ),
    render ? sign(render.video) : null,
    render ? sign(render.poster) : null,
    full ? sign(doc.stills?.status) : null,
    full ? sign(doc.stills?.feed) : null,
    doc.presenter?.use
      ? sign(doc.presenter.thumb ?? doc.presenter.photo)
      : null,
  ]);
  const script = doc.script;
  return {
    id: String(doc._id),
    status: doc.status,
    step: doc.step ?? null,
    errorCode: doc.errorCode ?? null,
    createdAt: toIso(doc.createdAt) ?? new Date(0).toISOString(),
    requestedAt:
      toIso(doc.requestedAt) ??
      toIso(doc.createdAt) ??
      new Date(0).toISOString(),
    startedAt: toIso(doc.startedAt),
    readyAt: toIso(doc.readyAt),
    renderNo: doc.renderNo ?? 1,
    language: doc.language ?? null,
    timings,
    idea: { kind: doc.idea.kind, text: doc.idea.text ?? null },
    voice: doc.voice,
    ending: {
      phone: doc.ending?.phone ?? null,
      shopName: doc.ending?.shopName ?? "",
    },
    products,
    script: script
      ? {
          sticker: script.sticker,
          captions: script.scenes.map(scene => ({
            productId: scene.productId,
            caption: scene.caption,
          })),
          priceCardTitle: script.priceCardTitle,
          ending: script.ending,
        }
      : null,
    scenes,
    video:
      render && videoUrl
        ? {
            url: videoUrl,
            bytes: render.bytes,
            seconds: render.seconds,
            posterUrl,
          }
        : null,
    stills: { statusUrl, feedUrl },
    post: script
      ? {
          text: adPostText({ ...doc, wordsCode: doc.wordsCode ?? null }) ?? "",
        }
      : null,
    ctwa: script
      ? {
          headline: script.ctwa.headline,
          primaryText: script.ctwa.primaryText,
          greeting: script.ctwa.greeting,
          questions: [...script.ctwa.questions],
        }
      : null,
    presenter: presenterUrl ? { imageUrl: presenterUrl } : null,
    costUsd: Math.max(0, doc.costMicros ?? 0) / 1_000_000,
  };
}

const findAd = (workspaceId: string, adId: string) =>
  ProductAd.findOne({ _id: adId, workspaceId }).lean<IProductAd | null>();

const adRecord = (workspaceId: string, doc: IProductAd) =>
  withProductPhotoUrls(() => toAdRecord(workspaceId, doc, "ad"));

/**
 * The workspace's newest ads, at most `limit`, as the "Made from your shelf"
 * list shows them: with the video, its poster and the products linked.
 */
export async function listProductAdRecords(
  workspaceId: string,
  limit: number
): Promise<ProductAdRecord[]> {
  const docs = await ProductAd.find({ workspaceId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean<IProductAd[]>();
  return withProductPhotoUrls(() =>
    Promise.all(docs.map(doc => toAdRecord(workspaceId, doc, "list")))
  );
}

// A run whose workflow never started (the server stopped between saving the
// ad and starting it) waits this long before the ad says it failed, so the
// owner can try again.
const NEVER_STARTED_MS = 2 * 60_000;

/** One ad as the studio shows it; null when it isn't this workspace's. */
export async function loadProductAdRecord(
  workspaceId: string,
  adId: string,
  now: Date = new Date()
): Promise<ProductAdRecord | null> {
  const doc = await findAd(workspaceId, adId);
  if (!doc) return null;
  const expected = buildProductAdWorkflowId({ adId, renderNo: doc.renderNo });
  const requestedAt = doc.requestedAt ?? doc.createdAt;
  if (
    doc.status === "making" &&
    doc.workflowId !== expected &&
    now.getTime() - requestedAt.getTime() > NEVER_STARTED_MS
  ) {
    const stuck = await ProductAd.updateOne(
      {
        _id: adId,
        workspaceId,
        status: "making",
        renderNo: doc.renderNo,
        workflowId: { $ne: expected },
      },
      {
        $set: {
          status: "failed",
          step: null,
          errorCode: "failed",
          errorMessage: "The ad's run never started",
        },
      }
    );
    if (stuck.modifiedCount > 0)
      return adRecord(workspaceId, {
        ...doc,
        status: "failed",
        step: null,
        errorCode: "failed",
      });
    const current = await findAd(workspaceId, adId);
    return current ? adRecord(workspaceId, current) : null;
  }
  const [record, pricesChanged] = await Promise.all([
    adRecord(workspaceId, doc),
    // A check the studio can do without: it never stops the ad loading.
    adPricesChanged(workspaceId, doc).catch(() => false),
  ]);
  return { ...record, pricesChanged };
}

/**
 * Whether a product's price on the shelf now reads differently from the one
 * the ad drew when it was made: the ad keeps its snapshot, so it still shows
 * the old one. A product gone from the shelf, or without a price now, has no
 * new price to show, so it doesn't count.
 */
export async function adPricesChanged(
  workspaceId: string,
  doc: Pick<IProductAd, "products" | "wordsCode" | "language">
): Promise<boolean> {
  const rows = await WorkspaceProduct.find({
    workspaceId,
    status: "published",
    _id: { $in: doc.products.map(product => product.productId) },
  })
    .select("price currency priceIsFrom")
    .lean<
      Array<{
        _id: unknown;
        price?: number | null;
        currency?: string | null;
        priceIsFrom?: boolean | null;
      }>
    >();
  const words = doc.wordsCode
    ? SHOP_WORDS[doc.wordsCode]
    : shopWords(doc.language);
  const prices = new Map(
    rows.map(row => [
      String(row._id),
      buyerPrice(
        {
          price:
            typeof row.price === "number" && Number.isFinite(row.price)
              ? row.price
              : null,
          currency: typeof row.currency === "string" ? row.currency : null,
          priceIsFrom: row.priceIsFrom === true,
        },
        words
      ),
    ])
  );
  return doc.products.some(product => {
    const now = prices.get(product.productId);
    return typeof now === "string" && now !== product.priceText;
  });
}

/** Starts the ad's run `renderNo` and keeps its workflow id on the ad. */
async function startAdRun(
  workspaceId: string,
  adId: string,
  renderNo: number,
  mode: ProductAdMode
): Promise<string> {
  const started = await startProductAdWorkflow({
    workspaceId,
    adId,
    renderNo,
    mode,
  });
  await ProductAd.updateOne(
    { _id: adId, workspaceId, renderNo },
    { $set: { workflowId: started.workflowId } }
  );
  return started.workflowId;
}

const isDuplicateKeyError = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: unknown }).code === 11000;

/**
 * The ad an earlier press of the same request made. One still waiting for
 * its first run to start (the press that made it may have stopped short) is
 * started again; asking for a run already started attaches to it. One saved
 * as failed because its first run never started (that press was answered
 * 503) is started now, as the press asked for it.
 */
async function replayAd(
  workspaceId: string,
  doc: IProductAd,
  now: Date
): Promise<ProductAdRecord> {
  const adId = String(doc._id);
  const expected = buildProductAdWorkflowId({ adId, renderNo: doc.renderNo });
  if (doc.status === "making" && doc.workflowId !== expected) {
    try {
      const workflowId = await startAdRun(
        workspaceId,
        adId,
        doc.renderNo,
        doc.renderNo === 1 ? "make" : "render"
      );
      return adRecord(workspaceId, { ...doc, workflowId });
    } catch (error) {
      logger.warn("[Products] ad restart on replay failed", {
        event: "products.ad_replay_start_failed",
        workspaceId,
        adId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (
    doc.status === "failed" &&
    doc.renderNo === 1 &&
    doc.workflowId !== expected &&
    !doc.startedAt
  )
    return startUnstartedAd(workspaceId, adId, now);
  return adRecord(workspaceId, doc);
}

/**
 * Starts the first run of a failed ad that never had one: nothing of it ran
 * or was paid for. The client sends a press again only with the brief it
 * first sent, so the saved brief is still the owner's. When the run can't
 * start, the ad stays failed and the error goes to the caller, as it did
 * for the press that saved it.
 */
async function startUnstartedAd(
  workspaceId: string,
  adId: string,
  now: Date
): Promise<ProductAdRecord> {
  const restarted = await ProductAd.findOneAndUpdate(
    {
      _id: adId,
      workspaceId,
      status: "failed",
      renderNo: 1,
      workflowId: { $ne: buildProductAdWorkflowId({ adId, renderNo: 1 }) },
      startedAt: null,
    },
    {
      $set: {
        status: "making",
        step: null,
        errorCode: null,
        errorMessage: null,
        requestedAt: now,
      },
    },
    { new: true }
  ).lean<IProductAd | null>();
  if (!restarted) {
    // Another send of the same press got there first.
    const current = await findAd(workspaceId, adId);
    if (!current) throw new Error("The ad disappeared while it was resent");
    return adRecord(workspaceId, current);
  }
  try {
    const workflowId = await startAdRun(workspaceId, adId, 1, "make");
    return adRecord(workspaceId, { ...restarted, workflowId });
  } catch (error) {
    logger.warn("[Products] ad start on replay failed", {
      event: "products.ad_replay_start_failed",
      workspaceId,
      adId,
      error: error instanceof Error ? error.message : String(error),
    });
    await ProductAd.updateOne(
      { _id: adId, workspaceId, renderNo: 1 },
      {
        $set: {
          status: "failed",
          step: null,
          errorCode: "failed",
          errorMessage: "The ad's run couldn't be started",
        },
      }
    );
    throw error;
  }
}

/** Why an ad wasn't made: the products, the letters, or the AI ledger. */
export type ProductAdCreateRefusal =
  | "not_enough_products"
  | "ad_letters_unsupported"
  | ProductAdAdmissionStop;

/**
 * Makes an ad from the owner's brief: checks the products (on the shelf,
 * with a cut-out and a price), the letters the ad would draw and the AI
 * allowance, then saves the ad with its snapshot of the products and starts
 * its first run. The same request makes one ad however often it's sent.
 * When the run can't start, the ad is saved as failed and the error goes to
 * the caller; sent again, the same request starts that ad.
 */
export async function createProductAd(params: {
  workspaceId: string;
  userId: string;
  request: ProductAdCreateRequest;
  now?: Date;
}): Promise<
  | { ad: ProductAdRecord; created: boolean }
  | { refused: ProductAdCreateRefusal }
> {
  const { workspaceId, request } = params;
  const earlier = await ProductAd.findOne({
    workspaceId,
    requestId: request.requestId,
  }).lean<IProductAd | null>();
  if (earlier)
    return {
      ad: await replayAd(workspaceId, earlier, params.now ?? new Date()),
      created: false,
    };

  const shelf = await loadAdShelf(workspaceId, request.productIds);
  if (shelf.missing > 0 || shelf.products.some(adProductProblem))
    return { refused: "not_enough_products" };
  const words = shopWords(shelf.language);
  const products = shelf.products.map(product => adSnapshot(product, words));
  const ideaText =
    request.idea.kind === "own" ? (request.idea.text ?? null) : null;
  const ending = await adEnding(workspaceId);
  if (adUnsupportedTexts({ products, ideaText }).length > 0)
    return { refused: "ad_letters_unsupported" };
  const stop = await adAdmissionStop(workspaceId);
  if (stop) return { refused: stop };

  const now = params.now ?? new Date();
  const _id = new mongoose.Types.ObjectId();
  const adId = String(_id);
  const presenter =
    request.presenter.use && request.presenter.consent && shelf.presenter
      ? {
          use: true,
          consentAt: now,
          photo: shelf.presenter.cutout,
          thumb: shelf.presenter.thumb,
        }
      : null;
  try {
    await ProductAd.create({
      _id,
      workspaceId,
      requestId: request.requestId,
      createdBy: params.userId,
      status: "making",
      requestedAt: now,
      step: null,
      language: shelf.language,
      wordsCode: words.code,
      idea: { kind: request.idea.kind, text: ideaText },
      voice: request.voice,
      presenter,
      ending,
      products,
      renderNo: 1,
      actionId: buildProductAdActionId(adId),
    });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    // The same press, sent twice at once: the other one made it.
    const made = await ProductAd.findOne({
      workspaceId,
      requestId: request.requestId,
    }).lean<IProductAd | null>();
    if (!made) throw error;
    return { ad: await replayAd(workspaceId, made, now), created: false };
  }
  try {
    await startAdRun(workspaceId, adId, 1, "make");
  } catch (error) {
    logger.error("[Products] ad start failed", error, {
      event: "products.ad_start_failed",
      workspaceId,
      adId,
    });
    await ProductAd.updateOne(
      { _id: adId, workspaceId },
      {
        $set: {
          status: "failed",
          step: null,
          errorCode: "failed",
          errorMessage: "The ad's run couldn't be started",
        },
      }
    );
    throw error;
  }
  const made = await findAd(workspaceId, adId);
  if (!made) throw new Error("The ad disappeared after it was made");
  return { ad: await adRecord(workspaceId, made), created: true };
}

/**
 * The owner's edits to the words on screen: checked like the script, saved,
 * and the video made again from the saved pictures, a run with no model
 * calls and so no AI action. Only a ready ad takes edits. Edits that change
 * nothing start nothing. When the run can't start, the ad goes back to how
 * it was and the error goes to the caller.
 */
export async function updateProductAdWords(params: {
  workspaceId: string;
  adId: string;
  changes: ProductAdUpdateRequest;
  now?: Date;
}): Promise<
  | { ad: ProductAdRecord; started: boolean }
  | {
      refused: "ad_not_found" | "ad_not_ready" | "invalid_request";
      issues?: string[];
    }
> {
  const { workspaceId, adId, changes } = params;
  const doc = await findAd(workspaceId, adId);
  if (!doc) return { refused: "ad_not_found" };
  if (doc.status !== "ready" || !doc.script) return { refused: "ad_not_ready" };
  const issues = adWordsIssues(
    changes,
    doc.products.map(product => product.productId)
  );
  if (issues.length > 0) return { refused: "invalid_request", issues };
  const script = applyAdWords(doc.script, changes);
  if (sameAdWords(doc.script, script))
    return { ad: await adRecord(workspaceId, doc), started: false };
  const renderNo = doc.renderNo + 1;
  const now = params.now ?? new Date();
  const updated = await ProductAd.findOneAndUpdate(
    { _id: adId, workspaceId, status: "ready", renderNo: doc.renderNo },
    {
      $set: {
        script,
        status: "making",
        step: "video",
        renderNo,
        requestedAt: now,
        startedAt: null,
        errorCode: null,
        errorMessage: null,
      },
    },
    { new: true }
  ).lean<IProductAd | null>();
  // Another edit or run got there first.
  if (!updated) return { refused: "ad_not_ready" };
  try {
    const workflowId = await startAdRun(workspaceId, adId, renderNo, "render");
    return {
      ad: await adRecord(workspaceId, { ...updated, workflowId }),
      started: true,
    };
  } catch (error) {
    logger.error("[Products] ad render start failed", error, {
      event: "products.ad_render_start_failed",
      workspaceId,
      adId,
      renderNo,
    });
    await ProductAd.updateOne(
      { _id: adId, workspaceId, renderNo },
      {
        $set: {
          script: doc.script,
          status: "ready",
          step: null,
          renderNo: doc.renderNo,
          requestedAt: doc.requestedAt ?? doc.createdAt,
          startedAt: doc.startedAt ?? null,
        },
      }
    );
    throw error;
  }
}

/**
 * "Try again" on a failed ad: a new run that resumes it, paying only for
 * what wasn't saved (the pictures already made are reused). It asks the AI
 * allowance first, as making the ad did. An ad that isn't failed is answered
 * as it is, so a second press starts nothing. When the run can't start, the
 * ad stays failed and the error goes to the caller.
 */
export async function retryProductAd(params: {
  workspaceId: string;
  adId: string;
  now?: Date;
}): Promise<
  | { ad: ProductAdRecord; started: boolean }
  | { refused: "ad_not_found" | ProductAdAdmissionStop }
> {
  const { workspaceId, adId } = params;
  const doc = await findAd(workspaceId, adId);
  if (!doc) return { refused: "ad_not_found" };
  if (doc.status !== "failed")
    return { ad: await adRecord(workspaceId, doc), started: false };
  // An action that has booked spend was admitted, and goes on without an
  // included action left; the limit and the trial still stop it.
  const stop = await adAdmissionStop(workspaceId, {
    admitted: (doc.costMicros ?? 0) > 0,
  });
  if (stop) return { refused: stop };
  const renderNo = doc.renderNo + 1;
  const updated = await ProductAd.findOneAndUpdate(
    { _id: adId, workspaceId, status: "failed", renderNo: doc.renderNo },
    {
      $set: {
        status: "making",
        step: null,
        errorCode: null,
        errorMessage: null,
        renderNo,
        requestedAt: params.now ?? new Date(),
        startedAt: null,
        readyAt: null,
      },
    },
    { new: true }
  ).lean<IProductAd | null>();
  if (!updated) {
    const current = await findAd(workspaceId, adId);
    if (!current) return { refused: "ad_not_found" };
    return { ad: await adRecord(workspaceId, current), started: false };
  }
  try {
    const workflowId = await startAdRun(workspaceId, adId, renderNo, "make");
    return {
      ad: await adRecord(workspaceId, { ...updated, workflowId }),
      started: true,
    };
  } catch (error) {
    logger.error("[Products] ad retry start failed", error, {
      event: "products.ad_retry_start_failed",
      workspaceId,
      adId,
      renderNo,
    });
    await ProductAd.updateOne(
      { _id: adId, workspaceId, renderNo },
      {
        $set: {
          status: "failed",
          errorCode: "failed",
          errorMessage: "The ad's run couldn't be started",
        },
      }
    );
    throw error;
  }
}
