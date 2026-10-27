import {
  getPublicKBArticleLocaleFallback,
  getPublicKBLanguageSwitcherLocale,
  readLocaleSearchParam,
  resolvePublicKBRequestedLocale,
} from "./public-kb-locale-fallback";

describe("public KB locale fallback helpers", () => {
  it("reads the locale search param from string or array values", () => {
    expect(readLocaleSearchParam({ locale: "ru" })).toBe("ru");
    expect(readLocaleSearchParam({ locale: ["kz", "en"] })).toBe("kz");
    expect(readLocaleSearchParam({ locale: "" })).toBeNull();
    expect(readLocaleSearchParam({})).toBeNull();
    expect(readLocaleSearchParam(null)).toBeNull();
  });

  it("resolves the requested public locale from search params", () => {
    expect(resolvePublicKBRequestedLocale({ locale: "ru" }, "en")).toBe("ru");
    expect(resolvePublicKBRequestedLocale({ locale: "xx" }, "en")).toBe("en");
    expect(resolvePublicKBRequestedLocale({}, "kz")).toBe("kz");
  });

  it("uses the requested supported locale as the public picker active locale", () => {
    expect(getPublicKBLanguageSwitcherLocale("kz", "en")).toBe("kz");
  });

  it("falls back to the rendered article locale when the requested locale is invalid", () => {
    expect(getPublicKBLanguageSwitcherLocale("xx", "en")).toBe("en");
    expect(getPublicKBLanguageSwitcherLocale(null, "ru")).toBe("ru");
  });

  it("shows a fallback notice when the requested language has no published article translation", () => {
    expect(
      getPublicKBArticleLocaleFallback({
        requestedLocale: "kz",
        renderedLocale: "en",
        availableLocales: ["en", "ru"],
      })
    ).toEqual({
      requestedLocale: "kz",
      renderedLocale: "en",
    });
  });

  it("does not show a fallback notice when the requested language is available or invalid", () => {
    expect(
      getPublicKBArticleLocaleFallback({
        requestedLocale: "ru",
        renderedLocale: "ru",
        availableLocales: ["en", "ru"],
      })
    ).toBeNull();

    expect(
      getPublicKBArticleLocaleFallback({
        requestedLocale: "xx",
        renderedLocale: "en",
        availableLocales: ["en"],
      })
    ).toBeNull();
  });
});
