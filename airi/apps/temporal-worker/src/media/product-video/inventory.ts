import { readFile } from "node:fs/promises";
import { estimateLlmCostUsd } from "@icecore/airi-runtime/llm-pricing";
import {
  createMetaResponse,
  deleteMetaFile,
  getMetaModels,
  MetaModelApiError,
  metaResponseText,
  uploadMetaFile,
  type MetaRequestOptions,
} from "@icecore/airi-runtime/meta-model-api";
import { whilePulsing } from "./pulse";

// Muse Spark watches the silent video with the owner's transcript as text and
// lists the products. Its answer is then checked in code, not trusted: every
// price must come with words the owner actually said.

export type InventoryItem = {
  /** Short catalog name in English. */
  name: string;
  /** The owner's own name for it, in the language they spoke. */
  localName: string;
  category: string;
  /** Specific English noun phrase for SAM, e.g. "pink toy phone". */
  samPhrase: string;
  price: number | null;
  currency: string | null;
  /** The transcript words the price comes from, verbatim. */
  priceQuote: string | null;
  firstSeenSeconds: number;
  clearestMomentSeconds: number;
  /** What the owner should confirm, from the model. */
  doubt: string | null;
};

export type ProductInventory = {
  language: string;
  items: InventoryItem[];
};

export type InventoryDeps = {
  createMetaResponse?: typeof createMetaResponse;
  uploadMetaFile?: typeof uploadMetaFile;
  deleteMetaFile?: typeof deleteMetaFile;
  onCost?: (usd: number, what: string) => void;
  pulse?: () => void;
};

// Reasoning shares this budget with the answer; 60 products need about 7,000
// tokens of JSON.
const MAX_OUTPUT_TOKENS = 24_000;

const nullable = (type: string) => ({ type: [type, "null"] });

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["language", "items"],
  properties: {
    language: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "name",
          "local_name",
          "category",
          "sam_phrase",
          "price",
          "currency",
          "price_quote",
          "first_seen_s",
          "clearest_moment_s",
          "doubt",
        ],
        properties: {
          name: { type: "string" },
          local_name: { type: "string" },
          category: { type: "string" },
          sam_phrase: { type: "string" },
          price: nullable("number"),
          currency: nullable("string"),
          price_quote: nullable("string"),
          first_seen_s: { type: "number" },
          clearest_moment_s: { type: "number" },
          doubt: nullable("string"),
        },
      },
    },
  },
};

export function inventoryPrompt(transcript: string): string {
  return `A shop owner filmed their products. The video has no sound. Below is a transcript of what they said, from a dedicated speech model, with each sentence's start time in seconds. Trust it for names and prices; use the video to see the products and when each one is shown.

Transcript:
${transcript.trim() || "(the owner said nothing)"}

List every distinct product the owner presents, in the order presented. Merge repeated sightings of the same item. Ignore background objects the owner does not present.
For each product:
- name: a short catalog name in English.
- local_name: the owner's own name for it, in the language they used.
- category: one or two English words.
- sam_phrase: a short, specific English noun phrase that picks out this item and not the others in view, for a segmentation model (for example "pink toy phone"). No lists, no negation.
- price and currency: the price of one item as a number, with an ISO currency code. Use KZT for теңге or тенге, and also when the owner says a number without a currency. If several prices are said for it (an old and a new price, per piece and per pack), use the price a buyer pays for one item now and explain in doubt. If one price is said for a group of products, give it to each and explain in doubt. null if no price was said for it.
- price_quote: the exact words from the transcript that state this item's price, copied verbatim; null if no price.
- first_seen_s: when the owner starts presenting it.
- clearest_moment_s: when it is most clearly visible, held still and in focus.
- doubt: if the owner should confirm something (an unusual currency, an unclear number, a price that might belong to another item, a name that doesn't match what is shown), say what in one short English sentence; otherwise null.
language: the language the owner spoke.`;
}

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";
const optionalText = (value: unknown, max: number): string | null =>
  text(value, max) || null;
const seconds = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

/** The model's JSON as typed items; malformed or nameless items are dropped. */
export function parseInventory(raw: string): ProductInventory {
  let json: { language?: unknown; items?: unknown };
  try {
    json = JSON.parse(raw) as typeof json;
  } catch {
    throw new MetaModelApiError({
      kind: "server",
      transient: true,
      code: "invalid_json",
      message: "Muse Spark's product list wasn't valid JSON",
    });
  }
  const items = Array.isArray(json.items) ? json.items : [];
  return {
    language: text(json.language, 40),
    items: items.flatMap((entry): InventoryItem[] => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as Record<string, unknown>;
      const name = text(item.name, 160);
      if (!name) return [];
      const price =
        typeof item.price === "number" &&
        Number.isFinite(item.price) &&
        item.price >= 0
          ? item.price
          : null;
      return [
        {
          name,
          localName: text(item.local_name, 160) || name,
          category: text(item.category, 60),
          samPhrase: text(item.sam_phrase, 80) || name,
          price,
          currency: price === null ? null : optionalText(item.currency, 8),
          priceQuote:
            price === null ? null : optionalText(item.price_quote, 300),
          firstSeenSeconds: seconds(item.first_seen_s),
          clearestMomentSeconds: seconds(item.clearest_moment_s),
          doubt: optionalText(item.doubt, 300),
        },
      ];
    }),
  };
}

/**
 * Uploads the prepared, silent video, asks Muse Spark for its products and
 * deletes the upload again: shop footage shouldn't stay on Meta's servers.
 */
export async function readProductInventory(
  request: { videoPath: string; transcript: string },
  deps: InventoryDeps = {},
  options?: MetaRequestOptions,
): Promise<ProductInventory> {
  const model = getMetaModels().museSpark;
  const { id } = await whilePulsing(deps.pulse, async () =>
    (deps.uploadMetaFile ?? uploadMetaFile)(
      {
        data: await readFile(request.videoPath),
        filename: "video.mp4",
        mimeType: "video/mp4",
      },
      options,
    ),
  );
  try {
    const response = await whilePulsing(deps.pulse, () =>
      (deps.createMetaResponse ?? createMetaResponse)(
        {
          model,
          input: [
            {
              type: "message",
              role: "user",
              content: [
                { type: "input_video", file_id: id },
                {
                  type: "input_text",
                  text: inventoryPrompt(request.transcript),
                },
              ],
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: "shop_inventory",
              strict: true,
              schema: SCHEMA,
            },
          },
          max_output_tokens: MAX_OUTPUT_TOKENS,
        },
        options,
      ),
    );
    deps.onCost?.(
      estimateLlmCostUsd({
        model,
        promptTokens: response.usage?.input_tokens,
        completionTokens: response.usage?.output_tokens,
        cachedPromptTokens: response.usage?.input_tokens_details?.cached_tokens,
      }).totalCostUsd,
      "inventory",
    );
    return parseInventory(metaResponseText(response));
  } finally {
    // It also expires by itself within a day if this fails.
    await (deps.deleteMetaFile ?? deleteMetaFile)(id).catch(() => undefined);
  }
}

// Spaces inside numbers go ("5 000" → "5000"), so a quote and the transcript
// compare however Scribe grouped the digits.
const normalizeText = (value: string) =>
  value
    .toLowerCase()
    .replaceAll(/(?<=\d)[\s .,](?=\d{3}\b)/g, "")
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Whether a quote the model claims to have copied really occurs in the transcript. */
export function quoteInTranscript(quote: string, transcript: string): boolean {
  const needle = normalizeText(quote);
  return needle !== "" && normalizeText(transcript).includes(needle);
}

/** The numbers written with digits in a quote; spoken numbers have none. */
function quotedNumbers(quote: string): number[] {
  return (normalizeText(quote).match(/\d+/g) ?? []).map(Number);
}

/**
 * Problems for the owner to confirm about each product, from our own checks
 * on top of the model's doubt, in the same order as `items`.
 */
export function inventoryChecks(
  items: InventoryItem[],
  transcript: string,
): string[][] {
  const quoteUses = new Map<string, number>();
  for (const item of items) {
    if (item.price === null || !item.priceQuote) continue;
    const key = normalizeText(item.priceQuote);
    quoteUses.set(key, (quoteUses.get(key) ?? 0) + 1);
  }
  return items.map((item) => {
    const checks: string[] = [];
    if (item.price === null) {
      checks.push("No price was said for this product.");
      return checks;
    }
    if (!item.priceQuote || !quoteInTranscript(item.priceQuote, transcript)) {
      checks.push("This price doesn't match anything in the narration.");
    } else {
      const numbers = quotedNumbers(item.priceQuote);
      if (numbers.length > 0 && !numbers.includes(item.price))
        checks.push("The price differs from the number in the narration.");
      if ((quoteUses.get(normalizeText(item.priceQuote)) ?? 0) > 1)
        checks.push("Another product's price comes from the same words.");
    }
    if (item.currency !== "KZT")
      checks.push(
        `The price is in ${item.currency ?? "an unknown currency"}, not tenge.`,
      );
    return checks;
  });
}

const MIN_WINDOW_SECONDS = 2;
const MAX_WINDOW_SECONDS = 16;

/**
 * The stretch of video in which each product is presented: from when it first
 * appears until the next product does, kept between 2 and 16 seconds and
 * always including its clearest moment.
 */
export function presentationWindows(
  items: Pick<InventoryItem, "firstSeenSeconds" | "clearestMomentSeconds">[],
  durationSeconds: number,
): Array<{ fromSeconds: number; toSeconds: number }> {
  const order = items
    .map((item, index) => ({ index, start: item.firstSeenSeconds }))
    .sort((a, b) => a.start - b.start);
  const windows: Array<{ fromSeconds: number; toSeconds: number }> = new Array(
    items.length,
  );
  // A window of `length` seconds around `center`, inside the video.
  const around = (center: number, length: number) => {
    const fromSeconds = Math.max(
      0,
      Math.min(center - length / 2, durationSeconds - length),
    );
    return {
      fromSeconds,
      toSeconds: Math.min(durationSeconds, fromSeconds + length),
    };
  };
  order.forEach(({ index, start }, k) => {
    const clearest = Math.min(
      durationSeconds,
      Math.max(0, items[index]!.clearestMomentSeconds),
    );
    let window = {
      fromSeconds: Math.max(0, Math.min(start, durationSeconds)),
      toSeconds: Math.min(
        durationSeconds,
        order[k + 1]?.start ?? durationSeconds,
      ),
    };
    const length = window.toSeconds - window.fromSeconds;
    if (length < MIN_WINDOW_SECONDS) {
      window = around(clearest, MIN_WINDOW_SECONDS);
    } else if (clearest < window.fromSeconds || clearest > window.toSeconds) {
      // Its clearest moment came after the next product appeared.
      window = around(clearest, Math.min(length, MAX_WINDOW_SECONDS));
    } else if (length > MAX_WINDOW_SECONDS) {
      const fromSeconds = Math.max(
        window.fromSeconds,
        Math.min(
          clearest - MAX_WINDOW_SECONDS / 2,
          window.toSeconds - MAX_WINDOW_SECONDS,
        ),
      );
      window = { fromSeconds, toSeconds: fromSeconds + MAX_WINDOW_SECONDS };
    }
    windows[index] = window;
  });
  return windows;
}
