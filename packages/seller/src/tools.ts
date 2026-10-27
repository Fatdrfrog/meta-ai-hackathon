import { readFileSync } from "node:fs";
import { messageText, type BasetenClient, type ToolCall } from "@vitrina/meta";
import { normalizePhone } from "./guards.ts";
import type { SellerOrder, SellerProduct, SellerTurnInput, TraceStep } from "./types.ts";

/** What one buyer message has done so far: the agent's actions land here, not in a database. */
export interface TurnState {
  readonly shown: Set<string>;
  order: SellerOrder | null;
  readonly ownerQuestions: string[];
  readonly trace: TraceStep[];
}

export interface ToolContext {
  readonly input: SellerTurnInput;
  readonly state: TurnState;
  readonly baseten: BasetenClient;
}

const object = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});

const fn = (name: string, description: string, parameters: object) => ({ type: "function", function: { name, description, parameters } });

export const TOOLS = [
  fn(
    "search_products",
    "Find the shop's products and their real prices. Search with the buyer's words, the owner's words or English. An empty query lists the shelf.",
    object({ query: { type: "string" } }),
  ),
  fn("match_photo", "Find the products in the shop that match the photo the buyer sent with this message.", object({})),
  fn(
    "show_products",
    "Show products to the buyer as cards with photo, name and price. Use the refs from search_products or match_photo.",
    object({ refs: { type: "array", items: { type: "string" } } }),
  ),
  fn(
    "place_order",
    "Place an order once the buyer has said what to buy. Refused with a reason if something is missing.",
    object({
      items: { type: "array", items: object({ ref: { type: "string" }, quantity: { type: "integer" } }) },
      name: { type: ["string", "null"] },
      phone: { type: ["string", "null"] },
    }),
  ),
  fn("order_status", "Look up the orders the buyer already placed in this chat.", object({})),
  fn(
    "ask_owner",
    "Pass a question the tools can't answer (delivery, payment, sizes, stock, discounts, custom orders) to the shop owner. Write it in Russian.",
    object({ question: { type: "string" } }),
  ),
];

const SHELF_LIMIT = 30;

/** The ref the model uses for a product: its place on the shelf. */
export const refOf = (index: number) => `p${index + 1}`;

const words = (text: string) =>
  text
    .toLowerCase()
    .replaceAll("ё", "е")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3);
// Four letters is enough to match Russian and Kazakh words across their endings: "куклу" and "Кукла".
const stem = (word: string) => word.slice(0, 4);

// Prices go to the model written out, so its replies carry the tenge sign the way buyers read them.
export const priceText = (price: number | null) =>
  price === null ? "no price yet, ask the owner" : `${String(price).replaceAll(/\B(?=(\d{3})+(?!\d))/g, " ")} ₸`;

export interface SearchResult {
  readonly ref: string;
  readonly name: string;
  readonly english: string;
  readonly category: string;
  readonly price: string;
}

const resultOf = (products: readonly SellerProduct[], index: number): SearchResult => {
  const p = products[index]!;
  return { ref: refOf(index), name: p.localName, english: p.name, category: p.category, price: priceText(p.price) };
};

export function searchProducts(products: readonly SellerProduct[], query: string, limit = 8): SearchResult[] {
  const wanted = words(query).map(stem);
  if (wanted.length === 0) return products.slice(0, limit).map((_, i) => resultOf(products, i));
  return products
    .map((p, index) => {
      const own = new Set(words(`${p.localName} ${p.name} ${p.category}`).map(stem));
      return { index, score: wanted.filter((w) => own.has(w)).length };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((m) => resultOf(products, m.index));
}

const imagePart = (path: string) => ({
  type: "image_url",
  image_url: { url: `data:${path.endsWith(".png") ? "image/png" : "image/jpeg"};base64,${readFileSync(path).toString("base64")}` },
});

// A separate vision call: the buyer's photo against the numbered sheet of the shop's cut-outs.
async function matchPhoto(ctx: ToolContext): Promise<object> {
  const { input } = ctx;
  if (!input.buyerPhotoPath || !input.catalogSheetPath) return { error: "The buyer didn't send a photo with this message." };
  const completion = await ctx.baseten.chatCompletion({
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "The first image is a customer's photo. The second shows a shop's products, each with a number in its corner. Which numbered products are in the customer's photo, or are what they're looking for? same=true only for the very same item.",
          },
          imagePart(input.buyerPhotoPath),
          imagePart(input.catalogSheetPath),
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "photo_match",
        strict: true,
        schema: object({ matches: { type: "array", items: object({ number: { type: "integer" }, same: { type: "boolean" } }) } }),
      },
    },
    reasoning_effort: "low",
    max_tokens: 2000,
  });
  let matches: { number: number; same: boolean }[] = [];
  try {
    matches = (JSON.parse(messageText(completion)) as { matches: typeof matches }).matches;
  } catch {
    return { error: "The photo couldn't be compared just now." };
  }
  const found = matches
    .filter((m) => input.products[m.number - 1])
    .map((m) => ({ ...resultOf(input.products, m.number - 1), same_item: m.same }));
  return found.length > 0 ? { matches: found } : { matches: [], note: "Nothing in the shop looks like the photo." };
}

function placeOrder(args: Record<string, unknown>, ctx: ToolContext): object {
  const { input, state } = ctx;
  if (state.order) return { ok: false, error: "An order was already placed in this reply." };
  const items = Array.isArray(args.items) ? (args.items as { ref?: unknown; quantity?: unknown }[]) : [];
  // The model sometimes sends numbers as strings and the other way round, so both are taken.
  const resolved = items.map((item) => ({ index: input.products.findIndex((_, i) => refOf(i) === item.ref), quantity: Number(item.quantity ?? 1) }));
  if (resolved.length === 0 || resolved.some((r) => r.index < 0 || !Number.isInteger(r.quantity) || r.quantity < 1 || r.quantity > 99)) {
    return { ok: false, error: "Every item needs a product ref from the tools and a quantity from 1 to 99." };
  }
  const given = typeof args.phone === "string" || typeof args.phone === "number" ? String(args.phone) : null;
  const phone = input.buyerPhone ?? normalizePhone(given);
  if (!phone) {
    return given
      ? { ok: false, error: `"${given}" isn't a phone number the shop can call. Ask the buyer to check it.` }
      : { ok: false, error: "There is no phone number. Ask the buyer for their name and phone number first." };
  }
  const lines = resolved.map((r) => ({ product: input.products[r.index]!, quantity: r.quantity }));
  const total = lines.every((l) => l.product.price !== null) ? lines.reduce((sum, l) => sum + l.quantity * l.product.price!, 0) : null;
  state.order = {
    items: lines.map((l) => ({ productId: l.product.id, quantity: l.quantity })),
    buyerName: typeof args.name === "string" && args.name.trim() ? args.name.trim() : null,
    buyerPhone: phone,
    total,
  };
  for (const l of lines) state.shown.add(l.product.id);
  return {
    ok: true,
    items: lines.map((l) => ({ name: l.product.localName, quantity: l.quantity, price: priceText(l.product.price) })),
    total: total === null ? "not known yet, the owner will confirm it" : priceText(total),
    next: "Tell the buyer the order is placed and the shop will contact them about payment and delivery.",
  };
}

async function run(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<object> {
  const { input, state } = ctx;
  switch (name) {
    case "search_products": {
      const results = searchProducts(input.products, typeof args.query === "string" ? args.query : "");
      if (results.length > 0) return { results, products_in_shop: input.products.length };
      // Word matching misses translations ("қуыршақ" for "Кукла"), so a small shop hands over its
      // whole shelf and the model judges for itself instead of guessing more words.
      return input.products.length <= SHELF_LIMIT
        ? { results: [], note: "No product matched these words. This is the whole shelf; judge from it.", shelf: searchProducts(input.products, "", SHELF_LIMIT) }
        : { results: [], note: "Nothing matched. Try other words, or an empty query to list the shelf." };
    }
    case "match_photo":
      return matchPhoto(ctx);
    case "show_products": {
      const refs = Array.isArray(args.refs) ? args.refs.filter((r): r is string => typeof r === "string") : [];
      const unknown: string[] = [];
      for (const r of refs) {
        const index = input.products.findIndex((_, i) => refOf(i) === r);
        if (index < 0) unknown.push(r);
        else if (state.shown.size < 10) state.shown.add(input.products[index]!.id);
      }
      return unknown.length > 0 ? { shown: state.shown.size, unknown_refs: unknown } : { shown: state.shown.size };
    }
    case "place_order":
      return placeOrder(args, ctx);
    case "order_status":
      return input.previousOrders?.length
        ? { orders: input.previousOrders.map((o) => ({ ...o, total: o.total === null ? "not known yet" : priceText(o.total) })) }
        : { orders: [], note: "No orders in this chat yet." };
    case "ask_owner": {
      const question = typeof args.question === "string" ? args.question.trim() : "";
      if (!question) return { ok: false, error: "The question is empty." };
      state.ownerQuestions.push(question);
      return { ok: true, next: "Tell the buyer you'll check with the owner." };
    }
    default:
      return { error: `There is no tool called ${name}.` };
  }
}

export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<object> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
  } catch {
    const result = { error: "The arguments weren't valid JSON." };
    ctx.state.trace.push({ tool: call.function.name, args: call.function.arguments, result });
    return result;
  }
  const result = await run(call.function.name, args, ctx);
  ctx.state.trace.push({ tool: call.function.name, args, result });
  return result;
}
