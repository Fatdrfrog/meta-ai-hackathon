import { join } from "node:path";
import type { MetaClient } from "@vitrina/meta";
import { cutOutProduct, type CutoutMethod } from "./cutout.ts";
import { readInventory, type InventoryItem } from "./inventory.ts";
import { prepareVideo } from "./media.ts";
import { transcribe, type SpeechProvider } from "./speech.ts";

// Each product takes 35-50 s of mostly waiting on Meta, so most of a shop video runs at once.
const CUT_CONCURRENCY = 6;
const MIN_WINDOW_S = 2;
const MAX_WINDOW_S = 16;

export interface CatalogProduct extends InventoryItem {
  /** Problems found by our own checks, on top of the model's `doubt`. */
  readonly checks: readonly string[];
  readonly framePath: string;
  readonly frameTimeS: number;
  /** Transparent PNG of the product, or null when SAM found nothing; then the frame stands in. */
  readonly cutoutPath: string | null;
  readonly samConfidence: number | null;
  readonly cutoutMethod: CutoutMethod;
}

/**
 * The stretch of video in which each product is presented: from when it first appears until the
 * next product does, kept between 2 and 16 seconds around its clearest moment.
 */
export function presentationWindows(
  items: readonly Pick<InventoryItem, "first_seen_s" | "clearest_moment_s">[],
  durationS: number,
): { fromS: number; toS: number }[] {
  const order = items.map((item, index) => ({ index, start: item.first_seen_s })).sort((a, b) => a.start - b.start);
  const windows: { fromS: number; toS: number }[] = new Array(items.length);
  order.forEach(({ index, start }, k) => {
    const clearest = Math.min(durationS, Math.max(0, items[index]!.clearest_moment_s));
    let fromS = Math.max(0, start);
    let toS = Math.min(durationS, order[k + 1]?.start ?? durationS);
    if (toS - fromS < MIN_WINDOW_S) {
      fromS = Math.max(0, clearest - MIN_WINDOW_S / 2);
      toS = Math.min(durationS, fromS + MIN_WINDOW_S);
    }
    if (toS - fromS > MAX_WINDOW_S) {
      fromS = Math.max(fromS, Math.min(clearest - MAX_WINDOW_S / 2, toS - MAX_WINDOW_S));
      toS = fromS + MAX_WINDOW_S;
    }
    windows[index] = { fromS, toS };
  });
  return windows;
}

export interface CatalogResult {
  readonly transcript: string;
  readonly language: string;
  readonly products: readonly CatalogProduct[];
  readonly spentUsd: number;
  readonly seconds: Readonly<Record<"prepare" | "listen" | "watch" | "cut", number>>;
}

export type Progress =
  | { readonly stage: "preparing" | "listening" | "watching" }
  | { readonly stage: "cutting"; readonly done: number; readonly total: number };

export interface BuildCatalogOptions {
  readonly sourcePath: string;
  /** Where intermediate files and cut-outs are written. */
  readonly workDir: string;
  readonly meta: MetaClient;
  readonly speech: SpeechProvider;
  readonly onProgress?: (progress: Progress) => void;
}

const normalizeText = (text: string) =>
  text
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Whether a quote the model claims to have copied really occurs in the transcript. */
export function quoteInTranscript(quote: string, transcript: string): boolean {
  const needle = normalizeText(quote);
  return needle !== "" && normalizeText(transcript).includes(needle);
}

// The model's answer is checked against the transcript instead of trusted: a price must come
// with words the owner actually said.
export function checkItem(item: InventoryItem, transcript: string): string[] {
  const checks: string[] = [];
  if (item.price === null) checks.push("No price was said for this item.");
  else if (!item.price_quote || !quoteInTranscript(item.price_quote, transcript)) {
    checks.push("This price doesn't match anything in the narration.");
  }
  if (item.price !== null && item.currency !== "KZT") checks.push(`The price is in ${item.currency ?? "an unknown currency"}, not tenge.`);
  return checks;
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function buildCatalog(options: BuildCatalogOptions): Promise<CatalogResult> {
  const { meta, workDir, onProgress } = options;
  const spentBefore = meta.ledger.totalUsd();
  const timer = () => {
    const started = Date.now();
    return () => (Date.now() - started) / 1000;
  };

  onProgress?.({ stage: "preparing" });
  let elapsed = timer();
  const prepared = await prepareVideo(options.sourcePath, workDir);
  const prepareS = elapsed();

  onProgress?.({ stage: "listening" });
  elapsed = timer();
  const [transcript, upload] = await Promise.all([
    transcribe(options.speech, prepared.audio, prepared.durationS, meta.ledger),
    meta.uploadFile(prepared.video, "video/mp4"),
  ]);
  const listenS = elapsed();

  onProgress?.({ stage: "watching" });
  elapsed = timer();
  const { inventory } = await readInventory(meta, upload.id, transcript);
  const watchS = elapsed();

  elapsed = timer();
  let cut = 0;
  onProgress?.({ stage: "cutting", done: 0, total: inventory.items.length });
  const windows = presentationWindows(inventory.items, prepared.durationS);
  const products = await mapWithConcurrency(inventory.items, CUT_CONCURRENCY, async (item, index): Promise<CatalogProduct> => {
    const slug = `${String(index + 1).padStart(2, "0")}-${item.sam_phrase.replaceAll(/\W+/g, "-").toLowerCase()}`;
    const cutout = await cutOutProduct({
      meta,
      videoPath: prepared.video,
      ...windows[index]!,
      product: item.sam_phrase,
      workDir: join(workDir, "products", slug),
      outPath: join(workDir, `${slug}.png`),
    });
    const checks = checkItem(item, transcript);
    if (cutout.method === "none") checks.push("The product couldn't be cut out of the video, so the whole frame is shown.");
    onProgress?.({ stage: "cutting", done: ++cut, total: inventory.items.length });
    return {
      ...item,
      checks,
      framePath: cutout.framePath,
      frameTimeS: cutout.frameTimeS,
      cutoutPath: cutout.cutoutPath,
      samConfidence: cutout.confidence,
      cutoutMethod: cutout.method,
    };
  });

  return {
    transcript,
    language: inventory.language,
    products,
    spentUsd: meta.ledger.totalUsd() - spentBefore,
    seconds: { prepare: prepareS, listen: listenS, watch: watchS, cut: elapsed() },
  };
}
