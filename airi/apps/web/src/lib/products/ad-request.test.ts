/** @jest-environment node */

// What the ad API takes, checked, and the owner's edits checked like the
// script and applied to it.

import {
  adWordsIssues,
  applyAdWords,
  parseAdProductIds,
  parseProductAdCreateRequest,
  parseProductAdUpdateRequest,
  sameAdWords,
} from "./ad-request";
import type { ProductAdScript } from "./types";

const DOLL = "651f1f77bcf86cd799439011";
const MUG = "651f1f77bcf86cd799439012";
const CLOCK = "651f1f77bcf86cd799439013";
const OLD_IMPORT = "651f1f77bcf86cd799439021";

const brief = (overrides: Record<string, unknown> = {}) => ({
  requestId: "press-1",
  productIds: [DOLL, MUG],
  idea: { kind: "new" as const },
  voice: "own" as const,
  presenter: { use: false, consent: false },
  ...overrides,
});

const script = (overrides: Partial<ProductAdScript> = {}): ProductAdScript => ({
  sticker: "Сөреде жаңа тауарлар",
  scenes: [
    {
      productId: DOLL,
      caption: "Көк көйлекті қуыршақ",
      setting: "oak_table_window",
    },
    { productId: MUG, caption: "Күнделікті кружка", setting: "linen_shelf" },
  ],
  priceCardTitle: "Екеуі де сөреде",
  ending: "WhatsApp-қа жазыңыз",
  postIntro: "Сөремізге жаңа тауарлар келді!",
  ctwa: {
    headline: "Жаңа ойыншықтар",
    primaryText: "Кукла мен кружка сөреде күтіп тұр.",
    greeting: "Сәлеметсіз бе! Қайсысы ұнады?",
    questions: ["Кукла бар ма?", "Жеткізу қанша?", "Тапсырыс беремін"],
  },
  edited: false,
  ...overrides,
});

describe("what the ad API takes", () => {
  it("takes 1 to 3 distinct product ids", () => {
    expect(parseAdProductIds([DOLL])).toEqual([DOLL]);
    expect(parseAdProductIds([DOLL.toUpperCase(), MUG])).toEqual([DOLL, MUG]);
    expect(parseAdProductIds([])).toBeNull();
    expect(parseAdProductIds([DOLL, MUG, CLOCK, OLD_IMPORT])).toBeNull();
    expect(parseAdProductIds([DOLL, DOLL])).toBeNull();
    expect(parseAdProductIds(["../products"])).toBeNull();
    expect(parseAdProductIds("651f")).toBeNull();
  });

  it("takes a brief, its own words in one line, and the presenter only with consent", () => {
    expect(parseProductAdCreateRequest(brief())).toEqual(brief());
    expect(
      parseProductAdCreateRequest(
        brief({ idea: { kind: "own", text: "  Алматы бойынша\n жеткізу " } })
      )?.idea
    ).toEqual({ kind: "own", text: "Алматы бойынша жеткізу" });
    // The text belongs only to the owner's own words.
    expect(
      parseProductAdCreateRequest(brief({ idea: { kind: "gift", text: "x" } }))
        ?.idea
    ).toEqual({ kind: "gift" });
    expect(
      parseProductAdCreateRequest(
        brief({ presenter: { use: true, consent: true } })
      )?.presenter
    ).toEqual({ use: true, consent: true });

    for (const bad of [
      null,
      brief({ requestId: "" }),
      brief({ requestId: "x".repeat(65) }),
      brief({ productIds: [] }),
      brief({ idea: { kind: "sale" } }),
      brief({ idea: { kind: "own", text: "   " } }),
      brief({ idea: { kind: "own", text: "a".repeat(121) } }),
      brief({ voice: "airi" }),
      brief({ presenter: { use: true, consent: false } }),
      brief({ presenter: { use: "yes", consent: true } }),
    ])
      expect(parseProductAdCreateRequest(bad)).toBeNull();
  });

  it("takes the owner's edits in one line each, and nothing that changes nothing", () => {
    expect(
      parseProductAdUpdateRequest({
        sticker: " Жаңа\nтауар ",
        captions: [{ productId: DOLL.toUpperCase(), caption: " Көк  көйлек " }],
      })
    ).toEqual({
      sticker: "Жаңа тауар",
      captions: [{ productId: DOLL, caption: "Көк көйлек" }],
    });
    for (const bad of [
      {},
      null,
      { sticker: 5 },
      { captions: [] },
      { captions: [{ productId: "x", caption: "a" }] },
      {
        captions: [
          { productId: DOLL, caption: "a" },
          { productId: DOLL, caption: "b" },
        ],
      },
    ])
      expect(parseProductAdUpdateRequest(bad)).toBeNull();
  });

  it("checks edits like the script: no prices on screen, the safe band's lines, the ad's products", () => {
    const ids = [DOLL, MUG];
    expect(adWordsIssues({ sticker: "Сөреде жаңа тауарлар" }, ids)).toEqual([]);
    expect(adWordsIssues({ sticker: "5000 ₸ ғана" }, ids).join(" ")).toMatch(
      /digit.*currency/
    );
    expect(
      adWordsIssues({ ending: "өте ұзын сөйлем ".repeat(5) }, ids).join(" ")
    ).toMatch(/2 lines of 26/);
    expect(
      adWordsIssues({ captions: [{ productId: CLOCK, caption: "Сағат" }] }, ids)
    ).toEqual([`${CLOCK} isn't one of the ad's products.`]);
    expect(adWordsIssues({ priceCardTitle: "東京" }, ids).join(" ")).toMatch(
      /fonts/
    );
  });

  it("puts edits into the script and marks it edited", () => {
    const edited = applyAdWords(script(), {
      sticker: "Жаңа",
      captions: [{ productId: MUG, caption: "Кружка" }],
    });
    expect(edited.sticker).toBe("Жаңа");
    expect(edited.scenes.map(scene => scene.caption)).toEqual([
      "Көк көйлекті қуыршақ",
      "Кружка",
    ]);
    expect(edited.scenes[1]!.setting).toBe("linen_shelf");
    expect(edited.priceCardTitle).toBe("Екеуі де сөреде");
    expect(edited.edited).toBe(true);
  });
});

describe("comparing the words on screen", () => {
  it("sees an edit to any line, and nothing else", () => {
    expect(sameAdWords(script(), script({ postIntro: "Басқа" }))).toBe(true);
    expect(sameAdWords(script(), script({ ending: "Жазыңыз" }))).toBe(false);
    expect(
      sameAdWords(
        script(),
        applyAdWords(script(), {
          captions: [{ productId: DOLL, caption: "Қуыршақ" }],
        })
      )
    ).toBe(false);
  });
});
