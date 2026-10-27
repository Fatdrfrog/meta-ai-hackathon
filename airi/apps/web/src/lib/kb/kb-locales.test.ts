import {
  LANGUAGE_SWITCHER_LOCALES,
  resolveKBArticleLocale,
  resolveKBPublicArticleReadLocale,
  resolveKBArticleReadLocale,
  toKBLocaleList,
} from "./kb-locales";

describe("KB article locale resolution", () => {
  it("uses the requested locale when the article has that locale", () => {
    expect(
      resolveKBArticleLocale({
        requestedLocale: "ru",
        availableLocales: ["en", "ru"],
      })
    ).toBe("ru");
  });

  it("falls back to the first available picker locale when requested locale is missing", () => {
    expect(
      resolveKBArticleLocale({
        requestedLocale: "en",
        availableLocales: ["ru", "kz"],
      })
    ).toBe("kz");
  });

  it("normalizes locale lists to supported unique picker order", () => {
    expect(toKBLocaleList(["ru", "xx", "uz", "en", "ru", "kz"])).toEqual([
      "kz",
      "en",
      "ru",
    ]);
    expect(LANGUAGE_SWITCHER_LOCALES).toEqual(["kz", "en", "ru"]);
  });

  it("falls back to the first available article locale for old articles", () => {
    expect(
      resolveKBArticleReadLocale({
        requestedLocale: "en",
        defaultLocale: "ru",
        localizationLocales: ["ru"],
      })
    ).toEqual({
      locale: "ru",
      availableLocales: ["ru"],
    });
  });

  it("uses the article default locale when no public locale is requested", () => {
    expect(
      resolveKBArticleReadLocale({
        requestedLocale: null,
        defaultLocale: "ru",
        localizationLocales: ["en", "ru"],
      })
    ).toEqual({
      locale: "ru",
      availableLocales: ["en", "ru"],
    });
  });

  it("does not expose the default locale in public reads without a public default variant", () => {
    expect(
      resolveKBPublicArticleReadLocale({
        requestedLocale: "en",
        defaultLocale: "en",
        localizationLocales: ["ru"],
        hasDefaultLocaleVariant: false,
      })
    ).toEqual({
      locale: "ru",
      availableLocales: ["ru"],
    });
  });

  it("keeps the default locale available in public reads when the default variant exists", () => {
    expect(
      resolveKBPublicArticleReadLocale({
        requestedLocale: "en",
        defaultLocale: "en",
        localizationLocales: ["ru"],
        hasDefaultLocaleVariant: true,
      })
    ).toEqual({
      locale: "en",
      availableLocales: ["en", "ru"],
    });
  });
});
