import { cleanString } from "@icecore/shared/lib/value-utils";
import { ElevenLabsSttError } from "./elevenlabs-stt";

// ElevenLabs Voice Isolator (POST /v1/audio-isolation) on airi's platform key:
// the speech of a recording without its background noise and music. The
// Products video ad polishes the owner's own spoken clips with it. Failures
// are ElevenLabsSttError, the package's ElevenLabs error, so callers settle
// spend by the same rules as transcription: a request refused before it was
// sent or answered 4xx billed nothing, and one answered 2xx billed its audio.

const ELEVENLABS_API_BASE_URL = "https://api.elevenlabs.io/v1";
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * The Voice Isolator's list price: USD 0.12 per minute of audio, from the
 * official API pricing page (https://elevenlabs.io/pricing/api), checked
 * 2026-11-02.
 */
export const ELEVENLABS_AUDIO_ISOLATION_MICROS_PER_MINUTE = 120_000;

/**
 * What isolating `seconds` of audio costs, rounded up to the micro-dollar. A
 * started second counts whole, as for Scribe: ElevenLabs doesn't say how a
 * last partial second is metered, and rounding it up never books less.
 */
export function elevenLabsAudioIsolationCostMicros(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new RangeError("Audio duration must be a non-negative number");
  }
  return Math.ceil(
    (Math.ceil(seconds) * ELEVENLABS_AUDIO_ISOLATION_MICROS_PER_MINUTE) / 60,
  );
}

export function isElevenLabsAudioIsolationConfigured(
  apiKey?: string | null,
): boolean {
  return Boolean(
    cleanString(apiKey, 4000) ||
      cleanString(process.env.ELEVENLABS_API_KEY, 4000),
  );
}

function failure(status: number, message: string): ElevenLabsSttError {
  if (status === 401 || status === 403)
    return new ElevenLabsSttError({
      kind: "auth",
      transient: false,
      status,
      message: message || "ElevenLabs authentication failed",
    });
  if (status === 408 || status === 429)
    return new ElevenLabsSttError({
      kind: status === 408 ? "timeout" : "rate_limit",
      transient: true,
      status,
      message: message || `ElevenLabs answered ${status}`,
    });
  if (status >= 400 && status < 500)
    return new ElevenLabsSttError({
      kind: "invalid_request",
      transient: false,
      status,
      message: message || "Invalid request sent to ElevenLabs",
    });
  return new ElevenLabsSttError({
    kind: status >= 500 ? "server" : "unknown",
    transient: true,
    status,
    message: message || `ElevenLabs answered ${status}`,
  });
}

async function failureMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const payload = JSON.parse(text) as { detail?: unknown; message?: unknown };
    const detail = payload.detail;
    if (typeof detail === "string") return cleanString(detail, 300);
    if (detail && typeof detail === "object" && "message" in detail)
      return cleanString((detail as { message?: unknown }).message, 300);
    if (typeof payload.message === "string")
      return cleanString(payload.message, 300);
  } catch {
    // Not JSON: keep the start of it.
  }
  return cleanString(text, 200);
}

/**
 * The speech of `audio` with its background removed, as the audio ElevenLabs
 * returns (MP3). One request: no retry, since a lost answer may still have
 * been billed.
 */
export async function isolateElevenLabsAudio(
  input: { audio: Buffer; filename: string; mimeType: string },
  options: {
    apiKey?: string | null;
    signal?: AbortSignal;
    timeoutMs?: number;
    fetch?: typeof fetch;
  } = {},
): Promise<{ audio: Buffer; mimeType: string }> {
  const apiKey =
    cleanString(options.apiKey, 4000) ||
    cleanString(process.env.ELEVENLABS_API_KEY, 4000);
  if (!apiKey)
    throw new ElevenLabsSttError({
      kind: "config",
      transient: false,
      message: "ELEVENLABS_API_KEY is not configured",
    });
  if (input.audio.length === 0)
    throw new ElevenLabsSttError({
      kind: "invalid_request",
      transient: false,
      message: "The audio to isolate is empty",
    });
  const form = new FormData();
  form.append(
    "audio",
    new Blob([new Uint8Array(input.audio)], { type: input.mimeType }),
    input.filename,
  );
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(
      `${ELEVENLABS_API_BASE_URL}/audio-isolation`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey },
        body: form,
        signal: controller.signal,
      },
    );
  } catch (error) {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    throw new ElevenLabsSttError({
      kind: controller.signal.aborted ? "timeout" : "unknown",
      transient: true,
      message:
        error instanceof Error
          ? cleanString(error.message, 300)
          : "ElevenLabs request failed",
    });
  }
  try {
    if (!response.ok)
      throw failure(response.status, await failureMessage(response));
    let audio: Buffer;
    try {
      audio = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      // The answer was 2xx: ElevenLabs took the audio even though it was lost.
      throw new ElevenLabsSttError({
        kind: "unknown",
        transient: true,
        status: response.status,
        message:
          error instanceof Error
            ? cleanString(error.message, 300)
            : "The answer was lost",
      });
    }
    if (audio.length === 0)
      throw new ElevenLabsSttError({
        kind: "unknown",
        transient: true,
        status: response.status,
        message: "ElevenLabs returned no audio",
      });
    return {
      audio,
      mimeType:
        cleanString(response.headers.get("content-type"), 80) || "audio/mpeg",
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * ElevenLabs instrumental music / sound generation rate: USD 0.001 per second
 * (1,000 micro-dollars per second; 10 characters per second at standard rate).
 */
export const ELEVENLABS_MUSIC_MICROS_PER_SECOND = 1_000;

/**
 * What generating `seconds` of instrumental background music costs, rounded up
 * to the whole second.
 */
export function elevenLabsMusicCostMicros(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new RangeError("Music duration must be a non-negative number");
  }
  return Math.ceil(seconds) * ELEVENLABS_MUSIC_MICROS_PER_SECOND;
}

/**
 * Composes an instrumental background music track with ElevenLabs
 * (`POST /v1/music` with `force_instrumental: true`, falling back to
 * `POST /v1/sound-generation` when `/v1/music` is refused on the account tier).
 */
export async function composeElevenLabsMusic(
  input: { prompt: string; seconds: number },
  options: {
    apiKey?: string | null;
    signal?: AbortSignal;
    timeoutMs?: number;
    fetch?: typeof fetch;
  } = {},
): Promise<{ audio: Buffer; mimeType: string }> {
  const apiKey =
    cleanString(options.apiKey, 4000) ||
    cleanString(process.env.ELEVENLABS_API_KEY, 4000);
  if (!apiKey)
    throw new ElevenLabsSttError({
      kind: "config",
      transient: false,
      message: "ELEVENLABS_API_KEY is not configured",
    });
  const prompt = cleanString(input.prompt, 1000);
  if (!prompt)
    throw new ElevenLabsSttError({
      kind: "invalid_request",
      transient: false,
      message: "The music prompt is empty",
    });
  if (!Number.isFinite(input.seconds) || input.seconds <= 0)
    throw new ElevenLabsSttError({
      kind: "invalid_request",
      transient: false,
      message: "The music duration must be positive",
    });
  const clampedSeconds = Math.max(3, Math.min(60, Math.ceil(input.seconds)));
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const doFetch = options.fetch ?? fetch;
  try {
    let response: Response;
    try {
      response = await doFetch(`${ELEVENLABS_API_BASE_URL}/music`, {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt,
          music_length_ms: clampedSeconds * 1000,
          force_instrumental: true,
        }),
        signal: controller.signal,
      });
      if (
        !response.ok &&
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 401 &&
        response.status !== 408 &&
        response.status !== 429
      ) {
        response = await doFetch(
          `${ELEVENLABS_API_BASE_URL}/sound-generation`,
          {
            method: "POST",
            headers: {
              "xi-api-key": apiKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              text: prompt,
              duration_seconds: Math.min(22, clampedSeconds),
              prompt_influence: 0.3,
            }),
            signal: controller.signal,
          },
        );
      }
    } catch (error) {
      throw new ElevenLabsSttError({
        kind: controller.signal.aborted ? "timeout" : "unknown",
        transient: true,
        message:
          error instanceof Error
            ? cleanString(error.message, 300)
            : "ElevenLabs music request failed",
      });
    }
    if (!response.ok)
      throw failure(response.status, await failureMessage(response));
    let audio: Buffer;
    try {
      audio = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw new ElevenLabsSttError({
        kind: "unknown",
        transient: true,
        status: response.status,
        message:
          error instanceof Error
            ? cleanString(error.message, 300)
            : "The answer was lost",
      });
    }
    if (audio.length === 0)
      throw new ElevenLabsSttError({
        kind: "unknown",
        transient: true,
        status: response.status,
        message: "ElevenLabs returned no audio",
      });
    return {
      audio,
      mimeType:
        cleanString(response.headers.get("content-type"), 80) || "audio/mpeg",
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
