import { pickLocaleFromAcceptLanguage } from "./accept-language";

describe("pickLocaleFromAcceptLanguage", () => {
  it.each([
    ["ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7", "ru"],
    ["kk-KZ,kk;q=0.9,ru;q=0.8", "kz"],
    ["kz", "kz"],
    ["en-US,en;q=0.9,ru;q=0.8", "en"],
    // Uzbek is a widget language, not an interface locale: fall through.
    ["uz-UZ,uz;q=0.9,ru;q=0.8", "ru"],
  ])("maps %s to %s", (header, locale) => {
    expect(pickLocaleFromAcceptLanguage(header)).toBe(locale);
  });

  it.each([["de-DE,de;q=0.9,*;q=0.5"], [""], [null]])(
    "has no interface locale for %p",
    header => {
      expect(pickLocaleFromAcceptLanguage(header)).toBeNull();
    }
  );
});
