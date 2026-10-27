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
