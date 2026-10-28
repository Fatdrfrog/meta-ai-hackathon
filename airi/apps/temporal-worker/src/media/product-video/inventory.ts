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
  PRODUCT_TEXT_SOURCES,
  PRODUCT_VIDEO_IMPORT_MAX_OPTIONS,
  type ProductDoubtSubject,
  type ProductTextSource,
} from "@icecore/temporal";
import { whilePulsing } from "./pulse";

// Muse Spark watches the silent video with the transcript as text and groups
// what is shown into the products the shop sells: each one name at one
// price, with the items shown for it as its options. Its answer is then
// checked in code, not trusted: every spoken price must come with words that
// were actually said.

/** One item shown for a product: a design, size or shape of it. */
export type InventoryOption = {
  /** A few English words that tell it apart from the product's other options. */
  description: string;
  /** Specific English noun phrase for SAM, e.g. "round tree-of-life panel". */
  samPhrase: string;
  firstSeenSeconds: number;
  clearestMomentSeconds: number;
};

/** One product: what a buyer orders by one name at one price. */
export type InventoryItem = {
  /** Short catalog name in English. */
  name: string;
  /** The shop's own name for it, in its own language. */
  localName: string;
  /** Whether that name was said or is only written in the video. */
  nameSource: ProductTextSource;
  category: string;
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
  priceSource: ProductTextSource | null;
  /** A starting price ("from 15 500"): the final one depends on options. */
  priceIsFrom: boolean;
  /** The items shown for it, in the order shown; empty when none was. */
  options: InventoryOption[];
  /** The option that represents the product, as an index into `options`. */
  featuredOption: number;
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

// Reasoning shares this budget with the answer; 60 options need about 7,000
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
          "name_source",
          "category",
          "price",
          "currency",
          "price_quote",
          "price_quote_s",
          "price_source",
          "price_is_from",
          "options",
          "featured_option",
          "doubt",
        ],
        properties: {
          name: { type: "string" },
          local_name: { type: "string" },
          name_source: { type: "string", enum: [...PRODUCT_TEXT_SOURCES] },
          category: { type: "string" },
          price: nullable("number"),
          currency: nullable("string"),
          price_quote: nullable("string"),
          price_quote_s: { type: "number" },
          price_source: {
            type: "string",
            enum: [...PRODUCT_TEXT_SOURCES, "none"],
          },
          price_is_from: { type: "boolean" },
          options: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "description",
                "sam_phrase",
                "first_seen_s",
                "clearest_moment_s",
              ],
              properties: {
                description: { type: "string" },
                sam_phrase: { type: "string" },
                first_seen_s: { type: "number" },
                clearest_moment_s: { type: "number" },
              },
            },
          },
          featured_option: { type: "integer" },
          doubt: nullable("string"),
        },
      },
    },
  },
};

export function inventoryPrompt(transcript: string): string {
  return `A shop made this video to show what it sells. It may be a plain video of products held up to the camera or standing on a shelf, or an edited promo with cuts, a presenter talking to the camera, products shown on screen behind them, headlines, captions and price stickers. The video has no sound. Below is a transcript of what was said, from a dedicated speech model, with times in seconds in square brackets: each sentence's start, and marks inside long sentences. Trust it for names and prices; use the video to see the items and when each one is shown.

Transcript:
${transcript.trim() || "(nothing was said)"}

Group what the video offers into the products the shop sells, in the order first shown. A product is what a buyer orders by one name at one price. Items shown under the same name and price, such as several designs, sizes or shapes of it, are that one product's options, whether they are shown one after another or several at once. Items under different names or prices are different products. When one sentence names several kinds together at one price ("panels and clocks from 15 500"), that is one product, named as said, with the items of all those kinds as its options. When the narration tells how something developed over time (what it once was, what it is today), the items shown along the way are not separate products or options: only the last one, shown as it is today, is the product's option. A product may be named aloud, or only by a headline or label written on screen over its items; a headline that names the items counts, a slogan does not. Ignore objects nobody offers: background items, the presenter's clothes, and furniture or decor that isn't for sale.
For each product:
- name: a short catalog name in English.
- local_name: the shop's own name for it, in its own language, as said or as written on screen.
- name_source: spoken, or on_screen when the name is only written in the video.
- category: one or two English words.
- price and currency: the price of one item as a number, with an ISO currency code. Use KZT for теңге or тенге, and also for a number without a currency. Only an amount a buyer pays is a price: a count (of families, customers, years) or a size is not, even when it is a big number. If several prices are said for it (an old and a new price, per piece and per pack), use the price a buyer pays for one item now and explain in doubt. If one price is said for several products, give it to each and explain in doubt. If no price is said for it but one is written on screen for it (a caption, a sticker, a tag), use that. If what is said and what is written disagree, use what is said and explain in doubt. null if there is no price.
- price_quote: the exact words from the transcript that state this product's price, copied verbatim; for a price that is only written on screen, the text exactly as written; null if no price.
- price_quote_s: the start time of the transcript line the spoken price is quoted from, exactly as written in its brackets; -1 for a price only written on screen, or no price.
- price_source: spoken, on_screen (only written in the video), or none when there is no price.
- price_is_from: true when it is a starting price ("from", "starting at", "от", "бастап"), because the final price depends on options or personalisation; otherwise false.
- options: the items shown for this product, in the order shown, at most 8; for each:
  - description: a few English words that tell it apart from the product's other options, for example "round tree-of-life panel".
  - sam_phrase: a short, specific English noun phrase that picks out this item and not the others in view, for a segmentation model (for example "pink toy phone"). No lists, no negation.
  - first_seen_s: when it is first shown.
  - clearest_moment_s: when it is most clearly visible: whole, in focus, and least covered by hands, people or captions.
- featured_option: the 0-based index of the option that best represents the product: when the narration tells how it began and what it is today, the item shown as the narration reaches today; otherwise the item the narration presents as the one for sale; otherwise the clearest and most typical one.
- doubt: if the shop should confirm something (an unusual currency, an unclear number, a price that might belong to another product, a name that doesn't match what is shown), say what in one short English sentence; otherwise null.
presenter: whether a person presents the products while facing the camera (more than just their hands). If so, present is true and clearest_moment_s is when their face and upper body are most clearly in view, least covered by products or captions; otherwise present is false and clearest_moment_s is 0.
language: the language spoken, or written on screen if nothing was said.`;
}

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";
const optionalText = (value: unknown, max: number): string | null =>
  text(value, max) || null;
const seconds = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

/** A product's options as typed items, at most PRODUCT_VIDEO_IMPORT_MAX_OPTIONS; nameless ones are dropped. */
function parseOptions(value: unknown): InventoryOption[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry): InventoryOption[] => {
      if (!entry || typeof entry !== "object") return [];
      const option = entry as Record<string, unknown>;
      const samPhrase = text(option.sam_phrase, 80);
      const description = text(option.description, 120) || samPhrase;
      if (!description) return [];
      return [
        {
          description,
          samPhrase: samPhrase || description,
          firstSeenSeconds: seconds(option.first_seen_s),
          clearestMomentSeconds: seconds(option.clearest_moment_s),
        },
      ];
    })
    .slice(0, PRODUCT_VIDEO_IMPORT_MAX_OPTIONS);
}

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
      const options = parseOptions(item.options);
      const featured = item.featured_option;
      return [
        {
          name,
          localName: text(item.local_name, 160) || name,
          nameSource: item.name_source === "on_screen" ? "on_screen" : "spoken",
          category: text(item.category, 60),
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
          options,
          featuredOption:
            typeof featured === "number" &&
            Number.isInteger(featured) &&
            featured >= 0 &&
            featured < options.length
              ? featured
              : 0,
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

/** The narration without its "[4.1]" time marks, which quotes don't copy. */
const withoutTimeMarks = (text: string) =>
  text.replaceAll(/\[\d+(?:\.\d+)?\]\s*/g, "");

/** Whether a quote the model claims to have copied really occurs in the transcript. */
export function quoteInTranscript(quote: string, transcript: string): boolean {
  const needle = normalizeText(withoutTimeMarks(quote));
  return (
    needle !== "" &&
    normalizeText(withoutTimeMarks(transcript)).includes(needle)
  );
}

/** The narration's timed sentences, from its "[7.5] text" lines. */
function timedSentences(
  transcript: string,
): Array<{ at: number; text: string }> {
  return transcript.split(/\r?\n/).flatMap((line) => {
    const match = /^\[(\d+(?:\.\d+)?)\]\s*(.*)$/.exec(line.trim());
    return match
      ? [{ at: Number(match[1]), text: withoutTimeMarks(match[2]!) }]
      : [];
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
  const needle = normalizeText(withoutTimeMarks(quote));
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
 * The stretch of video in which each item is shown: from when it first
 * appears until the next item does, kept between 2 and 16 seconds and always
 * including its clearest moment. Items are the options of all products, in
 * one list: items shown together share their stretch.
 */
export function presentationWindows(
  items: Pick<InventoryOption, "firstSeenSeconds" | "clearestMomentSeconds">[],
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

/**
 * What the model's own doubt is about. It is asked to doubt an unusual
 * currency, an unclear number, a price that may belong to another product,
 * or a name that doesn't match what is shown: a doubt that names a price, a
 * currency or a number is about the price, which the owner settles by
 * setting it; any other is about the product.
 */
export function modelDoubtSubject(doubt: string): ProductDoubtSubject {
  return /price|cost|currenc|tenge|amount|number|\d/i.test(doubt)
    ? "price"
    : "product";
}

// A product's review clip: the owner saying its price, from a little before
// the time mark the price's words start after.
const CLIP_LEAD_SECONDS = 0.3;
const MIN_CLIP_SECONDS = 2;
const MAX_CLIP_SECONDS = 6;
// Without a spoken price, this long around its featured item's clearest moment.
const SHOWN_CLIP_SECONDS = 4;

/** Each line of the narration as its pieces between time marks, in order. */
function timedPieces(
  transcript: string,
): Array<Array<{ at: number; text: string }>> {
  return transcript.split(/\r?\n/).flatMap((line) => {
    const parts = line.trim().split(/\[(\d+(?:\.\d+)?)\]\s*/);
    // A line starts with its time: ["", "1.0", "text", "2.5", "more", …].
    if (parts.length < 3 || parts[0] !== "") return [];
    const pieces: Array<{ at: number; text: string }> = [];
    for (let i = 1; i + 1 < parts.length; i += 2)
      pieces.push({ at: Number(parts[i]), text: parts[i + 1]! });
    return [pieces];
  });
}

/**
 * When the owner says a quoted price: from the time mark before its words
 * to the mark, or the next sentence, after them. The sentence is the one
 * starting at `atSeconds` when its words are in it, otherwise the nearest
 * one that has them; null when none does.
 */
function spokenQuoteWindow(
  quote: string,
  atSeconds: number | null,
  transcript: string,
): { from: number; to: number } | null {
  const needle = normalizeText(withoutTimeMarks(quote));
  if (!needle) return null;
  const lines = timedPieces(transcript);
  let best: { line: number; offset: number; distance: number } | null = null;
  for (const [line, pieces] of lines.entries()) {
    const offset = joinedText(pieces).text.indexOf(needle);
    if (offset < 0) continue;
    const distance =
      atSeconds === null ? line : Math.abs(pieces[0]!.at - atSeconds);
    if (!best || distance < best.distance) best = { line, offset, distance };
  }
  if (!best) return null;
  const { line, offset } = best;
  const pieces = lines[line]!;
  const { starts } = joinedText(pieces);
  let first = 0;
  let last = 0;
  starts.forEach((start, index) => {
    if (start <= offset) first = index;
    if (start < offset + needle.length) last = index;
  });
  const next = pieces[last + 1]?.at ?? lines[line + 1]?.[0]?.at;
  return {
    from: pieces[first]!.at,
    to: next ?? Number.POSITIVE_INFINITY,
  };
}

/** A line's pieces as one normalized text, and where each piece starts in it. */
function joinedText(pieces: Array<{ text: string }>): {
  text: string;
  starts: number[];
} {
  let text = "";
  const starts = pieces.map((piece) => {
    const words = normalizeText(piece.text);
    if (words && text) text += " ";
    const start = text.length;
    text += words;
    return start;
  });
  return { text, starts };
}

/**
 * The stretch of the video a product's review card plays with its sound:
 * the owner saying the price, from just before the time mark its words
 * start after to the next mark or sentence (2 to 6 s); for a price only on
 * screen, or none, 4 s around the featured item's clearest moment. Null
 * when it has neither.
 */
export function reviewClipWindow(
  item: Pick<
    InventoryItem,
    | "priceQuote"
    | "priceQuoteSeconds"
    | "priceSource"
    | "options"
    | "featuredOption"
  >,
  transcript: string,
  durationSeconds: number,
): { fromSeconds: number; toSeconds: number } | null {
  const spoken =
    item.priceSource === "spoken" && item.priceQuote
      ? spokenQuoteWindow(item.priceQuote, item.priceQuoteSeconds, transcript)
      : null;
  let from: number;
  let to: number;
  if (spoken) {
    from = spoken.from - CLIP_LEAD_SECONDS;
    to = spoken.to;
  } else {
    const shown = item.options[item.featuredOption] ?? item.options[0];
    if (!shown) return null;
    from = shown.clearestMomentSeconds - SHOWN_CLIP_SECONDS / 2;
    to = from + SHOWN_CLIP_SECONDS;
  }
  from = Math.min(Math.max(0, from), durationSeconds);
  to = Math.min(
    durationSeconds,
    Math.max(to, from + MIN_CLIP_SECONDS),
    from + MAX_CLIP_SECONDS,
  );
  // Near the end of the video it starts earlier, to stay long enough.
  if (to - from < MIN_CLIP_SECONDS) from = Math.max(0, to - MIN_CLIP_SECONDS);
  if (to - from <= 0) return null;
  const tenth = (seconds: number) => Math.round(seconds * 10) / 10;
  return { fromSeconds: tenth(from), toSeconds: tenth(to) };
}
