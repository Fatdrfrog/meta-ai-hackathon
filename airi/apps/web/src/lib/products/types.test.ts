import {
  formatProductPrice,
  productPriceLength,
  productPriceParts,
} from "./types";

// Prices are spaced with no-break spaces, so they never wrap. Expected texts
// are written with plain spaces here and compared with every space a no-break
// one.
const unbroken = (text: string) => text.replace(/ /g, "\u00a0");

describe("formatProductPrice", () => {
  test.each([
    [0, "0 ₸"],
    [950, "950 ₸"],
    [5000, "5 000 ₸"],
    [12500, "12 500 ₸"],
    [1250000, "1 250 000 ₸"],
  ])("writes %p tenge as %p", (price, text) => {
    expect(formatProductPrice(price, { currency: "KZT" })).toBe(unbroken(text));
  });

  test("keeps a price's cents, to its currency's own decimals", () => {
    expect(formatProductPrice(4999.6, { currency: "KZT" })).toBe(
      unbroken("4 999.60 ₸")
    );
    expect(formatProductPrice(12.5, { currency: "EUR" })).toBe(
      unbroken("12.50 EUR")
    );
    expect(formatProductPrice(9.5, { currency: "USD" })).toBe(
      unbroken("9.50 USD")
    );
    expect(formatProductPrice(4.99, { currency: "usd" })).toBe(
      unbroken("4.99 USD")
    );
    expect(formatProductPrice(1.25, { currency: "KWD" })).toBe(
      unbroken("1.250 KWD")
    );
    expect(formatProductPrice(1500, { currency: "JPY" })).toBe(
      unbroken("1 500 JPY")
    );
    expect(formatProductPrice(1e12, { currency: "IRR" })).toBe(
      unbroken("1 000 000 000 000 IRR")
    );
  });

  test("ends a price said in another currency in its code, unbroken", () => {
    expect(formatProductPrice(10, { currency: "USD" })).toBe(
      unbroken("10 USD")
    );
    expect(formatProductPrice(12500, { from: true, currency: "EUR" })).toBe(
      unbroken("from 12 500 EUR")
    );
    // As a model might write it.
    expect(formatProductPrice(10, { currency: " usd " })).toBe(
      unbroken("10 USD")
    );
  });

  test.each(["KZT", "kzt"])("writes tenge, %p, with its sign", currency => {
    expect(formatProductPrice(5000, { currency })).toBe(unbroken("5 000 ₸"));
  });

  // Never tenge by default: a currency nobody said is left out.
  test.each([null, undefined, "", "Tenge"])(
    "writes a price without a known currency, %p, bare",
    currency => {
      expect(formatProductPrice(5000, { currency })).toBe(unbroken("5 000"));
    }
  );

  test("writes a starting price with a no-break 'from'", () => {
    expect(formatProductPrice(15500, { from: true, currency: "KZT" })).toBe(
      unbroken("from 15 500 ₸")
    );
  });

  test("writes a price alike in every browser, whatever its Intl data says", () => {
    // Chrome prices RSD in whole dinars and doesn't know ZWG; Safari and
    // Firefox price IQD in 3 decimals. The worker and the server don't.
    const browserDecimals: Record<string, number> = { RSD: 0, IQD: 3 };
    const RealNumberFormat = Intl.NumberFormat;
    const realSupportedValuesOf = Intl.supportedValuesOf;
    const numberFormat = jest
      .spyOn(Intl, "NumberFormat")
      .mockImplementation((locales, options) => {
        const resolved = new RealNumberFormat(
          locales,
          options
        ).resolvedOptions();
        const digits = browserDecimals[options?.currency ?? ""];
        return {
          resolvedOptions: () =>
            digits === undefined
              ? resolved
              : { ...resolved, maximumFractionDigits: digits },
        } as unknown as Intl.NumberFormat;
      });
    const supportedValuesOf = jest
      .spyOn(Intl, "supportedValuesOf")
      .mockImplementation(key =>
        realSupportedValuesOf(key).filter(code => code !== "ZWG")
      );

    try {
      jest.isolateModules(() => {
        const { formatProductPrice: format } =
          jest.requireActual<typeof import("./types")>("./types");
        expect(format(1499.99, { currency: "RSD" })).toBe(
          unbroken("1 499.99 RSD")
        );
        expect(format(25000, { currency: "IQD" })).toBe(unbroken("25 000 IQD"));
        expect(format(20, { currency: "ZWG" })).toBe(unbroken("20 ZWG"));
      });
    } finally {
      numberFormat.mockRestore();
      supportedValuesOf.mockRestore();
    }
  });
});

describe("productPriceParts", () => {
  test("splits a starting price after its 'from', and never its amount or code", () => {
    expect(productPriceParts(15500, { from: true, currency: "KZT" })).toEqual([
      unbroken("from "),
      unbroken("15 500 ₸"),
    ]);
    expect(
      productPriceParts(1_250_000_000, { from: true, currency: "IRR" })
    ).toEqual([unbroken("from "), unbroken("1 250 000 000 IRR")]);
    expect(productPriceParts(4.99, { currency: "USD" })).toEqual([
      "",
      unbroken("4.99 USD"),
    ]);
    expect(productPriceParts(20)).toEqual(["", "20"]);
  });

  test.each([
    [15500, { from: true, currency: "KZT" }],
    [12.5, { currency: "EUR" }],
    [1.25, { from: true, currency: "KWD" }],
    [5000, { currency: null }],
  ])("its parts of %p make the formatted price", (price, options) => {
    expect(productPriceParts(price, options).join("")).toBe(
      formatProductPrice(price, options)
    );
  });
});

describe("productPriceLength", () => {
  test.each([
    ["No price yet", "short"],
    [formatProductPrice(15500, { from: true, currency: "KZT" }), "short"],
    [formatProductPrice(1299.99, { from: true, currency: "USD" }), "short"],
    [formatProductPrice(12_500_000, { from: true, currency: "IDR" }), "long"],
    [
      formatProductPrice(1_250_000_000, { from: true, currency: "IRR" }),
      "long",
    ],
    // At the price cap.
    [formatProductPrice(1e12, { from: true, currency: "IRR" }), "longest"],
    [
      formatProductPrice(999_999_999_999.999, { from: true, currency: "KWD" }),
      "longest",
    ],
  ])("%p is %p", (text, length) => {
    expect(productPriceLength(text)).toBe(length);
  });
});
