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
