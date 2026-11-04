import assert from "node:assert/strict";
import test from "node:test";

import {
  ELEVENLABS_SCRIBE_V2_MICROS_PER_HOUR,
  ELEVENLABS_SPEECH_MICROS_PER_1000_CHARACTERS,
  elevenLabsSpeechCostMicros,
  elevenLabsTranscriptionCostMicros,
} from "./elevenlabs-pricing";

test("keeps the list prices checked on the ElevenLabs API pricing page", () => {
  assert.equal(ELEVENLABS_SCRIBE_V2_MICROS_PER_HOUR, 220_000);
  assert.deepEqual(ELEVENLABS_SPEECH_MICROS_PER_1000_CHARACTERS, {
    eleven_multilingual_v2: 80_000,
    eleven_v3: 80_000,
    eleven_v4: 80_000,
  });
});

for (const [seconds, micros] of [
  [0, 0],
  // A 30 s voice note: USD 0.22 / 3600 * 30 = 0.0018333.
  [30, 1_834],
  // The longest conversation note: USD 0.0366667.
  [600, 36_667],
  // Whole hours stay exact rather than drifting a micro-dollar up.
  [3_600, 220_000],
] as const) {
  test(`prices ${seconds} s of Scribe v2 audio at ${micros} micro-dollars`, () => {
    assert.equal(elevenLabsTranscriptionCostMicros(seconds), micros);
  });
}

test("counts a started second of audio whole", () => {
  assert.equal(
    elevenLabsTranscriptionCostMicros(30.2),
    elevenLabsTranscriptionCostMicros(31),
  );
  assert.equal(elevenLabsTranscriptionCostMicros(0.01), 62);
});

test("refuses a duration that is not a non-negative number", () => {
  for (const seconds of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => elevenLabsTranscriptionCostMicros(seconds), RangeError);
  }
});

for (const modelId of ["eleven_multilingual_v2", "eleven_v3"]) {
  test(`prices ${modelId} speech per character`, () => {
    assert.equal(elevenLabsSpeechCostMicros(0, modelId), 0);
    assert.equal(elevenLabsSpeechCostMicros(1, modelId), 80);
    assert.equal(elevenLabsSpeechCostMicros(5, modelId), 400);
    // The 2,500-character limit: USD 0.20.
    assert.equal(elevenLabsSpeechCostMicros(2_500, modelId), 200_000);
  });
}

test("refuses to price a speech model without a checked list price", () => {
  for (const modelId of ["eleven_flash_v2_5", "toString", ""]) {
    assert.throws(
      () => elevenLabsSpeechCostMicros(5, modelId),
      /No ElevenLabs list price/,
    );
  }
});

test("refuses a character count that is not a non-negative integer", () => {
  for (const characters of [-1, 1.5, Number.NaN]) {
    assert.throws(
      () => elevenLabsSpeechCostMicros(characters, "eleven_v3"),
      RangeError,
    );
  }
});
