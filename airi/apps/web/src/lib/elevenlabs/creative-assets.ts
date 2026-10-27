import "server-only";
import type { CreativeAssetStatus } from "@/models/creative-asset";
import { cleanString } from "@icecore/shared/lib/value-utils";
import { normalizeElevenLabsAudio } from "./audio";
import { resolveElevenLabsSpeechOptions } from "./speech-options";

const ELEVENLABS_API_BASE_URL = "https://api.elevenlabs.io/v1";
const DEFAULT_SOUND_EFFECT_MODEL = "eleven_text_to_sound_v2";
const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";
const DEFAULT_TIMEOUT_MS = 60_000;

export type ElevenLabsWord = {
  text?: string;
  start?: number;
  end?: number;
  start_s?: number;
  end_s?: number;
  type?: string;
  word_type?: string;
};

export type ElevenLabsAudioResult = {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  modelId: string;
  raw?: unknown;
};

export type ElevenLabsDubbingStartResult = {
  dubbingId: string;
  expectedDurationSec: number | null;
  raw: unknown;
};

export type ElevenLabsDubbingStatusResult = {
  status: CreativeAssetStatus;
  providerStatus: string;
  error: string | null;
  targetLanguages: string[];
  raw: unknown;
};

function getTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.ELEVENLABS_TIMEOUT_MS || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(5 * 60_000, Math.max(1_000, parsed));
}

function getOutputFormat(): string {
  return (
    cleanString(process.env.ELEVENLABS_TTS_OUTPUT_FORMAT, 120) ||
    DEFAULT_OUTPUT_FORMAT
  );
}

function extensionFromMimeType(mimeType: string): string {
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("vtt")) return "vtt";
  if (mimeType === "audio/basic") return "ulaw";
  return "mp3";
}

async function fetchWithTimeout<T>(
  input: string,
  init: RequestInit,
  consume: (response: Response) => Promise<T>,
  timeoutMs = getTimeoutMs()
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    return await consume(response);
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(error => {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return null;
  });
}

function errorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const raw = payload as Record<string, unknown>;
  if (typeof raw.detail === "string") return raw.detail;
  if (typeof raw.error === "string") return raw.error;
  if (typeof raw.message === "string") return raw.message;
  if (
    raw.error &&
    typeof raw.error === "object" &&
    typeof (raw.error as Record<string, unknown>).message === "string"
  ) {
    return String((raw.error as Record<string, unknown>).message);
  }
  return "";
}

function assertOk(
  response: Response,
  payload: unknown,
  fallback: string
): void {
  if (response.ok) return;
  throw new Error(
    errorMessage(payload) || `${fallback}: HTTP ${response.status}`
  );
}

function normalizeVoiceId(value: string | null | undefined): string {
  return cleanString(value, 200);
}

async function resolveVoiceId(params: {
  apiKey: string;
  preferredVoiceId?: string | null;
  timeoutMs?: number;
}): Promise<string> {
  const preferred = normalizeVoiceId(params.preferredVoiceId);
  if (preferred) return preferred;

  const envVoiceId = normalizeVoiceId(process.env.ELEVENLABS_TTS_VOICE_ID);
  if (envVoiceId) return envVoiceId;

  const payload = await fetchWithTimeout(
    `${ELEVENLABS_API_BASE_URL}/voices`,
    { method: "GET", headers: { "xi-api-key": params.apiKey } },
    async response => {
      const payload = await readJson(response);
      assertOk(response, payload, "Failed to list ElevenLabs voices");
      return payload;
    },
    params.timeoutMs
  );

  const voices =
    payload &&
    typeof payload === "object" &&
    Array.isArray((payload as { voices?: unknown }).voices)
      ? ((payload as { voices: unknown[] }).voices as Record<string, unknown>[])
      : [];
  const voice = voices.find(item => cleanString(item.voice_id, 200));
  const voiceId = cleanString(voice?.voice_id, 200);
  if (!voiceId) {
    throw new Error("No ElevenLabs voice is available for text-to-speech.");
  }
  return voiceId;
}

export async function verifyStandardElevenLabsVoice(
  apiKey: string,
  voiceId: string
) {
  await fetchWithTimeout(
    `${ELEVENLABS_API_BASE_URL}/voices/${encodeURIComponent(voiceId)}`,
    { headers: { "xi-api-key": apiKey } },
    async response => {
      const payload = await readJson(response);
      assertOk(response, payload, "Could not verify the speech voice rate");
      const voice = payload as {
        category?: string;
        is_owner?: boolean;
        sharing?: { rate?: number };
      } | null;
      if (
        !voice ||
        (voice.category !== "premade" && voice.is_owner !== true) ||
        (voice.sharing?.rate !== undefined && voice.sharing.rate !== 0)
      ) {
        throw new Error(
          "This voice requires a customer ElevenLabs source. Choose a standard platform voice or connect your source."
        );
      }
    },
    10_000
  );
}

export async function submitElevenLabsTextToSpeech(params: {
  apiKey: string;
  text: string;
  voiceId?: string | null;
  language?: string | null;
  modelId?: string;
  /** Override env default (e.g. `opus_48000_64` for WhatsApp voice notes). */
  outputFormat?: string | null;
  /** Short conversational deadlines; existing creative jobs keep their default. */
  timeoutMs?: number;
}): Promise<ElevenLabsAudioResult> {
  const text = cleanString(params.text, 2500);
  if (!text) throw new Error("Text is required for voiceover generation.");

  const outputFormat =
    cleanString(params.outputFormat, 120) || getOutputFormat();
  const { modelId, languageCode } = resolveElevenLabsSpeechOptions({
    language: params.language,
    modelId: params.modelId || cleanString(process.env.ELEVENLABS_TTS_MODEL, 120),
  });
  const voiceId = await resolveVoiceId({
    apiKey: params.apiKey,
    preferredVoiceId: params.voiceId,
    timeoutMs: params.timeoutMs,
  });
  const body: Record<string, unknown> = {
    text,
    model_id: modelId,
  };
  if (languageCode && modelId !== "eleven_multilingual_v2") {
    body.language_code = languageCode;
  }

  return fetchWithTimeout(
    `${ELEVENLABS_API_BASE_URL}/text-to-speech/${encodeURIComponent(
      voiceId
    )}?output_format=${encodeURIComponent(outputFormat)}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": params.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    async response => {
      if (!response.ok) {
        const payload = await readJson(response);
        assertOk(response, payload, "Failed to generate ElevenLabs voiceover");
      }
      const { buffer, mimeType } = normalizeElevenLabsAudio({
        buffer: Buffer.from(await response.arrayBuffer()),
        outputFormat,
        contentType: response.headers.get("content-type"),
      });
      return {
        buffer,
        mimeType,
        fileName: `elevenlabs-voiceover.${extensionFromMimeType(mimeType)}`,
        modelId,
        raw: { voiceId, outputFormat },
      };
    },
    params.timeoutMs
  );
}

export async function submitElevenLabsSoundEffect(params: {
  apiKey: string;
  prompt: string;
  durationSeconds?: number | null;
}): Promise<ElevenLabsAudioResult> {
  const prompt = cleanString(params.prompt, 1000);
  if (!prompt)
    throw new Error("Prompt is required for sound effect generation.");

  const configuredOutputFormat = getOutputFormat();
  // The shared TTS setting may request raw mono PCM. Sound effects do not
  // document their channel layout, so request an encoded container for playback.
  const outputFormat = configuredOutputFormat.toLowerCase().startsWith("pcm_")
    ? DEFAULT_OUTPUT_FORMAT
    : configuredOutputFormat;
  const modelId =
    cleanString(process.env.ELEVENLABS_SOUND_EFFECT_MODEL, 120) ||
    DEFAULT_SOUND_EFFECT_MODEL;
  const body: Record<string, unknown> = {
    text: prompt,
    model_id: modelId,
  };
  if (
    typeof params.durationSeconds === "number" &&
    Number.isFinite(params.durationSeconds)
  ) {
    body.duration_seconds = Math.min(
      30,
      Math.max(0.5, Math.round(params.durationSeconds * 10) / 10)
    );
  }

  return fetchWithTimeout(
    `${ELEVENLABS_API_BASE_URL}/sound-generation?output_format=${encodeURIComponent(
      outputFormat
    )}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": params.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    async response => {
      if (!response.ok) {
        const payload = await readJson(response);
        assertOk(
          response,
          payload,
          "Failed to generate ElevenLabs sound effect"
        );
      }
      const { buffer, mimeType } = normalizeElevenLabsAudio({
        buffer: Buffer.from(await response.arrayBuffer()),
        outputFormat,
        contentType: response.headers.get("content-type"),
      });
      return {
        buffer,
        mimeType,
        fileName: `elevenlabs-sound-effect.${extensionFromMimeType(mimeType)}`,
        modelId,
        raw: { outputFormat, durationSeconds: body.duration_seconds ?? null },
      };
    }
  );
}

function extractWords(payload: unknown): ElevenLabsWord[] {
  if (!payload || typeof payload !== "object") return [];
  const raw = payload as Record<string, unknown>;
  if (Array.isArray(raw.words)) return raw.words as ElevenLabsWord[];
  if (raw.transcription && typeof raw.transcription === "object") {
    return extractWords(raw.transcription);
  }
  if (Array.isArray(raw.transcripts)) {
    return raw.transcripts.flatMap(transcript => {
      if (!transcript || typeof transcript !== "object") return [];
      const words = (transcript as Record<string, unknown>).words;
      return Array.isArray(words) ? (words as ElevenLabsWord[]) : [];
    });
  }
  return [];
}

function extractText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const raw = payload as Record<string, unknown>;
  if (typeof raw.text === "string") return raw.text.trim();
  if (raw.transcription && typeof raw.transcription === "object") {
    return extractText(raw.transcription);
  }
  if (Array.isArray(raw.transcripts)) {
    return raw.transcripts
      .map(transcript =>
        transcript && typeof transcript === "object"
          ? cleanString((transcript as Record<string, unknown>).text, 100000)
          : ""
      )
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

export function extractElevenLabsTranscriptWords(
  payload: unknown
): ElevenLabsWord[] {
  return extractWords(payload);
}

export function extractElevenLabsTranscriptText(payload: unknown): string {
  return extractText(payload);
}

function formatTimestamp(seconds: number): string {
  const totalMillis = Math.round(Math.max(0, seconds) * 1000);
  const hours = Math.floor(totalMillis / 3_600_000);
  const minutes = Math.floor((totalMillis % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((totalMillis % 60_000) / 1000);
  const millis = totalMillis % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0"
  )}:${String(wholeSeconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

export function buildWebVttFromElevenLabsWords(
  words: ElevenLabsWord[]
): string {
  const cues: Array<{ start: number; end: number; text: string }> = [];
  let current: { start: number; end: number; parts: string[] } | null = null;

  for (const word of words) {
    const text = cleanString(word.text, 200);
    const type = cleanString(word.type || word.word_type, 40);
    if (!text || (type && type !== "word")) continue;
    const start =
      typeof word.start === "number" ? word.start : Number(word.start_s);
    const end = typeof word.end === "number" ? word.end : Number(word.end_s);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      continue;
    }

    if (
      !current ||
      start - current.end > 0.9 ||
      current.parts.join(" ").length + text.length > 64
    ) {
      if (current) {
        cues.push({
          start: current.start,
          end: current.end,
          text: current.parts.join(" "),
        });
      }
      current = { start, end, parts: [text] };
    } else {
      current.end = Math.max(current.end, end);
      current.parts.push(text);
    }
  }

  if (current) {
    cues.push({
      start: current.start,
      end: current.end,
      text: current.parts.join(" "),
    });
  }

  if (cues.length === 0) return "WEBVTT\n\n";

  return `WEBVTT\n\n${cues
    .map(
      (cue, index) =>
        `${index + 1}\n${formatTimestamp(cue.start)} --> ${formatTimestamp(
          cue.end
        )}\n${cue.text}`
    )
    .join("\n\n")}\n`;
}

export function buildWebVttFromPlainText(text: string): string {
  const cleaned = cleanString(text, 100000);
  if (!cleaned) return "WEBVTT\n\n";
  const chunks = cleaned.match(/[^.!?\n]+[.!?\n]*/g) || [cleaned];
  return `WEBVTT\n\n${chunks
    .slice(0, 100)
    .map((chunk, index) => {
      const start = index * 4;
      const end = start + 4;
      return `${index + 1}\n${formatTimestamp(start)} --> ${formatTimestamp(
        end
      )}\n${chunk.trim()}`;
    })
    .join("\n\n")}\n`;
}

export async function startElevenLabsDubbing(params: {
  apiKey: string;
  sourceUrl: string;
  targetLanguage: string;
  sourceLanguage?: string | null;
  name?: string | null;
}): Promise<ElevenLabsDubbingStartResult> {
  const sourceUrl = cleanString(params.sourceUrl, 4000);
  if (!sourceUrl || new URL(sourceUrl).protocol !== "https:") {
    throw new Error(
      "A public HTTPS audio or video URL is required for dubbing."
    );
  }
  const targetLanguage = cleanString(params.targetLanguage, 24).toLowerCase();
  if (!targetLanguage)
    throw new Error("Target language is required for dubbing.");

  const formData = new FormData();
  formData.append("source_url", sourceUrl);
  formData.append("target_lang", targetLanguage);
  formData.append(
    "source_lang",
    cleanString(params.sourceLanguage, 24) || "auto"
  );
  formData.append("watermark", "false");
  const name = cleanString(params.name, 120);
  if (name) formData.append("name", name);

  const payload = await fetchWithTimeout(
    `${ELEVENLABS_API_BASE_URL}/dubbing`,
    {
      method: "POST",
      headers: { "xi-api-key": params.apiKey },
      body: formData,
    },
    async response => {
      const payload = await readJson(response);
      assertOk(response, payload, "Failed to start ElevenLabs dubbing");
      return payload;
    }
  );

  const raw = payload && typeof payload === "object" ? payload : {};
  const dubbingId = cleanString(
    (raw as Record<string, unknown>).dubbing_id,
    200
  );
  if (!dubbingId) throw new Error("ElevenLabs did not return a dubbing id.");

  const expectedDuration = Number(
    (raw as Record<string, unknown>).expected_duration_sec
  );
  return {
    dubbingId,
    expectedDurationSec: Number.isFinite(expectedDuration)
      ? expectedDuration
      : null,
    raw: payload,
  };
}

export function normalizeElevenLabsDubbingStatus(
  status: string
): CreativeAssetStatus {
  const normalized = status.trim().toLowerCase();
  if (["dubbed", "done", "complete", "completed"].includes(normalized)) {
    return "complete";
  }
  if (["failed", "error"].includes(normalized)) return "failed";
  return "in_progress";
}

export async function getElevenLabsDubbingStatus(params: {
  apiKey: string;
  dubbingId: string;
}): Promise<ElevenLabsDubbingStatusResult> {
  const dubbingId = cleanString(params.dubbingId, 200);
  const payload = await fetchWithTimeout(
    `${ELEVENLABS_API_BASE_URL}/dubbing/${encodeURIComponent(dubbingId)}`,
    {
      method: "GET",
      headers: { "xi-api-key": params.apiKey },
    },
    async response => {
      const payload = await readJson(response);
      assertOk(response, payload, "Failed to check ElevenLabs dubbing status");
      return payload;
    }
  );

  const raw = payload && typeof payload === "object" ? payload : {};
  const providerStatus = cleanString(
    (raw as Record<string, unknown>).status,
    80
  );
  const targetLanguages = Array.isArray(
    (raw as Record<string, unknown>).target_languages
  )
    ? ((raw as Record<string, unknown>).target_languages as unknown[])
        .map(value => cleanString(value, 24))
        .filter(Boolean)
    : [];

  return {
    status: normalizeElevenLabsDubbingStatus(providerStatus),
    providerStatus,
    error: cleanString((raw as Record<string, unknown>).error, 1000) || null,
    targetLanguages,
    raw: payload,
  };
}

export async function downloadElevenLabsDubbingResult(params: {
  apiKey: string;
  dubbingId: string;
  languageCode: string;
}): Promise<ElevenLabsAudioResult> {
  return fetchWithTimeout(
    `${ELEVENLABS_API_BASE_URL}/dubbing/${encodeURIComponent(
      params.dubbingId
    )}/audio/${encodeURIComponent(params.languageCode)}`,
    {
      method: "GET",
      headers: { "xi-api-key": params.apiKey },
    },
    async response => {
      if (!response.ok) {
        const payload = await readJson(response);
        assertOk(
          response,
          payload,
          "Failed to download ElevenLabs dubbed media"
        );
      }
      const mimeType = response.headers.get("content-type") || "audio/mpeg";
      return {
        buffer: Buffer.from(await response.arrayBuffer()),
        mimeType,
        fileName: `elevenlabs-dub.${extensionFromMimeType(mimeType)}`,
        modelId: "elevenlabs-dubbing",
      };
    }
  );
}
