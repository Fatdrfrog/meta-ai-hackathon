import { estimateLlmCostUsd } from "@icecore/airi-runtime/llm-pricing";
import {
  createMetaResponse,
  getMetaModels,
  metaResponseText,
  type MetaRequestOptions,
} from "@icecore/airi-runtime/meta-model-api";

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
  onCost?: (usd: number, what: string) => void;
};

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
- price and currency: the price the owner said for this item as a number, with an ISO currency code (KZT for теңге or тенге); null if no price was said for it.
- price_quote: the exact words from the transcript that state the price, copied verbatim; null if no price.
- first_seen_s: when the owner starts presenting it.
- clearest_moment_s: when it is most clearly visible, held still and in focus.
- doubt: if the owner should confirm something (an unusual currency, an unclear number, a price that might belong to another item), say what in one short English sentence; otherwise null.
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
  const json = JSON.parse(raw) as { language?: unknown; items?: unknown };
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

export async function readProductInventory(
  request: { videoFileId: string; transcript: string },
  deps: InventoryDeps = {},
  options?: MetaRequestOptions,
): Promise<ProductInventory> {
  const model = getMetaModels().museSpark;
  const response = await (deps.createMetaResponse ?? createMetaResponse)(
    {
      model,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_video", file_id: request.videoFileId },
            { type: "input_text", text: inventoryPrompt(request.transcript) },
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
      max_output_tokens: 8000,
    },
    options,
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
}

const normalizeText = (value: string) =>
  value
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Whether a quote the model claims to have copied really occurs in the transcript. */
export function quoteInTranscript(quote: string, transcript: string): boolean {
  const needle = normalizeText(quote);
  return needle !== "" && normalizeText(transcript).includes(needle);
}

/** Problems for the owner to confirm, from our own checks on top of the model's doubt. */
export function inventoryItemChecks(
  item: InventoryItem,
  transcript: string,
): string[] {
  const checks: string[] = [];
  if (item.price === null) checks.push("No price was said for this product.");
  else if (!item.priceQuote || !quoteInTranscript(item.priceQuote, transcript))
    checks.push("This price doesn't match anything in the narration.");
  if (item.price !== null && item.currency !== "KZT")
    checks.push(
      `The price is in ${item.currency ?? "an unknown currency"}, not tenge.`,
    );
  return checks;
}

const MIN_WINDOW_SECONDS = 2;
const MAX_WINDOW_SECONDS = 16;

/**
 * The stretch of video in which each product is presented: from when it first
 * appears until the next product does, kept between 2 and 16 seconds around
 * its clearest moment.
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
  order.forEach(({ index, start }, k) => {
    const clearest = Math.min(
      durationSeconds,
      Math.max(0, items[index]!.clearestMomentSeconds),
    );
    let fromSeconds = Math.max(0, Math.min(start, durationSeconds));
    let toSeconds = Math.min(
      durationSeconds,
      order[k + 1]?.start ?? durationSeconds,
    );
    if (toSeconds - fromSeconds < MIN_WINDOW_SECONDS) {
      fromSeconds = Math.max(
        0,
        Math.min(
          clearest - MIN_WINDOW_SECONDS / 2,
          durationSeconds - MIN_WINDOW_SECONDS,
        ),
      );
      toSeconds = Math.min(durationSeconds, fromSeconds + MIN_WINDOW_SECONDS);
    }
    if (toSeconds - fromSeconds > MAX_WINDOW_SECONDS) {
      fromSeconds = Math.max(
        fromSeconds,
        Math.min(
          clearest - MAX_WINDOW_SECONDS / 2,
          toSeconds - MAX_WINDOW_SECONDS,
        ),
      );
      toSeconds = fromSeconds + MAX_WINDOW_SECONDS;
    }
    windows[index] = { fromSeconds, toSeconds };
  });
  return windows;
}
