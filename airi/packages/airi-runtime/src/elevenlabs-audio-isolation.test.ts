import assert from "node:assert/strict";
import test from "node:test";

import {
  elevenLabsAudioIsolationCostMicros,
  isElevenLabsAudioIsolationConfigured,
  isolateElevenLabsAudio,
} from "./elevenlabs-audio-isolation";
import {
  ElevenLabsSttError,
  isElevenLabsSttAcceptedRequest,
  isElevenLabsSttRefusedRequest,
} from "./elevenlabs-stt";

const INPUT = {
  audio: Buffer.from("RIFF....WAVE"),
  filename: "voice.wav",
  mimeType: "audio/wav",
};

test("the Voice Isolator is priced at USD 0.12 a minute, per started second", () => {
  assert.equal(elevenLabsAudioIsolationCostMicros(0), 0);
  assert.equal(elevenLabsAudioIsolationCostMicros(15), 30_000);
  assert.equal(elevenLabsAudioIsolationCostMicros(14.2), 30_000);
  assert.equal(elevenLabsAudioIsolationCostMicros(60), 120_000);
  assert.throws(() => elevenLabsAudioIsolationCostMicros(-1), RangeError);
});

test("it posts the audio with airi's key and returns the isolated audio", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const result = await isolateElevenLabsAudio(INPUT, {
    apiKey: "test-key",
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(Buffer.from("ID3 isolated"), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    }) as typeof fetch,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.elevenlabs.io/v1/audio-isolation");
  assert.equal(calls[0]!.init.method, "POST");
  assert.deepEqual(calls[0]!.init.headers, { "xi-api-key": "test-key" });
  const form = calls[0]!.init.body as FormData;
  const audio = form.get("audio") as File;
  assert.equal(audio.name, "voice.wav");
  assert.equal(audio.type, "audio/wav");
  assert.equal(result.audio.toString(), "ID3 isolated");
  assert.equal(result.mimeType, "audio/mpeg");
});

test("a refused request billed nothing; an outage may have", async () => {
  const answer = (status: number, body: string) =>
    (async () => new Response(body, { status })) as unknown as typeof fetch;

  const refused = await isolateElevenLabsAudio(INPUT, {
    apiKey: "test-key",
    fetch: answer(422, JSON.stringify({ detail: { message: "bad audio" } })),
  }).catch((error: unknown) => error);
  assert.ok(refused instanceof ElevenLabsSttError);
  assert.equal(refused.message, "bad audio");
  assert.equal(isElevenLabsSttRefusedRequest(refused), true);

  const outage = await isolateElevenLabsAudio(INPUT, {
    apiKey: "test-key",
    fetch: answer(503, "<html>busy</html>"),
  }).catch((error: unknown) => error);
  assert.ok(outage instanceof ElevenLabsSttError);
  assert.equal(outage.info.transient, true);
  assert.equal(isElevenLabsSttRefusedRequest(outage), false);

  const empty = await isolateElevenLabsAudio(INPUT, {
    apiKey: "test-key",
    fetch: answer(200, ""),
  }).catch((error: unknown) => error);
  assert.equal(isElevenLabsSttAcceptedRequest(empty), true);
});

test("without a key or audio, nothing is sent", async () => {
  const saved = process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  try {
    assert.equal(isElevenLabsAudioIsolationConfigured(), false);
    assert.equal(isElevenLabsAudioIsolationConfigured("key"), true);
    let sent = false;
    const noKey = await isolateElevenLabsAudio(INPUT, {
      fetch: (async () => {
        sent = true;
        return new Response("");
      }) as unknown as typeof fetch,
    }).catch((error: unknown) => error);
    assert.ok(noKey instanceof ElevenLabsSttError);
    assert.equal(noKey.info.kind, "config");
    assert.equal(isElevenLabsSttRefusedRequest(noKey), true);
    const noAudio = await isolateElevenLabsAudio(
      { ...INPUT, audio: Buffer.alloc(0) },
      { apiKey: "test-key" },
    ).catch((error: unknown) => error);
    assert.equal(isElevenLabsSttRefusedRequest(noAudio), true);
    assert.equal(sent, false);
  } finally {
    if (saved === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = saved;
  }
});
