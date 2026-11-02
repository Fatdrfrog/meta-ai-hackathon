import assert from "node:assert/strict";
import test from "node:test";

import { scribeTranscriptLines } from "./transcript";

test("rebuilds sentences from Scribe's words, each with its start time", () => {
  const word = (text: string, start: number) => ({ text, type: "word", start });
  const space = { text: " ", type: "spacing", start: 0 };

  const lines = scribeTranscriptLines({
    text: "ignored when words exist",
    words: [
      word("Кукла", 1.25),
      space,
      word("Лол,", 1.6),
      space,
      { text: "(laughs)", type: "audio_event", start: 2 },
      word("бес", 2.4),
      space,
      word("мың.", 2.8),
      space,
      word("Кружка", 7.04),
      space,
      word("ақ", 7.5),
      { text: 3, type: "word", start: 8 },
    ],
  });

  assert.equal(lines, "[1.3] Кукла Лол, бес мың.\n[7.0] Кружка ақ");
});

test("falls back to plain text, or nothing", () => {
  assert.equal(scribeTranscriptLines({ text: " Сәлем " }), "Сәлем");
  assert.equal(scribeTranscriptLines({ words: [] }), "");
  assert.equal(scribeTranscriptLines(null), "");
});

test("marks the time inside a long sentence, so each part has its moment", () => {
  // QazOner's promo opens with one 7-second sentence over four products;
  // "бүгін" (today) comes over the third.
  const said = [
    ["Кезінде", 0.3],
    ["небәрі", 0.9],
    ["он", 1.5],
    ["жеті", 1.8],
    ["шаршы", 2.2],
    ["метр", 2.6],
    ["аумақтан", 3.0],
    ["бүгін", 4.1],
    ["отбасының", 5.2],
    ["тарихы", 6.4],
    ["түсірілді.", 7.0],
  ] as const;
  const words = said.flatMap(([text, start]) => [
    { text, type: "word", start },
    { text: " ", type: "spacing", start },
  ]);

  assert.equal(
    scribeTranscriptLines({ words }),
    "[0.3] Кезінде небәрі он [1.8] жеті шаршы метр аумақтан [4.1] бүгін отбасының [6.4] тарихы түсірілді.",
  );
});

const lines = (words: unknown[]) =>
  scribeTranscriptLines({ words }).split("\n");

// A spaced script's sentences as Scribe gives them: a token per word, 0.4 s
// apart, each followed by a spacing token; each sentence 3 s after the last.
const spoken = (...sentences: string[]) =>
  sentences.flatMap((sentence, at) =>
    sentence.split(" ").flatMap((text, index) => [
      { text, type: "word", start: at * 3 + index * 0.4 },
      { text: " ", type: "spacing", start: at * 3 + index * 0.4 },
    ]),
  );

test("ends sentences at the marks of every script", () => {
  // Chinese, without spacing tokens.
  assert.deepEqual(
    lines([
      { text: "这个杯子五十元。", type: "word", start: 0.2 },
      { text: "那个娃娃也是五十元。", type: "word", start: 3 },
      { text: "这个钥匙扣二十元！", type: "word", start: 6 },
    ]),
    [
      "[0.2] 这个杯子五十元。",
      "[3.0] 那个娃娃也是五十元。",
      "[6.0] 这个钥匙扣二十元！",
    ],
  );
  for (const [first, second] of [
    ["यह कप पाँच सौ रुपये का है।", "यह प्लेट भी पाँच सौ रुपये की है।"],
    ["یہ کپ پانچ سو روپے کا ہے۔", "یہ پلیٹ بھی پانچ سو روپے کی ہے۔"],
    ["كم سعر هذا الكوب؟", "خمسون ريالا."],
    ["Բաժակը հինգ հազար դրամ է։", "Ափսեն էլ հինգ հազար դրամ է։"],
    // A Greek question ends in ";", or in U+037E, which looks the same.
    ["Πόσο κάνει;", "Πέντε ευρώ."],
    ["Πόσο κάνει\u037e", "Πέντε ευρώ."],
  ] as const) {
    assert.deepEqual(
      lines(spoken(first, second)),
      [`[0.0] ${first}`, `[3.0] ${second}`],
      first,
    );
  }
  // Outside Greek, ";" ends no sentence, and "…" never does.
  assert.deepEqual(lines(spoken("Кукла бес мың; кружка бес жүз.")), [
    "[0.0] Кукла бес мың; кружка бес жүз.",
  ]);
  assert.deepEqual(lines(spoken("Кукла… бес мың.")), ["[0.0] Кукла… бес мың."]);
});

// Japanese as Scribe v2 wrote a synthetic narration (2026-11-01): a token per
// character, no spacing tokens, and each "。" a token of its own, of no length.
const characters = (text: string, start: number) =>
  [...text].map((char, index) => {
    const at = start + index * 0.15;
    return {
      text: char,
      type: "word",
      start: at,
      end: char === "。" ? at : at + 0.15,
    };
  });

test("reads Japanese as Scribe writes it, a token per character", () => {
  assert.deepEqual(
    lines([
      ...characters("このマグカップは千五百円です。", 0.08),
      ...characters("このお皿も千五百円です。", 3.3),
      ...characters("この小さいお皿は五百円です。", 6.38),
    ]),
    [
      "[0.1] このマグカップは千五百円です。",
      "[3.3] このお皿も千五百円です。",
      "[6.4] この小さいお皿は五百円です。",
    ],
  );
  // Scribe glued two of a narration's 14 "。" to the Latin word after them,
  // and timed each token from the mark: "LOL" was said about 36.1 s in.
  assert.deepEqual(
    lines([
      ...characters("三百円です", 31.68),
      { text: "。LOL", type: "word", start: 32.52, end: 36.6 },
      ...characters("ドールです", 36.6),
      { text: "。LOL", type: "word", start: 37.4, end: 38.6 },
      ...characters("ドールは五千円です。", 38.6),
    ]),
    [
      "[31.7] 三百円です。",
      "[36.6] LOLドールです。",
      "[38.6] LOLドールは五千円です。",
    ],
  );
  // A mark before a digit stays put: it may be a decimal point.
  assert.deepEqual(lines(spoken("Just .99 today.")), ["[0.0] Just .99 today."]);
});

// Thai words of two products, 0.3 s long, with 2.8 s between the products.
const thaiWords = (timed: boolean) =>
  (
    [
      ["แก้ว", 0.3],
      ["ใบนี้", 0.7],
      ["ราคา", 1.1],
      ["ห้าสิบ", 1.5],
      ["บาท", 1.9],
      ["จาน", 5],
      ["ใบนี้", 5.4],
      ["ก็", 5.8],
      ["ห้าสิบ", 6.1],
      ["บาท", 6.5],
    ] as const
  ).map(([text, start]) => ({
    text,
    type: "word",
    start,
    ...(timed ? { end: start + 0.3 } : {}),
  }));

test("without a single mark, as Scribe writes Thai, a pause ends a sentence", () => {
  assert.deepEqual(lines(thaiWords(true)), [
    "[0.3] แก้วใบนี้ราคาห้าสิบบาท",
    "[5.0] จานใบนี้ก็ห้าสิบบาท",
  ]);
  // Without end times there is no pause to go by. The marks inside, written
  // into the words they fall in, leave each word whole once dropped.
  assert.deepEqual(lines(thaiWords(false)), [
    "[0.3] แก้วใบนี้ราคาห้าสิบ[1.9]บาท[5.0]จานใบนี้ก็ห้าสิบ[6.5]บาท",
  ]);
  // A punctuated narration ends sentences at its marks alone.
  const kazakh = (
    [
      ["Кукла", 1, 1.3],
      ["бес", 3, 3.3],
      ["мың.", 3.4, 4],
      ["Кружка", 9, 9.4],
      ["ақ", 9.5, 9.8],
    ] as const
  ).flatMap(([text, start, end]) => [
    { text, type: "word", start, end },
    { text: " ", type: "spacing", start: end, end },
  ]);
  assert.deepEqual(lines(kazakh), ["[1.0] Кукла бес мың.", "[9.0] Кружка ақ"]);

  // A shorter pause ends one only where Scribe wrote a space.
  const clauses = (space: boolean) => [
    ...(
      [
        ["แก้ว", 0],
        ["ใบนี้", 0.3],
        ["ห้าสิบ", 0.6],
        ["บาท", 1],
      ] as const
    ).map(([text, start]) => ({ text, type: "word", start, end: start + 0.3 })),
    ...(space ? [{ text: " ", type: "spacing", start: 1.3, end: 1.9 }] : []),
    ...(
      [
        ["จาน", 1.9],
        ["ใบนี้", 2.2],
        ["ร้อย", 2.5],
        ["บาท", 2.8],
      ] as const
    ).map(([text, start]) => ({ text, type: "word", start, end: start + 0.3 })),
  ];
  assert.deepEqual(lines(clauses(false)), [
    "[0.0] แก้วใบนี้ห้าสิบบาทจานใบนี้ร้อยบาท",
  ]);
  assert.deepEqual(lines(clauses(true)), [
    "[0.0] แก้วใบนี้ห้าสิบบาท",
    "[1.9] จานใบนี้ร้อยบาท",
  ]);
});

test("without a single mark, a script with a space after every word stays one sentence", () => {
  // An unpunctuated Kazakh reply, with pauses of 0.6 and 0.9 s inside the
  // price: one line with marks inside, byte for byte as before pauses ended
  // sentences (78d89a672), so the price stays whole.
  const said = [
    ["Кукла", 0.3, 0.7],
    ["Лолдың", 0.8, 1.3],
    ["бағасы", 1.4, 1.9],
    ["бес", 2, 2.3],
    ["мың", 2.9, 3.2],
    ["теңге", 4.1, 4.6],
  ] as const;
  const words = said.flatMap(([text, start, end], index) => [
    { text, type: "word", start, end },
    ...(index + 1 < said.length
      ? [{ text: " ", type: "spacing", start: end, end: said[index + 1]![1] }]
      : []),
  ]);
  assert.equal(
    scribeTranscriptLines({ words }),
    "[0.3] Кукла Лолдың бағасы [2.0] бес мың [4.1] теңге",
  );
});

test("reads Thai as Scribe writes it, a clause a line", () => {
  // Scribe v2 on a synthetic Thai narration (2026-11-01): no sentence marks,
  // words cut into pieces with no spacing tokens between them, and a spacing
  // token only between clauses, over pauses of 0.68 and 0.70 s.
  const pieces = (said: string, start: number, end: number) => {
    const parts = said.split("|");
    const step = (end - start) / parts.length;
    return parts.map((text, index) => ({
      text,
      type: "word",
      start: start + index * step,
      end: start + (index + 1) * step,
    }));
  };
  assert.deepEqual(
    lines([
      ...pieces("แก้ว|ใบ|นี้|รา|คา|ห้า|สิบ|บาท", 0.1, 1.96),
      { text: " ", type: "spacing", start: 1.96, end: 2.64 },
      ...pieces("จาน|ใบ|นี้|ก็|รา|คา|ห้า|สิบ|บาท|เหมือน|กัน", 2.64, 5.08),
      { text: " ", type: "spacing", start: 5.08, end: 5.78 },
      ...pieces("ส่วน|กาน้ำชา|ใบนี้|ราคา|หนึ่งร้อย|ยี่สิบเก้า|บาท", 5.78, 9.16),
    ]),
    [
      "[0.1] แก้วใบนี้ราคาห้าสิบบาท",
      "[2.6] จานใบนี้ก็ราคาห้าสิบบาทเหมือนกัน",
      "[5.8] ส่วนกาน้ำชาใบนี้ราคาหนึ่งร้อยยี่สิบเก้าบาท",
    ],
  );
});

// Scribe v2's words for the probe's synthetic Thai narration (2026-11-01),
// as it returned them: [text, start, end], its two spacing tokens as " ".
const THAI_PROBE: Array<[string, number, number]> = [
  ["แ", 0.1, 0.14],
  ["ก้", 0.14, 0.24],
  ["ว", 0.26, 0.32],
  ["ใ", 0.32, 0.44],
  ["บ", 0.44, 0.5],
  ["นี้", 0.5, 0.92],
  ["ร", 0.92, 0.98],
  ["า", 0.98, 1.06],
  ["ค", 1.06, 1.12],
  ["า", 1.12, 1.28],
  ["ห้", 1.28, 1.36],
  ["า", 1.36, 1.46],
  ["สิ", 1.46, 1.56],
  ["บ", 1.56, 1.64],
  ["บ", 1.64, 1.72],
  ["า", 1.72, 1.86],
  ["ท", 1.86, 1.96],
  [" ", 1.96, 2.64],
  ["จ", 2.64, 2.72],
  ["า", 2.72, 2.78],
  ["น", 2.78, 2.86],
  ["ใ", 2.86, 3],
  ["บ", 3, 3.06],
  ["นี้", 3.06, 3.54],
  ["ก็", 3.54, 3.7],
  ["ร", 3.7, 3.76],
  ["า", 3.76, 3.86],
  ["ค", 3.86, 3.94],
  ["า", 3.94, 4.059],
  ["ห้", 4.059, 4.14],
  ["า", 4.14, 4.24],
  ["สิ", 4.24, 4.34],
  ["บ", 4.34, 4.42],
  ["บ", 4.42, 4.46],
  ["า", 4.46, 4.52],
  ["ท", 4.52, 4.56],
  ["เ", 4.56, 4.6],
  ["ห", 4.6, 4.62],
  ["มื", 4.62, 4.66],
  ["อ", 4.66, 4.7],
  ["น", 4.7, 4.78],
  ["กั", 4.78, 5],
  ["น", 5, 5.08],
  [" ", 5.08, 5.78],
  ["ส่", 5.78, 5.86],
  ["ว", 5.86, 5.94],
  ["น", 5.94, 6.04],
  ["ก", 6.04, 6.1],
  ["า", 6.1, 6.18],
  ["น้", 6.18, 6.28],
  ["ำ", 6.28, 6.4],
  ["ช", 6.4, 6.46],
  ["า", 6.46, 6.58],
  ["ใ", 6.58, 6.72],
  ["บ", 6.72, 6.8],
  ["นี้", 6.8, 7.36],
  ["ร", 7.36, 7.42],
  ["า", 7.42, 7.52],
  ["ค", 7.52, 7.62],
  ["า", 7.62, 7.74],
  ["ห", 7.74, 7.76],
  ["นึ่", 7.78, 7.9],
  ["ง", 7.9, 8],
  ["ร้", 8, 8.08],
  ["อ", 8.08, 8.18],
  ["ย", 8.18, 8.28],
  ["ยี่", 8.28, 8.48],
  ["สิ", 8.48, 8.58],
  ["บ", 8.58, 8.64],
  ["เ", 8.64, 8.68],
  ["ก้", 8.68, 8.76],
  ["า", 8.8, 8.9],
  ["บ", 8.9, 8.98],
  ["า", 8.98, 9.1],
  ["ท", 9.1, 9.16],
];

test("reads Scribe's real Thai words as three clauses", () => {
  assert.deepEqual(
    lines(
      THAI_PROBE.map(([text, start, end]) => ({
        text,
        type: text === " " ? "spacing" : "word",
        start,
        end,
      })),
    ),
    [
      "[0.1] แก้วใบนี้ราคาห้าสิบบาท",
      "[2.6] จานใบนี้ก็ราคาห้าสิบบาทเหมือนกัน",
      // Its marks fall inside words, and are written into them.
      "[5.8] ส่วนกาน้ำชาใบนี้[7.4]ราคาหนึ่งร้อยยี่สิบเก้า[8.9]บาท",
    ],
  );
});
