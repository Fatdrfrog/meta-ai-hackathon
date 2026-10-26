import assert from "node:assert/strict";
import { test } from "node:test";
import { scribeLines } from "./speech.ts";

const w = (text: string, start: number) => ({ text, type: "word" as const, start });
const space = { text: " ", type: "spacing" as const, start: 0 };

test("Scribe words become timestamped sentences", () => {
  const words = [
    w("Мына", 0.5), space, w("әтеш", 0.9), space, w("бес", 1.4), space, w("жүз.", 1.7),
    { text: "(laughter)", type: "audio_event" as const, start: 2.0 },
    w("Қуыршақ", 3.2), space, w("бес", 3.8), space, w("мың", 4.1),
  ];
  assert.equal(scribeLines(words), "[0.5] Мына әтеш бес жүз.\n[3.2] Қуыршақ бес мың");
});
