// Prices as shop owners say, show and type them, in any currency and any
// script. The import's price checks, the stored product and the owner's price
// editor share these rules. Pure and without dependencies, and nothing is
// built at import: the currency table and digit values are read on first use.
// Regex literals avoid lookbehind and named groups, because apps/web
// type-checks this file at target ES2017.

/** A sanity cap on prices, in the currency's own units (IRR and VND prices run high). */
export const PRODUCT_MAX_PRICE = 1_000_000_000_000;

/** The most decimals a stored price has (KWD, BHD, OMR, JOD, TND and LYD have 3). */
export const PRODUCT_PRICE_MAX_DECIMALS = 3;

// The currencies a price may be in, and their decimals, are fixed here, not
// read from the runtime's Intl data: runtimes disagree. Safari and Firefox
// give IQD 3 decimals and IDR, HUF and PKR 2, so "25,000" IQD would read as
// 25; Chrome gives RSD 0 and lacks SLE, XCG and ZWG; Safari and Firefox list
// codes no price is in, such as RUR and XXX. The worker, the server and every
// browser must read a typed price, and show a stored one, alike. This is the
// table Node 24 reports (ICU 78.3, CLDR 48), which the import was built on.
const CURRENCY_CODES =
  "AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND " +
  "BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUC CUP CVE CZK " +
  "DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD " +
  "HKD HNL HRK HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF " +
  "KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP " +
  "MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP " +
  "PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS " +
  "SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD " +
  "UYU UZS VES VND VUV WST XAF XCD XCG XDR XOF XPF XSU YER ZAR ZMW ZWG ZWL";
// Priced in whole units, as shops price them (25 000 IQD, 15 000 IDR)...
const WHOLE_UNIT_CURRENCIES =
  "AFN ALL BIF CLP COP DJF GNF HUF IDR IQD IRR ISK JPY KMF KPW KRW LAK LBP " +
  "MGA MMK PKR PYG RWF SLL SOS SYP UGX VND VUV XAF XOF XPF YER";
// ...or in thousandths; every other code in hundredths, RSD among them.
const THOUSANDTHS_CURRENCIES = "BHD JOD KWD LYD OMR TND";

let decimalsByCurrency: ReadonlyMap<string, number> | null = null;

/** Every code a price may be in, with the decimals it is priced in. */
function currencyDecimals(): ReadonlyMap<string, number> {
  if (!decimalsByCurrency) {
    const table = new Map<string, number>();
    for (const code of CURRENCY_CODES.split(" ")) table.set(code, 2);
    for (const code of WHOLE_UNIT_CURRENCIES.split(" ")) table.set(code, 0);
    for (const code of THOUSANDTHS_CURRENCIES.split(" ")) table.set(code, 3);
    decimalsByCurrency = table;
  }
  return decimalsByCurrency;
}

/**
 * A currency as written, read as a code would be: NFKC first, so a
 * full-width "ＪＰＹ" from a CJK keyboard is JPY, then in capitals, with the
 * Turkish capital "İ" as "I".
 */
function currencyKey(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toUpperCase()
    .replace(/\u0130|I\u0307/g, "I");
}

/**
 * The ISO 4217 code a value names, when it is one a price may be in (" usd "
 * is USD); null for anything else ("TL", "$", "Tenge", "XXX", a number).
 */
export function productCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = currencyKey(value);
  return currencyDecimals().has(code) ? code : null;
}

/** The decimals a currency is priced in (JPY 0, USD 2, KWD 3); 2 when it is unknown. */
export function productPriceDecimals(
  currency: string | null | undefined,
): number {
  if (typeof currency !== "string") return 2;
  return currencyDecimals().get(currencyKey(currency)) ?? 2;
}

/** An amount in whole minor units, rounded half up on its decimal digits (1.005 USD is 101 cents). */
export function toMinorUnits(amount: number, digits: number): number {
  // Moving the point in the written number avoids float drift: 1.005 * 100 is
  // 100.49999999999999. An amount written with an exponent ("1e+21") can't
  // take another, so it is multiplied instead.
  const shifted = Number(`${amount}e${digits}`);
  return Math.round(Number.isFinite(shifted) ? shifted : amount * 10 ** digits);
}

/** An amount rounded to its currency's decimals: 4.994 USD is 4.99, 1500.4 JPY 1500, 1.2504 KWD 1.25. */
export function roundProductPrice(
  amount: number,
  currency: string | null | undefined,
): number {
  const digits = productPriceDecimals(currency);
  return toMinorUnits(amount, digits) / 10 ** digits;
}

/** Whether an amount has no more than `digits` decimals (4.99 has 2). */
export function hasAtMostDecimals(amount: number, digits: number): boolean {
  return (
    Number.isFinite(amount) &&
    toMinorUnits(amount, digits) / 10 ** digits === amount
  );
}

let digitValues: Map<string, string> | null = null;

/** One decimal digit of any script in ASCII: its place in its run of ten. */
function asciiDigit(char: string): string {
  digitValues ??= new Map();
  let value = digitValues.get(char);
  if (value === undefined) {
    const code = char.codePointAt(0)!;
    let place = 0;
    // Unicode keeps each script's digits 0-9 in a row; a few rows follow one
    // another (the mathematical digits), hence the cap and the remainder.
    while (place < 60 && /\p{Nd}/u.test(String.fromCodePoint(code - place - 1)))
      place++;
    value = String(place % 10);
    digitValues.set(char, value);
  }
  return value;
}

/** NFKC (full-width digits and no-break spaces fold), then every decimal digit in ASCII. */
export function asciiDigits(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\p{Nd}/gu, (char) =>
      char >= "0" && char <= "9" ? char : asciiDigit(char),
    );
}

const DECIMAL_MARKS: readonly string[] = [".", ",", "٫"];
const GROUP_MARKS: readonly string[] = [".", ",", "'", "’", "٬", " "];
const SEPARATOR = /[.,'’٫٬\s]/;
// Digits joined by marks. A space joins them only before exactly three more
// digits, so "10 000 15 000" is two numbers.
const NUMBER = /\d+(?:(?:[.,'’٫٬]|\s(?=\d{3}(?!\d)))\d+)*/g;

/** A written number's digit groups and the marks between them, any space as " ". */
function writtenParts(written: string): { groups: string[]; marks: string[] } {
  return {
    groups: written.split(SEPARATOR),
    marks: written
      .replace(/\d+/g, "")
      .split("")
      .map((mark) => (/\s/.test(mark) ? " " : mark)),
  };
}

/** The integer that digit groups spell with these marks between them, or null when they aren't one grouping. */
function grouped(
  groups: readonly string[],
  marks: readonly string[],
): string | null {
  const [first, ...rest] = groups;
  if (first === undefined) return null;
  if (rest.length === 0) return first;
  const mark = marks[0];
  if (
    mark === undefined ||
    !GROUP_MARKS.includes(mark) ||
    marks.some((other) => other !== mark)
  )
    return null;
  // A grouping never starts with 0: "0.999" isn't 999, nor "0,500" 500.
  if (!/^[1-9]/.test(first)) return null;
  // Western grouping: 1,299 and 15 500. Indian: 1,49,999 and 1,00,00,000.
  const western =
    first.length <= 3 && rest.every((group) => group.length === 3);
  const indian =
    mark !== "." &&
    rest.length >= 2 &&
    first.length <= 2 &&
    rest.every(
      (group, index) => group.length === (index < rest.length - 1 ? 2 : 3),
    );
  return western || indian ? groups.join("") : null;
}

/**
 * The integer and decimal digits of a number whose last mark is a decimal
 * point, used only there, before no more digits than the currency's decimals;
 * null otherwise. Zero cents ("00") read as decimals in any currency, because
 * owners write them even where prices have no cents ("Rp15.000,00").
 */
function decimalReading(
  groups: readonly string[],
  marks: readonly string[],
  decimals: number,
): [string, string] | null {
  const point = marks[marks.length - 1];
  const fraction = groups[groups.length - 1];
  if (point === undefined || fraction === undefined) return null;
  if (!DECIMAL_MARKS.includes(point) || marks.indexOf(point) < marks.length - 1)
    return null;
  if (fraction.length > decimals && fraction !== "00") return null;
  const integer = grouped(groups.slice(0, -1), marks.slice(0, -1));
  return integer === null ? null : [integer, fraction];
}

/**
 * Every amount a number written with digits in `text` can mean, in
 * thousandths of the currency's unit: grouped ("1,299", "1'250", "1,49,999"),
 * with decimals up to the currency's own ("4,99"; "1.250" in KWD) or zero
 * cents in any currency, or else each run of digits on its own. Empty when
 * the text has no digits.
 */
export function quotedAmounts(
  text: string,
  currency: string | null | undefined,
): number[] {
  const decimals = productPriceDecimals(currency);
  const amounts = new Set<number>();
  for (const match of asciiDigits(text).matchAll(NUMBER)) {
    const { groups, marks } = writtenParts(match[0]);
    // Longer than any price can be (PRODUCT_MAX_PRICE has 13 digits).
    if (groups.some((group) => group.length > 13)) continue;
    const readings: Array<[string, string]> = [];
    const whole = grouped(groups, marks);
    if (whole !== null) readings.push([whole, ""]);
    const decimal = decimalReading(groups, marks, decimals);
    if (decimal) readings.push(decimal);
    if (readings.length === 0)
      for (const group of groups) readings.push([group, ""]);
    for (const [integer, fraction] of readings)
      amounts.add(
        Number(integer) * 1000 + Number(`${fraction}000`.slice(0, 3)),
      );
  }
  return [...amounts];
}

/** An amount in thousandths, as `quotedAmounts` gives them (4.99 is 4990). */
export function amountInThousandths(amount: number): number {
  return toMinorUnits(amount, 3);
}

/**
 * A price the owner typed, read in its currency: null for an empty field,
 * "invalid" for anything that isn't plainly one number, which is never
 * guessed at. Money signs typed with it are dropped; letters are not.
 */
export function parseTypedPrice(
  text: string,
  currency: string | null | undefined,
): number | null | "invalid" {
  // The signs go before NFKC, which writes ₨ as "Rs" and ﷼ as "ریال".
  const rest = asciiDigits(text.replace(/[\p{Sc}円元圓]/gu, "")).trim();
  if (!rest) return null;
  if (!/^\d+(?:[.,'’٫٬\s]\d+)*$/.test(rest)) return "invalid";
  const { groups, marks } = writtenParts(rest);
  const decimal = decimalReading(groups, marks, productPriceDecimals(currency));
  let price: number;
  if (decimal) {
    const [integer, fraction] = decimal;
    price = Number(`${integer}.${fraction}`);
  } else {
    const whole = grouped(groups, marks);
    if (whole === null) return "invalid";
    price = Number(whole);
  }
  return price <= PRODUCT_MAX_PRICE ? price : "invalid";
}
