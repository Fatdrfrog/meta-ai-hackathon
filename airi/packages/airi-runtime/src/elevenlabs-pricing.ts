// ElevenLabs list prices for the models airi pins on platform-paid calls, in
// micro-dollars (1,000,000 per USD), from the official API pricing page,
// checked 2026-10-30: https://elevenlabs.io/pricing/api. The rates are the same
// on every plan tier and exclude taxes. Speech to text is "metered on every
// second of audio you send", silence included
// (https://elevenlabs.io/docs/overview/capabilities/speech-to-text); text to
// speech is billed per character. Recheck both before pinning another model.

/** Scribe v2 (`scribe_v2`): USD 0.22 per hour of audio. */
export const ELEVENLABS_SCRIBE_V2_MICROS_PER_HOUR = 220_000;

/**
 * Multilingual v2, v3 and v4: USD 0.08 per 1,000 characters (v4 checked
 * 2026-11-03, for the Products ad's voice-over).
 */
export const ELEVENLABS_SPEECH_MICROS_PER_1000_CHARACTERS: Readonly<
  Record<string, number>
> = {
  eleven_multilingual_v2: 80_000,
  eleven_v3: 80_000,
  eleven_v4: 80_000,
};

/**
 * What Scribe v2 charges for `seconds` of audio, rounded up to the
 * micro-dollar. A started second counts whole: ElevenLabs does not say how a
 * last partial second is metered, and rounding it up never books less than
 * the bill.
 */
export function elevenLabsTranscriptionCostMicros(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new RangeError("Audio duration must be a non-negative number");
  }
  return Math.ceil(
    (Math.ceil(seconds) * ELEVENLABS_SCRIBE_V2_MICROS_PER_HOUR) / 3600,
  );
}

/**
 * What speaking `characters` characters with `modelId` costs, rounded up to
 * the micro-dollar. A model without a checked price throws.
 */
export function elevenLabsSpeechCostMicros(
  characters: number,
  modelId: string,
): number {
  const microsPer1000 = Object.hasOwn(
    ELEVENLABS_SPEECH_MICROS_PER_1000_CHARACTERS,
    modelId,
  )
    ? ELEVENLABS_SPEECH_MICROS_PER_1000_CHARACTERS[modelId]
    : undefined;
  if (microsPer1000 === undefined) {
    throw new Error(`No ElevenLabs list price for speech model ${modelId}`);
  }
  if (!Number.isSafeInteger(characters) || characters < 0) {
    throw new RangeError("Character count must be a non-negative integer");
  }
  return Math.ceil((characters * microsPer1000) / 1000);
}
