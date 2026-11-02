import assert from "node:assert/strict";
import test from "node:test";

import {
  amountInThousandths,
  asciiDigits,
  hasAtMostDecimals,
  parseTypedPrice,
  PRODUCT_MAX_PRICE,
  productCurrency,
  productPriceDecimals,
  quotedAmounts,
  roundProductPrice,
  toMinorUnits,
} from "./price";

// First in this file, before anything has read a currency.
test("prices read the same whatever the runtime's Intl data says", () => {
  // Safari and Firefox price IQD in 3 decimals and IDR in 2, as ISO 4217
  // does, and list retired codes; Chrome prices RSD in 0 and lacks ZWG.
  const intl = Intl as unknown as Record<string, unknown>;
  const { NumberFormat, supportedValuesOf } = Intl;
  const browserDecimals: Record<string, number> = {
    IQD: 3,
    IDR: 2,
    HUF: 2,
    RSD: 0,
  };
  intl.NumberFormat = function (
    locales?: string | string[],
    options?: Intl.NumberFormatOptions,
  ) {
    const resolved = new NumberFormat(locales, options).resolvedOptions();
    const digits = browserDecimals[options?.currency ?? ""];
    return {
      resolvedOptions: () =>
        digits === undefined
          ? resolved
          : { ...resolved, maximumFractionDigits: digits },
    };
  };
  intl.supportedValuesOf = (key: "currency") =>
    key === "currency"
      ? [
          ...supportedValuesOf(key).filter((code) => code !== "ZWG"),
          "RUR",
          "XXX",
        ]
      : supportedValuesOf(key);
  try {
    assert.equal(productPriceDecimals("IQD"), 0);
    assert.equal(parseTypedPrice("25,000", "IQD"), 25_000);
    assert.deepEqual(quotedAmounts("25,000 IQD", "IQD"), [25_000_000]);
    assert.equal(parseTypedPrice("15.000", "IDR"), 15_000);
    assert.equal(parseTypedPrice("1499.99", "RSD"), 1499.99);
    assert.equal(roundProductPrice(1499.99, "RSD"), 1499.99);
    assert.equal(productCurrency("RUR"), null);
    assert.equal(productCurrency("XXX"), null);
    assert.equal(productCurrency("ZWG"), "ZWG");
  } finally {
    intl.NumberFormat = NumberFormat;
    intl.supportedValuesOf = supportedValuesOf;
  }
});

test("productCurrency keeps only the ISO 4217 codes a price may be in", () => {
  const cases: Array<[unknown, string | null]> = [
    [" usd ", "USD"],
    ["kzt", "KZT"],
    // New codes Chrome doesn't know yet.
    ["ZWG", "ZWG"],
    ["XCG", "XCG"],
    ["ABC", null],
    // Codes Safari and Firefox list, which no price is in.
    ["XXX", null],
    ["RUR", null],
    ["XAU", null],
    ["TL", null],
    ["$", null],
    ["Tenge", null],
    [5, null],
    [null, null],
  ];
  for (const [value, code] of cases) {
    assert.equal(productCurrency(value), code, String(value));
  }
});

test("productPriceDecimals follows the currency, and is 2 when it is unknown", () => {
  const cases: Array<[string | null, number]> = [
    ["KZT", 2],
    ["USD", 2],
    ["RSD", 2],
    ["JPY", 0],
    ["IRR", 0],
    ["IQD", 0],
    ["IDR", 0],
    ["HUF", 0],
    ["PKR", 0],
    ["KWD", 3],
    [" omr ", 3],
    [null, 2],
    ["ABC", 2],
  ];
  for (const [currency, decimals] of cases) {
    assert.equal(productPriceDecimals(currency), decimals, String(currency));
  }
});

test("roundProductPrice rounds half up to the currency's decimals", () => {
  const cases: Array<[number, string, number]> = [
    [1.005, "USD", 1.01],
    [4.994, "USD", 4.99],
    [4.999, "USD", 5],
    [1500.4, "JPY", 1500],
    [1.2504, "KWD", 1.25],
    [5000, "KZT", 5000],
    [4999.6, "KZT", 4999.6],
  ];
  for (const [amount, currency, rounded] of cases) {
    assert.equal(
      roundProductPrice(amount, currency),
      rounded,
      `${amount} ${currency}`,
    );
  }
});

test("toMinorUnits and amountInThousandths count without float drift", () => {
  assert.equal(toMinorUnits(1.005, 2), 101); // 1.005 * 100 is 100.49999999999999
  assert.equal(amountInThousandths(4.99), 4_990); // 4.99 * 1000 is 4990.000000000001
  assert.equal(amountInThousandths(15_500), 15_500_000);
  // An amount JavaScript writes with an exponent is multiplied instead.
  assert.equal(toMinorUnits(1e21, 2), 1e23);
});

test("hasAtMostDecimals", () => {
  assert.equal(hasAtMostDecimals(4.99, 2), true);
  assert.equal(hasAtMostDecimals(1.255, 3), true);
  assert.equal(hasAtMostDecimals(4.9999, 3), false);
  assert.equal(hasAtMostDecimals(Number.NaN, 3), false);
  assert.equal(hasAtMostDecimals(1e12, 3), true);
});

test("asciiDigits writes the digits of every script in ASCII", () => {
  const cases: Array<[string, string]> = [
    ["٥٠", "50"], // Arabic-Indic
    ["۱۲۵۰۰", "12500"], // Persian and Urdu
    ["५०", "50"], // Devanagari
    ["১৫০", "150"], // Bengali
    ["๕๐", "50"], // Thai
    ["၅၀", "50"], // Myanmar
    ["１５００", "1500"], // full-width
    ["1 250", "1 250"], // a no-break space folds to a space
  ];
  for (const [text, ascii] of cases) {
    assert.equal(asciiDigits(text), ascii, text);
  }
});

test("quotedAmounts reads decimals and groupings, in thousandths", () => {
  const cases: Array<[string, string | null, number[]]> = [
    ["$4.99", "USD", [4_990]],
    ["12,50 €", "EUR", [12_500]],
    ["$1,299.99", "USD", [1_299_990]],
    ["1.299,00 Euro", "EUR", [1_299_000]],
    ["₹1,49,999", "INR", [149_999_000]],
    ["1'250 Franken", "CHF", [1_250_000]],
    ["1.250 Euro", "EUR", [1_250_000]],
    ["1.250 KD", "KWD", [1_250_000, 1_250]],
    ["150.000đ", "VND", [150_000_000]],
    ["10 000 15 000", null, [10_000_000, 15_000_000]],
    ["15500т бастап", "KZT", [15_500_000]],
    ["٤٫٩٩ ريال", "SAR", [4_990]],
    ["٢٬٥٠٠ ريال", "SAR", [2_500_000]],
    ["бес мың теңге", "KZT", []],
    ["10000000000000", null, []], // longer than any price
  ];
  for (const [text, currency, amounts] of cases) {
    assert.deepEqual(quotedAmounts(text, currency), amounts, text);
  }
});

test("zero cents read as decimals even in a currency without cents", () => {
  // IDR, HUF and PKR are priced in whole units, but tags still show zero cents.
  assert.deepEqual(quotedAmounts("Rp15.000,00", "IDR"), [15_000_000]);
  assert.deepEqual(quotedAmounts("1 500,00 Ft", "HUF"), [1_500_000]);
  assert.deepEqual(quotedAmounts("Rs. 1,500.00", "PKR"), [1_500_000]);
  assert.equal(parseTypedPrice("15.000,00", "IDR"), 15_000);
  // Only zero cents: other decimals still don't read in such a currency.
  assert.equal(parseTypedPrice("1,5", "JPY"), "invalid");
  assert.equal(parseTypedPrice("1,50", "JPY"), "invalid");
  assert.deepEqual(quotedAmounts("1,50", "JPY"), [1_000, 50_000]);
});

test("parseTypedPrice reads one plain number in the currency", () => {
  const cases: Array<[string, string | null, number | null | "invalid"]> = [
    ["16 900", "KZT", 16_900],
    ["16 900 ₸", "KZT", 16_900],
    ["1.500", "KZT", 1_500],
    ["4,99", "USD", 4.99],
    ["1.299,99", "EUR", 1299.99],
    ["1.250", "KWD", 1.25],
    ["1,5", "JPY", "invalid"],
    ["۱۲۵۰۰", "IRR", 12_500],
    ["１５００", "JPY", 1_500],
    ["€4,99", "EUR", 4.99],
    ["1500円", "JPY", 1_500],
    ["1.5k", "USD", "invalid"],
    ["4.99 USD", "USD", "invalid"],
    ["4.9999", "USD", "invalid"],
    ["", null, null],
    // With a no-break space, as airi groups the prices it shows.
    ["4 999.60", "KZT", 4999.6],
  ];
  for (const [text, currency, price] of cases) {
    assert.equal(parseTypedPrice(text, currency), price, `${text} ${currency}`);
  }
});

test("parseTypedPrice refuses a price above the cap", () => {
  assert.equal(parseTypedPrice("1 000 000 000 000", "IRR"), PRODUCT_MAX_PRICE);
  assert.equal(parseTypedPrice("1000000000001", "IRR"), "invalid");
});

test("a grouping of thousands never starts with 0", () => {
  // "0.999" in USD has too many decimals, and isn't 999 either.
  const cases: Array<[string, string, number | "invalid"]> = [
    ["0.999", "USD", "invalid"],
    ["0,500", "EUR", "invalid"],
    ["0.500", "KZT", "invalid"],
    ["0 500", "KZT", "invalid"],
    ["00.500", "USD", "invalid"],
    // A three-decimal currency still reads it as decimals.
    ["0.500", "KWD", 0.5],
    ["0.50", "USD", 0.5],
    ["1.500", "KZT", 1500],
  ];
  for (const [text, currency, price] of cases) {
    assert.equal(parseTypedPrice(text, currency), price, `${text} ${currency}`);
  }
  // A quote's number that is no grouping is read run by run, as any other.
  assert.deepEqual(quotedAmounts("$0.999", "USD"), [0, 999_000]);
  assert.deepEqual(quotedAmounts("0.500 KD", "KWD"), [500]);
});

test("money signs typed with a price go before NFKC turns them into letters", () => {
  // NFKC writes ₨ as "Rs" and ﷼ as "ریال".
  assert.equal(parseTypedPrice("500₨", "PKR"), 500);
  assert.equal(parseTypedPrice("₨ 1,500", "PKR"), 1500);
  assert.equal(parseTypedPrice("500﷼", "IRR"), 500);
  assert.equal(parseTypedPrice("＄4.99", "USD"), 4.99);
  // Letters typed with it are still refused.
  assert.equal(parseTypedPrice("Rs 1,500", "PKR"), "invalid");
});

test("a currency code reads the same typed full-width or with a Turkish capital", () => {
  const cases: Array<[string, string]> = [
    ["ＪＰＹ", "JPY"],
    ["ｕｓｄ", "USD"],
    ["İNR", "INR"],
    // The same "İ" lower-cased, as "i" with a dot above.
    ["i\u0307nr", "INR"],
  ];
  for (const [value, code] of cases) {
    assert.equal(productCurrency(value), code, value);
  }
  assert.equal(productPriceDecimals("ＪＰＹ"), 0);
  assert.equal(productPriceDecimals("ＫＷＤ"), 3);
});
