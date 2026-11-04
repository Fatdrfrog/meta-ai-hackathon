import assert from "node:assert/strict";
import test from "node:test";

import {
  ElevenLabsSttError,
  isElevenLabsSttRefusedRequest,
} from "./elevenlabs-stt";
import { elevenLabsSpeechCostMicros } from "./elevenlabs-pricing";
import {
  ELEVENLABS_AD_SPEECH_MODELS,
  elevenLabsAdSpeechModels,
  elevenLabsSpokenSpan,
  speakElevenLabsWithTimestamps,
} from "./elevenlabs-tts";

const ANSWER = {
  audio_base64: Buffer.from("ID3 speech").toString("base64"),
  alignment: {
    characters: [" ", "Б", "е", "с", ".", " "],
    character_start_times_seconds: [0, 0.12, 0.2, 0.31, 0.4, 0.45],
    character_end_times_seconds: [0.12, 0.2, 0.31, 0.4, 0.45, 0.6],
  },
};

function fakeFetch(answer: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer();
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

test("Kazakh, Russian and English are read by Eleven v4, with a fallback that also reads them", () => {
  assert.deepEqual(elevenLabsAdSpeechModels("kk"), {
    modelId: "eleven_v4",
    fallbackModelId: "eleven_v3",
  });
  assert.equal(elevenLabsAdSpeechModels("RU").modelId, "eleven_v4");
  assert.equal(elevenLabsAdSpeechModels(null).modelId, "eleven_v4");
  // Multilingual v2 has no Kazakh: never Kazakh's model.
  assert.notEqual(
    ELEVENLABS_AD_SPEECH_MODELS.kk.fallbackModelId,
    "eleven_multilingual_v2",
  );
  // Every model has a checked list price.
  for (const models of Object.values(ELEVENLABS_AD_SPEECH_MODELS)) {
    assert.equal(elevenLabsSpeechCostMicros(1000, models.modelId), 80_000);
    assert.equal(
      elevenLabsSpeechCostMicros(1000, models.fallbackModelId),
      80_000,
    );
  }
});

test("it asks for speech with timestamps and returns the audio and where each character is", async () => {
  const { calls, fetch } = fakeFetch(
    () => new Response(JSON.stringify(ANSWER), { status: 200 }),
  );
  const speech = await speakElevenLabsWithTimestamps(
    {
      voiceId: "voice123",
      text: " Бес. ",
      modelId: "eleven_v4",
      languageCode: "kk",
      voiceSettings: { stability: 0.6, similarityBoost: 0.8 },
      seed: 7,
    },
    { apiKey: "k", fetch },
  );
  assert.equal(
    calls[0]!.url,
    "https://api.elevenlabs.io/v1/text-to-speech/voice123/with-timestamps?output_format=mp3_44100_128",
  );
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    text: "Бес.",
    model_id: "eleven_v4",
    language_code: "kk",
    voice_settings: { stability: 0.6, similarity_boost: 0.8 },
    seed: 7,
  });
  assert.equal(speech.audio.toString(), "ID3 speech");
  assert.equal(speech.mimeType, "audio/mpeg");
  assert.equal(speech.characters, 4);
  assert.equal(speech.modelId, "eleven_v4");
  assert.deepEqual(elevenLabsSpokenSpan(speech.alignment), {
    start: 0.12,
    end: 0.4,
  });
});

test("Multilingual v2 is sent no language code", async () => {
  const { calls, fetch } = fakeFetch(
    () => new Response(JSON.stringify(ANSWER), { status: 200 }),
  );
  await speakElevenLabsWithTimestamps(
    {
      voiceId: "v",
      text: "Hi",
      modelId: "eleven_multilingual_v2",
      languageCode: "ru",
    },
    { apiKey: "k", fetch },
  );
  assert.equal(
    JSON.parse(String(calls[0]!.init.body)).language_code,
    undefined,
  );
});

test("an answer without timestamps still gives the audio; one without audio is lost", async () => {
  const bare = await speakElevenLabsWithTimestamps(
    { voiceId: "v", text: "Hi", modelId: "eleven_v4" },
    {
      apiKey: "k",
      fetch: fakeFetch(
        () =>
          new Response(JSON.stringify({ audio_base64: ANSWER.audio_base64 })),
      ).fetch,
    },
  );
  assert.equal(bare.alignment, null);
  assert.equal(elevenLabsSpokenSpan(bare.alignment), null);
  const lost = await speakElevenLabsWithTimestamps(
    { voiceId: "v", text: "Hi", modelId: "eleven_v4" },
    { apiKey: "k", fetch: fakeFetch(() => new Response("{}")).fetch },
  ).catch((e: unknown) => e);
  assert.ok(lost instanceof ElevenLabsSttError);
  assert.equal(lost.info.status, 200);
});

test("a refused voice or model billed nothing; empty text or a bad id never calls", async () => {
  const refused = await speakElevenLabsWithTimestamps(
    { voiceId: "v", text: "Hi", modelId: "eleven_v4" },
    {
      apiKey: "k",
      fetch: fakeFetch(
        () =>
          new Response(
            JSON.stringify({ detail: { message: "voice_not_found" } }),
            { status: 400 },
          ),
      ).fetch,
    },
  ).catch((e: unknown) => e);
  assert.equal(isElevenLabsSttRefusedRequest(refused), true);
  const { calls, fetch } = fakeFetch(() => new Response("{}"));
  await assert.rejects(
    speakElevenLabsWithTimestamps(
      { voiceId: "v", text: "  ", modelId: "eleven_v4" },
      { apiKey: "k", fetch },
    ),
    ElevenLabsSttError,
  );
  await assert.rejects(
    speakElevenLabsWithTimestamps(
      { voiceId: "a/b", text: "x", modelId: "eleven_v4" },
      { apiKey: "k", fetch },
    ),
    ElevenLabsSttError,
  );
  assert.equal(calls.length, 0);
});
