import {
  carouselCardText,
  clipText,
  ORDER_FORM_TITLE_MAX,
  orderFormOption,
} from "./kit-text";
import { SHOP_WORDS } from "./shop-words";

// The words on a kit's cards and form: one copy for Meta and the preview.

const NBSP = " ";

describe("clipText", () => {
  it("keeps short text and cuts long text with an ellipsis, no dangling comma", () => {
    expect(clipText("Кукла Лол", 30)).toBe("Кукла Лол");
    expect(clipText("Есімі жазылған медаль ілгіш, ағаш, үш қатар", 30)).toBe(
      "Есімі жазылған медаль ілгіш…"
    );
  });
});

describe("carouselCardText", () => {
  it("puts the name, then the price as buyers read it, on its own line", () => {
    expect(
      carouselCardText(
        { name: "Кукла Лол", price: 5000, currency: "KZT", priceIsFrom: false },
        SHOP_WORDS.kk
      )
    ).toEqual({
      name: "Кукла Лол",
      price: `5${NBSP}000${NBSP}₸`,
      text: `Кукла Лол\n5${NBSP}000${NBSP}₸`,
    });
    expect(
      carouselCardText(
        { name: "Шежіре", price: 15500, currency: "KZT", priceIsFrom: true },
        SHOP_WORDS.kk
      ).text
    ).toBe(`Шежіре\n15${NBSP}500${NBSP}₸ бастап`);
  });

  it("shows only the name without a price, and keeps a long name within the card", () => {
    expect(
      carouselCardText(
        { name: "Mug", price: null, currency: null, priceIsFrom: false },
        SHOP_WORDS.en
      )
    ).toEqual({ name: "Mug", price: null, text: "Mug" });
    const long = carouselCardText(
      {
        name: "x".repeat(400),
        price: 10,
        currency: "USD",
        priceIsFrom: false,
      },
      SHOP_WORDS.en
    );
    expect(long.text.length).toBeLessThanOrEqual(160);
    expect(long.text.endsWith(`\n10${NBSP}USD`)).toBe(true);
  });
});

describe("orderFormOption", () => {
  it("clips the name to what a form row holds, with the price beneath", () => {
    const option = orderFormOption(
      {
        name: "Есімі жазылған медаль ілгіш, ағаш, үш қатар",
        price: 16900,
        currency: "KZT",
        priceIsFrom: true,
      },
      SHOP_WORDS.ru
    );
    expect(option.title.length).toBeLessThanOrEqual(ORDER_FORM_TITLE_MAX);
    expect(option.description).toBe(`от 16${NBSP}900${NBSP}₸`);
    expect(
      orderFormOption(
        { name: "Mug", price: null, currency: null, priceIsFrom: false },
        SHOP_WORDS.en
      )
    ).toEqual({ title: "Mug", description: null });
  });
});
