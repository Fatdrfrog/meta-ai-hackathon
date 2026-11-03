// How a price is said in the shop languages (Kazakh, Russian, English): the
// number words, and where in the owner's own words their price is. The ad
// worker refuses a script that says a price in words (prices are drawn by
// code), and the import stage's "What you said" sets the price words apart.
// Pure and without dependencies. apps/web type-checks this file at target
// ES2017, so its regexes use no lookbehind, named groups or Unicode property
// escapes.

// Kazakh's number words take endings ("мыңға", "жүзден"); so do the big
// ones in every language ("миллиона", "thousands"). Russian's other number
// words change inside instead, so only their own forms count: "стол" (a
// table) isn't "сто".
const KAZAKH = [
  ...["бір", "екі", "үш", "төрт", "бес", "алты", "жеті", "сегіз", "тоғыз"],
  ...["он", "жиырма", "отыз", "қырық", "елу", "алпыс", "жетпіс", "сексен"],
  ...["тоқсан", "жүз", "мың"],
];
const BIG = [
  "миллион",
  "миллиард",
  "thousand",
  "million",
  "billion",
  "hundred",
];
const RUSSIAN = [
  ...["ноль", "один", "одна", "одно", "два", "две", "три", "четыре", "пять"],
  ...["шесть", "семь", "восемь", "девять", "десять", "одиннадцать"],
  ...["двенадцать", "тринадцать", "четырнадцать", "пятнадцать"],
  ...["шестнадцать", "семнадцать", "восемнадцать", "девятнадцать"],
  ...["двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят"],
  ...["семьдесят", "восемьдесят", "девяносто", "сто", "двести", "триста"],
  ...["четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот"],
  ...["девятьсот", "тысяча", "тысячи", "тысяч", "тысячу", "полторы"],
  ...["полтора"],
];
const ENGLISH = [
  ...["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"],
  ...["nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen"],
  ...["sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty"],
  ...["forty", "fifty", "sixty", "seventy", "eighty", "ninety"],
];

/** The words a price is said with (paid gate: «кукла бес мың», «бес жүз теңге»). */
export const SPOKEN_NUMBER_WORDS: ReadonlySet<string> = new Set([
  ...KAZAKH,
  ...BIG,
  ...RUSSIAN,
  ...ENGLISH,
]);
const WITH_ENDINGS: ReadonlySet<string> = new Set([...KAZAKH, ...BIG]);

const length = (text: string) => Array.from(text).length;

/**
 * Whether `word` (lower-cased) is the number word `said`: the same word, or
 * for one that takes endings, a word of 3 letters or more with up to 4
 * letters after it. "үшін" (for) isn't "үш" (three).
 */
export function saysSpokenWord(word: string, said: string): boolean {
  if (word === said) return true;
  if (!WITH_ENDINGS.has(said)) return false;
  const saidLength = length(said);
  return (
    saidLength >= 3 && word.startsWith(said) && length(word) - saidLength <= 4
  );
}

/** The number word `word` says ("мың" for "мыңға"), the longest; null for none. */
export function spokenNumberRoot(word: string): string | null {
  let root: string | null = null;
  SPOKEN_NUMBER_WORDS.forEach((said) => {
    if (
      saysSpokenWord(word, said) &&
      (root === null || said.length > root.length)
    )
      root = said;
  });
  return root;
}

// A price's currency as owners say it: the start of the word, for the
// endings it takes ("теңгеден", "рублей", "dollars").
const CURRENCY_STEMS = [
  "теңге",
  "тенге",
  "тг",
  "рубл",
  "руб",
  "доллар",
  "евро",
  "сом",
  "сум",
  "tenge",
  "dollar",
  "euro",
  "rouble",
  "ruble",
];
const CURRENCY_SIGNS = "₸$€₽£¥";

// Words (Latin and Cyrillic letters), numbers ("15 500", "9.99") and signs.
const WORD = "[A-Za-zÀ-ɏЀ-ԯ]+";
const TOKEN = `[0-9]+(?:[ \\u00a0.,][0-9]+)*|${WORD}|[${CURRENCY_SIGNS}]`;

/**
 * What a word of the owner's is to a price said in it: a number (digits or
 * a number word as it is), a number word with an ending («мыңға»), a
 * currency word or sign; null for none, and for a word of the product's
 * own name.
 */
type PriceWord = "number" | "ending" | "currency" | "sign";

function priceWord(token: string, name: ReadonlySet<string>): PriceWord | null {
  if (/^[0-9]/.test(token)) return "number";
  if (CURRENCY_SIGNS.includes(token)) return "sign";
  const word = token.toLowerCase();
  if (name.has(word)) return null;
  const root = spokenNumberRoot(word);
  if (root !== null) return root === word ? "number" : "ending";
  return CURRENCY_STEMS.some((stem) => word.startsWith(stem))
    ? "currency"
    : null;
}

/**
 * Where in the owner's words their price is: the last run of numbers,
 * number words and currency words in it («бес жүз теңге» in «мына кружка
 * бес жүз теңге»), as `quote.slice(start, end)`; null when none is said.
 * A number word with an ending and a currency word count only right after
 * a number, with nothing but a space between: «жүзім» (grapes), «бесік» (a
 * cradle), «, бірақ» (but) and «сумка» (a bag) only start like one, and
 * «бес мыңға» or «15 мыңнан» stay whole. The words of the product's own
 * `name` aren't its price, as in the ad worker's reading.
 */
export function spokenPriceSpan(
  quote: string,
  name?: string | null,
): { start: number; end: number } | null {
  const own = new Set(
    (name?.match(new RegExp(WORD, "g")) ?? []).map((word) =>
      word.toLowerCase(),
    ),
  );
  const tokens = new RegExp(TOKEN, "g");
  let span: { start: number; end: number } | null = null;
  let run: { start: number; end: number } | null = null;
  // The run's last word, and where it ends.
  let last: PriceWord | null = null;
  let lastEnd = 0;
  for (let match = tokens.exec(quote); match; match = tokens.exec(quote)) {
    const start = match.index;
    const end = start + match[0].length;
    const word = priceWord(match[0], own);
    const afterNumber =
      (last === "number" || last === "ending") &&
      !/\S/.test(quote.slice(lastEnd, start));
    if (word === "number" || word === "sign" || (word && afterNumber)) {
      run = run ? { start: run.start, end } : { start, end };
      span = run;
      last = word;
    } else {
      run = null;
      last = null;
    }
    lastEnd = end;
  }
  return span;
}
