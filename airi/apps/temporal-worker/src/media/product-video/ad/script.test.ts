import assert from "node:assert/strict";
import test from "node:test";
import { MetaModelApiError } from "@icecore/airi-runtime/meta-model-api";
import { WorkspaceAiSpendError } from "@icecore/airi-runtime/workspace-ai-spend";
import {
  PRODUCT_SHOP_WORDS_CODES,
  productAdScriptIssues,
} from "@icecore/temporal";

import {
  adScriptPrompt,
  adScriptSchema,
  fallbackAdScript,
  isKazakh,
  kazakhSpellingIssues,
  parseAdScript,
  saidAround,
  scriptLanguage,
  spokenPriceIssues,
  withCheckedOptions,
  writeAdScript,
  type ScriptRequest,
} from "./script";

const REQUEST: ScriptRequest = {
  language: "Kazakh",
  wordsCode: "kk",
  idea: { kind: "new", text: null },
  shopName: "Demo Shop",
  products: [
    {
      productId: "doll",
      name: "Кукла Лол",
      englishName: "LOL doll",
      priceText: "5 000 ₸",
      priceQuote: "бес мың теңге",
      description: "blonde doll in a blue dress",
      said: ["[1.0] Кукла Лол, бес мың теңге."],
    },
    {
      productId: "mug",
      name: "Кружка Web UMN",
      englishName: "Frosted cup",
      priceText: "500 ₸",
      priceQuote: "бес жүз теңге",
      description: "frosted plastic cup with a logo",
      said: [],
    },
  ],
};

const GOOD = {
  sticker: "Жаңа тауар",
  scenes: [
    {
      productId: "mug",
      caption: "Таңғы шайға арналған",
      setting: "oak_table_window",
    },
    {
      productId: "doll",
      caption: "Балаңызға керемет сыйлық",
      setting: "playroom_shelf",
    },
  ],
  priceCardTitle: "Біздің бағалар",
  ending: "WhatsApp-қа жазыңыз",
  postIntro: "Сөремізде жаңа тауарлар бар.",
  ctwa: {
    headline: "Жаңа тауарлар",
    primaryText: "Ұнағанын таңдап, WhatsApp-қа жазыңыз.",
    greeting: "Сәлеметсіз бе! Қандай тауар қызықтырады?",
    questions: [
      "Жеткізу бар ма?",
      "Қай жерде орналасқансыз?",
      "Басқа түсі бар ма?",
    ],
  },
};

test("the schema is strict: every object closed, every key required", () => {
  const visit = (node: unknown, path: string) => {
    if (!node || typeof node !== "object") return;
    const schema = node as Record<string, unknown>;
    if (schema.type === "object") {
      assert.equal(schema.additionalProperties, false, `${path} isn't closed`);
      const keys = Object.keys(schema.properties as object);
      assert.deepEqual(
        [...(schema.required as string[])].sort(),
        keys.sort(),
        `${path} leaves keys optional`,
      );
      for (const key of keys)
        visit(
          (schema.properties as Record<string, unknown>)[key],
          `${path}.${key}`,
        );
    }
    if (schema.type === "array") visit(schema.items, `${path}[]`);
  };
  const schema = adScriptSchema(["doll", "mug"]) as Record<string, any>;
  visit(schema, "script");
  assert.deepEqual(schema.properties.scenes.items.properties.productId.enum, [
    "doll",
    "mug",
  ]);
});

test("the prompt names the language, the products in order and the price rule", () => {
  const prompt = adScriptPrompt(REQUEST);
  assert.match(prompt, /Write every text in Kazakh/);
  assert.match(
    prompt,
    /1\. Product id "doll" is in image 1: «Кукла Лол» \(in English: LOL doll\)/,
  );
  assert.match(prompt, /2\. Product id "mug" is in image 2/);
  assert.match(prompt, /never write a price, a number, a digit or a currency/);
  // The paid gate: "only letters" made Muse Spark drop every full stop,
  // question mark and hyphen ("WhatsApp қа"); punctuation is asked for.
  assert.match(prompt, /with the language's normal punctuation, and no emoji/);
  assert.match(
    prompt,
    /the questions are sentences with full stops, commas and question marks/,
  );
  assert.match(prompt, /joining a Kazakh ending with a hyphen \(WhatsApp-қа\)/);
  assert.doesNotMatch(prompt, /Use only Latin or Cyrillic letters/);
  // The narration's neighbouring lines can be about the next product.
  assert.match(
    prompt,
    /the lines before and after may be about other products; use only what is about this one/,
  );
  assert.match(prompt, /The owner said its price as «бес мың теңге»/);
  assert.match(prompt, /\[1\.0\] Кукла Лол, бес мың теңге\./);
  assert.doesNotMatch(prompt, /previous answer/);
  const repair = adScriptPrompt(REQUEST, ["sticker has a digit"]);
  assert.match(
    repair,
    /Your previous answer had these problems[\s\S]*- sticker has a digit/,
  );
  assert.match(
    adScriptPrompt({ ...REQUEST, idea: { kind: "own", text: "Тек бүгін" } }),
    /The owner's own idea for the ad, in their words: «Тек бүгін»/,
  );
});

test("the language: the one Muse Spark named, else the fixed words' language", () => {
  assert.equal(
    scriptLanguage({ language: "Turkish", wordsCode: "en" }),
    "Turkish",
  );
  assert.equal(scriptLanguage({ language: "kk", wordsCode: "kk" }), "Kazakh");
  assert.equal(scriptLanguage({ language: null, wordsCode: "ru" }), "Russian");
  assert.equal(scriptLanguage({ language: "  ", wordsCode: null }), "English");
});

test("an answer that passes is used as it is, its scenes in the products' order", async () => {
  const questions: string[] = [];
  const written = await writeAdScript(REQUEST, async (question) => {
    questions.push(question);
    return GOOD;
  });
  assert.equal(written.source, "muse");
  assert.equal(questions.length, 1);
  assert.deepEqual(
    written.script.scenes.map((scene) => scene.productId),
    ["doll", "mug"],
  );
  assert.deepEqual(productAdScriptIssues(written.script, ["doll", "mug"]), []);
});

test("a failing answer gets one repair call with its problems; the repair is used", async () => {
  const questions: string[] = [];
  const written = await writeAdScript(REQUEST, async (question, call) => {
    questions.push(question);
    return call === 1 ? { ...GOOD, sticker: "Тек 5000 теңге!" } : GOOD;
  });
  assert.equal(written.source, "repaired");
  assert.equal(questions.length, 2);
  assert.match(questions[1]!, /sticker has a digit/);
  assert.match(questions[1]!, /sticker names a currency/);
  assert.deepEqual(written.problems.length, 2);
});

test("a Kazakh answer spelled with another language's letter gets one repair call", async () => {
  // The paid gate's toy shelf: «җуыршақ», a Tatar letter, for «қуыршақ».
  const questions: string[] = [];
  const written = await writeAdScript(REQUEST, async (question, call) => {
    questions.push(question);
    return call === 1
      ? {
          ...GOOD,
          scenes: [
            GOOD.scenes[0]!,
            { ...GOOD.scenes[1]!, caption: "Сары шашты җуыршақ" },
          ],
        }
      : GOOD;
  });
  assert.equal(written.source, "repaired");
  assert.match(questions[0]!, /Spell Kazakh with its own letters/);
  assert.match(
    questions[1]!,
    /caption has letters Kazakh doesn't use \(җ\); spell it with Kazakh letters/,
  );
});

test("the spelling check: Kazakh scripts only, and names keep their own letters", () => {
  const ids = ["doll", "mug"];
  const good = parseAdScript(GOOD, ids);
  const misspelt = parseAdScript({ ...GOOD, sticker: "Жаңа җуыршақ" }, ids);
  assert.deepEqual(kazakhSpellingIssues(good, REQUEST), []);
  assert.deepEqual(kazakhSpellingIssues(misspelt, REQUEST), [
    "sticker has letters Kazakh doesn't use (җ); spell it with Kazakh letters.",
  ]);
  // Another language's words aren't checked, nor letters a name has.
  const tatar = { ...REQUEST, language: "Tatar", wordsCode: "en" as const };
  assert.deepEqual(kazakhSpellingIssues(misspelt, tatar), []);
  const named = {
    ...REQUEST,
    products: [
      { ...REQUEST.products[0]!, name: "Җиләк" },
      REQUEST.products[1]!,
    ],
  };
  assert.deepEqual(kazakhSpellingIssues(misspelt, named), []);
  assert.doesNotMatch(
    adScriptPrompt({ ...REQUEST, language: "Russian", wordsCode: "ru" }),
    /Spell Kazakh/,
  );
});

test("Kazakh is told by any of its names, and every text is spelled-checked, the CTWA headline too", () => {
  for (const language of [
    "Kazakh",
    "Qazaq",
    "kaz",
    "қазақ тілі",
    "Казахский",
    "kk",
  ])
    assert.ok(isKazakh({ language, wordsCode: "en" }), language);
  // The language spoken wins over the fixed words' language.
  for (const language of ["Karakalpak", "Russian", "Tatar", "kazan"])
    assert.equal(isKazakh({ language, wordsCode: "kk" }), false, language);
  // The paid gate's toy shelf: «Жаңа җуыршақ пен кружка» as the headline.
  const headline = parseAdScript(
    { ...GOOD, ctwa: { ...GOOD.ctwa, headline: "Жаңа җуыршақ пен кружка" } },
    ["doll", "mug"],
  );
  assert.deepEqual(
    kazakhSpellingIssues(headline, { ...REQUEST, language: "Qazaq" }),
    [
      "ctwa.headline has letters Kazakh doesn't use (җ); spell it with Kazakh letters.",
    ],
  );
});

test("a price said in words gets one repair call; said twice, the code writes", async () => {
  // «Бар болғаны бес мыңға» ("only five thousand") passes the shared
  // checks: no digit, no currency word. It would stand next to the tag.
  const priced = {
    ...GOOD,
    scenes: [
      GOOD.scenes[0]!,
      { ...GOOD.scenes[1]!, caption: "Бар болғаны бес мыңға" },
    ],
  };
  assert.deepEqual(
    productAdScriptIssues(parseAdScript(priced, ["doll", "mug"]), [
      "doll",
      "mug",
    ]),
    [],
  );
  const questions: string[] = [];
  const repaired = await writeAdScript(REQUEST, async (question, call) => {
    questions.push(question);
    return call === 1 ? priced : GOOD;
  });
  assert.equal(repaired.source, "repaired");
  assert.match(questions[0]!, /not even in words/);
  assert.match(
    questions[1]!,
    /caption says a price in words; write no prices or numbers, code adds the prices/,
  );

  const twice = await writeAdScript(REQUEST, async () => ({
    ...GOOD,
    ending: "Бес мыңға алыңыз",
  }));
  assert.equal(twice.source, "fallback");
  assert.deepEqual(spokenPriceIssues(twice.script, REQUEST), []);
});

test("prices in words: thousands in any shop language, and each product's spoken price", () => {
  const ids = ["doll", "mug"];
  const issuesOf = (caption: string, request: ScriptRequest = REQUEST) =>
    spokenPriceIssues(
      parseAdScript(
        {
          ...GOOD,
          scenes: [{ ...GOOD.scenes[0]!, caption }, GOOD.scenes[1]!],
        },
        ids,
      ),
      request,
    );
  for (const priced of [
    "Бар болғаны бес мыңға",
    "Всего пять тысяч",
    "Only five thousand",
    "Екі млн емес",
    // The mug's own spoken price, «бес жүз», with a Kazakh ending.
    "Бар болғаны бес жүзге",
  ])
    assert.equal(issuesOf(priced).length, 1, priced);
  for (const plain of [
    "Таңғы шайға арналған",
    // One number word alone isn't the mug's price; "жүз" is also a face.
    "Бес түсі бар",
    "Жүзге арналған крем",
    "Тапсырыс беру үшін жазыңыз",
  ])
    assert.deepEqual(issuesOf(plain), [], plain);
  // A price said in one word counts as that word: «пятьсот», not «алтын».
  const rubles: ScriptRequest = {
    ...REQUEST,
    products: [
      { ...REQUEST.products[0]!, priceQuote: "всего пятьсот рублей" },
      { ...REQUEST.products[1]!, priceQuote: "алтын сақина" },
    ],
  };
  assert.equal(issuesOf("Всего пятьсот", rubles).length, 1);
  assert.deepEqual(issuesOf("Алтын түсті кружка", rubles), []);
  // "this one" in what the owner said doesn't make every "one" a price.
  const english: ScriptRequest = {
    ...REQUEST,
    products: [
      { ...REQUEST.products[0]!, priceQuote: "this one is fifty dollars" },
      REQUEST.products[1]!,
    ],
  };
  assert.deepEqual(issuesOf("The one she asked for", english), []);
  assert.equal(issuesOf("Just fifty", english).length, 1);
  // A name's own words are the product's, not a price.
  const named: ScriptRequest = {
    ...REQUEST,
    products: [
      { ...REQUEST.products[0]!, name: "Миллион раушан" },
      REQUEST.products[1]!,
    ],
  };
  assert.deepEqual(issuesOf("Миллион раушан гүлі", named), []);
  assert.deepEqual(spokenPriceIssues(parseAdScript(GOOD, ids), REQUEST), []);
});

test("two failing answers leave the code's own words, which pass the checks", async () => {
  const written = await writeAdScript(REQUEST, async () => ({
    ...GOOD,
    ending: "A".repeat(80),
  }));
  assert.equal(written.source, "fallback");
  assert.equal(written.script.sticker, "Сөремізде жаңа тауар");
  assert.deepEqual(productAdScriptIssues(written.script, ["doll", "mug"]), []);
});

test("Muse Spark errors count as failed answers; a ledger refusal is thrown on", async () => {
  let calls = 0;
  const written = await writeAdScript(REQUEST, async () => {
    calls++;
    throw new MetaModelApiError({
      kind: "server",
      transient: true,
      message: "502",
    });
  });
  assert.equal(calls, 2);
  assert.equal(written.source, "fallback");

  const recovered = await writeAdScript(REQUEST, async (_question, call) => {
    if (call === 1)
      throw new MetaModelApiError({
        kind: "server",
        transient: true,
        code: "invalid_json",
        message: "not JSON",
      });
    return GOOD;
  });
  assert.equal(recovered.source, "repaired");

  await assert.rejects(
    writeAdScript(REQUEST, async () => {
      throw new WorkspaceAiSpendError("workspace_ai_spend_limit");
    }),
    WorkspaceAiSpendError,
  );
});

test("the code's words pass the checks in every fixed language and for every idea", () => {
  for (const wordsCode of [...PRODUCT_SHOP_WORDS_CODES, null]) {
    for (const idea of [
      { kind: "new" as const, text: null },
      { kind: "gift" as const, text: null },
      { kind: "own" as const, text: "Only this week on our shelf" },
      { kind: "own" as const, text: "Акция 2 дня" },
    ]) {
      const script = fallbackAdScript({ ...REQUEST, wordsCode, idea });
      assert.deepEqual(
        productAdScriptIssues(script, ["doll", "mug"]),
        [],
        `${wordsCode} ${idea.kind}`,
      );
      assert.deepEqual(
        spokenPriceIssues(script, { ...REQUEST, wordsCode, idea }),
        [],
        `${wordsCode} ${idea.kind}: a price in words`,
      );
    }
  }
  // The owner's own words go on the sticker when they fit, but never digits.
  assert.equal(
    fallbackAdScript({
      ...REQUEST,
      idea: { kind: "own", text: "Тек осы аптада" },
    }).sticker,
    "Тек осы аптада",
  );
  assert.equal(
    fallbackAdScript({ ...REQUEST, idea: { kind: "own", text: "Акция 2 дня" } })
      .sticker,
    "Сөремізде жаңа тауар",
  );
});

test("an answer missing a product keeps its scenes as they are, for the checks to refuse", () => {
  const script = parseAdScript({ ...GOOD, scenes: [GOOD.scenes[0]] }, [
    "doll",
    "mug",
  ]);
  assert.deepEqual(productAdScriptIssues(script, ["doll", "mug"]), [
    "No scene shows product doll.",
  ]);
  // Junk becomes empty texts, which the checks also refuse.
  const junk = parseAdScript("nonsense", ["doll"]);
  assert.equal(junk.sticker, "");
  assert.deepEqual(junk.scenes, []);
});

test("the narration about a product: the quote's line, the one before, the one after while its clip runs", () => {
  const transcript = [
    "[0.0] Сәлеметсіздер ме.",
    "[1.0] Кукла Лол, бес мың теңге.",
    "[2.6] Көк көйлегі бар.",
    "[4.2] Кружка, бес жүз теңге.",
    "[7.0] Келіңіздер.",
  ].join("\n");
  const doll = { fromSeconds: 0.8, toSeconds: 4.0 };
  assert.deepEqual(saidAround(transcript, "бес мың теңге", doll), [
    "[0.0] Сәлеметсіздер ме.",
    "[1.0] Кукла Лол, бес мың теңге.",
    "[2.6] Көк көйлегі бар.",
  ]);
  // Without the clip's end, the line after may already be the next product.
  assert.deepEqual(saidAround(transcript, "бес мың теңге", null), [
    "[0.0] Сәлеметсіздер ме.",
    "[1.0] Кукла Лол, бес мың теңге.",
  ]);
  // A line where another product's price is said is that product's.
  assert.deepEqual(
    saidAround(
      transcript,
      "Көк көйлегі",
      { fromSeconds: 2.5, toSeconds: 7.5 },
      ["бес мың теңге", "бес жүз теңге"],
    ),
    ["[2.6] Көк көйлегі бар."],
  );
  assert.deepEqual(
    saidAround(transcript, "unknown words", { fromSeconds: 7.2, toSeconds: 9 }),
    ["[4.2] Кружка, бес жүз теңге.", "[7.0] Келіңіздер."],
  );
  assert.deepEqual(saidAround(transcript, null, null), []);
  assert.deepEqual(
    saidAround(null, "бес", { fromSeconds: 1, toSeconds: 2 }),
    [],
  );
});

test("the paid gate's Shezhire panel no longer gets the medal hanger's line", () => {
  // QazOner's narration: the line after the panel's price is about the
  // medal hanger (not in the ad), and starts as the panel's clip ends.
  const transcript = [
    "[0.3] Кезінде небәрі он жеті шаршы метр [1.8] аумақтан басталған біздің өндірісімізде [3.8] бүгін жиырма алты мыңнан аса отбасының [5.7] тарихы ағашқа түсірілді.",
    "[7.5] Шенжірелердің бағасы небәри он бес мың бес жүзден басталады.",
    "[11.0] Жеңімпаз бұрышын жасап, келесі жеңістерге жігер сіңіріңіз.",
  ].join("\n");
  const said = saidAround(
    transcript,
    "он бес мың бес жүзден басталады",
    { fromSeconds: 7.2, toSeconds: 11.0 },
    ["отыз бес мыңнан басталады"],
  );
  assert.equal(said.length, 2);
  assert.match(said[1]!, /^\[7\.5\] Шенжірелердің бағасы/);
  assert.ok(!said.some((line) => line.includes("Жеңімпаз")));
});

const OPENINGS = [
  { text: "Сөреде жаңа тауар", kind: "news", gloss: "New on the shelf" },
  {
    text: "Сыйлық іздеп жүрсіз бе?",
    kind: "question",
    gloss: "Looking for a gift?",
  },
  {
    text: "Балаңыз қуанады",
    kind: "promise",
    gloss: "Your child will love it",
  },
];
const ENDINGS = [
  {
    text: "Тапсырыс беру үшін жазыңыз",
    kind: "order",
    gloss: "Message us to order",
  },
  { text: "Сұрағыңызды жазыңыз", kind: "ask", gloss: "Ask us anything" },
  {
    text: "Өзіңізге сақтатып қойыңыз",
    kind: "reserve",
    gloss: "Have one kept for you",
  },
];
const WITH_OPTIONS = {
  ...GOOD,
  openings: OPENINGS,
  sticker: OPENINGS[0]!.text,
  endings: ENDINGS,
  ending: ENDINGS[0]!.text,
};

test("the schema asks for three openings and three endings, each closed, by kind", () => {
  const schema = adScriptSchema(["doll"]) as Record<string, any>;
  for (const [key, kinds] of [
    ["openings", ["news", "question", "promise"]],
    ["endings", ["order", "ask", "reserve"]],
  ] as const) {
    assert.ok(schema.required.includes(key), key);
    const item = schema.properties[key].items;
    assert.equal(item.additionalProperties, false);
    assert.deepEqual([...item.required].sort(), ["gloss", "kind", "text"]);
    assert.deepEqual(item.properties.kind.enum, kinds);
  }
  const prompt = adScriptPrompt(REQUEST);
  assert.match(prompt, /openings: exactly three short hooks/);
  assert.match(prompt, /news \(what's new on the shelf\), question/);
  assert.match(prompt, /endings: exactly three last words/);
  assert.match(prompt, /order \(to order one\), ask/);
  assert.match(prompt, /sticker: the opening you would show/);
  assert.match(prompt, /These rules hold for every opening and ending too/);
});

test("three openings and three endings are kept as written, in their kinds' order", async () => {
  const written = await writeAdScript(REQUEST, async () => ({
    ...WITH_OPTIONS,
    // Out of order, and a kind twice: the first of each is kept.
    openings: [
      OPENINGS[2],
      OPENINGS[0],
      { ...OPENINGS[0], text: "Тағы бір жаңалық" },
      OPENINGS[1],
    ],
  }));
  assert.equal(written.source, "muse");
  assert.deepEqual(written.script.openings, OPENINGS);
  assert.deepEqual(written.script.endings, ENDINGS);
  assert.equal(written.script.sticker, OPENINGS[0]!.text);
  assert.equal(written.script.ending, ENDINGS[0]!.text);
  assert.deepEqual(written.problems, []);
});

test("an opening or ending that fails a check is dropped, never the script", async () => {
  let calls = 0;
  const written = await writeAdScript(REQUEST, async () => {
    calls++;
    return {
      ...WITH_OPTIONS,
      openings: [
        // A digit; a price said in words; a Tatar letter in Kazakh.
        { ...OPENINGS[0]!, text: "Тек 2 күн" },
        { ...OPENINGS[1]!, text: "Бес мыңға сыйлық па?" },
        OPENINGS[2],
      ],
      endings: [
        ENDINGS[0],
        { ...ENDINGS[1]!, text: "Җазыңыз бізге" },
        // A gloss with a price loses only the gloss.
        { ...ENDINGS[2]!, gloss: "Keep one for 5000 tenge" },
      ],
    };
  });
  assert.equal(calls, 1, "a failing option alone asks for no repair");
  assert.equal(written.source, "muse");
  assert.deepEqual(
    written.script.openings?.map((option) => option.kind),
    ["promise"],
  );
  assert.deepEqual(
    written.script.endings?.map((option) => [option.kind, option.gloss]),
    [
      ["order", "Message us to order"],
      ["reserve", ""],
    ],
  );
  assert.equal(written.problems.length, 3);
  assert.match(written.problems.join("\n"), /openings\[0\]\.text has a digit/);
  assert.match(
    written.problems.join("\n"),
    /openings\[1\]\.text says a price in words/,
  );
  assert.match(
    written.problems.join("\n"),
    /endings\[1\]\.text has letters Kazakh doesn't use/,
  );
});

test("a missing or failing sticker or ending takes the first opening or ending that passes", async () => {
  const written = await writeAdScript(REQUEST, async () => ({
    ...WITH_OPTIONS,
    sticker: "",
    ending: "Бес мыңға алыңыз",
    openings: [{ ...OPENINGS[0]!, text: "Тек 2 күн" }, OPENINGS[1]],
  }));
  assert.equal(written.source, "muse");
  assert.equal(written.script.sticker, OPENINGS[1]!.text);
  assert.equal(written.script.ending, ENDINGS[0]!.text);

  // With no option to stand in, the script is repaired; the repair hears
  // about the dropped options too.
  const questions: string[] = [];
  const repaired = await writeAdScript(REQUEST, async (question, call) => {
    questions.push(question);
    return call === 1
      ? {
          ...GOOD,
          sticker: "",
          openings: [{ ...OPENINGS[0]!, text: "Тек 2 күн" }],
        }
      : WITH_OPTIONS;
  });
  assert.equal(repaired.source, "repaired");
  assert.match(questions[1]!, /sticker is empty/);
  assert.match(questions[1]!, /openings\[0\]\.text has a digit/);
});

test("the code's own words offer one opening and one ending", () => {
  for (const wordsCode of [...PRODUCT_SHOP_WORDS_CODES, null]) {
    for (const idea of [
      { kind: "new" as const, text: null },
      { kind: "gift" as const, text: null },
      { kind: "own" as const, text: "Тек осы аптада" },
    ]) {
      const script = fallbackAdScript({ ...REQUEST, wordsCode, idea });
      assert.equal(script.openings?.length, 1);
      assert.equal(script.endings?.length, 1);
      assert.deepEqual(
        [script.openings![0]!.kind, script.openings![0]!.text],
        ["news", script.sticker],
      );
      assert.deepEqual(
        [script.endings![0]!.kind, script.endings![0]!.text],
        ["order", script.ending],
      );
      assert.ok(script.openings![0]!.gloss && script.endings![0]!.gloss);
      assert.deepEqual(
        withCheckedOptions(script, { ...REQUEST, wordsCode, idea }).issues,
        [],
        `${wordsCode} ${idea.kind}`,
      );
    }
  }
});
