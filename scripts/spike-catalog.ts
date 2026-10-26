// Spike v2: video to catalog cut-outs for about $0.07 a minute of video.
// One Muse Spark call understands the whole video. For each product, the sharpest local frame
// around its clearest moment goes to SAM 3.1 as a single image ($0.0025), and the best mask
// becomes a transparent cut-out. Run: pnpm spike:catalog <video> [--file-id=<id>]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bestMask, createMetaClient, loadConfig, openSpendLedger, outputText, segmentImage } from "@vitrina/meta";
import { contactSheet, cutOut, sharpestImage } from "./image-tools.ts";
import { extractFrames, normalizeVideo } from "./video-tools.ts";

const SPIKE_DIR = ".data/spikes";
const WINDOW_S = 1; // search this far either side of the clearest moment
const SAMPLE_FPS = 10;

const args = process.argv.slice(2);
const [videoPath] = args.filter((arg) => !arg.startsWith("--"));
const fileIdArg = args.find((arg) => arg.startsWith("--file-id="))?.slice("--file-id=".length);
if (!videoPath) {
  console.error("Usage: pnpm spike:catalog <shop-video.mp4|.mov> [--file-id=<id>]");
  process.exit(1);
}

interface Product {
  name: string;
  category: string;
  sam_phrase: string;
  spoken_price: number | null;
  currency: string | null;
  spoken_quote: string | null;
  first_seen_s: number;
  clearest_moment_s: number;
  doubt: string | null;
}

interface Inventory {
  narration_language: string;
  narration_transcript: string;
  products: Product[];
}

const nullable = (type: string) => ({ type: [type, "null"] });

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["narration_language", "narration_transcript", "products"],
  properties: {
    narration_language: { type: "string" },
    narration_transcript: { type: "string" },
    products: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "category", "sam_phrase", "spoken_price", "currency", "spoken_quote", "first_seen_s", "clearest_moment_s", "doubt"],
        properties: {
          name: { type: "string" },
          category: { type: "string" },
          sam_phrase: { type: "string" },
          spoken_price: nullable("number"),
          currency: nullable("string"),
          spoken_quote: nullable("string"),
          first_seen_s: { type: "number" },
          clearest_moment_s: { type: "number" },
          doubt: nullable("string"),
        },
      },
    },
  },
};

const PROMPT = `A shop owner is filming their products and may say names and prices out loud in Russian or Kazakh.
List every distinct product the owner presents. Merge repeated sightings of the same physical item into one entry.
Ignore things in the background that the owner does not present.
For each product:
- name: a short catalog name in English.
- sam_phrase: a short, specific English noun phrase that picks out this item and not the others in view, for a segmentation model (for example "pink toy phone" or "rooster figurine"). No lists, no negation.
- spoken_price and currency: only if you heard the price said or read it on a tag; quote the exact words in spoken_quote.
- first_seen_s: when the owner starts presenting it.
- clearest_moment_s: the moment it is most clearly visible, held still and in focus, ideally while it is being named.
- doubt: if the owner should confirm something (an unusual currency, an unclear number, a toy versus a real item), say what in one short sentence; otherwise null.
Transcribe the narration in its original language.`;

const config = loadConfig();
const client = createMetaClient(config, openSpendLedger(config.ledgerPath, config.budgetUsd));
const seconds = (since: number) => ((Date.now() - since) / 1000).toFixed(1);

const mp4 = await normalizeVideo(videoPath, SPIKE_DIR);
const fileId = fileIdArg ?? (await client.uploadFile(mp4, "video/mp4")).id;

let started = Date.now();
const response = await client.createResponse({
  model: config.models.spark,
  input: [
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_video", file_id: fileId },
        { type: "input_text", text: PROMPT },
      ],
    },
  ],
  text: { format: { type: "json_schema", name: "shop_inventory", strict: true, schema } },
  max_output_tokens: 8000,
});
const inventory = JSON.parse(outputText(response)) as Inventory;
console.log(`Muse Spark: ${inventory.products.length} products in ${seconds(started)}s (${inventory.narration_language})`);

const runDir = join(SPIKE_DIR, `${Date.now()}-catalog`);
const results = [];
for (const [i, product] of inventory.products.entries()) {
  started = Date.now();
  const slug = `${String(i + 1).padStart(2, "0")}-${product.sam_phrase.replaceAll(/\W+/g, "-")}`;
  const frames = await extractFrames(
    mp4,
    product.clearest_moment_s - WINDOW_S,
    product.clearest_moment_s + WINDOW_S,
    SAMPLE_FPS,
    join(runDir, slug),
  );
  const frame = await sharpestImage(frames.map((f) => f.path));
  const segmentation = await segmentImage(client, {
    imageUrl: `data:image/jpeg;base64,${readFileSync(frame.path).toString("base64")}`,
    concept: product.sam_phrase,
  });
  if (segmentation.outcome.status !== "completed") console.warn(`${product.name}: SAM ended early`, segmentation.outcome);
  const mask = bestMask(segmentation.records);
  const cutoutPath = join(runDir, `${slug}.png`);
  if (mask) await cutOut(frame.path, mask, cutoutPath);
  results.push({
    product,
    frame: frame.path,
    frameTimeS: frames.find((f) => f.path === frame.path)?.timeS,
    sharpness: frame.sharpness,
    matches: segmentation.records.filter((r) => r.kind === "mask").length,
    confidence: mask?.confidence ?? null,
    cutout: mask ? cutoutPath : null,
    seconds: Number(seconds(started)),
  });
}

const sheetPath = join(runDir, "contact-sheet.png");
await contactSheet(
  results.map((r) => ({
    path: r.cutout ?? r.frame,
    lines: [
      `${r.product.name}${r.cutout ? "" : " (no SAM match)"}`,
      `${r.product.spoken_price === null ? "no price" : `${r.product.spoken_price} ${r.product.currency ?? ""}`}${r.product.doubt ? "  ⚠ confirm" : ""}`,
    ],
  })),
  sheetPath,
);
writeFileSync(join(runDir, "result.json"), `${JSON.stringify({ fileId, usage: response.usage, inventory, results }, null, 2)}\n`);

console.table(
  results.map((r) => ({
    product: r.product.name,
    phrase: r.product.sam_phrase,
    price: r.product.spoken_price === null ? "-" : `${r.product.spoken_price} ${r.product.currency ?? ""}`,
    at: `${r.frameTimeS?.toFixed(1)}s`,
    sharp: r.sharpness.toFixed(1),
    matches: r.matches,
    conf: r.confidence?.toFixed(2) ?? "-",
    doubt: r.product.doubt ?? "",
  })),
);
console.log(`Contact sheet: ${sheetPath}`);
console.log(`Estimated spend so far: $${client.ledger.totalUsd().toFixed(4)} of $${client.ledger.limitUsd}`);
