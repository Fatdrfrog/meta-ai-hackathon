import { readFileSync } from "node:fs";
import type { BasetenClient } from "@vitrina/meta";
import { allowedAmounts, checkReply, plainText } from "./guards.ts";
import { executeTool, TOOLS, type TurnState } from "./tools.ts";
import type { SellerTurn, SellerTurnInput } from "./types.ts";

const MAX_ROUNDS = 6;

export function systemPrompt(input: Pick<SellerTurnInput, "shopName" | "channel" | "products">): string {
  const categories = [...new Set(input.products.map((p) => p.category.toLowerCase()))].slice(0, 8).join(", ");
  const ordering =
    input.channel === "web"
      ? "and given their name and phone number (ask for whatever is missing first)"
      : "(their WhatsApp number is already known)";
  return `You are the shop assistant for ${input.shopName}, a small shop in Kazakhstan, ${input.channel === "web" ? "in the chat on its shop page" : "on WhatsApp"}. The shop has ${input.products.length} products: ${categories}.

Work with the tools:
- search_products before you talk about any product: it gives the real names and prices. If nothing matches, try other words.
- match_photo when the buyer sent a photo.
- show_products for the products your reply is about; the buyer sees them as cards with photo, name and price.
- place_order once the buyer has said what to buy ${ordering}. If they didn't say how many, it's one. If it's refused, tell the buyer what's missing.
- order_status whenever the buyer asks about their orders, even if the chat seems to show them: you only see the latest messages.
- ask_owner for what the tools can't answer: delivery, payment, sizes, stock, discounts, custom orders.

Then reply to the buyer in the language of their last message (Kazakh, Russian or English): one to three short sentences, plain text, with prices written the way the tools give them (5 000 ₸). Never invent prices, discounts, stock, sizes, colours, delivery or payment terms. Call products by their names; never mention refs, numbers from the tools, or the tools themselves.`;
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

const imagePart = (path: string) => ({
  type: "image_url",
  image_url: { url: `data:image/jpeg;base64,${readFileSync(path).toString("base64")}` },
});

/** Amounts the reply may state: real prices, several of a product the turn is about, and the order total. */
function allowedFor(input: SellerTurnInput, state: TurnState): Set<number> {
  const priceOf = (id: string) => input.products.find((p) => p.id === id)?.price ?? null;
  const known = (prices: (number | null)[]) => prices.filter((p): p is number => p !== null);
  const referenced = [...state.shown, ...(state.order?.items.map((i) => i.productId) ?? [])];
  return allowedAmounts(known(input.products.map((p) => p.price)), known(referenced.map(priceOf)), state.order?.total ?? null);
}

// Muse Spark Open works the buyer's message through tools (search, photo match, cards, order,
// owner question) for up to six rounds. Its actions are validated inside the tools, and its final
// reply is checked before the buyer sees it: one corrective round, then a safe answer.
export async function runSellerTurn(baseten: BasetenClient, input: SellerTurnInput): Promise<SellerTurn> {
  const state: TurnState = { shown: new Set(), order: null, ownerQuestions: [], trace: [] };
  const latest = input.buyerPhotoPath ? [{ type: "text", text: input.buyerText || "(sent a photo)" }, imagePart(input.buyerPhotoPath)] : input.buyerText;
  const messages: unknown[] = [
    { role: "system", content: systemPrompt(input) },
    ...input.history.slice(-12).map((m) => ({ role: m.role === "buyer" ? "user" : "assistant", content: m.text })),
    { role: "user", content: latest },
  ];

  let corrections: string[] = [];
  let stopReason = "the assistant didn't finish within the allowed steps";
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const completion = await baseten.chatCompletion({ messages, tools: TOOLS, tool_choice: "auto", reasoning_effort: "low", max_tokens: 2000 });
    const message = completion.choices[0]?.message;
    const calls = message?.tool_calls ?? [];
    if (calls.length > 0) {
      messages.push({ role: "assistant", content: message?.content ?? null, tool_calls: calls });
      for (const call of calls) {
        const result = await executeTool(call, { input, state, baseten });
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
      continue;
    }
    const reply = plainText(message?.content ?? "");
    const problems = checkReply(reply, allowedFor(input, state), input.products.flatMap((p) => [p.localName, p.name]));
    if (problems.length === 0) {
      return {
        reply,
        productIds: [...state.shown],
        order: state.order,
        ownerQuestion: state.ownerQuestions.join("\n") || null,
        corrections,
        trace: state.trace,
      };
    }
    if (corrections.length > 0) {
      stopReason = problems.join("; ");
      break;
    }
    corrections = problems;
    messages.push(
      { role: "assistant", content: reply },
      { role: "user", content: `(From the shop's system, not the buyer.) Your reply broke the rules: ${problems.join("; ")}. Write the reply to the buyer again.` },
    );
  }

  return {
    reply: CHECK_WITH_OWNER[languageOf(input.buyerText)],
    productIds: [...state.shown],
    order: state.order,
    ownerQuestion: [...state.ownerQuestions, `Покупатель написал: «${input.buyerText}». Ассистент не смог ответить (${stopReason}).`].join("\n"),
    corrections: corrections.length > 0 ? corrections : [stopReason],
    trace: state.trace,
  };
}
