import assert from "node:assert/strict";
import test from "node:test";
import type { AdScript, ScriptRequest } from "./script";
import {
  fallbackSpokenLine,
  sceneVoiceRoom,
  spokenLineBudget,
  spokenLineIssues,
  spokenLinesPrompt,
  SPOKEN_LINE_SCHEMA,
} from "./voice-script";

const product = (productId: string, name: string) => ({
  productId,
  name,
  englishName: null,
  priceText: "5 000 ₸",
  priceQuote: "бес мың",
  description: "",
  said: [],
});

const REQUEST: ScriptRequest = {
  language: "Kazakh",
  wordsCode: "kk",
  idea: { kind: "new", text: null },
  shopName: "Qazoner",
  products: [product("p1", "Қуыршақ"), product("p2", "Кукла 3 в 1")],
};

const script = (spoken: string[]): AdScript => ({
  sticker: "s",
  scenes: spoken.map((line, index) => ({
    productId: `p${index + 1}`,
    caption: "c",
    setting: "oak_table_window",
    spoken: line,
  })),
  priceCardTitle: "t",
  ending: "e",
  postIntro: "p",
  ctwa: { headline: "h", primaryText: "p", greeting: "g", questions: ["q"] },
});

test("the spoken line is a plain string in the schema", () => {
  assert.deepEqual(SPOKEN_LINE_SCHEMA, { type: "string" });
});

test("the prompt asks for a short line in the ad's language, with no price", () => {
  const prompt = spokenLinesPrompt(REQUEST);
  assert.match(prompt, /in Kazakh/);
  assert.match(prompt, /Never a price, a number/);
  assert.match(prompt, /at most \d+ words/);
  assert.match(
    spokenLinesPrompt({ ...REQUEST, language: "Uzbek", wordsCode: "en" }),
    /in Uzbek/,
  );
});

test("more products leave each scene's words less room", () => {
  assert.ok(sceneVoiceRoom(1) > 5);
  assert.ok(sceneVoiceRoom(3) < sceneVoiceRoom(2));
  assert.ok(spokenLineBudget(3) >= 1.2);
});

test("good lines pass; numbers, prices, signs, Tatar letters and long lines are sent back", () => {
  assert.deepEqual(
    spokenLineIssues(script(["Жұмсақ қуыршақ", "Бір керемет сыйлық"]), REQUEST),
    [],
  );
  // A product's own name may hold a number.
  assert.deepEqual(
    spokenLineIssues(script(["Қуыршақ", "Кукла 3 в 1 дайын"]), REQUEST),
    [],
  );
  // An empty line passes: code says the name.
  assert.deepEqual(spokenLineIssues(script(["", ""]), REQUEST), []);
  const [price] = spokenLineIssues(
    script(["Небары бес мың теңге", "Жақсы"]),
    REQUEST,
  );
  assert.match(price!, /scenes\[0\]\.spoken says «бес мың», «теңге»/);
  assert.match(
    spokenLineIssues(script(["Жаңа 🎁", "Жақсы"]), REQUEST)[0]!,
    /sign a voice can't say/,
  );
  assert.match(
    spokenLineIssues(script(["җуыршақ", "Жақсы"]), REQUEST)[0]!,
    /letters Kazakh doesn't use \(җ\)/,
  );
  const long =
    "Қолдан тоқылған жұмсақ қуыршақ, балаңызға ең жақсы сыйлық болатын, түнде қасында ұйықтайтын досы";
  assert.match(
    spokenLineIssues(script([long, "Жақсы"]), REQUEST)[0]!,
    /too long/,
  );
});

test("the code's own line is the product's name", () => {
  assert.equal(fallbackSpokenLine(REQUEST, REQUEST.products[0]!), "Қуыршақ.");
  assert.equal(
    fallbackSpokenLine(REQUEST, { ...REQUEST.products[0]!, name: " " }),
    "",
  );
});
