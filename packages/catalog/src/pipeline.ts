import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bestMask, segmentImage, type MetaClient } from "@vitrina/meta";
import { cutOut, sharpestImage } from "./images.ts";
import { readInventory, type InventoryItem } from "./inventory.ts";
import { extractFrames, prepareVideo } from "./media.ts";
import { transcribe, type SpeechProvider } from "./speech.ts";

const WINDOW_S = 1; // look for the sharpest frame this far either side of the clearest moment
const SAMPLE_FPS = 10;
const CUT_CONCURRENCY = 3;

export interface CatalogProduct extends InventoryItem {
  /** Problems found by our own checks, on top of the model's `doubt`. */
  readonly checks: readonly string[];
  readonly framePath: string;
  readonly frameTimeS: number;
  /** Transparent PNG of the product, or null when SAM found nothing; then the frame stands in. */
  readonly cutoutPath: string | null;
  readonly samConfidence: number | null;
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
  const products = await mapWithConcurrency(inventory.items, CUT_CONCURRENCY, async (item, index) => {
    const slug = `${String(index + 1).padStart(2, "0")}-${item.sam_phrase.replaceAll(/\W+/g, "-").toLowerCase()}`;
    const frames = await extractFrames(
      prepared.video,
      item.clearest_moment_s - WINDOW_S,
      item.clearest_moment_s + WINDOW_S,
      SAMPLE_FPS,
      join(workDir, "frames", slug),
    );
    const frame = await sharpestImage(frames.map((f) => f.path));
    const segmentation = await segmentImage(meta, {
      imageUrl: `data:image/jpeg;base64,${readFileSync(frame.path).toString("base64")}`,
      concept: item.sam_phrase,
    });
    const mask = bestMask(segmentation.records);
    const cutoutPath = mask ? join(workDir, `${slug}.png`) : null;
    if (mask && cutoutPath) await cutOut(frame.path, mask, cutoutPath);
    const checks = checkItem(item, transcript);
    if (!mask) checks.push("The product couldn't be cut out of the video, so the whole frame is shown.");
    onProgress?.({ stage: "cutting", done: ++cut, total: inventory.items.length });
    return {
      ...item,
      checks,
      framePath: frame.path,
      frameTimeS: frames.find((f) => f.path === frame.path)?.timeS ?? item.clearest_moment_s,
      cutoutPath,
      samConfidence: mask?.confidence ?? null,
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
