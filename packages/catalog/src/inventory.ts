import { outputText, type MetaClient, type TokenUsage } from "@vitrina/meta";

export interface InventoryItem {
  /** Short catalog name in English. */
  readonly name: string;
  /** The owner's own name for it, in the language they spoke. */
  readonly local_name: string;
  readonly category: string;
  /** Specific English noun phrase for SAM, e.g. "pink toy phone". */
  readonly sam_phrase: string;
  readonly price: number | null;
  readonly currency: string | null;
  /** The transcript words the price comes from, verbatim, so it can be checked. */
  readonly price_quote: string | null;
  readonly first_seen_s: number;
  readonly clearest_moment_s: number;
  readonly doubt: string | null;
}

export interface Inventory {
  readonly language: string;
  readonly items: readonly InventoryItem[];
}

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
          "name", "local_name", "category", "sam_phrase", "price", "currency",
          "price_quote", "first_seen_s", "clearest_moment_s", "doubt",
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

export async function readInventory(
  meta: MetaClient,
  videoFileId: string,
  transcript: string,
): Promise<{ inventory: Inventory; usage?: TokenUsage }> {
  const response = await meta.createResponse({
    model: meta.config.models.spark,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_video", file_id: videoFileId },
          { type: "input_text", text: inventoryPrompt(transcript) },
        ],
      },
    ],
    text: { format: { type: "json_schema", name: "shop_inventory", strict: true, schema: SCHEMA } },
    max_output_tokens: 8000,
  });
  return { inventory: JSON.parse(outputText(response)) as Inventory, usage: response.usage };
}
