import {
  getCountryLabel,
  ISO_COUNTRY_CODES,
  resolveCountryCode,
} from "./countries";

type CountriesModule = typeof import("./countries");

// Each case needs fresh per-locale caches.
function withFreshCountries(verify: (countries: CountriesModule) => void) {
  jest.isolateModules(() => {
    verify(jest.requireActual<CountriesModule>("./countries"));
  });
}

describe("ISO_COUNTRY_CODES", () => {
  it("lists all 249 ISO 3166-1 alpha-2 codes, sorted and unique", () => {
    expect(ISO_COUNTRY_CODES).toHaveLength(249);
    expect(new Set(ISO_COUNTRY_CODES).size).toBe(249);
    expect([...ISO_COUNTRY_CODES].sort()).toEqual([...ISO_COUNTRY_CODES]);
    expect(ISO_COUNTRY_CODES.every(code => /^[A-Z]{2}$/.test(code))).toBe(true);
    expect(ISO_COUNTRY_CODES).toEqual(
      expect.arrayContaining(["CW", "KZ", "MF", "SX", "UZ"])
    );
    expect(ISO_COUNTRY_CODES).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^(?:UK|EU|XK|AN|SU)$/)])
    );
  });

  it("has an English name for every code", () => {
    const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    expect(
      ISO_COUNTRY_CODES.filter(code => regionNames.of(code) === code)
    ).toEqual([]);
  });
});

describe("getCountryLabel", () => {
  it.each([
    ["KZ", "en", "Kazakhstan"],
    ["KZ", "ru", "Казахстан"],
    ["KZ", "kz", "Қазақстан"],
    ["UZ", "kz", "Өзбекстан"],
    ["uz", "en", "Uzbekistan"],
  ])("names %s in %s as %s", (code, locale, expected) => {
    expect(getCountryLabel(code, locale)).toBe(expected);
  });

  it("falls back to the code for codes and locales Intl can't name", () => {
    expect(getCountryLabel("K1", "en")).toBe("K1");
    expect(getCountryLabel("", "en")).toBe("");
    expect(getCountryLabel("KZ", "not a locale!")).toBe("KZ");
  });

  it("builds region names once per locale, and none for Kazakh", () => {
    const OriginalDisplayNames = Intl.DisplayNames;
    const displayNames = jest
      .spyOn(Intl, "DisplayNames")
      .mockImplementation((...args) => new OriginalDisplayNames(...args));
    try {
      withFreshCountries(countries => {
        expect(countries.getCountryLabel("KZ", "kz")).toBe("Қазақстан");
        expect(countries.getCountryLabel("UZ", "kz")).toBe("Өзбекстан");
        expect(countries.getCountryLabel("KZ", "kk")).toBe("Қазақстан");
        expect(countries.getCountryLabel("KZ", "ru")).toBe("Казахстан");
        expect(countries.getCountryLabel("UZ", "ru")).toBe("Узбекистан");
        expect(countries.getCountryLabel("KZ", "en")).toBe("Kazakhstan");
      });
      expect(displayNames.mock.calls).toEqual([
        [["ru"], { type: "region" }],
        [["en"], { type: "region" }],
      ]);
    } finally {
      displayNames.mockRestore();
    }
  });

  it("falls back to codes when Intl.DisplayNames throws", () => {
    const displayNames = jest
      .spyOn(Intl, "DisplayNames")
      .mockImplementation(() => {
        throw new RangeError("unsupported locale");
      });
    try {
      withFreshCountries(countries => {
        expect(countries.getCountryLabel("KZ", "ru")).toBe("KZ");
        expect(countries.resolveCountryCode("kz")).toBe("KZ");
        expect(countries.resolveCountryCode("Kazakhstan")).toBeNull();
      });
    } finally {
      displayNames.mockRestore();
    }
  });

  // Chromium-based browsers have no Kazakh region names: "kk" answers in
  // Russian there.
  it("names countries in Kazakh where Intl has no Kazakh names", () => {
    const OriginalDisplayNames = Intl.DisplayNames;
    const displayNames = jest
      .spyOn(Intl, "DisplayNames")
      .mockImplementation(
        (locales, options) =>
          new OriginalDisplayNames(
            locales === "kk" || (Array.isArray(locales) && locales[0] === "kk")
              ? ["ru"]
              : locales,
            options
          )
      );
    try {
      withFreshCountries(countries => {
        expect(countries.getCountryLabel("KZ", "kz")).toBe("Қазақстан");
        expect(countries.getCountryLabel("UZ", "kz")).toBe("Өзбекстан");
        expect(countries.resolveCountryCode("Өзбекстан")).toBe("UZ");
        expect(countries.resolveCountryCode("қазақстан")).toBe("KZ");
        expect(countries.resolveCountryCode("Казахстан")).toBe("KZ");
      });
    } finally {
      displayNames.mockRestore();
    }
  });

  it("has a Kazakh name for every code", () => {
    for (const code of ISO_COUNTRY_CODES) {
      expect(getCountryLabel(code, "kz")).not.toBe(code);
    }
  });

  it("falls back to codes when Intl.DisplayNames is unavailable", () => {
    const originalDisplayNames = Intl.DisplayNames;
    Object.defineProperty(Intl, "DisplayNames", {
      configurable: true,
      value: undefined,
    });
    try {
      withFreshCountries(countries => {
        expect(countries.getCountryLabel("KZ", "en")).toBe("KZ");
        expect(countries.resolveCountryCode("uz")).toBe("UZ");
        expect(countries.resolveCountryCode("Узбекистан")).toBeNull();
      });
    } finally {
      Object.defineProperty(Intl, "DisplayNames", {
        configurable: true,
        value: originalDisplayNames,
      });
    }
  });
});

describe("resolveCountryCode", () => {
  it.each([
    ["KZ", "KZ"],
    ["kz", "KZ"],
    [" Uz ", "UZ"],
    ["ＫＺ", "KZ"],
    ["Kazakhstan", "KZ"],
    ["KAZAKHSTAN", "KZ"],
    ["Казахстан", "KZ"],
    ["казахстан", "KZ"],
    ["Қазақстан", "KZ"],
    ["ҚАЗАҚСТАН", "KZ"],
    ["Uzbekistan", "UZ"],
    ["Узбекистан", "UZ"],
    ["Өзбекстан", "UZ"],
    ["  united   states ", "US"],
    ["Соединённые Штаты", "US"],
    ["Ресей", "RU"],
  ])("resolves %j to %s", (value, expected) => {
    expect(resolveCountryCode(value)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    7,
    { code: "KZ" },
    "",
    "   ",
    "UK",
    "EU",
    "K Z",
    "Kazakh",
    "Atlantis",
  ])("returns null for %j", value => {
    expect(resolveCountryCode(value)).toBeNull();
  });
});
