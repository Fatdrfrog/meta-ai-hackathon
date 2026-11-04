/** @jest-environment node */

// What the ad API takes, checked, and the owner's edits checked like the
// script and applied to it.

import {
  adSceneChangeIssues,
  adWordsIssues,
  applyAdSceneChanges,
  applyAdWords,
  parseAdProductIds,
  parseProductAdCreateRequest,
  parseProductAdSceneRequest,
  parseProductAdUpdateRequest,
  sameAdScenes,
  sameAdWords,
  parseProductAdPublishRequest,
} from "./ad-request";
import type { ProductAdScript } from "./types";
import type { ProductAdStoredScene } from "@icecore/temporal";

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

  it("takes every voice mode, and an Airi voice only from the curated list", () => {
    for (const voice of ["own", "clone", "none"] as const)
      expect(parseProductAdCreateRequest(brief({ voice }))?.voice).toBe(voice);
    expect(parseProductAdCreateRequest(brief({ voice: "robot" }))).toBeNull();
    // No voice is curated yet, so no Airi voice is taken.
    expect(
      parseProductAdCreateRequest(
        brief({ voice: "stock", stockVoiceId: "unlisted" })
      )
    ).toBeNull();
    expect(parseProductAdCreateRequest(brief({ voice: "stock" }))).toBeNull();
    // A voice id belongs only to "stock"; an empty one is no id.
    expect(
      parseProductAdCreateRequest(brief({ voice: "own", stockVoiceId: "x" }))
    ).toBeNull();
    expect(
      parseProductAdCreateRequest(brief({ voice: "own", stockVoiceId: null }))
    ).toEqual(brief());
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

  it("takes the Reel tile's motion with a brief and as an edit, and nothing it doesn't know", () => {
    expect(
      parseProductAdCreateRequest(brief({ motion: "filmed_sold" }))?.motion
    ).toBe("filmed_sold");
    // Absent reads as the shelf ad, as v2's briefs were.
    expect(parseProductAdCreateRequest(brief())).not.toHaveProperty("motion");
    expect(parseProductAdCreateRequest(brief({ motion: "turntable" }))).toBe(
      null
    );
    expect(parseProductAdUpdateRequest({ motion: "float" })).toEqual({
      motion: "float",
    });
    expect(
      parseProductAdUpdateRequest({ motion: "pop", sticker: " Жаңа " })
    ).toEqual({ motion: "pop", sticker: "Жаңа" });
    for (const bad of [{ motion: "spin" }, { motion: null }, { motion: 1 }])
      expect(parseProductAdUpdateRequest(bad)).toBeNull();
    expect(
      parseProductAdSceneRequest({
        requestId: "press-2",
        setting: "linen_shelf",
        changes: { motion: "filmed_sold" },
      })?.changes
    ).toEqual({ motion: "filmed_sold" });
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

describe("the scenes' free changes", () => {
  it("takes a word zone, the exact photo and a kept picture per scene, and no other keys", () => {
    expect(
      parseProductAdUpdateRequest({
        scenes: [
          { productId: DOLL.toUpperCase(), textZone: "bottom" },
          { productId: MUG, useExact: true },
        ],
      })
    ).toEqual({
      scenes: [
        { productId: DOLL, textZone: "bottom" },
        { productId: MUG, useExact: true },
      ],
    });
    expect(
      parseProductAdUpdateRequest({
        sticker: "Жаңа",
        scenes: [{ productId: DOLL, pictureIndex: 3, useExact: false }],
      })
    ).toEqual({
      sticker: "Жаңа",
      scenes: [{ productId: DOLL, pictureIndex: 3, useExact: false }],
    });
    for (const bad of [
      { scenes: [] },
      { scenes: "x" },
      { scenes: [{ productId: DOLL }] },
      { scenes: [{ productId: "x", textZone: "top" }] },
      { scenes: [{ productId: DOLL, textZone: "middle" }] },
      { scenes: [{ productId: DOLL, useExact: "yes" }] },
      { scenes: [{ productId: DOLL, pictureIndex: 4 }] },
      { scenes: [{ productId: DOLL, pictureIndex: -1 }] },
      { scenes: [{ productId: DOLL, pictureIndex: 1.5 }] },
      // A kept picture is picked to be seen, not hidden behind the exact photo.
      { scenes: [{ productId: DOLL, pictureIndex: 0, useExact: true }] },
      { scenes: [{ productId: DOLL, textZone: "top", look: "studio" }] },
      {
        scenes: [
          { productId: DOLL, textZone: "top" },
          { productId: DOLL, useExact: true },
        ],
      },
      { scenes: [1, 2, 3, 4].map(() => ({ productId: DOLL, useExact: true })) },
      { sticker: "Жаңа", motion: "lively" },
    ])
      expect(parseProductAdUpdateRequest(bad)).toBeNull();
  });

  const scene = (
    productId: string,
    overrides: Partial<ProductAdStoredScene> = {}
  ): ProductAdStoredScene => ({
    productId,
    exact: { bucket: "media", path: `exact-${productId}.png` },
    muse: { bucket: "media", path: `scene-${productId}-a1.png` },
    method: "muse",
    check: { same: true, difference: null },
    box: { x: 0.2, y: 0.3, w: 0.5, h: 0.5 },
    attempts: 1,
    pictures: [
      {
        ref: { bucket: "media", path: `scene-${productId}-a0.png` },
        box: { x: 0.1, y: 0.2, w: 0.4, h: 0.4 },
        place: "linen shelf",
        madeAt: new Date("2026-11-03T10:00:00.000Z"),
      },
      {
        ref: { bucket: "media", path: `scene-${productId}-a1.png` },
        box: { x: 0.2, y: 0.3, w: 0.5, h: 0.5 },
        place: "oak table by a window",
        madeAt: new Date("2026-11-03T10:01:00.000Z"),
      },
    ],
    ...overrides,
  });

  it("finds scene changes for products the ad doesn't show, or pictures a scene didn't keep", () => {
    const scenes = [scene(DOLL), scene(MUG, { pictures: undefined })];
    expect(
      adSceneChangeIssues(
        [
          { productId: DOLL, pictureIndex: 1 },
          { productId: MUG, textZone: "top" },
        ],
        scenes
      )
    ).toEqual([]);
    expect(
      adSceneChangeIssues(
        [
          { productId: DOLL, pictureIndex: 2 },
          { productId: MUG, pictureIndex: 0 },
          { productId: CLOCK, useExact: true },
        ],
        scenes
      )
    ).toEqual([
      `${DOLL} has no kept picture 2.`,
      `${MUG} has no kept picture 0.`,
      `${CLOCK} isn't one of the ad's scenes.`,
    ]);
    expect(adSceneChangeIssues(undefined, scenes)).toEqual([]);
  });

  it("puts a kept picture back with its box, checked, and turns the exact photo off", () => {
    const [doll, mug] = applyAdSceneChanges(
      [scene(DOLL, { useExact: true }), scene(MUG)],
      [
        { productId: DOLL, pictureIndex: 0 },
        { productId: MUG, textZone: "top", useExact: true },
      ]
    );
    expect(doll).toMatchObject({
      muse: { bucket: "media", path: `scene-${DOLL}-a0.png` },
      box: { x: 0.1, y: 0.2, w: 0.4, h: 0.4 },
      method: "muse",
      check: { same: true, difference: null },
      useExact: false,
    });
    expect(mug).toMatchObject({ textZone: "top", useExact: true });
    expect(mug!.muse).toEqual(scene(MUG).muse);
  });

  it("sees a change to a scene's picture, zone or exact photo, and nothing else", () => {
    const scenes = [scene(DOLL), scene(MUG)];
    expect(
      sameAdScenes(
        scenes,
        scenes.map(entry => ({ ...entry }))
      )
    ).toBe(true);
    // Defaults read the same as v1's absent fields.
    expect(
      sameAdScenes(scenes, [
        { ...scene(DOLL), textZone: "auto", useExact: false },
        scene(MUG),
      ])
    ).toBe(true);
    // The picture already in the video, picked again, changes nothing.
    expect(
      sameAdScenes(
        scenes,
        applyAdSceneChanges(scenes, [{ productId: DOLL, pictureIndex: 1 }])
      )
    ).toBe(true);
    for (const change of [
      { productId: DOLL, pictureIndex: 0 },
      { productId: DOLL, textZone: "bottom" as const },
      { productId: MUG, useExact: true },
    ])
      expect(sameAdScenes(scenes, applyAdSceneChanges(scenes, [change]))).toBe(
        false
      );
  });
});

describe("New picture", () => {
  it("takes a tested setting or the owner's place in up to 80 letters, exactly one", () => {
    expect(
      parseProductAdSceneRequest({
        requestId: " press-2 ",
        setting: "gift_table",
      })
    ).toEqual({ requestId: "press-2", setting: "gift_table" });
    expect(
      parseProductAdSceneRequest({
        requestId: "press-3",
        words: "  киіз үй ішінде,\nтекемет үстінде ",
        changes: { scenes: [{ productId: MUG, textZone: "top" }] },
      })
    ).toEqual({
      requestId: "press-3",
      words: "киіз үй ішінде, текемет үстінде",
      changes: { scenes: [{ productId: MUG, textZone: "top" }] },
    });
    expect(
      parseProductAdSceneRequest({ requestId: "p", words: "а".repeat(80) })
    ).toEqual({ requestId: "p", words: "а".repeat(80) });
    for (const bad of [
      null,
      { setting: "gift_table" },
      { requestId: "x".repeat(65), setting: "gift_table" },
      { requestId: "p" },
      { requestId: "p", setting: "gift_table", words: "a yurt" },
      { requestId: "p", setting: "moon" },
      { requestId: "p", words: "   " },
      { requestId: "p", words: "а".repeat(81) },
      { requestId: "p", words: 5 },
      { requestId: "p", setting: "gift_table", changes: {} },
      { requestId: "p", setting: "gift_table", changes: { sticker: 4 } },
      { requestId: "p", setting: "gift_table", look: "studio" },
    ])
      expect(parseProductAdSceneRequest(bad)).toBeNull();
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

// Studio v3: posting the ad on Instagram.
describe("the Instagram press, checked", () => {
  it("takes each destination's shape", () => {
    expect(
      parseProductAdPublishRequest({ requestId: " r-1 ", destination: "reel" })
    ).toEqual({ request: { requestId: "r-1", destination: "reel" } });
    expect(
      parseProductAdPublishRequest({
        requestId: "r-2",
        destination: "post",
        still: {
          kind: "studio",
          productId: DOLL.toUpperCase(),
          colourway: "night",
        },
        caption: "  Hi  ",
      })
    ).toEqual({
      request: {
        requestId: "r-2",
        destination: "post",
        still: { kind: "studio", productId: DOLL, colourway: "night" },
        caption: "Hi",
      },
    });
    expect(
      parseProductAdPublishRequest({
        requestId: "r-3",
        destination: "carousel",
        slides: [
          { kind: "collection", productId: null },
          { kind: "room", productId: DOLL },
        ],
      })
    ).toMatchObject({
      request: { slides: [{ kind: "collection" }, { kind: "room" }] },
    });
  });

  it("refuses what doesn't fit", () => {
    const issues = (body: unknown) =>
      "issues" in parseProductAdPublishRequest(body)
        ? (parseProductAdPublishRequest(body) as { issues: string[] }).issues
        : [];
    expect(issues(null)).toHaveLength(1);
    expect(issues({ requestId: "", destination: "reel" })).toEqual([
      "requestId: 1 to 64 characters",
    ]);
    expect(issues({ requestId: "r", destination: "facebook" })).toHaveLength(1);
    expect(issues({ requestId: "r", destination: "post" })).toEqual([
      "still: a post needs its picture",
    ]);
    expect(
      issues({
        requestId: "r",
        destination: "reel",
        still: { kind: "room", productId: DOLL },
      })
    ).toEqual(["still: a reel takes no single picture"]);
    expect(
      issues({
        requestId: "r",
        destination: "carousel",
        slides: [{ kind: "room", productId: DOLL }],
      })
    ).toEqual(["slides: 2 to 4 pictures"]);
    expect(
      issues({
        requestId: "r",
        destination: "post",
        still: { kind: "room", productId: "x" },
      })
    ).toHaveLength(1);
    expect(
      issues({ requestId: "r", destination: "reel", caption: "x".repeat(2201) })
    ).toEqual(["caption: at most 2200 characters"]);
    expect(
      issues({
        requestId: "r",
        destination: "reel",
        caption: Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" "),
      })
    ).toEqual(["caption: at most 30 hashtags"]);
  });
});
