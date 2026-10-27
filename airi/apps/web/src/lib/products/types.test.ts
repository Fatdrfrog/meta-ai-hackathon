import { formatProductPrice } from "./types";

describe("formatProductPrice", () => {
  test.each([
    [0, "0 ₸"],
    [950, "950 ₸"],
    [5000, "5 000 ₸"],
    [12500, "12 500 ₸"],
    [1250000, "1 250 000 ₸"],
    [4999.6, "5 000 ₸"],
  ])("writes %p as %p", (price, text) => {
    expect(formatProductPrice(price)).toBe(text);
  });
});
