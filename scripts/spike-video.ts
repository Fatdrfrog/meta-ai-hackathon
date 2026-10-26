// Spike: can Muse Spark list a shop's products from one phone video, with prices heard in
// Russian or Kazakh narration? Run: pnpm spike:video <video>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMetaClient, loadConfig, openSpendLedger, outputText } from "@vitrina/meta";
import { normalizeVideo } from "./video-tools.ts";

const SPIKE_DIR = ".data/spikes";

const [videoPath] = process.argv.slice(2);
if (!videoPath) {
  console.error("Usage: pnpm spike:video <shop-video.mp4|.mov>");
  process.exit(1);
}

interface Product {
  name: string;
  category: string;
  colors: string[];
  visible_text: string | null;
  spoken_price: number | null;
  currency: string | null;
  spoken_quote: string | null;
  first_seen_s: number;
  last_seen_s: number;
}

interface Inventory {
  narration_language: string;
  narration_transcript: string;
  products: Product[];
  sam_concepts: string[];
}

const nullable = (type: string) => ({ type: [type, "null"] });

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["narration_language", "narration_transcript", "products", "sam_concepts"],
  properties: {
    narration_language: { type: "string" },
    narration_transcript: { type: "string" },
    products: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "category", "colors", "visible_text", "spoken_price", "currency", "spoken_quote", "first_seen_s", "last_seen_s"],
        properties: {
          name: { type: "string" },
          category: { type: "string" },
          colors: { type: "array", items: { type: "string" } },
          visible_text: nullable("string"),
          spoken_price: nullable("number"),
          currency: nullable("string"),
          spoken_quote: nullable("string"),
          first_seen_s: { type: "number" },
          last_seen_s: { type: "number" },
        },
      },
    },
    sam_concepts: { type: "array", items: { type: "string" } },
  },
};

const PROMPT = `A shop owner is filming their products and may say names and prices out loud in Russian or Kazakh.
List every distinct product you can see. Merge repeated sightings of the same physical item into one entry.
Give a price only if you heard it said or read it on a tag, and quote the exact words you heard.
Transcribe the narration in its original language.
Finally, suggest 1 to 3 short English noun phrases (for example "medal" or "trophy") that a segmentation model could use to find these products in the video.`;

const config = loadConfig();
const client = createMetaClient(config, openSpendLedger(config.ledgerPath, config.budgetUsd));

const mp4 = await normalizeVideo(videoPath, SPIKE_DIR);
const file = await client.uploadFile(mp4, "video/mp4");
console.log(`Uploaded ${mp4} as file ${file.id}`);

const response = await client.createResponse({
  model: config.models.spark,
  input: [
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_video", file_id: file.id },
        { type: "input_text", text: PROMPT },
      ],
    },
  ],
  text: { format: { type: "json_schema", name: "shop_inventory", strict: true, schema } },
  max_output_tokens: 8000,
});

const inventory = JSON.parse(outputText(response)) as Inventory;
const outPath = join(SPIKE_DIR, `${Date.now()}-video.json`);
writeFileSync(outPath, `${JSON.stringify({ fileId: file.id, model: config.models.spark, usage: response.usage, inventory }, null, 2)}\n`);

console.log(`Narration (${inventory.narration_language}): ${inventory.narration_transcript}`);
console.table(
  inventory.products.map((p) => ({
    name: p.name,
    category: p.category,
    price: p.spoken_price === null ? "-" : `${p.spoken_price} ${p.currency ?? ""}`,
    seen: `${p.first_seen_s}-${p.last_seen_s}s`,
    heard: p.spoken_quote ?? "",
  })),
);
console.log(`SAM concepts to try: ${inventory.sam_concepts.join(", ")}`);
console.log(`Saved ${outPath}. Next: pnpm spike:sam ${videoPath} "<concept>" --file-id=${file.id}`);
console.log(`Estimated spend so far: $${client.ledger.totalUsd().toFixed(4)} of $${client.ledger.limitUsd}`);
