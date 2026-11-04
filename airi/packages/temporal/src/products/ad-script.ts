// The words a video ad puts on screen and in its post, and the checks every
// version of them passes: Muse Spark's script, the code's fallback, and the
// owner's edits. No price is ever written here: code draws prices from the
// shelf. Pure and without dependencies. apps/web type-checks this file at
// target ES2017, so its regexes use no lookbehind, named groups or Unicode
// property escapes.

import {
  PRODUCT_AD_OPTIONS_MAX,
  PRODUCT_AD_SETTINGS,
  type ProductAdOption,
  type ProductAdScript,
  type ProductAdSetting,
} from "./contracts";

/** A text's room: at most `lines` wrapped lines of `chars` characters, or `chars` in all. */
export type ProductAdTextLimit = { chars: number; lines?: number };

/**
 * How much each text may hold. On-screen texts are wrapped lines that stay
 * inside the Reels safe band; the post and the Click-to-WhatsApp copy follow
 * Meta's ad limits.
 */
export const PRODUCT_AD_TEXT_LIMITS = {
  sticker: { chars: 26, lines: 1 },
  caption: { chars: 26, lines: 2 },
  priceCardTitle: { chars: 26, lines: 1 },
  ending: { chars: 26, lines: 2 },
  postIntro: { chars: 200 },
  ctwaHeadline: { chars: 40 },
  ctwaPrimaryText: { chars: 125 },
  ctwaGreeting: { chars: 160 },
  ctwaQuestion: { chars: 80 },
} as const satisfies Record<string, ProductAdTextLimit>;

/** The quick questions a Click-to-WhatsApp ad offers. */
export const PRODUCT_AD_CTWA_QUESTIONS = 3;

const length = (text: string) => Array.from(text).length;

/**
 * The text in lines of at most `chars` characters, broken between words; a
 * word longer than a line stands on a line of its own.
 */
export function productAdLines(text: string, chars: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.trim().split(/\s+/)) {
    if (!word) continue;
    if (!line) line = word;
    else if (length(line) + 1 + length(word) <= chars) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// The Latin and Cyrillic letters, marks and punctuation that BOTH of the ad's
// bundled fonts draw (Geologica and Inter, in the worker's assets/fonts),
// Kazakh's letters included, and the tenge sign, № and ™. Geologica has the
// fewer: Cyrillic Supplement, most of Latin Extended-B, the soft hyphen and
// the narrow and thin spaces are missing from it. A glyph test in the worker
// (ad/fonts.test.ts) checks every code point here against both fonts.
const SUPPORTED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0a, 0x0a],
  [0x20, 0x7e],
  [0xa0, 0xac],
  [0xae, 0x148],
  [0x14a, 0x17e],
  [0x18f, 0x18f],
  [0x192, 0x192],
  [0x1a0, 0x1a1],
  [0x1af, 0x1b0],
  [0x1c5, 0x1ce],
  [0x1e6, 0x1e7],
  [0x1ea, 0x1eb],
  [0x1fa, 0x21b],
  [0x22a, 0x22d],
  [0x230, 0x233],
  [0x237, 0x237],
  [0x259, 0x259],
  [0x2bc, 0x2bc],
  [0x2c6, 0x2c7],
  [0x2d8, 0x2dd],
  [0x300, 0x304],
  [0x306, 0x30a],
  [0x30c, 0x30c],
  [0x30f, 0x30f],
  [0x31b, 0x31b],
  [0x323, 0x323],
  [0x326, 0x328],
  [0x400, 0x45f],
  [0x462, 0x463],
  [0x46a, 0x46b],
  [0x472, 0x475],
  [0x490, 0x49d],
  [0x4a0, 0x4a5],
  [0x4aa, 0x4ab],
  [0x4ae, 0x4b3],
  [0x4b6, 0x4bb],
  [0x4c0, 0x4c2],
  [0x4cb, 0x4cc],
  [0x4cf, 0x4d9],
  [0x4dc, 0x4df],
  [0x4e2, 0x4e9],
  [0x4ee, 0x4f9],
  [0x1e80, 0x1e85],
  [0x1e9e, 0x1e9e],
  [0x1ea0, 0x1ef9],
  [0x2010, 0x2010],
  [0x2013, 0x2014],
  [0x2018, 0x201a],
  [0x201c, 0x201e],
  [0x2020, 0x2022],
  [0x2026, 0x2026],
  [0x2030, 0x2030],
  [0x2032, 0x2033],
  [0x2039, 0x203a],
  [0x2044, 0x2044],
  [0x2052, 0x2052],
  [0x20b8, 0x20b8],
  [0x2116, 0x2116],
  [0x2122, 0x2122],
];

/** The code point ranges productAdLettersSupported takes, for the worker's glyph test. */
export const PRODUCT_AD_SUPPORTED_RANGES = SUPPORTED_RANGES;

/**
 * Whether every character of a text is one the ad's fonts draw: Latin and
 * Cyrillic letters (Kazakh's included), digits, punctuation and ₸. Product
 * names in any other script, emoji, or the rarer letters the fonts lack
 * (Cyrillic Supplement, most of Latin Extended-B) can't go in a video ad yet.
 */
export function productAdLettersSupported(text: string): boolean {
  for (const char of text.normalize("NFC")) {
    const code = char.codePointAt(0) ?? 0;
    if (!SUPPORTED_RANGES.some(([from, to]) => code >= from && code <= to))
      return false;
  }
  return true;
}

/**
 * The shop's name as an ad may draw and say it: trimmed, or "" when the
 * fonts can't draw every letter of it (an emoji, CJK). The ending then
 * leaves the name out and its pill says "WhatsApp", so a workspace name the
 * owner can't change from Products never draws boxes, nor stops an ad.
 */
export function productAdShopName(name: string): string {
  const trimmed = name.trim();
  return productAdLettersSupported(trimmed) ? trimmed : "";
}

const isCurrencySign = (code: number) =>
  code === 0x24 ||
  (code >= 0xa2 && code <= 0xa5) ||
  code === 0x58f ||
  code === 0xe3f ||
  (code >= 0x20a0 && code <= 0x20cf);

// Currency words in the shop languages; whole words, or their first part for
// words that take endings ("теңгеге", "долларов").
const CURRENCY_WORDS = new Set(["тг", "руб", "евро", "euro", "euros"]);
const CURRENCY_STEMS = [
  "теңге",
  "тенге",
  "рубл",
  "доллар",
  "tenge",
  "dollar",
  "ruble",
  "rouble",
];

/**
 * Whether a text names a price's currency: a sign or a currency word. A price
 * also needs a number, which is refused on its own; an ISO code without one
 * isn't a price, and capitals such as "ALL" or "CUP" are words too.
 */
function namesCurrency(text: string): boolean {
  for (const char of text) {
    if (isCurrencySign(char.codePointAt(0) ?? 0)) return true;
  }
  for (const word of text.split(/[^A-Za-zÀ-ɏЀ-ԯ]+/)) {
    if (!word) continue;
    const lower = word.toLowerCase();
    if (CURRENCY_WORDS.has(lower)) return true;
    if (CURRENCY_STEMS.some((stem) => lower.startsWith(stem))) return true;
  }
  return false;
}

/**
 * What's wrong with one of the ad's texts, in English, each naming `field`:
 * empty, a digit or a currency (prices are drawn by code), letters the fonts
 * lack, or more than its room. Empty when it passes.
 */
export function productAdTextIssues(
  field: string,
  text: string,
  limit: ProductAdTextLimit,
): string[] {
  const issues: string[] = [];
  const trimmed = text.trim();
  if (!trimmed) return [`${field} is empty.`];
  if (/[0-9]/.test(trimmed))
    issues.push(
      `${field} has a digit; write no numbers or prices, code adds the prices.`,
    );
  if (namesCurrency(trimmed))
    issues.push(
      `${field} names a currency; write no prices, code adds the prices.`,
    );
  if (!productAdLettersSupported(trimmed))
    issues.push(
      `${field} has characters the ad's fonts can't draw; use Latin or Cyrillic letters only.`,
    );
  if (limit.lines !== undefined) {
    const lines = productAdLines(trimmed, limit.chars);
    if (
      lines.length > limit.lines ||
      lines.some((line) => length(line) > limit.chars)
    )
      issues.push(
        limit.lines === 1
          ? `${field} must fit one line of ${limit.chars} characters.`
          : `${field} must fit ${limit.lines} lines of ${limit.chars} characters.`,
      );
  } else if (length(trimmed) > limit.chars) {
    issues.push(`${field} is longer than ${limit.chars} characters.`);
  }
  return issues;
}

/**
 * What's wrong with Muse Spark's openings or endings, each named by its
 * place ("openings[1]"): every text passes the same checks as the words it
 * stands in for (`limit`: the sticker's or the ending's), the kinds are
 * distinct, and there are at most PRODUCT_AD_OPTIONS_MAX. Empty when they
 * pass; the worker drops a failing option rather than the script.
 */
export function productAdOptionIssues(
  field: "openings" | "endings",
  options: ReadonlyArray<ProductAdOption<string>>,
  limit: ProductAdTextLimit,
): string[] {
  const issues = options.flatMap((option, index) =>
    productAdTextIssues(`${field}[${index}]`, option.text, limit),
  );
  if (options.length > PRODUCT_AD_OPTIONS_MAX)
    issues.push(`${field} must hold at most ${PRODUCT_AD_OPTIONS_MAX}.`);
  const kinds = options.map((option) => option.kind);
  if (new Set(kinds).size !== kinds.length)
    issues.push(`${field} must each be of a different kind.`);
  return issues;
}

const isSetting = (value: unknown): value is ProductAdSetting =>
  (PRODUCT_AD_SETTINGS as readonly unknown[]).includes(value);

/**
 * Every problem with an ad's script, in English, for Muse Spark's repair
 * retry and for the owner's edits; empty when it passes. Each of the ad's
 * products needs exactly one scene, and no scene may show anything else.
 */
export function productAdScriptIssues(
  script: Omit<ProductAdScript, "edited">,
  productIds: readonly string[],
): string[] {
  const limits = PRODUCT_AD_TEXT_LIMITS;
  const issues = [
    ...productAdTextIssues("sticker", script.sticker, limits.sticker),
    ...script.scenes.flatMap((scene, index) => [
      ...productAdTextIssues(
        `scenes[${index}].caption`,
        scene.caption,
        limits.caption,
      ),
      ...(isSetting(scene.setting)
        ? []
        : [
            `scenes[${index}].setting must be one of ${PRODUCT_AD_SETTINGS.join(", ")}.`,
          ]),
    ]),
    ...productAdTextIssues(
      "priceCardTitle",
      script.priceCardTitle,
      limits.priceCardTitle,
    ),
    ...productAdTextIssues("ending", script.ending, limits.ending),
    ...productAdTextIssues("postIntro", script.postIntro, limits.postIntro),
    ...productAdTextIssues(
      "ctwa.headline",
      script.ctwa.headline,
      limits.ctwaHeadline,
    ),
    ...productAdTextIssues(
      "ctwa.primaryText",
      script.ctwa.primaryText,
      limits.ctwaPrimaryText,
    ),
    ...productAdTextIssues(
      "ctwa.greeting",
      script.ctwa.greeting,
      limits.ctwaGreeting,
    ),
    ...script.ctwa.questions.flatMap((question, index) =>
      productAdTextIssues(
        `ctwa.questions[${index}]`,
        question,
        limits.ctwaQuestion,
      ),
    ),
  ];
  if (script.ctwa.questions.length !== PRODUCT_AD_CTWA_QUESTIONS)
    issues.push(
      `ctwa.questions must hold exactly ${PRODUCT_AD_CTWA_QUESTIONS} questions.`,
    );
  const scenesOf = new Map<string, number>();
  for (const scene of script.scenes)
    scenesOf.set(scene.productId, (scenesOf.get(scene.productId) ?? 0) + 1);
  for (const productId of productIds) {
    const count = scenesOf.get(productId) ?? 0;
    if (count === 0) issues.push(`No scene shows product ${productId}.`);
    else if (count > 1)
      issues.push(`Product ${productId} has ${count} scenes; give it one.`);
  }
  for (const productId of scenesOf.keys()) {
    if (!productIds.includes(productId))
      issues.push(
        `scenes show ${productId}, which isn't one of the ad's products.`,
      );
  }
  return issues;
}
