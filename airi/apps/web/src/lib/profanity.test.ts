import { checkProfanity } from "@/lib/profanity";

describe("profanity dictionary initialization", () => {
  it("does no compilation on import or empty input and reuses each requested language", () => {
    const constructor = jest.spyOn(globalThis, "RegExp");
    const compiledPatterns = () =>
      constructor.mock.calls.filter(([, flags]) => flags === "iu").length;
    try {
      jest.isolateModules(() => {
        const { checkProfanity: check } =
          jest.requireActual<typeof import("./profanity")>("./profanity");
        expect(compiledPatterns()).toBe(0);
        expect(check("", "").toxic).toBe(false);
        expect(check("unsupported", "hello").toxic).toBe(false);
        expect(compiledPatterns()).toBe(0);

        expect(check("en", "shiiit").toxic).toBe(true);
        const englishCount = compiledPatterns();
        expect(englishCount).toBeGreaterThan(0);
        expect(check("en", "hello").toxic).toBe(false);
        expect(compiledPatterns()).toBe(englishCount);

        expect(check("ru", "хуй").toxic).toBe(true);
        expect(compiledPatterns()).toBeGreaterThan(englishCount);
        const russianCount = compiledPatterns();
        expect(check("ru", "привет").toxic).toBe(false);
        expect(compiledPatterns()).toBe(russianCount);
      });
    } finally {
      constructor.mockRestore();
    }
  });
});

describe("checkProfanity", () => {
  it("does not match wildcard stems inside ordinary Unicode words", () => {
    expect(checkProfanity("", "Ожидайте, проверьте жидкость")).toEqual({
      toxic: false,
      maxSeverity: 0,
      categories: [],
    });
  });

  it("still matches a wildcard stem at the start of a complete word", () => {
    expect(checkProfanity("", "жидовский").categories).toContain("жидов*");
  });

  it.each([
    "Current status of all widget conversations",
    "No blocks match this search",
    "Bob from Acme",
    "Standart shrift",
    "O'ngga",
    "The headline should sit below the image",
  ])("does not let obfuscation patterns match ordinary copy: %s", text => {
    expect(checkProfanity("", text)).toEqual({
      toxic: false,
      maxSeverity: 0,
      categories: [],
    });
  });

  it.each([
    ["cuuunt", "cu*n*t"],
    ["shiiit", "sh*i*t"],
    ["boooob", "boo*b"],
    ["bollocks", "bo*ll*o*cks"],
  ])("still detects repeated-letter profanity: %s", (text, pattern) => {
    expect(checkProfanity("en", text).categories).toContain(pattern);
  });

  it.each([
    ["жоғалып кет", "жоғ* кет"],
    ["шешеніңді", "шешен*ді"],
  ])("keeps Kazakh wildcard spans meaningful: %s", (text, pattern) => {
    expect(checkProfanity("kz", text).categories).toContain(pattern);
  });

  it.each(["I am Airi Telegram assistant", "RAM usage is high"])(
    "only checks ambiguous short terms for an explicit language: %s",
    text => {
      expect(checkProfanity("", text)).toEqual({
        toxic: false,
        maxSeverity: 0,
        categories: [],
      });
    }
  );

  it("keeps ambiguous short terms available to explicit language checks", () => {
    expect(checkProfanity("uz", "am").categories).toContain("am");
    expect(checkProfanity("uz", "ram").categories).toContain("ram");
  });

  it.each([
    ["bo'q", "bo'q"],
    ["bo’q", "bo'q"],
    ["boʻq", "bo'q"],
    ["boʼq", "bo'q"],
    ["boq", "boq"],
    ["ko't", "ko't"],
    ["ko’t", "ko't"],
    ["koʻt", "ko't"],
    ["koʼt", "ko't"],
    ["kot", "kot"],
  ])(
    "detects standalone Uzbek profanity in universal scans: %s",
    (text, pattern) => {
      expect(checkProfanity("", text).categories).toContain(pattern);
    }
  );

  it.each(["boqcha", "ko'tarildi", "kotib"])(
    "keeps universal short-token matches on Unicode word boundaries: %s",
    text => {
      expect(checkProfanity("", text)).toEqual({
        toxic: false,
        maxSeverity: 0,
        categories: [],
      });
    }
  );

  it.each([
    ["ass", "ass"],
    ["fag", "fa*g"],
    ["хуй", "хуй"],
    ["боқ", "боқ"],
  ])(
    "still detects genuine short profanity in universal scans: %s",
    (text, pattern) => {
      expect(checkProfanity("", text).categories).toContain(pattern);
    }
  );

  it.each(["bo’q", "boʻq", "boʼq"])(
    "detects Uzbek profanity across apostrophe variants: %s",
    text => {
      expect(checkProfanity("uz", text).categories).toContain("bo'q");
    }
  );

  it.each(["ko’tarildi", "koʻtarildi", "koʼtarildi"])(
    "does not prefix-match an ordinary Uzbek word across apostrophe variants: %s",
    text => {
      expect(checkProfanity("uz", text)).toEqual({
        toxic: false,
        maxSeverity: 0,
        categories: [],
      });
    }
  );

  it.each(["узбекский язык", "таджикский язык"])(
    "does not classify a neutral identity as profanity: %s",
    text => {
      expect(checkProfanity("ru", text)).toEqual({
        toxic: false,
        maxSeverity: 0,
        categories: [],
      });
    }
  );

  it.each([
    ["", "Это святая вода"],
    ["ru", "богатый выбор"],
    ["", "голубой цвет"],
    ["", "An enby customer"],
    ["", "A cishet customer"],
    ["", "A collared shirt"],
    ["", "Market domination"],
    ["", "A bloody nose"],
    ["", "Jesus Christ"],
    ["uz", "ko'tarildi"],
  ])(
    "does not classify ordinary language as profanity: %s / %s",
    (lang, text) => {
      expect(checkProfanity(lang, text)).toEqual({
        toxic: false,
        maxSeverity: 0,
        categories: [],
      });
    }
  );
});
