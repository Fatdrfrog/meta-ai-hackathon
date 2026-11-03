import {
  buyerPrice,
  SHOP_WORDS,
  shopWords,
  spokeShopWordsLanguage,
} from "./shop-words";

// Prices group their digits and join their currency with no-break spaces.
const nb = " ";

describe("shopWords", () => {
  it("writes for buyers in the language the owner spoke, English otherwise", () => {
    expect(shopWords("Kazakh").code).toBe("kk");
    expect(shopWords("kk").code).toBe("kk");
    expect(shopWords("Russian").code).toBe("ru");
    expect(shopWords("Kazakh and Russian").code).toBe("kk");
    expect(shopWords("Uzbek").code).toBe("en");
    expect(shopWords(null).code).toBe("en");
  });

  it("calls English the owner's own language only when they spoke it", () => {
    for (const spoken of ["Kazakh", "kk", "Russian", "English", "en"])
      expect(spokeShopWordsLanguage(spoken)).toBe(true);
    // English words, but not a language the owner spoke.
    for (const other of ["Uzbek", "Spanish", "Bengali", null, ""])
      expect(spokeShopWordsLanguage(other)).toBe(false);
  });

  it("has every word in each language", () => {
    for (const words of Object.values(SHOP_WORDS)) {
      expect(words.carouselBody).not.toBe("");
      expect(words.orderButton).not.toBe("");
      expect(Object.values(words.form).every(Boolean)).toBe(true);
    }
  });
});

describe("buyerPrice", () => {
  const priced = {
    price: 15500,
    currency: "KZT",
    priceIsFrom: false,
  };

  it("writes the price in its currency, tenge with ₸", () => {
    expect(buyerPrice(priced, SHOP_WORDS.kk)).toBe(`15${nb}500${nb}₸`);
    expect(
      buyerPrice({ ...priced, price: 12.5, currency: "EUR" }, SHOP_WORDS.en)
    ).toBe(`12.50${nb}EUR`);
  });

  it("says a starting price the shop's way", () => {
    const from = { ...priced, priceIsFrom: true };
    expect(buyerPrice(from, SHOP_WORDS.kk)).toBe(`15${nb}500${nb}₸ бастап`);
    expect(buyerPrice(from, SHOP_WORDS.ru)).toBe(`от 15${nb}500${nb}₸`);
    expect(buyerPrice(from, SHOP_WORDS.en)).toBe(`from 15${nb}500${nb}₸`);
  });

  it("leaves a price whose currency wasn't said bare, and none without a price", () => {
    expect(buyerPrice({ ...priced, currency: null }, SHOP_WORDS.ru)).toBe(
      `15${nb}500`
    );
    expect(buyerPrice({ ...priced, price: null }, SHOP_WORDS.kk)).toBeNull();
  });
});
