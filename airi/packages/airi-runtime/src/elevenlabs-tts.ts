import { cleanString } from "@icecore/shared/lib/value-utils";
import { ElevenLabsSttError } from "./elevenlabs-stt";
import {
  elevenLabsRequest,
  type ElevenLabsRequestOptions,
} from "./elevenlabs-voices";

// ElevenLabs text to speech with character timestamps (POST
// /v1/text-to-speech/{voice_id}/with-timestamps) on airi's platform key: the
// Products video ad's voice-over, read in the shop owner's cloned voice or
// one of airi's voices, and the voice picker's samples. The timestamps say
// where the words start and end, so the line is trimmed to them.
// https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps
// (checked 2026-11-03). Billed per character of `text` (elevenlabs-pricing.ts).

/**
 * The model each shop language is read with, and the one tried when
 * ElevenLabs refuses the first. Checked 2026-11-03 against GET /v1/models on
 * airi's account and https://elevenlabs.io/docs/overview/models: Eleven v4
 * reads Kazakh, Russian and English (94 languages) and is the one ElevenLabs
 * names for "high-fidelity voice cloning with reliable speaker
 * preservation"; Eleven v3 reads Kazakh too; Multilingual v2 and Flash v2.5
 * have no Kazakh. All of them cost USD 0.08 per 1,000 characters but Flash.
 */
export const ELEVENLABS_AD_SPEECH_MODELS: Readonly<
  Record<"kk" | "ru" | "en", { modelId: string; fallbackModelId: string }>
> = {
  kk: { modelId: "eleven_v4", fallbackModelId: "eleven_v3" },
  ru: { modelId: "eleven_v4", fallbackModelId: "eleven_multilingual_v2" },
  en: { modelId: "eleven_v4", fallbackModelId: "eleven_multilingual_v2" },
};

/** The models for a language code; Eleven v4 (then v3) for any language not listed. */
export function elevenLabsAdSpeechModels(languageCode: string | null): {
  modelId: string;
  fallbackModelId: string;
} {
  const code = (languageCode ?? "").toLowerCase();
  return Object.hasOwn(ELEVENLABS_AD_SPEECH_MODELS, code)
    ? ELEVENLABS_AD_SPEECH_MODELS[code as "kk" | "ru" | "en"]
    : { modelId: "eleven_v4", fallbackModelId: "eleven_v3" };
}

/** Models that take no `language_code` (ElevenLabs refuses it for Multilingual v2). */
const NO_LANGUAGE_CODE = new Set(["eleven_multilingual_v2"]);

/** Where each character of the text was said, in seconds. */
export type ElevenLabsAlignment = {
  characters: string[];
  starts: number[];
  ends: number[];
};

export type ElevenLabsSpeech = {
  /** The audio, as ElevenLabs encoded it (MP3 unless asked otherwise). */
  audio: Buffer;
  mimeType: string;
  /** Null when ElevenLabs sent no usable timestamps. */
  alignment: ElevenLabsAlignment | null;
  modelId: string;
  /** The characters billed: the text sent. */
  characters: number;
};

/** The characters ElevenLabs bills for `text`: every one sent. */
export function elevenLabsSpeechCharacters(text: string): number {
  return text.length;
}

function alignmentOf(value: unknown): ElevenLabsAlignment | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const characters = raw.characters;
  const starts = raw.character_start_times_seconds;
  const ends = raw.character_end_times_seconds;
  if (
    !Array.isArray(characters) ||
    !Array.isArray(starts) ||
    !Array.isArray(ends) ||
    characters.length === 0 ||
    starts.length !== characters.length ||
    ends.length !== characters.length ||
    !starts.every((t) => typeof t === "number" && Number.isFinite(t)) ||
    !ends.every((t) => typeof t === "number" && Number.isFinite(t))
  )
    return null;
  return {
    characters: characters.map(String),
    starts: starts as number[],
    ends: ends as number[],
  };
}

/**
 * Reads `text` in `voiceId` with `modelId` and returns the audio with its
 * character timestamps. One request: no retry, since a lost answer may still
 * have been billed. A 4xx (a refused voice or model) billed nothing.
 */
export async function speakElevenLabsWithTimestamps(
  input: {
    voiceId: string;
    text: string;
    modelId: string;
    /** ISO 639-1; sent to models that take it. */
    languageCode?: string | null;
    /** ElevenLabs' output format; mp3_44100_128 by default. */
    outputFormat?: string;
    /** Steadier reading for an ad; ElevenLabs' defaults otherwise. */
    voiceSettings?: {
      stability?: number;
      similarityBoost?: number;
      speed?: number;
    };
    /** Best-effort repeatable reading. */
    seed?: number;
  },
  options: ElevenLabsRequestOptions = {},
): Promise<ElevenLabsSpeech> {
  const voiceId = cleanString(input.voiceId, 64);
  if (!voiceId || !/^[A-Za-z0-9_-]+$/.test(voiceId))
    throw new ElevenLabsSttError({
      kind: "invalid_request",
      transient: false,
      message: "Not an ElevenLabs voice id",
    });
  const text = input.text.trim();
  if (!text)
    throw new ElevenLabsSttError({
      kind: "invalid_request",
      transient: false,
      message: "There is nothing to read",
    });
  const outputFormat = cleanString(input.outputFormat, 40) || "mp3_44100_128";
  const body: Record<string, unknown> = { text, model_id: input.modelId };
  const languageCode = cleanString(input.languageCode, 8).toLowerCase();
  if (languageCode && !NO_LANGUAGE_CODE.has(input.modelId))
    body.language_code = languageCode;
  if (input.voiceSettings) {
    const settings: Record<string, number> = {};
    if (input.voiceSettings.stability !== undefined)
      settings.stability = input.voiceSettings.stability;
    if (input.voiceSettings.similarityBoost !== undefined)
      settings.similarity_boost = input.voiceSettings.similarityBoost;
    if (input.voiceSettings.speed !== undefined)
      settings.speed = input.voiceSettings.speed;
    if (Object.keys(settings).length) body.voice_settings = settings;
  }
  if (input.seed !== undefined) body.seed = input.seed;
  return elevenLabsRequest(
    `/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=${encodeURIComponent(outputFormat)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    async (response) => {
      const payload = (await response.json()) as {
        audio_base64?: unknown;
        alignment?: unknown;
        normalized_alignment?: unknown;
      };
      const audio =
        typeof payload?.audio_base64 === "string"
          ? Buffer.from(payload.audio_base64, "base64")
          : Buffer.alloc(0);
      if (audio.length === 0) throw new Error("ElevenLabs returned no audio");
      return {
        audio,
        mimeType: outputFormat.startsWith("mp3")
          ? "audio/mpeg"
          : outputFormat.startsWith("opus")
            ? "audio/ogg"
            : outputFormat.startsWith("wav")
              ? "audio/wav"
              : "application/octet-stream",
        alignment:
          alignmentOf(payload.alignment) ??
          alignmentOf(payload.normalized_alignment),
        modelId: input.modelId,
        characters: elevenLabsSpeechCharacters(text),
      };
    },
    { timeoutMs: 45_000, ...options },
  );
}

/**
 * Where the words are in the audio, from the timestamps: the first and last
 * character that isn't a space or a mark. Null without timestamps or words.
 */
export function elevenLabsSpokenSpan(
  alignment: ElevenLabsAlignment | null,
): { start: number; end: number } | null {
  if (!alignment) return null;
  // Not a space or a mark (no Unicode property escapes: the web checks
  // this file at ES2017).
  const spoken = (char: string) =>
    char.length > 0 && !/^[\s.,!?;:…—–\-"'«»()[\]]+$/.test(char);
  const first = alignment.characters.findIndex(spoken);
  if (first < 0) return null;
  let last = alignment.characters.length - 1;
  while (last > first && !spoken(alignment.characters[last]!)) last--;
  const start = alignment.starts[first]!;
  const end = alignment.ends[last]!;
  return end > start ? { start, end } : null;
}
