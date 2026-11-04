// The ad's voices (Part V): airi's curated ElevenLabs voices, and the pure
// helpers the web and the worker share about what a voice says. A price is
// never the model's: the voice-over's line is Muse Spark's words without a
// number, and code adds the shelf price after it, in Kazakh, Russian or
// English number words, then reads its own words back to check they say the
// shelf's amount. Pure and without dependencies. apps/web type-checks this
// file at target ES2017, so its regexes use no lookbehind, named groups or
// Unicode property escapes.

import type { ProductAdVoiceMode, ProductShopWordsCode } from "./contracts";
import { spokenNumberRoot, spokenPriceSpan } from "./spoken-price";

/**
 * One of airi's "Airi voices": an ElevenLabs premade voice that speaks the
 * shop languages, with the name and a few English words the picker shows.
 */
export type ProductAdStockVoice = {
  /** ElevenLabs' voice id. */
  id: string;
  name: string;
  /** "Warm, unhurried", for the picker. */
  about: string;
  /** The shop languages it reads well; the picker offers it only for these. */
  languages: readonly ProductShopWordsCode[];
};

/**
 * The curated voices an ad may be read in ("stock" mode): ElevenLabs'
 * premade voices, free to use on airi's own key, read by Eleven v4 in
 * Kazakh, Russian and English. Each id was checked with GET /v2/voices on
 * airi's account on 2026-11-03 (category "premade"). Their samples in each
 * language are made once (GET /products/voice/samples).
 */
export const PRODUCT_AD_STOCK_VOICES: readonly ProductAdStockVoice[] = [
  {
    id: "cgSgspJ2msm6clMCkdW9",
    name: "Jessica",
    about: "Bright and warm",
    languages: ["kk", "ru", "en"],
  },
  {
    id: "TX3LPaxmHKxFdv7VOQHJ",
    name: "Liam",
    about: "Lively, made for social video",
    languages: ["kk", "ru", "en"],
  },
  {
    id: "EXAVITQu4vr4xnSDxMaL",
    name: "Sarah",
    about: "Calm and reassuring",
    languages: ["kk", "ru", "en"],
  },
  {
    id: "nPczCjzI2devNBz1zQrb",
    name: "Brian",
    about: "Deep and comforting",
    languages: ["kk", "ru", "en"],
  },
];

/** The listed voice with this id; null for any other. */
export function productAdStockVoice(id: unknown): ProductAdStockVoice | null {
  return PRODUCT_AD_STOCK_VOICES.find((voice) => voice.id === id) ?? null;
}

/**
 * Whether going back to "Your recording" may cost AI on a finished ad: the
 * owner's clips are cleaned up once (ElevenLabs' Voice Isolator, booked in
 * the ad's action) and kept. An ad made in the recording, or whose new
 * words fell back to it, has them kept; any other may not, so it's counted
 * as paid (at worst an ad made in the recording and changed twice is told
 * of a cent it won't pay).
 */
export function productAdRecordingIsPaid(ad: {
  voice: ProductAdVoiceMode;
  voiceResult?: { used: ProductAdVoiceMode } | null;
}): boolean {
  return ad.voice !== "own" && ad.voiceResult?.used !== "own";
}

/**
 * What an Airi voice's sample says in each shop language: short, with no
 * price, so one sample serves every shop.
 */
export const PRODUCT_AD_VOICE_SAMPLE_TEXT: Readonly<
  Record<ProductShopWordsCode, string>
> = {
  kk: "Сәлеметсіз бе! Біздің сөреде жаңа тауарлар бар. Тапсырыс беру үшін бізге жазыңыз.",
  ru: "Здравствуйте! У нас на полке новые товары. Чтобы заказать, напишите нам.",
  en: "Hello! New pieces just arrived on our shelf. Message us to order yours.",
};

// ---------------------------------------------------------------------------
// The language the voice-over speaks.

/** A language code has number words written by code: kk, ru or en. */
export type ProductAdSpeechCode = ProductShopWordsCode;

/**
 * The language the voice-over's lines are in, as a code with number words:
 * the language the owner spoke as Muse Spark named it ("Kazakh", «қазақ
 * тілі», "ru"), else the ad's fixed words; null for any other language
 * (Uzbek, Turkish…), which the voice reads without a spoken price.
 */
export function productAdSpeechCode(
  language: string | null | undefined,
  wordsCode: ProductShopWordsCode | null | undefined,
): ProductAdSpeechCode | null {
  const spoken = (language ?? "").trim().toLowerCase();
  if (!spoken) return wordsCode ?? "en";
  if (/^(kazakh|kazak|qazaq|қазақ|казах|kaz$|kk$)/.test(spoken)) return "kk";
  if (/^(russian|русск|орыс|rus$|ru$)/.test(spoken)) return "ru";
  if (/^(english|англ|ағылшын|eng$|en$)/.test(spoken)) return "en";
  return null;
}

// ---------------------------------------------------------------------------
// The shelf price, read back from the text code drew.

/** A shelf price as an ad's `priceText` holds it ("15 500 ₸ бастап"). */
export type ProductAdShelfPrice = {
  amount: number;
  /** The ISO code ("KZT" for ₸); null when no currency was said or shown. */
  currency: string | null;
  /** A starting price ("from"). */
  from: boolean;
};

const SPACES = /[   ]/g;

/**
 * The price in an ad's `priceText`, which code drew from the shelf
 * (`buyerPrice`): an amount with spaced thousands and an optional fraction,
 * an optional "₸" or ISO code, and the shop words' "from" ("бастап", "от",
 * "from"). Null for any other text.
 */
export function productAdShelfPrice(
  priceText: string,
): ProductAdShelfPrice | null {
  let text = priceText.replace(SPACES, " ").trim().replace(/\s+/g, " ");
  let from = false;
  const kk = /^(.+) бастап$/.exec(text);
  const ru = /^от (.+)$/i.exec(text);
  const en = /^from (.+)$/i.exec(text);
  const lead = kk ?? ru ?? en;
  if (lead) {
    from = true;
    text = lead[1]!;
  }
  const match =
    /^(\d{1,3}(?: \d{3})+|\d+)(?:\.(\d{1,3}))?(?: (₸|[A-Z]{3}))?$/.exec(text);
  if (!match) return null;
  const whole = Number(match[1]!.replace(/ /g, ""));
  const fraction = match[2] ? Number(match[2]) / 10 ** match[2].length : 0;
  const amount = whole + fraction;
  if (!Number.isFinite(amount)) return null;
  const sign = match[3] ?? null;
  return { amount, currency: sign === "₸" ? "KZT" : sign, from };
}

// ---------------------------------------------------------------------------
// Number words: Kazakh, Russian (nominative, and genitive after «от») and
// English, for whole amounts up to the shelf's cap.

const KK_UNITS = [
  "",
  "бір",
  "екі",
  "үш",
  "төрт",
  "бес",
  "алты",
  "жеті",
  "сегіз",
  "тоғыз",
];
const KK_TENS = [
  "",
  "он",
  "жиырма",
  "отыз",
  "қырық",
  "елу",
  "алпыс",
  "жетпіс",
  "сексен",
  "тоқсан",
];
const KK_SCALES = ["", "мың", "миллион", "миллиард", "триллион"];

// Kazakh's ablative ("-дан", "-ден", "-тан", "-тен", "-нан", "-нен") on the
// word a starting price ends with, before «бастап»: by the last sound and
// the word's vowels. The number words and currencies are a closed set.
const KK_ABLATIVE: Readonly<Record<string, string>> = {
  бір: "бірден",
  екі: "екіден",
  үш: "үштен",
  төрт: "төрттен",
  бес: "бестен",
  алты: "алтыдан",
  жеті: "жетіден",
  сегіз: "сегізден",
  тоғыз: "тоғыздан",
  он: "оннан",
  жиырма: "жиырмадан",
  отыз: "отыздан",
  қырық: "қырықтан",
  елу: "елуден",
  алпыс: "алпыстан",
  жетпіс: "жетпістен",
  сексен: "сексеннен",
  тоқсан: "тоқсаннан",
  жүз: "жүзден",
  мың: "мыңнан",
  миллион: "миллионнан",
  миллиард: "миллиардтан",
  триллион: "триллионнан",
  теңге: "теңгеден",
  рубль: "рубльден",
  доллар: "доллардан",
  еуро: "еуродан",
  сом: "сомнан",
  сум: "сумнан",
};

type RuCase = "nominative" | "genitive";

const RU_UNITS: Record<RuCase, { m: string[]; f: string[] }> = {
  nominative: {
    m: [
      "",
      "один",
      "два",
      "три",
      "четыре",
      "пять",
      "шесть",
      "семь",
      "восемь",
      "девять",
    ],
    f: [
      "",
      "одна",
      "две",
      "три",
      "четыре",
      "пять",
      "шесть",
      "семь",
      "восемь",
      "девять",
    ],
  },
  genitive: {
    m: [
      "",
      "одного",
      "двух",
      "трёх",
      "четырёх",
      "пяти",
      "шести",
      "семи",
      "восьми",
      "девяти",
    ],
    f: [
      "",
      "одной",
      "двух",
      "трёх",
      "четырёх",
      "пяти",
      "шести",
      "семи",
      "восьми",
      "девяти",
    ],
  },
};
const RU_TEENS: Record<RuCase, string[]> = {
  nominative: [
    "десять",
    "одиннадцать",
    "двенадцать",
    "тринадцать",
    "четырнадцать",
    "пятнадцать",
    "шестнадцать",
    "семнадцать",
    "восемнадцать",
    "девятнадцать",
  ],
  genitive: [
    "десяти",
    "одиннадцати",
    "двенадцати",
    "тринадцати",
    "четырнадцати",
    "пятнадцати",
    "шестнадцати",
    "семнадцати",
    "восемнадцати",
    "девятнадцати",
  ],
};
const RU_TENS: Record<RuCase, string[]> = {
  nominative: [
    "",
    "",
    "двадцать",
    "тридцать",
    "сорок",
    "пятьдесят",
    "шестьдесят",
    "семьдесят",
    "восемьдесят",
    "девяносто",
  ],
  genitive: [
    "",
    "",
    "двадцати",
    "тридцати",
    "сорока",
    "пятидесяти",
    "шестидесяти",
    "семидесяти",
    "восьмидесяти",
    "девяноста",
  ],
};
const RU_HUNDREDS: Record<RuCase, string[]> = {
  nominative: [
    "",
    "сто",
    "двести",
    "триста",
    "четыреста",
    "пятьсот",
    "шестьсот",
    "семьсот",
    "восемьсот",
    "девятьсот",
  ],
  genitive: [
    "",
    "ста",
    "двухсот",
    "трёхсот",
    "четырёхсот",
    "пятисот",
    "шестисот",
    "семисот",
    "восьмисот",
    "девятисот",
  ],
};
/** A noun after a number: [after 1, after 2-4, after 5-20 and 0] in the nominative. */
type RuForms = { one: string; few: string; many: string; genOne: string };
const RU_SCALES: Array<RuForms & { feminine: boolean }> = [
  { one: "", few: "", many: "", genOne: "", feminine: false },
  {
    one: "тысяча",
    few: "тысячи",
    many: "тысяч",
    genOne: "тысячи",
    feminine: true,
  },
  {
    one: "миллион",
    few: "миллиона",
    many: "миллионов",
    genOne: "миллиона",
    feminine: false,
  },
  {
    one: "миллиард",
    few: "миллиарда",
    many: "миллиардов",
    genOne: "миллиарда",
    feminine: false,
  },
  {
    one: "триллион",
    few: "триллиона",
    many: "триллионов",
    genOne: "триллиона",
    feminine: false,
  },
];

const EN_ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const EN_TENS = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];
const EN_SCALES = ["", "thousand", "million", "billion", "trillion"];

/** The amount's groups of three digits, the lowest first. */
function groupsOf(amount: number): number[] {
  const groups: number[] = [];
  let rest = amount;
  do {
    groups.push(rest % 1000);
    rest = Math.floor(rest / 1000);
  } while (rest > 0);
  return groups;
}

/** Russian's noun form after `n`, by its last two digits, in `grammaticalCase`. */
function ruForm(n: number, forms: RuForms, grammaticalCase: RuCase): string {
  const lastTwo = n % 100;
  const last = n % 10;
  const one = last === 1 && lastTwo !== 11;
  if (grammaticalCase === "genitive") return one ? forms.genOne : forms.many;
  if (one) return forms.one;
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14))
    return forms.few;
  return forms.many;
}

function kkUnder1000(n: number): string[] {
  const words: string[] = [];
  const hundreds = Math.floor(n / 100);
  const tens = Math.floor((n % 100) / 10);
  const units = n % 10;
  if (hundreds > 0) {
    if (hundreds > 1) words.push(KK_UNITS[hundreds]!);
    words.push("жүз");
  }
  if (tens > 0) words.push(KK_TENS[tens]!);
  if (units > 0) words.push(KK_UNITS[units]!);
  return words;
}

function ruUnder1000(
  n: number,
  feminine: boolean,
  grammaticalCase: RuCase,
): string[] {
  const words: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds > 0) words.push(RU_HUNDREDS[grammaticalCase][hundreds]!);
  if (rest >= 10 && rest < 20)
    words.push(RU_TEENS[grammaticalCase][rest - 10]!);
  else {
    const tens = Math.floor(rest / 10);
    const units = rest % 10;
    if (tens > 0) words.push(RU_TENS[grammaticalCase][tens]!);
    if (units > 0)
      words.push(RU_UNITS[grammaticalCase][feminine ? "f" : "m"][units]!);
  }
  return words;
}

function enUnder1000(n: number): string[] {
  const words: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds > 0) words.push(EN_ONES[hundreds]!, "hundred");
  if (rest > 0)
    words.push(
      rest < 20
        ? EN_ONES[rest]!
        : EN_TENS[Math.floor(rest / 10)]! +
            (rest % 10 ? `-${EN_ONES[rest % 10]}` : ""),
    );
  return words;
}

/**
 * A whole amount in words: Kazakh («он бес мың бес жүз»), Russian in the
 * nominative or, after «от», the genitive («пятнадцати тысяч пятисот»), or
 * English ("fifteen thousand five hundred"). A leading one thousand (and
 * Kazakh's one hundred) is said without its "one", as people say it. Null
 * for an amount that isn't a whole number from 0 below 10^15.
 */
export function productAdNumberWords(
  amount: number,
  code: ProductAdSpeechCode,
  grammaticalCase: RuCase = "nominative",
): string | null {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount >= 1e15)
    return null;
  if (amount === 0)
    return code === "kk"
      ? "нөл"
      : code === "ru"
        ? grammaticalCase === "genitive"
          ? "нуля"
          : "ноль"
        : "zero";
  const groups = groupsOf(amount);
  const words: string[] = [];
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index]!;
    if (group === 0) continue;
    const leading = index === groups.length - 1;
    if (code === "kk") {
      if (!(index === 1 && group === 1 && leading))
        words.push(...kkUnder1000(group));
      if (index > 0) words.push(KK_SCALES[index]!);
    } else if (code === "ru") {
      const scale = RU_SCALES[index]!;
      if (!(index > 0 && group === 1 && leading))
        words.push(
          ...ruUnder1000(
            group,
            index === 0 ? false : scale.feminine,
            grammaticalCase,
          ),
        );
      if (index > 0) words.push(ruForm(group, scale, grammaticalCase));
    } else {
      words.push(...enUnder1000(group));
      if (index > 0) words.push(EN_SCALES[index]!);
    }
  }
  return words.join(" ");
}

// The currency's word in each language: Kazakh's never changes after a
// number; Russian's agrees with it; English's is plural but after one.
const KK_CURRENCY: Readonly<Record<string, string>> = {
  KZT: "теңге",
  RUB: "рубль",
  USD: "доллар",
  EUR: "еуро",
  KGS: "сом",
  UZS: "сум",
};
const RU_CURRENCY: Readonly<Record<string, RuForms>> = {
  KZT: { one: "тенге", few: "тенге", many: "тенге", genOne: "тенге" },
  RUB: { one: "рубль", few: "рубля", many: "рублей", genOne: "рубля" },
  USD: { one: "доллар", few: "доллара", many: "долларов", genOne: "доллара" },
  EUR: { one: "евро", few: "евро", many: "евро", genOne: "евро" },
  KGS: { one: "сом", few: "сома", many: "сомов", genOne: "сома" },
  UZS: { one: "сум", few: "сума", many: "сумов", genOne: "сума" },
};
const EN_CURRENCY: Readonly<Record<string, [one: string, many: string]>> = {
  KZT: ["tenge", "tenge"],
  RUB: ["ruble", "rubles"],
  USD: ["dollar", "dollars"],
  EUR: ["euro", "euros"],
  KGS: ["som", "som"],
  UZS: ["sum", "sum"],
};

/**
 * The shelf price as the voice-over says it, written by code: a short
 * sentence after Muse Spark's line («Бағасы — он бес мың бес жүз
 * теңгеден бастап.», «Цена — от пятнадцати тысяч пятисот тенге.», "Price:
 * from fifteen thousand five hundred tenge."). Null when code can't say it:
 * a price with a fraction, a currency it has no word for, or a language
 * other than Kazakh, Russian and English. The video still draws it.
 */
export function productAdPriceSpeech(
  price: ProductAdShelfPrice,
  code: ProductAdSpeechCode,
): string | null {
  if (!Number.isSafeInteger(price.amount)) return null;
  const currency = price.currency;
  if (code === "kk") {
    const number = productAdNumberWords(price.amount, "kk");
    if (number === null) return null;
    if (currency !== null && !Object.hasOwn(KK_CURRENCY, currency)) return null;
    const words = [
      ...number.split(" "),
      ...(currency ? [KK_CURRENCY[currency]!] : []),
    ];
    if (price.from) {
      const last = words.pop()!;
      const ablative = KK_ABLATIVE[last];
      if (!ablative) return null;
      words.push(ablative, "бастап");
    }
    return `Бағасы — ${words.join(" ")}.`;
  }
  if (code === "ru") {
    const grammaticalCase: RuCase = price.from ? "genitive" : "nominative";
    const number = productAdNumberWords(price.amount, "ru", grammaticalCase);
    if (number === null) return null;
    if (currency !== null && !Object.hasOwn(RU_CURRENCY, currency)) return null;
    const unit = currency
      ? ` ${ruForm(price.amount, RU_CURRENCY[currency]!, grammaticalCase)}`
      : "";
    return `Цена — ${price.from ? "от " : ""}${number}${unit}.`;
  }
  const number = productAdNumberWords(price.amount, "en");
  if (number === null) return null;
  if (currency !== null && !Object.hasOwn(EN_CURRENCY, currency)) return null;
  const unit = currency
    ? ` ${EN_CURRENCY[currency]![price.amount === 1 ? 0 : 1]}`
    : "";
  return `Price: ${price.from ? "from " : ""}${number}${unit}.`;
}

// ---------------------------------------------------------------------------
// Reading number words back.

type NumberWord =
  | { kind: "add"; value: number }
  | { kind: "times100" }
  | { kind: "scale"; value: number };

/** Every number word code writes, in every form, with what it adds. */
const NUMBER_WORDS: ReadonlyMap<string, NumberWord> = (() => {
  const words = new Map<string, NumberWord>();
  const add = (word: string, value: number) =>
    words.set(word, { kind: "add", value });
  KK_UNITS.forEach((word, value) => word && add(word, value));
  KK_TENS.forEach((word, value) => word && add(word, value * 10));
  EN_ONES.forEach((word, value) => add(word, value));
  EN_TENS.forEach((word, value) => word && add(word, value * 10));
  for (const grammaticalCase of ["nominative", "genitive"] as const) {
    for (const gender of ["m", "f"] as const)
      RU_UNITS[grammaticalCase][gender].forEach(
        (word, value) => word && add(word, value),
      );
    RU_TEENS[grammaticalCase].forEach((word, index) => add(word, 10 + index));
    RU_TENS[grammaticalCase].forEach(
      (word, value) => word && add(word, value * 10),
    );
    RU_HUNDREDS[grammaticalCase].forEach(
      (word, value) => word && add(word, value * 100),
    );
  }
  add("нөл", 0);
  add("ноль", 0);
  add("нуля", 0);
  words.set("жүз", { kind: "times100" });
  words.set("hundred", { kind: "times100" });
  KK_SCALES.forEach(
    (word, index) =>
      index && words.set(word, { kind: "scale", value: 1000 ** index }),
  );
  EN_SCALES.forEach(
    (word, index) =>
      index && words.set(word, { kind: "scale", value: 1000 ** index }),
  );
  RU_SCALES.forEach((forms, index) => {
    if (!index) return;
    for (const word of [forms.one, forms.few, forms.many, forms.genOne])
      words.set(word, { kind: "scale", value: 1000 ** index });
  });
  // A Kazakh starting price's last word, with its ablative.
  for (const [word, ablative] of Object.entries(KK_ABLATIVE)) {
    const plain = words.get(word);
    if (plain) words.set(ablative, plain);
  }
  // Russian's without «ё», as people also type it.
  for (const [word, value] of Array.from(words.entries()))
    if (word.indexOf("ё") >= 0) words.set(word.replace(/ё/g, "е"), value);
  return words;
})();

/** A text's words, lower-cased: runs of Latin or Cyrillic letters, or of digits. */
function tokensOf(
  text: string,
): Array<{ word: string; start: number; end: number }> {
  const tokens: Array<{ word: string; start: number; end: number }> = [];
  const pattern = /[0-9]+|[A-Za-zÀ-ɏЀ-ԯ]+/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text))
    tokens.push({
      word: match[0].toLowerCase(),
      start: match.index,
      end: match.index + match[0].length,
    });
  return tokens;
}

/**
 * The amount a run of number words says («он бес мың бес жүз» is 15 500),
 * reading every form code writes; null when the words aren't a number.
 */
export function productAdWordsAmount(words: readonly string[]): number | null {
  if (words.length === 0) return null;
  let total = 0;
  let current = 0;
  let any = false;
  for (const raw of words) {
    const word = NUMBER_WORDS.get(raw.toLowerCase());
    if (!word) return null;
    any = true;
    if (word.kind === "add") current += word.value;
    else if (word.kind === "times100") current = (current || 1) * 100;
    else {
      total += (current || 1) * word.value;
      current = 0;
    }
  }
  return any ? total + current : null;
}

/**
 * The amount a voice-over's price sentence says, read back from its words:
 * the one run of number words in it. Null when it has none, or more than
 * one run.
 */
export function productAdSpokenAmount(text: string): number | null {
  const runs: string[][] = [];
  let run: string[] | null = null;
  for (const { word } of tokensOf(text)) {
    if (NUMBER_WORDS.has(word)) {
      if (!run) runs.push((run = []));
      run.push(word);
    } else run = null;
  }
  return runs.length === 1 ? productAdWordsAmount(runs[0]!) : null;
}

/**
 * What's wrong with a price sentence code wrote, for the voice-over:
 * empty when its words read back as the shelf's amount and name its
 * currency. A failure is code's own mistake, so the voice-over never says it.
 */
export function productAdPriceSpeechIssues(
  sentence: string,
  price: ProductAdShelfPrice,
): string[] {
  const issues: string[] = [];
  const said = productAdSpokenAmount(sentence);
  if (said !== price.amount)
    issues.push(
      `The spoken price says ${said ?? "no amount"}, not ${price.amount}.`,
    );
  if (price.currency) {
    const words = new Set(tokensOf(sentence).map((token) => token.word));
    const names = [
      KK_CURRENCY[price.currency],
      KK_CURRENCY[price.currency] && KK_ABLATIVE[KK_CURRENCY[price.currency]!],
      ...Object.values(RU_CURRENCY[price.currency] ?? {}),
      ...(EN_CURRENCY[price.currency] ?? []),
    ].filter((name): name is string => Boolean(name));
    if (!names.some((name) => words.has(name)))
      issues.push(
        `The spoken price doesn't name its currency (${price.currency}).`,
      );
  }
  return issues;
}

// ---------------------------------------------------------------------------
// The model's line: no numbers, no prices.

// Number words that are also everyday words alone: Kazakh's «бір» (a, one)
// and «он» (ten, right), «жүз» (a hundred, a face), English "one", and
// Russian's «один» (alone). In a run with another number word they count.
const ALONE_OK = new Set(["бір", "он", "жүз", "one", "один", "одна", "одно"]);

// Currencies a line may not name: only code says a price.
const CURRENCY_WORDS = new Set([
  "теңге",
  "тенге",
  "тг",
  "рубль",
  "рубля",
  "рублей",
  "руб",
  "доллар",
  "доллара",
  "долларов",
  "евро",
  "еуро",
  "tenge",
  "dollar",
  "dollars",
  "euro",
  "euros",
  "ruble",
  "rubles",
  "rouble",
  "roubles",
]);
const CURRENCY_SIGNS = /[₸$€₽£¥]/;

/**
 * The numbers, prices and currencies a voice-over line of Muse Spark's says,
 * which only code may say: digits, number words (any form code writes, and
 * Kazakh's with endings after another number word, as the import's
 * spoken-price reader reads them), currency words and signs. The words of
 * the products' and the shop's own names don't count. Empty when it says none.
 */
export function productAdSpokenNumbers(
  text: string,
  names: readonly string[] = [],
): string[] {
  const own = new Set(
    names.flatMap((name) => tokensOf(name).map((token) => token.word)),
  );
  const found: string[] = [];
  if (CURRENCY_SIGNS.test(text)) found.push(CURRENCY_SIGNS.exec(text)![0]);
  let run: string[] = [];
  const close = () => {
    if (run.length > 1 || (run.length === 1 && !ALONE_OK.has(run[0]!)))
      found.push(run.join(" "));
    run = [];
  };
  for (const { word } of tokensOf(text)) {
    if (own.has(word)) {
      close();
      continue;
    }
    if (/^[0-9]/.test(word)) {
      // Digits always count.
      close();
      found.push(word);
      continue;
    }
    if (CURRENCY_WORDS.has(word)) {
      close();
      found.push(word);
      continue;
    }
    const root = spokenNumberRoot(word);
    const exact = NUMBER_WORDS.has(word) || root === word;
    if (exact || (root !== null && run.length > 0)) run.push(word);
    else close();
  }
  close();
  // The import's reader, for a price run it finds that the words above don't.
  const span = spokenPriceSpan(text, names.join(" "));
  if (span && found.length === 0) {
    const said = text.slice(span.start, span.end).trim();
    if (!ALONE_OK.has(said.toLowerCase()) && !own.has(said.toLowerCase()))
      found.push(said);
  }
  return found.map((entry) => entry.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// How long a line takes to say.

/** Letters and digits a voice reads per second, by language, at its usual pace. */
const READ_PER_SECOND: Readonly<Record<ProductAdSpeechCode, number>> = {
  kk: 13,
  ru: 14,
  en: 14.5,
};

/**
 * About how long a line takes to say, in seconds: its letters and digits at
 * the language's pace, with a short pause at each comma or dash and a
 * longer one between sentences. An estimate, to fit the words before paying
 * for them; the read audio is measured after.
 */
export function productAdSpeechSeconds(
  text: string,
  code: ProductAdSpeechCode | null,
): number {
  const letters = (text.match(/[0-9A-Za-zÀ-ɏЀ-ԯ]/g) ?? []).length;
  const commas = (text.match(/[,;:—–]/g) ?? []).length;
  const stops = (text.trim().match(/[.!?…]+(?=\s)/g) ?? []).length;
  return letters / READ_PER_SECOND[code ?? "en"] + commas * 0.15 + stops * 0.3;
}

// Kazakh's Cyrillic letters, Russian's among them (as the script's own check).
const KAZAKH_CYRILLIC = "аәбвгғдеёжзийкқлмнңоөпрстуұүфхһцчшщъыіьэюя";

/**
 * The Cyrillic letters in a Kazakh `text` that Kazakh doesn't use (Muse
 * Spark once wrote a Tatar «җ»), except those in `allowed` (the shop's and
 * products' own names). Empty when there are none.
 */
export function productAdForeignKazakhLetters(
  text: string,
  allowed = "",
): string[] {
  const own = allowed.toLowerCase();
  const foreign = new Set<string>();
  for (const char of Array.from(text.toLowerCase())) {
    const code = char.charCodeAt(0);
    if (
      code >= 0x400 &&
      code <= 0x4ff &&
      KAZAKH_CYRILLIC.indexOf(char) < 0 &&
      own.indexOf(char) < 0
    )
      foreign.add(char);
  }
  return Array.from(foreign);
}
