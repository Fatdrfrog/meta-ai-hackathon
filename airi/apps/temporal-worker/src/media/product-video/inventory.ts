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
import {
  PRODUCT_PRICE_SOURCES,
  type ProductPriceSource,
} from "@icecore/temporal";
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
  /** The transcript words the price comes from, or the text shown on screen, verbatim. */
  priceQuote: string | null;
  /**
   * When the narration's sentence the price was said in starts, as the
   * transcript times it; null for a price on screen or no price.
   */
  priceQuoteSeconds: number | null;
  /** Null when there is no price. */
  priceSource: ProductPriceSource | null;
  /** A starting price ("from 15 500"): the final one depends on options. */
  priceIsFrom: boolean;
  firstSeenSeconds: number;
  clearestMomentSeconds: number;
  /** What the owner should confirm, from the model. */
  doubt: string | null;
};

export type ProductInventory = {
  language: string;
  items: InventoryItem[];
  /** A person who presents the products facing the camera, or null. */
  presenter: { clearestMomentSeconds: number } | null;
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
  required: ["language", "items", "presenter"],
  properties: {
    language: { type: "string" },
    presenter: {
      type: "object",
      additionalProperties: false,
      required: ["present", "clearest_moment_s"],
      properties: {
        present: { type: "boolean" },
        clearest_moment_s: { type: "number" },
      },
    },
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
          "price_quote_s",
          "price_source",
          "price_is_from",
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
          price_quote_s: { type: "number" },
          price_source: {
            type: "string",
            enum: [...PRODUCT_PRICE_SOURCES, "none"],
          },
          price_is_from: { type: "boolean" },
          first_seen_s: { type: "number" },
          clearest_moment_s: { type: "number" },
          doubt: nullable("string"),
        },
      },
    },
  },
};

export function inventoryPrompt(transcript: string): string {
  return `A shop made this video to show the products it sells. It may be a plain video of products held up to the camera or standing on a shelf, or an edited promo with cuts, a presenter talking to the camera, products shown on screen behind them, captions and price stickers. The video has no sound. Below is a transcript of what was said, from a dedicated speech model, with each sentence's start time in seconds. Trust it for names and prices; use the video to see the products and when each one is shown.

Transcript:
${transcript.trim() || "(nothing was said)"}

List every distinct product offered for sale, in the order shown, whether held, standing or shown on screen. Merge repeated sightings of the same item. When one kind of product is shown in several designs (several family-tree panels, several clocks), list each design that is clearly shown as its own product, with the price said for that kind. Ignore objects nobody offers: background items, the presenter's clothes, and furniture or decor that isn't for sale.
For each product:
- name: a short catalog name in English.
- local_name: the shop's own name for it, in the language spoken (or written on screen, if nothing was said).
- category: one or two English words.
- sam_phrase: a short, specific English noun phrase that picks out this item and not the others in view, for a segmentation model (for example "pink toy phone"). No lists, no negation.
- price and currency: the price of one item as a number, with an ISO currency code. Use KZT for теңге or тенге, and also for a number without a currency. If several prices are said for it (an old and a new price, per piece and per pack), use the price a buyer pays for one item now and explain in doubt. If one price is said for a group of products, give it to each and explain in doubt. If no price is said for it but one is written on screen for it (a caption, a sticker, a tag), use that. If what is said and what is written disagree, use what is said and explain in doubt. null if there is no price.
- price_quote: the exact words from the transcript that state this item's price, copied verbatim; for a price that is only written on screen, the text exactly as written; null if no price.
- price_quote_s: the start time of the transcript line the spoken price is quoted from, exactly as written in its brackets; -1 for a price only written on screen, or no price.
- price_source: spoken, on_screen (only written in the video), or none when there is no price.
- price_is_from: true when it is a starting price ("from", "starting at", "от", "бастап"), because the final price depends on options or personalisation; otherwise false.
- first_seen_s: when it is first shown.
- clearest_moment_s: when it is most clearly visible: whole, in focus, and least covered by hands, people or captions.
- doubt: if the shop should confirm something (an unusual currency, an unclear number, a price that might belong to another item, a name that doesn't match what is shown), say what in one short English sentence; otherwise null.
presenter: whether a person presents the products while facing the camera (more than just their hands). If so, present is true and clearest_moment_s is when their face and upper body are most clearly in view, least covered by products or captions; otherwise present is false and clearest_moment_s is 0.
language: the language spoken, or written on screen if nothing was said.`;
}

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";
const optionalText = (value: unknown, max: number): string | null =>
  text(value, max) || null;
const seconds = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

/** The model's JSON as typed items; malformed or nameless items are dropped. */
export function parseInventory(raw: string): ProductInventory {
  let json: { language?: unknown; items?: unknown; presenter?: unknown };
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
  const presenter =
    json.presenter && typeof json.presenter === "object"
      ? (json.presenter as Record<string, unknown>)
      : null;
  return {
    language: text(json.language, 40),
    presenter:
      presenter?.present === true
        ? { clearestMomentSeconds: seconds(presenter.clearest_moment_s) }
        : null,
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
          priceQuoteSeconds:
            price !== null &&
            typeof item.price_quote_s === "number" &&
            Number.isFinite(item.price_quote_s) &&
            item.price_quote_s >= 0
              ? item.price_quote_s
              : null,
          // A price with no believable source is held to the stricter,
          // spoken check.
          priceSource:
            price === null
              ? null
              : item.price_source === "on_screen"
                ? "on_screen"
                : "spoken",
          priceIsFrom: price !== null && item.price_is_from === true,
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

/** The narration's timed sentences, from its "[7.5] text" lines. */
function timedSentences(
  transcript: string,
): Array<{ at: number; text: string }> {
  return transcript.split(/\r?\n/).flatMap((line) => {
    const match = /^\[(\d+(?:\.\d+)?)\]\s*(.*)$/.exec(line.trim());
    return match ? [{ at: Number(match[1]), text: match[2]! }] : [];
  });
}

/**
 * Where in the narration a spoken quote comes from, as a key two products
 * share only when their prices come from the same words in the same
 * sentence; null when the quote isn't in the narration. A shop that says
 * "from 15 500" twice, of different products, uses those words twice.
 */
function spokenQuoteSource(
  quote: string,
  atSeconds: number | null,
  transcript: string,
): string | null {
  const needle = normalizeText(quote);
  if (!needle) return null;
  const sentence =
    atSeconds === null
      ? undefined
      : timedSentences(transcript).find(
          (candidate) => Math.abs(candidate.at - atSeconds) < 0.05,
        );
  if (sentence && normalizeText(sentence.text).includes(needle))
    return `${sentence.at}|${needle}`;
  return quoteInTranscript(quote, transcript) ? needle : null;
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
  const sources = items.map((item) => {
    if (item.price === null || !item.priceQuote) return null;
    return item.priceSource === "on_screen"
      ? `screen|${normalizeText(item.priceQuote)}`
      : spokenQuoteSource(item.priceQuote, item.priceQuoteSeconds, transcript);
  });
  const quoteUses = new Map<string, number>();
  for (const source of sources) {
    if (source) quoteUses.set(source, (quoteUses.get(source) ?? 0) + 1);
  }
  return items.map((item, index) => {
    const checks: string[] = [];
    if (item.price === null) {
      checks.push("No price was said or shown for this product.");
      return checks;
    }
    const quote = item.priceQuote;
    // Text on screen has no transcript to be checked against; it is only
    // checked against itself.
    const onScreen = item.priceSource === "on_screen";
    if (onScreen) {
      checks.push(
        "This price was read from text in the video, not said aloud.",
      );
    }
    const source = sources[index];
    if (!quote || !source) {
      checks.push(
        onScreen
          ? "The video's text for this price is missing."
          : "This price doesn't match anything in the narration.",
      );
    } else {
      const numbers = quotedNumbers(quote);
      if (numbers.length > 0 && !numbers.includes(item.price))
        checks.push(
          onScreen
            ? "The price differs from the number shown in the video."
            : "The price differs from the number in the narration.",
        );
      if ((quoteUses.get(source) ?? 0) > 1)
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
