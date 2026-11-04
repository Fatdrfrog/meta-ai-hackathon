import {
  PRODUCT_AD_MAX_PRODUCTS,
  productAdForeignKazakhLetters,
  productAdSpeechCode,
  productAdSpeechSeconds,
  productAdSpokenNumbers,
  type ProductAdSpeechCode,
} from "@icecore/temporal";
import { planTimeline } from "./layout";
import type { AdScript, ScriptProduct, ScriptRequest } from "./script";

// The voice-over's words in the script (Part V): each scene's spoken line,
// which "Your voice, new words" and "Airi voices" read. script.ts asks Muse
// Spark for it in the same call as the rest (SPOKEN_LINE_SCHEMA in each
// scene, spokenLinesPrompt in the question), judges it with
// spokenLineIssues, and has the code write one with fallbackSpokenLine when
// Muse Spark can't. A line never holds a price: code says the shelf price
// after it (voice.ts), in words it checks. This file imports no values from
// script.ts, which imports it.

/** The JSON schema of a scene's `spoken`, which script.ts puts in each scene. */
export const SPOKEN_LINE_SCHEMA = { type: "string" } as const;

const LANGUAGE_NAMES: Record<ProductAdSpeechCode, string> = {
  kk: "Kazakh",
  ru: "Russian",
  en: "English",
};

/** The voice-over's language, by name, for the prompt. */
function speechLanguage(request: ScriptRequest): string {
  const code = productAdSpeechCode(request.language, request.wordsCode);
  if (code) return LANGUAGE_NAMES[code];
  return request.language?.trim() || "English";
}

/**
 * About how long code's price sentence after a line takes to say ("Бағасы —
 * он бес мың бес жүз теңгеден бастап."), for the line's budget.
 */
const PRICE_SENTENCE_SECONDS = 2.6;

/**
 * Seconds a scene's whole voice-over may take when every scene says as much
 * as it can: what the timeline gives an ad of `productCount` products
 * (layout.ts), less the voice's lead and the cross-fade.
 */
export function sceneVoiceRoom(productCount: number): number {
  const count = Math.max(1, Math.min(PRODUCT_AD_MAX_PRODUCTS, productCount));
  const timeline = planTimeline(
    Array.from({ length: count }, () => ({ voiceSeconds: 10 })),
  );
  const rooms = timeline.scenes.flatMap((scene) =>
    scene.kind === "product" && scene.voice ? [scene.voice.seconds] : [],
  );
  return rooms.length ? Math.min(...rooms) : 0;
}

/** Seconds Muse Spark's own line may take in a scene, before the price. */
export function spokenLineBudget(productCount: number): number {
  return Math.max(1.2, sceneVoiceRoom(productCount) - PRICE_SENTENCE_SECONDS);
}

/** About how many words fit that budget, for the prompt. */
function wordsBudget(productCount: number): number {
  return Math.max(3, Math.round(spokenLineBudget(productCount) * 2));
}

/** The question's paragraph about the spoken lines. */
export function spokenLinesPrompt(request: ScriptRequest): string {
  const words = wordsBudget(request.products.length);
  return (
    `Also give each scene "spoken": what a voice-over says while that scene shows, in ${speechLanguage(request)}: ` +
    `one short phrase about that product, at most ${words} words, from what the owner said or the photo shows, ` +
    `written as it is said aloud (no emoji, hashtags or abbreviations). Never a price, a number, a digit or a ` +
    `currency in it, not even in words: code says the product's shelf price right after your phrase.`
  );
}

/** Every name a line may use as it is: the shop's and the products'. */
function ownNames(request: ScriptRequest): string[] {
  return [request.shopName, ...request.products.map((product) => product.name)];
}

/** A surrogate pair: an emoji or another sign outside the letters a voice reads. */
const EMOJI = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[#@*_~<>{}[\]|\\]/;

/**
 * What's wrong with one spoken line, for the repair call; empty when it
 * passes. An empty line passes: code says the product's name instead.
 */
export function spokenLineTextIssues(
  field: string,
  text: string,
  request: ScriptRequest,
): string[] {
  const line = text.trim();
  if (!line) return [];
  const issues: string[] = [];
  const numbers = productAdSpokenNumbers(line, ownNames(request));
  if (numbers.length)
    issues.push(
      `${field} says ${numbers.map((said) => `«${said}»`).join(", ")}; leave every price, number and currency out, code says the price.`,
    );
  if (EMOJI.test(line))
    issues.push(`${field} has a sign a voice can't say; write only words.`);
  const code = productAdSpeechCode(request.language, request.wordsCode);
  if (code === "kk") {
    const foreign = productAdForeignKazakhLetters(
      line,
      ownNames(request).join(" "),
    );
    if (foreign.length)
      issues.push(
        `${field} has letters Kazakh doesn't use (${foreign.join(", ")}); spell it with Kazakh letters.`,
      );
  }
  // Well over the budget only: voice.ts says a line that doesn't fit
  // without it, so a little over never costs the whole script a repair.
  const budget = spokenLineBudget(request.products.length);
  if (productAdSpeechSeconds(line, code) > budget * 1.4)
    issues.push(
      `${field} is too long to say in its scene; keep it to ${wordsBudget(request.products.length)} words.`,
    );
  return issues;
}

/** What's wrong with the scenes' spoken lines, for the repair call; empty when they pass. */
export function spokenLineIssues(
  script: AdScript,
  request: ScriptRequest,
): string[] {
  return script.scenes.flatMap((scene, index) =>
    spokenLineTextIssues(
      `scenes[${index}].spoken`,
      scene.spoken ?? "",
      request,
    ),
  );
}

/**
 * The code's own spoken line for a scene, when Muse Spark's script failed:
 * the product's name as the owner gave it ("" for none).
 */
export function fallbackSpokenLine(
  _request: ScriptRequest,
  product: ScriptProduct,
): string {
  const name = product.name.replace(/\s+/g, " ").trim();
  if (!name) return "";
  return /[.!?…]$/.test(name) ? name : `${name}.`;
}
