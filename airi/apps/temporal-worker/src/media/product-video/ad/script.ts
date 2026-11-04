import { MetaModelApiError } from "@icecore/airi-runtime/meta-model-api";
import {
  cleanAdScriptForLanguage,
  PRODUCT_AD_CTWA_QUESTIONS,
  PRODUCT_AD_ENDING_KINDS,
  PRODUCT_AD_OPENING_KINDS,
  PRODUCT_AD_OPTIONS_MAX,
  PRODUCT_AD_SETTINGS,
  PRODUCT_AD_TEXT_LIMITS,
  productAdOptionIssues,
  productAdScriptIssues,
  productAdTextIssues,
  saysSpokenWord,
  spokenNumberRoot,
  type ProductAdEndingKind,
  type ProductAdIdeaKind,
  type ProductAdOpeningKind,
  type ProductAdOption,
  type ProductAdScript,
  type ProductAdSetting,
  type ProductAdTextLimit,
  type ProductShopWordsCode,
} from "@icecore/temporal";
import {
  fallbackSpokenLine,
  SPOKEN_LINE_SCHEMA,
  spokenLineIssues,
  spokenLinesPrompt,
} from "./voice-script";

// The ad's words: one Muse Spark 1.3 call with a strict JSON schema writes the
// sticker, a caption and a setting for each product's scene, the price card's
// title, the ending, the post's opening and the Click-to-WhatsApp copy, in
// the language the owner spoke and from what they said; and three openings
// and three endings, one of each kind, for the owner to pick from in the
// studio. No price is ever written: code draws the shelf's prices. Every
// answer passes the shared checks (ad-script.ts); a failing one gets one
// repair call with the problems listed, and after that the code writes plain
// words itself, so an ad always has words. An opening or ending that fails
// the same checks is dropped, never the script.

export type AdScript = Omit<ProductAdScript, "edited">;

export type ScriptProduct = {
  productId: string;
  /** The name the owner gave it, as the shelf shows it. */
  name: string;
  englishName: string | null;
  /** The price as buyers read it, for context only. */
  priceText: string;
  /** The owner's words the price came from. */
  priceQuote: string | null;
  /** A few English words that tell it apart. */
  description: string;
  /** The narration lines around what the owner said about it. */
  said: string[];
};

export type ScriptRequest = {
  /** The language the owner spoke, as Muse Spark named it; null when unknown. */
  language: string | null;
  /** The language of the ad's fixed words. */
  wordsCode: ProductShopWordsCode | null;
  idea: { kind: ProductAdIdeaKind; text: string | null };
  shopName: string;
  products: ScriptProduct[];
};

const LANGUAGE_NAMES: Record<ProductShopWordsCode, string> = {
  kk: "Kazakh",
  ru: "Russian",
  en: "English",
};

const SETTING_WORDS: Record<ProductAdSetting, string> = {
  oak_table_window: "a light oak table by a bright window",
  linen_shelf: "a shelf draped with natural linen",
  stone_counter: "a pale stone counter",
  playroom_shelf: "a white shelf in a bright children's playroom",
  gift_table: "a table with soft wrapping paper and ribbon, set for a gift",
  market_stall:
    "a wooden stall at a sunny bazaar, woven baskets softly blurred behind",
  marble_boutique: "a white marble counter in a bright, calm boutique",
  festive_table:
    "a festive table with a patterned tablecloth and warm string lights",
  vanity_table: "a light vanity table with a round mirror in soft daylight",
  kitchen_counter: "a bright kitchen counter with fresh green herbs",
  cafe_table: "a small round cafe table in warm morning sunlight",
  wooden_workbench: "a warm wooden craft workbench with natural wood grain",
  garden_patio:
    "a natural stone table on a sunlit garden patio with soft green leaves behind",
  bookshop_desk:
    "a tidy wooden study desk with stacked books softly blurred behind",
  velvet_display:
    "a soft cream velvet jewelry display stand under warm boutique light",
  terracotta_ledge:
    "a warm terracotta courtyard ledge in soft afternoon sunlight",
  minimal_pedestal:
    "a clean travertine stone pedestal in a sunlit minimalist studio",
  cozy_living_room: "a low wooden coffee table in a bright, cozy living room",
  bakery_counter: "a warm butcher-block bakery counter in soft morning light",
  woven_rug: "a handwoven patterned rug in warm natural daylight",
};

/** Muse Image's words for a setting, which scenes.ts puts in its prompt. */
export function settingWords(setting: ProductAdSetting): string {
  return SETTING_WORDS[setting];
}

/** The language the words are written in, by name, for the prompt. */
export function scriptLanguage(
  request: Pick<ScriptRequest, "language" | "wordsCode">,
): string {
  const spoken = request.language?.trim() ?? "";
  if (spoken && !/^[a-z]{2}$/i.test(spoken)) return spoken;
  const code = (spoken || request.wordsCode || "en").toLowerCase();
  return Object.hasOwn(LANGUAGE_NAMES, code)
    ? LANGUAGE_NAMES[code as ProductShopWordsCode]
    : "English";
}

const IDEAS: Record<Exclude<ProductAdIdeaKind, "own">, string> = {
  new: "New on the shelf: these products have just arrived.",
  gift: "A gift idea: these products make a good present.",
};

/** The JSON schema Muse Spark answers in: every key required, nothing else. */
export function adScriptSchema(productIds: string[]): object {
  const text = { type: "string" };
  const options = (kinds: readonly string[]) => ({
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["text", "kind", "gloss"],
      properties: {
        text,
        kind: { type: "string", enum: [...kinds] },
        gloss: text,
      },
    },
  });
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "openings",
      "sticker",
      "scenes",
      "priceCardTitle",
      "endings",
      "ending",
      "postIntro",
      "ctwa",
    ],
    properties: {
      openings: options(PRODUCT_AD_OPENING_KINDS),
      sticker: text,
      scenes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["productId", "caption", "setting", "spoken"],
          properties: {
            productId: { type: "string", enum: productIds },
            caption: text,
            setting: { type: "string", enum: [...PRODUCT_AD_SETTINGS] },
            // The voice-over's line (Part V, voice-script.ts).
            spoken: SPOKEN_LINE_SCHEMA,
          },
        },
      },
      priceCardTitle: text,
      endings: options(PRODUCT_AD_ENDING_KINDS),
      ending: text,
      postIntro: text,
      ctwa: {
        type: "object",
        additionalProperties: false,
        required: ["headline", "primaryText", "greeting", "questions"],
        properties: {
          headline: text,
          primaryText: text,
          greeting: text,
          questions: { type: "array", items: text },
        },
      },
    },
  };
}

const quote = (text: string) =>
  `«${text.replaceAll("«", "").replaceAll("»", "")}»`;

/**
 * Whether the words are written in Kazakh, however Muse Spark named the
 * language: "Kazakh", "Qazaq", "kaz", «қазақ тілі» or «казахский».
 */
export function isKazakh(
  request: Pick<ScriptRequest, "language" | "wordsCode">,
): boolean {
  return /^(kazakh|kazak|qazaq|қазақ|казах|kaz$)/i.test(
    scriptLanguage(request).trim(),
  );
}

// Kazakh's Cyrillic letters, Russian's among them. Muse Spark once spelled
// the doll «җуыршақ», with a Tatar letter, for «қуыршақ» (paid gate,
// 2026-11-02); the fonts draw җ, so only this check catches it.
const KAZAKH_CYRILLIC = new Set(
  Array.from("аәбвгғдеёжзийкқлмнңоөпрстуұүфхһцчшщъыіьэюя"),
);

/** Every text of a script, each with the field the checks name it by. */
function scriptTexts(script: AdScript): Array<[string, string]> {
  return [
    ["sticker", script.sticker],
    ...script.scenes.map((scene, index): [string, string] => [
      `scenes[${index}].caption`,
      scene.caption,
    ]),
    ["priceCardTitle", script.priceCardTitle],
    ["ending", script.ending],
    ["postIntro", script.postIntro],
    ["ctwa.headline", script.ctwa.headline],
    ["ctwa.primaryText", script.ctwa.primaryText],
    ["ctwa.greeting", script.ctwa.greeting],
    ...script.ctwa.questions.map((question, index): [string, string] => [
      `ctwa.questions[${index}]`,
      question,
    ]),
  ];
}

/** A text's words, lower-cased: runs of letters. */
const wordsOf = (text: string): string[] =>
  text
    .normalize("NFC")
    .toLowerCase()
    .match(/\p{L}+/gu) ?? [];

/**
 * What's wrong with a Kazakh script's spelling: each text holding a
 * Cyrillic letter Kazakh doesn't use, unless the shop's or a product's own
 * name has it. Empty for a script in any other language.
 */
export function kazakhSpellingIssues(
  script: AdScript,
  request: ScriptRequest,
): string[] {
  return kazakhTextIssues(scriptTexts(script), request);
}

/** kazakhSpellingIssues for any texts, each with the field it's named by. */
function kazakhTextIssues(
  texts: Array<[string, string]>,
  request: ScriptRequest,
): string[] {
  if (!isKazakh(request)) return [];
  const names = new Set(
    Array.from(
      [request.shopName, ...request.products.map((product) => product.name)]
        .join(" ")
        .toLowerCase(),
    ),
  );
  return texts.flatMap(([field, text]) => {
    const foreign = new Set<string>();
    for (const char of text.normalize("NFC").toLowerCase()) {
      const code = char.codePointAt(0) ?? 0;
      if (
        code >= 0x400 &&
        code <= 0x4ff &&
        !KAZAKH_CYRILLIC.has(char) &&
        !names.has(char)
      )
        foreign.add(char);
    }
    return foreign.size
      ? [
          `${field} has letters Kazakh doesn't use (${[...foreign].join(", ")}); spell it with Kazakh letters.`,
        ]
      : [];
  });
}

// A price said in words is still a price, which only code draws. The shared
// checks refuse digits and currencies; these catch the rest. Thousands and
// up are said with these words in the shop languages, and little else
// starts with them; Kazakh's "жүз" (a hundred) is also a face, so it counts
// only as part of a product's own spoken price, below.
const SCALE_STEMS = [
  "мың",
  "тысяч",
  "миллион",
  "миллиард",
  "thousand",
  "million",
  "billion",
  "hundred",
];
const SCALE_WORDS = new Set(["тыс", "млн", "млрд"]);

// A product's spoken price is its quote's run of number words (the shared
// SPOKEN_NUMBER_WORDS: the paid gate's owner said «кукла бес мың»). Those
// that are also "a", "one" (this one) or "he" aren't a price said alone.
const NOT_ALONE = new Set(["бір", "он", "one", "один", "одна", "одно"]);

/**
 * Each product's price as the owner said it: the runs of number words in
 * its quote ("бес мың" in «кукла бес мыңға»), as the number words they are
 * ("бес", "мың"), without its name's words. A price said in one word is a
 * number word itself: "алтын" (gold) starts like "алты" (six), but isn't one.
 */
function spokenPrices(request: ScriptRequest, names: Set<string>): string[][] {
  return request.products.flatMap((product) => {
    const runs: Array<Array<{ word: string; root: string }>> = [];
    let run: Array<{ word: string; root: string }> = [];
    for (const word of wordsOf(product.priceQuote ?? "")) {
      const root = names.has(word) ? null : spokenNumberRoot(word);
      if (root) run.push({ word, root });
      else if (run.length) {
        runs.push(run);
        run = [];
      }
    }
    if (run.length) runs.push(run);
    return runs
      .filter(
        (said) =>
          said.length > 1 ||
          (said[0]!.word === said[0]!.root && !NOT_ALONE.has(said[0]!.root)),
      )
      .map((said) => said.map((entry) => entry.root));
  });
}

/**
 * Whether `words` say a spoken price: one said in one word ("пятьсот") as
 * that word, one said in more as two of its words in a row ("бес жүзге"),
 * so a single "бес" in «Бес түсі бар» isn't a price.
 */
function saysPrice(words: string[], price: string[]): boolean {
  if (price.length === 1) return words.includes(price[0]!);
  return words.some((word, index) =>
    price.some(
      (said, at) =>
        at + 1 < price.length &&
        index + 1 < words.length &&
        saysSpokenWord(word, said) &&
        saysSpokenWord(words[index + 1]!, price[at + 1]!),
    ),
  );
}

/**
 * What's wrong with a script that says a price in words: each text holding
 * a word for thousands or more ("мыңға", "тысяч", "thousand"), or a
 * product's price as the owner said it («бес жүз»). Words the shop's or a
 * product's own name has don't count. Empty when it passes.
 */
export function spokenPriceIssues(
  script: AdScript,
  request: ScriptRequest,
): string[] {
  return spokenPriceTextIssues(scriptTexts(script), request);
}

/** spokenPriceIssues for any texts, each with the field it's named by. */
function spokenPriceTextIssues(
  texts: Array<[string, string]>,
  request: ScriptRequest,
): string[] {
  const names = new Set(
    wordsOf(
      [
        request.shopName,
        ...request.products.map((product) => product.name),
      ].join(" "),
    ),
  );
  const prices = spokenPrices(request, names);
  return texts.flatMap(([field, text]) => {
    const words = wordsOf(text).filter((word) => !names.has(word));
    const scale = words.some(
      (word) =>
        SCALE_WORDS.has(word) ||
        SCALE_STEMS.some((stem) => word.startsWith(stem)),
    );
    return scale || prices.some((price) => saysPrice(words, price))
      ? [
          `${field} says a price in words; write no prices or numbers, code adds the prices.`,
        ]
      : [];
  });
}

/** The question Muse Spark answers, with the product photos as images 1 to n. */
export function adScriptPrompt(
  request: ScriptRequest,
  problems: string[] = [],
): string {
  const language = scriptLanguage(request);
  const limits = PRODUCT_AD_TEXT_LIMITS;
  const idea =
    request.idea.kind === "own" && request.idea.text?.trim()
      ? `The owner's own idea for the ad, in their words: ${quote(request.idea.text.trim())}.`
      : IDEAS[request.idea.kind === "gift" ? "gift" : "new"];
  const products = request.products
    .map((product, index) => {
      const lines = [
        `${index + 1}. Product id "${product.productId}" is in image ${index + 1}: ${quote(product.name)}` +
          (product.englishName ? ` (in English: ${product.englishName})` : "") +
          (product.description ? `; it is ${product.description}` : "") +
          ".",
        `   Its price, which code draws on screen: ${product.priceText}.`,
      ];
      if (product.priceQuote)
        lines.push(
          `   The owner said its price as ${quote(product.priceQuote)}.`,
        );
      // The lines on each side can be about the products filmed before and
      // after it: the paid gate's Shezhire panel got the medal hanger's
      // "winner's corner" as its caption.
      if (product.said.length)
        lines.push(
          `   What the owner said around it in the video (the lines before and after may be about other products; ` +
            `use only what is about this one):\n${product.said.map((line) => `     ${line}`).join("\n")}`,
        );
      return lines.join("\n");
    })
    .join("\n");
  const settings = PRODUCT_AD_SETTINGS.map(
    (setting) => `${setting} (${SETTING_WORDS[setting]})`,
  ).join(", ");
  return [
    `You write the words of a short vertical video ad, about 15 seconds, for a small shop that sells on WhatsApp. ` +
      `The shop owner filmed their products and said their prices; the ad shows each product in its own scene, ` +
      `then all of them with their prices, then asks buyers to message the shop on WhatsApp.`,
    `Write every text in ${language}, the language the owner spoke, in plain words a buyer reads in a second.`,
    request.shopName.trim()
      ? `The shop is called ${quote(request.shopName.trim())}.`
      : "",
    idea,
    `The products, in the order the ad shows them:\n${products}`,
    `Write:\n` +
      `- openings: exactly three short hooks shown at the start, for the owner to choose from, one of each kind: ` +
      `news (what's new on the shelf), question (a question a buyer answers yes to), promise (what the buyer gets ` +
      `from it); each text at most ${limits.sticker.chars} characters on one line, with gloss: the text in plain ` +
      `English for the owner, at most ${GLOSS_LIMIT.chars} characters.\n` +
      `- sticker: the opening you would show, its text copied exactly from openings.\n` +
      `- scenes: exactly one per product, in the order above, each with productId (the product's id exactly), ` +
      `caption (why a buyer would want it, from what the owner said or the photo shows; at most ${limits.caption.lines} lines ` +
      `of ${limits.caption.chars} characters), and setting (where it looks its best, one of: ${settings}).\n` +
      `- priceCardTitle: the title over all the products with their prices, at most ${limits.priceCardTitle.chars} characters.\n` +
      `- endings: exactly three last words that ask buyers to message the shop on WhatsApp, for the owner to choose ` +
      `from, one of each kind: order (to order one), ask (to ask the shop anything), reserve (to keep one for ` +
      `themselves); each text at most ${limits.ending.lines} lines of ${limits.ending.chars} characters, with gloss: ` +
      `the text in plain English for the owner, at most ${GLOSS_LIMIT.chars} characters.\n` +
      `- ending: the ending you would show, its text copied exactly from endings.\n` +
      `- postIntro: the opening of the post that goes with the video, at most ${limits.postIntro.chars} characters; ` +
      `code adds each product's name and price after it.\n` +
      `- ctwa: Click-to-WhatsApp ad copy: headline (at most ${limits.ctwaHeadline.chars} characters), primaryText ` +
      `(at most ${limits.ctwaPrimaryText.chars}), greeting (the shop's first message to a buyer who taps the ad, ` +
      `at most ${limits.ctwaGreeting.chars}) and exactly ${PRODUCT_AD_CTWA_QUESTIONS} questions a buyer can tap ` +
      `(each at most ${limits.ctwaQuestion.chars}).`,
    spokenLinesPrompt(request),
    `Rules: never write a price, a number, a digit or a currency in any text, not even in words; code adds the shelf's prices. ` +
      `Say only what the owner said or the photos show: no "best", "guaranteed", discounts, sizes or materials ` +
      `nobody mentioned. Write in Latin or Cyrillic letters with the language's normal punctuation, and no emoji: ` +
      `the post, the greeting and the questions are sentences with full stops, commas and question marks; the ` +
      `openings, sticker, captions, title, endings and ending need no full stop (a question opening keeps its ` +
      `question mark). These rules hold for every opening and ending too. Write the shop's name exactly as given, and the app ` +
      (isKazakh(request)
        ? `as WhatsApp in Latin letters, joining a Kazakh ending with a hyphen (WhatsApp-қа). `
        : `as WhatsApp in Latin letters, with no Kazakh ending attached (for example "в WhatsApp", never "WhatsApp-қа"). Do not mix languages. `) +
      `Keep every text within its length.`,
    isKazakh(request)
      ? `Spell Kazakh with its own letters (ә, ғ, қ, ң, ө, ұ, ү, һ, і), never with another language's, such as җ.`
      : "",
    problems.length
      ? `Your previous answer had these problems. Fix every one and answer again:\n${problems.map((problem) => `- ${problem}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const clean = (value: unknown): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

/**
 * Muse Spark's openings or endings as options: texts trimmed, only the
 * kinds asked for, the first of each kind, in the kinds' order; at most
 * PRODUCT_AD_OPTIONS_MAX. withCheckedOptions then drops any that fail.
 */
function parseOptions<K extends string>(
  raw: unknown,
  kinds: readonly K[],
): ProductAdOption<K>[] {
  const found = new Map<K, ProductAdOption<K>>();
  for (const item of Array.isArray(raw) ? raw : []) {
    const entry = (item && typeof item === "object" ? item : {}) as Record<
      string,
      unknown
    >;
    const kind = clean(entry.kind) as K;
    const text = clean(entry.text);
    if (!kinds.includes(kind) || !text || found.has(kind)) continue;
    found.set(kind, { text, kind, gloss: clean(entry.gloss) });
  }
  return kinds
    .flatMap((kind) => (found.has(kind) ? [found.get(kind)!] : []))
    .slice(0, PRODUCT_AD_OPTIONS_MAX);
}

/**
 * Muse Spark's answer as a script: texts trimmed to one space between words,
 * scenes in the products' order when each product has exactly one. The
 * shared checks then judge it.
 */
export function parseAdScript(raw: unknown, productIds: string[]): AdScript {
  const answer = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const ctwa = (
    answer.ctwa && typeof answer.ctwa === "object" ? answer.ctwa : {}
  ) as Record<string, unknown>;
  const scenes = (Array.isArray(answer.scenes) ? answer.scenes : []).map(
    (scene) => {
      const entry = (scene && typeof scene === "object" ? scene : {}) as Record<
        string,
        unknown
      >;
      const spoken = clean(entry.spoken);
      return {
        productId: clean(entry.productId),
        caption: clean(entry.caption),
        setting: clean(entry.setting) as ProductAdSetting,
        ...(spoken ? { spoken } : {}),
      };
    },
  );
  const ordered = productIds.map((id) =>
    scenes.filter((scene) => scene.productId === id),
  );
  return {
    sticker: clean(answer.sticker),
    scenes: ordered.every((found) => found.length === 1)
      ? ordered.map((found) => found[0]!)
      : scenes,
    priceCardTitle: clean(answer.priceCardTitle),
    ending: clean(answer.ending),
    openings: parseOptions(answer.openings, PRODUCT_AD_OPENING_KINDS),
    endings: parseOptions(answer.endings, PRODUCT_AD_ENDING_KINDS),
    postIntro: clean(answer.postIntro),
    ctwa: {
      headline: clean(ctwa.headline),
      primaryText: clean(ctwa.primaryText),
      greeting: clean(ctwa.greeting),
      questions: (Array.isArray(ctwa.questions) ? ctwa.questions : []).map(
        clean,
      ),
    },
  };
}

/** The room an option's English gloss has; the studio shows it under the option. */
export const GLOSS_LIMIT: ProductAdTextLimit = { chars: 80 };

/**
 * What's wrong with one text standing in for the sticker or the ending: the
 * shared checks at `limit`, Kazakh's spelling and a price said in words.
 */
function wordsIssues(
  field: string,
  text: string,
  limit: ProductAdTextLimit,
  request: ScriptRequest,
): string[] {
  return [
    ...productAdTextIssues(field, text, limit),
    ...kazakhTextIssues([[field, text]], request),
    ...spokenPriceTextIssues([[field, text]], request),
  ];
}

/**
 * The options that pass every check the words they stand in for pass,
 * each with a gloss that holds no price (or none); and what was wrong with
 * those dropped, for a repair call.
 */
function checkedOptions<K extends string>(
  field: "openings" | "endings",
  options: ReadonlyArray<ProductAdOption<K>>,
  limit: ProductAdTextLimit,
  request: ScriptRequest,
): { kept: ProductAdOption<K>[]; issues: string[] } {
  const kept: ProductAdOption<K>[] = [];
  const issues: string[] = [];
  options.forEach((option, index) => {
    const found = [
      ...wordsIssues(`${field}[${index}].text`, option.text, limit, request),
      // One of each kind, at most three: parseOptions saw to it, but a
      // script from elsewhere is checked the same way.
      ...productAdOptionIssues(field, [...kept, option], limit).filter(
        (issue) => !issue.startsWith(`${field}[`),
      ),
    ];
    if (found.length) {
      issues.push(...found);
      return;
    }
    // The gloss is the owner's only, in English: a price or a digit in it is
    // dropped, never the option.
    const gloss =
      productAdTextIssues("gloss", option.gloss, GLOSS_LIMIT).length === 0
        ? option.gloss
        : "";
    kept.push({ ...option, gloss });
  });
  return { kept, issues };
}

/**
 * The script with its openings and endings checked: a failing option is
 * dropped. The sticker and the ending are Muse Spark's own picks; when one
 * is missing, or fails its checks, the first opening (or ending) that
 * passes takes its place. `issues` lists what was wrong with the options
 * dropped, for a repair call the script needs anyway.
 */
export function withCheckedOptions(
  rawScript: AdScript,
  request: ScriptRequest,
): { script: AdScript; issues: string[] } {
  const script = cleanAdScriptForLanguage(
    rawScript,
    request.language,
    request.wordsCode,
  );
  const limits = PRODUCT_AD_TEXT_LIMITS;
  const openings = checkedOptions(
    "openings",
    script.openings ?? [],
    limits.sticker,
    request,
  );
  const endings = checkedOptions(
    "endings",
    script.endings ?? [],
    limits.ending,
    request,
  );
  const fails = (field: string, text: string, limit: ProductAdTextLimit) =>
    !text.trim() || wordsIssues(field, text, limit, request).length > 0;
  const sticker =
    fails("sticker", script.sticker, limits.sticker) && openings.kept[0]
      ? openings.kept[0].text
      : script.sticker;
  const ending =
    fails("ending", script.ending, limits.ending) && endings.kept[0]
      ? endings.kept[0].text
      : script.ending;
  return {
    script: {
      ...script,
      sticker,
      ending,
      openings: openings.kept,
      endings: endings.kept,
    },
    issues: [...openings.issues, ...endings.issues],
  };
}

type FallbackWords = {
  sticker: Record<"new" | "gift", string>;
  caption: Record<"new" | "gift", string>;
  priceCardTitle: string;
  ending: string;
  /** The sticker's and the ending's English glosses, for the studio's options. */
  stickerGloss: Record<"new" | "gift", string>;
  endingGloss: string;
  postIntro: Record<"new" | "gift", string>;
  headline: Record<"new" | "gift", string>;
  primaryText: string;
  greeting: string;
  questions: string[];
};

// The code's own words, for an ad Muse Spark couldn't write. Kazakh to be
// confirmed by a native speaker.
const FALLBACK: Record<ProductShopWordsCode, FallbackWords> = {
  kk: {
    sticker: { new: "Сөремізде жаңа тауар", gift: "Сыйлыққа тамаша" },
    caption: { new: "Қазір сөреде бар", gift: "Сыйлыққа лайық" },
    priceCardTitle: "Біздің бағалар",
    ending: "Тапсырыс беру үшін жазыңыз",
    stickerGloss: { new: "New on our shelf", gift: "Great as a gift" },
    endingGloss: "Message us to order",
    postIntro: {
      new: "Сөремізде жаңа тауарлар бар.",
      gift: "Сыйлық іздеп жүрсеңіз, мына тауарларды қараңыз.",
    },
    headline: {
      new: "Сөремізде жаңа тауарлар",
      gift: "Сыйлыққа тамаша тауарлар",
    },
    primaryText: "Ұнағанын таңдап, WhatsApp-қа жазыңыз.",
    greeting: "Сәлеметсіз бе! Қандай тауар қызықтырады?",
    questions: [
      "Жеткізу бар ма?",
      "Қай жерде орналасқансыз?",
      "Басқа түсі бар ма?",
    ],
  },
  ru: {
    sticker: { new: "Новинка на полке", gift: "Идея для подарка" },
    caption: { new: "Уже на полке", gift: "Отличный подарок" },
    priceCardTitle: "Наши цены",
    ending: "Пишите нам в WhatsApp",
    stickerGloss: { new: "New on the shelf", gift: "A gift idea" },
    endingGloss: "Message us on WhatsApp",
    postIntro: {
      new: "У нас на полке новинки.",
      gift: "Ищете подарок? Посмотрите эти товары.",
    },
    headline: { new: "Новинки на нашей полке", gift: "Идеи для подарка" },
    primaryText: "Выберите, что понравится, и напишите нам в WhatsApp.",
    greeting: "Здравствуйте! Какой товар вас интересует?",
    questions: ["Есть доставка?", "Где вы находитесь?", "Есть другие цвета?"],
  },
  en: {
    sticker: { new: "New on the shelf", gift: "A gift idea" },
    caption: { new: "On the shelf now", gift: "A lovely gift" },
    priceCardTitle: "Our prices",
    ending: "Message us on WhatsApp",
    stickerGloss: { new: "New on the shelf", gift: "A gift idea" },
    endingGloss: "Message us on WhatsApp",
    postIntro: {
      new: "New on our shelf.",
      gift: "Looking for a gift? Have a look at these.",
    },
    headline: { new: "New on our shelf", gift: "Gift ideas from our shelf" },
    primaryText: "Pick the one you like and message us on WhatsApp.",
    greeting: "Hello! Which product are you interested in?",
    questions: [
      "Do you deliver?",
      "Where are you located?",
      "Do you have other colours?",
    ],
  },
};

const DEFAULT_SETTING: ProductAdSetting = "oak_table_window";

/**
 * The code's own script, in the ad's fixed words' language: preset words for
 * the idea, the owner's own idea where it fits, and the oak table for every
 * scene; one opening (its sticker, as news) and one ending (as order). It
 * always passes the checks.
 */
export function fallbackAdScript(request: ScriptRequest): AdScript {
  const words = FALLBACK[request.wordsCode ?? "en"];
  const kind = request.idea.kind === "gift" ? "gift" : "new";
  const own =
    request.idea.kind === "own" ? (request.idea.text?.trim() ?? "") : "";
  const fits = (field: keyof typeof PRODUCT_AD_TEXT_LIMITS) =>
    own !== "" &&
    productAdTextIssues(field, own, PRODUCT_AD_TEXT_LIMITS[field]).length === 0;
  const sticker = fits("sticker") ? own : words.sticker[kind];
  const opening: ProductAdOption<ProductAdOpeningKind> = {
    text: sticker,
    kind: "news",
    gloss: fits("sticker") ? "Your own idea" : words.stickerGloss[kind],
  };
  const ending: ProductAdOption<ProductAdEndingKind> = {
    text: words.ending,
    kind: "order",
    gloss: words.endingGloss,
  };
  return {
    openings: [opening],
    endings: [ending],
    sticker,
    scenes: request.products.map((product) => {
      const spoken = fallbackSpokenLine(request, product);
      return {
        productId: product.productId,
        caption: words.caption[kind],
        setting: DEFAULT_SETTING,
        ...(spoken ? { spoken } : {}),
      };
    }),
    priceCardTitle: words.priceCardTitle,
    ending: words.ending,
    postIntro: fits("postIntro") ? own : words.postIntro[kind],
    ctwa: {
      headline: words.headline[kind],
      primaryText: words.primaryText,
      greeting: words.greeting,
      questions: [...words.questions],
    },
  };
}

export type WrittenScript = {
  script: AdScript;
  /** muse: the first answer passed; repaired: the second did; fallback: the code wrote it. */
  source: "muse" | "repaired" | "fallback";
  /** What was wrong with the answers that didn't pass. */
  problems: string[];
};

/**
 * Writes the ad's script: Muse Spark's answer when it passes the checks, else
 * one repair call with the problems listed, else the code's own words. A
 * Muse Spark error (a refusal, an outage, an answer that isn't JSON) counts
 * as a failed answer. `ask` makes one paid call; anything it throws that
 * isn't a Meta model error (the ledger refusing the spend) is thrown on.
 */
export async function writeAdScript(
  request: ScriptRequest,
  ask: (question: string, call: 1 | 2) => Promise<unknown>,
): Promise<WrittenScript> {
  const productIds = request.products.map((product) => product.productId);
  const problems: string[] = [];
  let issues: string[] = [];
  for (const call of [1, 2] as const) {
    let answer: unknown;
    try {
      answer = await ask(adScriptPrompt(request, issues), call);
    } catch (error) {
      if (!(error instanceof MetaModelApiError)) throw error;
      issues = [];
      problems.push(`call ${call}: ${error.message}`);
      continue;
    }
    // A failing opening or ending is dropped, and never fails the script on
    // its own; a repair call the script needs anyway lists it too.
    const checked = withCheckedOptions(
      parseAdScript(answer, productIds),
      request,
    );
    const script = checked.script;
    issues = [
      ...productAdScriptIssues(script, productIds),
      ...kazakhSpellingIssues(script, request),
      ...spokenPriceIssues(script, request),
      ...spokenLineIssues(script, request),
    ];
    if (issues.length === 0) {
      problems.push(...checked.issues.map((issue) => `call ${call}: ${issue}`));
      return { script, source: call === 1 ? "muse" : "repaired", problems };
    }
    issues.push(...checked.issues);
    problems.push(...issues.map((issue) => `call ${call}: ${issue}`));
  }
  return { script: fallbackAdScript(request), source: "fallback", problems };
}

/**
 * The narration lines about a product: the line holding its price quote
 * (or, without the quote in the narration, the line being said when its
 * clip starts), the line before it, and the line after it only while the
 * product's own clip still runs. A line where another of the ad's products
 * has its price said is that product's. The paid gate's Shezhire panel got
 * the next line, the medal hanger's "winner's corner", as its caption: it
 * starts at 11.0 s, as the panel's clip ends.
 */
export function saidAround(
  transcript: string | null,
  priceQuote: string | null,
  clip: { fromSeconds: number; toSeconds: number } | null,
  otherQuotes: readonly string[] = [],
): string[] {
  const lines = (transcript ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  const words = (text: string) =>
    text
      .replace(/\[\d+(?:\.\d+)?\]/g, " ")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const startOf = (line: string) =>
    Number(/^\[(\d+(?:\.\d+)?)\]/.exec(line)?.[1]);
  let index = -1;
  const needle = priceQuote ? words(priceQuote) : "";
  if (needle) index = lines.findIndex((line) => words(line).includes(needle));
  if (index < 0 && clip !== null) {
    lines.forEach((line, i) => {
      const at = startOf(line);
      if (Number.isFinite(at) && at <= clip.fromSeconds + 0.5) index = i;
    });
  }
  if (index < 0) return [];
  const others = otherQuotes.map(words).filter(Boolean);
  const anothers = (line: string) =>
    others.some((quote) => words(line).includes(quote));
  const before = lines[index - 1];
  const after = lines[index + 1];
  const afterStarts = after ? startOf(after) : Number.NaN;
  return [
    ...(before && !anothers(before) ? [before] : []),
    lines[index]!,
    ...(after &&
    !anothers(after) &&
    clip !== null &&
    Number.isFinite(afterStarts) &&
    afterStarts < clip.toSeconds
      ? [after]
      : []),
  ];
}
