import { readFileSync } from "node:fs";
import { messageText, type BasetenClient } from "@vitrina/meta";
import { allowedAmounts, normalizePhone, unbackedPrices } from "./guards.ts";

export type Channel = "web" | "whatsapp";

export interface SellerProduct {
  readonly id: string;
  /** The owner's name for it, in their language. */
  readonly localName: string;
  readonly name: string;
  readonly category: string;
  readonly price: number | null;
}

export interface SellerMessage {
  readonly role: "buyer" | "seller";
  readonly text: string;
}

export interface SellerTurnInput {
  readonly shopName: string;
  readonly channel: Channel;
  /** In shelf order: label n in the prompt and on the catalog sheet is products[n - 1]. */
  readonly products: readonly SellerProduct[];
  /** Numbered sheet of the products' photos, used when the buyer sends a photo. */
  readonly catalogSheetPath?: string;
  readonly history: readonly SellerMessage[];
  readonly buyerText: string;
  readonly buyerPhotoPath?: string;
  /** Known on WhatsApp; on the web the buyer has to give it. */
  readonly buyerPhone?: string;
}

export interface SellerOrder {
  readonly items: readonly { readonly productId: string; readonly quantity: number }[];
  readonly buyerName: string | null;
  readonly buyerPhone: string;
  /** Null when an item has no price yet. */
  readonly total: number | null;
}

export interface SellerTurn {
  readonly reply: string;
  readonly productIds: readonly string[];
  readonly order: SellerOrder | null;
  /** A question for the shop owner, written in Russian. */
  readonly ownerQuestion: string | null;
  /** What the checks caught in the model's first answer; empty when it passed. */
  readonly corrections: readonly string[];
}

interface RawAnswer {
  reply: string;
  show: number[];
  order: { items: { label: number; quantity: number }[]; name: string | null; phone: string | null } | null;
  ask_owner: string | null;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "show", "order", "ask_owner"],
  properties: {
    reply: { type: "string" },
    show: { type: "array", items: { type: "integer" } },
    order: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["items", "name", "phone"],
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["label", "quantity"],
                properties: { label: { type: "integer" }, quantity: { type: "integer" } },
              },
            },
            name: { type: ["string", "null"] },
            phone: { type: ["string", "null"] },
          },
        },
      ],
    },
    ask_owner: { type: ["string", "null"] },
  },
};

export function systemPrompt(input: Pick<SellerTurnInput, "shopName" | "channel" | "products">): string {
  const products = input.products
    .map((p, i) => `${i + 1}. ${p.localName}: ${p.price === null ? "no price yet, ask the owner" : `${p.price} ₸`}. In English: ${p.name} (${p.category}).`)
    .join("\n");
  const ordering =
    input.channel === "web"
      ? "and has given a name and a phone number. Until then, ask for whatever is missing"
      : "(their WhatsApp number is already known)";
  return `You sell for ${input.shopName}, a small shop in Kazakhstan, ${input.channel === "web" ? "in the chat on its shop page" : "on WhatsApp"}.

Products for sale (the number is the product's label):
${products}

Rules:
- Reply in the language of the buyer's last message: Kazakh, Russian or English. One to three short sentences, plain text, no markdown.
- Call a product by the owner's name for it (before the colon); to an English-speaking buyer, use its English name. Never add names, labels or categories in brackets.
- Sell only these products. Write prices exactly as listed, in digits with ₸. Never invent prices, discounts, stock, sizes, colours, delivery or payment terms.
- When the buyer asks something this list doesn't answer (delivery, payment, sizes, stock, a discount, a custom order), say you will ask the owner, and put the question in ask_owner, in Russian, for the owner to read. Otherwise ask_owner is null.
- show: labels of the products your reply is about, at most 10; the buyer sees them as cards with photos, names and prices. Empty when the reply isn't about products. Because the cards carry the details, name at most two products in the text itself.
- order: only when the buyer has clearly said what to buy ${ordering}; if they didn't say how many, it's one. Otherwise null. When you place an order, say it's placed and that the shop will contact them about payment and delivery, and ask nothing else in that reply.
- If the buyer sent a photo, the first image is theirs and the second shows our products with their labels. Find the same product; if none matches, say so and show the closest.`;
}

const imagePart = (path: string) => ({
  type: "image_url",
  image_url: { url: `data:${path.endsWith(".png") ? "image/png" : "image/jpeg"};base64,${readFileSync(path).toString("base64")}` },
});

/** Checks the model's answer against the catalog; returns the turn and what broke the rules. */
export function validateAnswer(raw: RawAnswer, input: SellerTurnInput): { turn: Omit<SellerTurn, "corrections">; problems: string[] } {
  const problems: string[] = [];
  const byLabel = (label: number) => input.products[label - 1];
  const productIds = [...new Set(raw.show.filter((l) => byLabel(l)).map((l) => byLabel(l)!.id))].slice(0, 10);
  const unknown = raw.show.filter((l) => !byLabel(l));
  if (unknown.length > 0) problems.push(`show has labels that aren't products: ${unknown.join(", ")}`);

  let order: SellerOrder | null = null;
  if (raw.order) {
    const items = raw.order.items.filter((it) => byLabel(it.label) && Number.isInteger(it.quantity) && it.quantity >= 1 && it.quantity <= 99);
    const phone = input.buyerPhone ?? normalizePhone(raw.order.phone);
    if (items.length === 0 || items.length !== raw.order.items.length) problems.push("the order has items that aren't products or have a bad quantity");
    else if (!phone) problems.push("the order has no valid phone number; ask the buyer for it before ordering");
    else {
      const prices = items.map((it) => byLabel(it.label)!.price);
      order = {
        items: items.map((it) => ({ productId: byLabel(it.label)!.id, quantity: it.quantity })),
        buyerName: raw.order.name?.trim() || null,
        buyerPhone: phone,
        total: prices.every((p) => p !== null) ? items.reduce((sum, it, i) => sum + it.quantity * prices[i]!, 0) : null,
      };
    }
  }

  const priceOf = (id: string) => input.products.find((p) => p.id === id)?.price ?? null;
  const known = (prices: (number | null)[]) => prices.filter((p): p is number => p !== null);
  const referenced = [...productIds, ...(order?.items.map((it) => it.productId) ?? [])];
  const unbacked = unbackedPrices(
    raw.reply,
    allowedAmounts(known(input.products.map((p) => p.price)), known(referenced.map(priceOf)), order?.total ?? null),
  );
  if (unbacked.length > 0) problems.push(`the reply states prices that aren't in the product list: ${unbacked.join(", ")}`);
  if (raw.reply.trim() === "") problems.push("the reply is empty");

  return { turn: { reply: raw.reply.trim(), productIds, order, ownerQuestion: raw.ask_owner?.trim() || null }, problems };
}

/** Rough language of a buyer's message, for the fallback reply. */
export function languageOf(text: string): "kk" | "ru" | "en" {
  if (/[әғқңөұүһі]/i.test(text)) return "kk";
  return /[а-яё]/i.test(text) ? "ru" : "en";
}

const CHECK_WITH_OWNER = {
  kk: "Дүкен иесінен нақтылап, жақын арада жауап беремін.",
  ru: "Уточню у владельца магазина и скоро отвечу.",
  en: "I'll check with the shop owner and get back to you shortly.",
} as const;

export async function runSellerTurn(baseten: BasetenClient, input: SellerTurnInput): Promise<SellerTurn> {
  const latest = input.buyerPhotoPath && input.catalogSheetPath
    ? [{ type: "text", text: input.buyerText || "(a photo)" }, imagePart(input.buyerPhotoPath), imagePart(input.catalogSheetPath)]
    : input.buyerText;
  const messages: unknown[] = [
    { role: "system", content: systemPrompt(input) },
    ...input.history.slice(-12).map((m) => ({ role: m.role === "buyer" ? "user" : "assistant", content: m.text })),
    { role: "user", content: latest },
  ];

  const ask = async (conversation: unknown[]): Promise<RawAnswer | null> => {
    const completion = await baseten.chatCompletion({
      messages: conversation,
      response_format: { type: "json_schema", json_schema: { name: "seller_turn", strict: true, schema: SCHEMA } },
      reasoning_effort: "low",
      max_tokens: 3000,
    });
    try {
      return JSON.parse(messageText(completion)) as RawAnswer;
    } catch {
      return null;
    }
  };

  const first = await ask(messages);
  const checked = first ? validateAnswer(first, input) : null;
  if (checked && checked.problems.length === 0) return { ...checked.turn, corrections: [] };

  // One corrective round with the problems spelled out, then a safe answer.
  const problems = checked?.problems ?? ["the answer wasn't valid JSON"];
  const second = await ask([
    ...messages,
    { role: "assistant", content: JSON.stringify(first ?? {}) },
    { role: "user", content: `Your answer broke the rules: ${problems.join("; ")}. Answer the buyer again, following the rules.` },
  ]);
  const rechecked = second ? validateAnswer(second, input) : null;
  if (rechecked && rechecked.problems.length === 0) return { ...rechecked.turn, corrections: problems };
  return {
    reply: CHECK_WITH_OWNER[languageOf(input.buyerText)],
    productIds: rechecked?.turn.productIds ?? checked?.turn.productIds ?? [],
    order: null,
    ownerQuestion: `Покупатель спросил: «${input.buyerText}». Ответ ИИ не прошёл проверку (${problems.join("; ")}).`,
    corrections: problems,
  };
}
