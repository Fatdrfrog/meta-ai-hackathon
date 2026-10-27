const mockFetch = jest.fn();

import {
  buildWebVttFromElevenLabsWords,
  normalizeElevenLabsDubbingStatus,
  startElevenLabsDubbing,
  submitElevenLabsSoundEffect,
  submitElevenLabsTextToSpeech,
  verifyStandardElevenLabsVoice,
} from "./creative-assets";

describe("ElevenLabs creative asset helpers", () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.useRealTimers();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it.each([{ category: "professional", is_owner: false, sharing: { rate: 0.05 } }, {}, null])("rejects unverified or premium platform voices: %j", async voice => {
    mockFetch.mockResolvedValue(Response.json(voice));
    await expect(verifyStandardElevenLabsVoice("platform-key", "voice-1")).rejects.toThrow("customer ElevenLabs source");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain("/voices/voice-1");
  });

  it("accepts a known standard voice without generating audio", async () => {
    mockFetch.mockResolvedValue(Response.json({ category: "premade" }));
    await expect(verifyStandardElevenLabsVoice("platform-key", "voice-1")).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("maps word timestamps to WebVTT cues", () => {
    const vtt = buildWebVttFromElevenLabsWords([
      { text: "Hello", start: 0, end: 0.4 },
      { text: "world", start: 0.4, end: 1.1 },
      { text: "Again", start: 2.2, end: 2.8 },
    ]);

    expect(vtt).toContain("WEBVTT");
    expect(vtt).toContain("00:00:00.000 --> 00:00:01.100");
    expect(vtt).toContain("Hello world");
    expect(vtt).toContain("00:00:02.200 --> 00:00:02.800");
    expect(vtt).toContain("Again");
  });

  it("carries rounded subtitle milliseconds into the next second", () => {
    const vtt = buildWebVttFromElevenLabsWords([
      { text: "Hello", start: 59.9996, end: 61.25 },
    ]);
    expect(vtt).toContain("00:01:00.000 --> 00:01:01.250");
    expect(vtt).not.toContain(".1000");
  });

  it("enforces the requested language on a compatible speech model", async () => {
    process.env.ELEVENLABS_TTS_MODEL = "eleven_v3";
    mockFetch.mockResolvedValue(
      new Response(new Uint8Array([1, 2]), {
        headers: { "content-type": "audio/mpeg" },
      })
    );

    await submitElevenLabsTextToSpeech({
      apiKey: "el-key",
      voiceId: "voice-1",
      text: "Сәлем",
      language: "kz-KZ",
    });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({
      language_code: "kk",
      model_id: "eleven_v3",
    });
  });

  it("uses a Kazakh-capable model when Kazakh is requested without a model override", async () => {
    delete process.env.ELEVENLABS_TTS_MODEL;
    mockFetch.mockResolvedValue(
      new Response(new Uint8Array([1, 2]), {
        headers: { "content-type": "audio/mpeg" },
      })
    );
    const result = await submitElevenLabsTextToSpeech({
      apiKey: "el-key",
      voiceId: "voice-1",
      text: "Сәлем",
      language: "kk",
    });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({
      language_code: "kk",
      model_id: "eleven_v3",
    });
    expect(result.modelId).toBe("eleven_v3");
  });

  it("preserves the full subtitle interval when speaker words overlap", () => {
    const vtt = buildWebVttFromElevenLabsWords([
      { text: "Hello", start: 0, end: 3 },
      { text: "Yes", start: 0.4, end: 1 },
    ]);
    expect(vtt).toContain("00:00:00.000 --> 00:00:03.000");
  });

  it("rejects an incompatible configured model before generating Kazakh speech", async () => {
    process.env.ELEVENLABS_TTS_MODEL = "eleven_multilingual_v2";
    await expect(
      submitElevenLabsTextToSpeech({
        apiKey: "el-key",
        text: "Сәлем",
        language: "kz",
      })
    ).rejects.toThrow(/does not support Kazakh/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("keeps the speech deadline active while downloading audio", async () => {
    jest.useFakeTimers();
    process.env.ELEVENLABS_TIMEOUT_MS = "1000";
    mockFetch.mockImplementation(async (_url, init) => ({
      ok: true,
      headers: new Headers({ "content-type": "audio/mpeg" }),
      arrayBuffer: () =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        }),
    }));
    const pending = submitElevenLabsTextToSpeech({
      apiKey: "el-key",
      voiceId: "voice-1",
      text: "Hello",
    });
    const rejection = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockFetch.mock.calls[0][1].signal.aborted).toBe(true);
    await rejection;
  });

  it("uses a shorter caller deadline for conversational speech", async () => {
    jest.useFakeTimers();
    mockFetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        })
    );
    const speech = submitElevenLabsTextToSpeech({
      apiKey: "el-key",
      voiceId: "voice",
      text: "Hello",
      timeoutMs: 10000,
    });
    const rejected = expect(speech).rejects.toMatchObject({
      name: "AbortError",
    });
    await jest.advanceTimersByTimeAsync(10000);
    await rejected;
    expect(jest.getTimerCount()).toBe(0);
  });

  it("returns playable WAV bytes for raw PCM voiceover audio", async () => {
    process.env.ELEVENLABS_TTS_OUTPUT_FORMAT = "pcm_16000";
    const samples = Buffer.from([0, 0, 1, 0]);
    mockFetch.mockResolvedValue(
      new Response(samples, { headers: { "content-type": "audio/pcm" } })
    );
    const result = await submitElevenLabsTextToSpeech({
      apiKey: "el-key",
      voiceId: "voice-1",
      text: "Hello",
    });
    expect(result.mimeType).toBe("audio/wav");
    expect(result.fileName).toMatch(/\.wav$/);
    expect(result.buffer.toString("ascii", 0, 4)).toBe("RIFF");
    expect(result.buffer.toString("ascii", 8, 12)).toBe("WAVE");
    expect(result.buffer.readUInt32LE(24)).toBe(16000);
    expect(result.buffer.subarray(44)).toEqual(samples);
  });

  it("requests encoded sound effects when the TTS format is raw PCM", async () => {
    process.env.ELEVENLABS_TTS_OUTPUT_FORMAT = "pcm_16000";
    mockFetch.mockResolvedValue(
      new Response(new Uint8Array([1, 2]), {
        headers: { "content-type": "audio/mpeg" },
      })
    );
    const result = await submitElevenLabsSoundEffect({
      apiKey: "el-key",
      prompt: "Chime",
    });
    expect(mockFetch.mock.calls[0][0]).toContain("output_format=mp3_44100_128");
    expect(result.mimeType).toBe("audio/mpeg");
    expect(result.fileName).toMatch(/\.mp3$/);
  });

  it.each(["voiceover", "sound effect"])(
    "rejects empty provider %s audio",
    async kind => {
      mockFetch.mockResolvedValue(new Response(new Uint8Array()));
      const pending =
        kind === "voiceover"
          ? submitElevenLabsTextToSpeech({
              apiKey: "el-key",
              voiceId: "voice-1",
              text: "Hello",
            })
          : submitElevenLabsSoundEffect({ apiKey: "el-key", prompt: "Chime" });
      await expect(pending).rejects.toThrow(/empty audio/);
    }
  );

  it("submits sound effects with text, duration, and output format", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "audio/mpeg" }),
      arrayBuffer: async () => Buffer.from("audio").buffer,
    });

    const result = await submitElevenLabsSoundEffect({
      apiKey: "el-key",
      prompt: "soft cafe ambience",
      durationSeconds: 4,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "xi-api-key": "el-key",
          "Content-Type": "application/json",
        }),
        body: expect.any(String),
      })
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({
      text: "soft cafe ambience",
      duration_seconds: 4,
      model_id: "eleven_text_to_sound_v2",
    });
    expect(result.mimeType).toBe("audio/mpeg");
    expect(result.fileName).toBe("elevenlabs-sound-effect.mp3");
  });

  it("starts a dubbing job from a source URL and target language", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        dubbing_id: "dub-1",
        expected_duration_sec: 12,
      }),
    });

    const result = await startElevenLabsDubbing({
      apiKey: "el-key",
      sourceUrl: "https://cdn.example.com/video.mp4",
      targetLanguage: "es",
      name: "WhatsApp follow-up dub",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.elevenlabs.io/v1/dubbing",
      expect.objectContaining({
        method: "POST",
        headers: { "xi-api-key": "el-key" },
        body: expect.any(FormData),
      })
    );
    expect(result.dubbingId).toBe("dub-1");
    expect(result.expectedDurationSec).toBe(12);
  });

  it("normalizes dubbing provider statuses", () => {
    expect(normalizeElevenLabsDubbingStatus("dubbed")).toBe("complete");
    expect(normalizeElevenLabsDubbingStatus("failed")).toBe("failed");
    expect(normalizeElevenLabsDubbingStatus("dubbing")).toBe("in_progress");
  });
});
