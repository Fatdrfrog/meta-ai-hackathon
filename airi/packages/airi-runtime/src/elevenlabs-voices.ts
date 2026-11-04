import { cleanString } from "@icecore/shared/lib/value-utils";
import { ElevenLabsSttError } from "./elevenlabs-stt";

// ElevenLabs voices on airi's platform key: an Instant Voice Clone of a shop
// owner (POST /v1/voices/add), made only after they ticked that it's their
// voice or that the speaker agreed, and deleting it again (DELETE
// /v1/voices/{id}) when they press "Remove my voice". Failures are
// ElevenLabsSttError, the package's ElevenLabs error, so callers read them
// as they read transcription's: a 4xx refused the request, anything else may
// or may not have happened. https://elevenlabs.io/docs/api-reference/voices
// (checked 2026-11-03). An Instant Voice Clone has no list price of its own.

export const ELEVENLABS_API_BASE_URL = "https://api.elevenlabs.io/v1";
/** The voices list with search (GET /v2/voices). */
export const ELEVENLABS_API_V2_BASE_URL = "https://api.elevenlabs.io/v2";
const DEFAULT_TIMEOUT_MS = 60_000;

/** The platform key: the one given, else ELEVENLABS_API_KEY. */
export function elevenLabsPlatformKey(apiKey?: string | null): string {
  return (
    cleanString(apiKey, 4000) ||
    cleanString(process.env.ELEVENLABS_API_KEY, 4000)
  );
}

/** Whether airi's ElevenLabs key is set, so voices can be made and read. */
export function isElevenLabsVoicesConfigured(apiKey?: string | null): boolean {
  return Boolean(elevenLabsPlatformKey(apiKey));
}

/** ElevenLabs' answer `status` as the package's error, transient or not. */
export function elevenLabsRequestFailure(
  status: number,
  message: string,
): ElevenLabsSttError {
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

/** What ElevenLabs said went wrong, from its error body; never a secret. */
export async function elevenLabsFailureMessage(
  response: Response,
): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const payload = JSON.parse(text) as { detail?: unknown; message?: unknown };
    const detail = payload.detail;
    if (typeof detail === "string") return cleanString(detail, 300);
    if (Array.isArray(detail))
      return cleanString(
        detail
          .map((item) =>
            item && typeof item === "object" && "msg" in item
              ? String((item as { msg?: unknown }).msg)
              : "",
          )
          .filter(Boolean)
          .join("; "),
        300,
      );
    if (detail && typeof detail === "object" && "message" in detail)
      return cleanString((detail as { message?: unknown }).message, 300);
    if (typeof payload.message === "string")
      return cleanString(payload.message, 300);
  } catch {
    // Not JSON: keep the start of it.
  }
  return cleanString(text, 200);
}

export type ElevenLabsRequestOptions = {
  apiKey?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

/**
 * One request to ElevenLabs with airi's key, cut at the timeout or the
 * caller's signal; `read` turns a 2xx answer into the result. A request that
 * never got an answer is a transient error (it may still have been done).
 */
export async function elevenLabsRequest<T>(
  path: string,
  init: {
    method: string;
    headers?: Record<string, string>;
    body?: BodyInit;
    /** The API's root; ELEVENLABS_API_BASE_URL (v1) unless given. */
    baseUrl?: string;
  },
  read: (response: Response) => Promise<T>,
  options: ElevenLabsRequestOptions = {},
): Promise<T> {
  const apiKey = elevenLabsPlatformKey(options.apiKey);
  if (!apiKey)
    throw new ElevenLabsSttError({
      kind: "config",
      transient: false,
      message: "ELEVENLABS_API_KEY is not configured",
    });
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(
        `${init.baseUrl ?? ELEVENLABS_API_BASE_URL}${path}`,
        {
          method: init.method,
          headers: { "xi-api-key": apiKey, ...init.headers },
          ...(init.body !== undefined ? { body: init.body } : {}),
          signal: controller.signal,
        },
      );
    } catch (error) {
      throw new ElevenLabsSttError({
        kind: controller.signal.aborted ? "timeout" : "unknown",
        transient: true,
        message:
          error instanceof Error
            ? cleanString(error.message, 300)
            : "ElevenLabs request failed",
      });
    }
    if (!response.ok)
      throw elevenLabsRequestFailure(
        response.status,
        await elevenLabsFailureMessage(response),
      );
    try {
      return await read(response);
    } catch (error) {
      if (error instanceof ElevenLabsSttError) throw error;
      // The answer was 2xx: ElevenLabs did the work even though it was lost.
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
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** A recording to clone a voice from. */
export type ElevenLabsVoiceSample = {
  audio: Buffer;
  filename: string;
  mimeType: string;
};

/**
 * Makes an Instant Voice Clone from `samples` and returns its voice id. The
 * caller has the speaker's consent. `removeBackgroundNoise` runs ElevenLabs'
 * own audio isolation on the samples; airi sends them isolated already, so
 * it's off unless asked for. One request: no retry, since a lost answer may
 * still have made the voice (the caller looks it up by name, or leaves it).
 */
export async function createElevenLabsInstantVoice(
  input: {
    name: string;
    samples: ElevenLabsVoiceSample[];
    description?: string;
    removeBackgroundNoise?: boolean;
  },
  options: ElevenLabsRequestOptions = {},
): Promise<{ voiceId: string; requiresVerification: boolean }> {
  const name = cleanString(input.name, 100);
  if (!name)
    throw new ElevenLabsSttError({
      kind: "invalid_request",
      transient: false,
      message: "A cloned voice needs a name",
    });
  const samples = input.samples.filter((sample) => sample.audio.length > 0);
  if (samples.length === 0)
    throw new ElevenLabsSttError({
      kind: "invalid_request",
      transient: false,
      message: "A cloned voice needs a recording",
    });
  const form = new FormData();
  form.append("name", name);
  for (const sample of samples)
    form.append(
      "files",
      new Blob([new Uint8Array(sample.audio)], { type: sample.mimeType }),
      sample.filename,
    );
  form.append(
    "remove_background_noise",
    input.removeBackgroundNoise ? "true" : "false",
  );
  const description = cleanString(input.description, 500);
  if (description) form.append("description", description);
  return elevenLabsRequest(
    "/voices/add",
    { method: "POST", body: form },
    async (response) => {
      const payload = (await response.json()) as {
        voice_id?: unknown;
        requires_verification?: unknown;
      };
      const voiceId = cleanString(payload?.voice_id, 64);
      if (!voiceId) throw new Error("ElevenLabs answered without a voice id");
      return {
        voiceId,
        requiresVerification: payload.requires_verification === true,
      };
    },
    { timeoutMs: 90_000, ...options },
  );
}

/**
 * The ids of the voices airi's key made under exactly this name: ElevenLabs'
 * search of the account's own voices (GET /v2/voices, voice_type=personal),
 * matched in full. A clone's name carries what it was made for, so this
 * finds one whose create answer was lost, or whose run stopped before
 * saving it, to delete it.
 */
export async function findElevenLabsVoicesByName(
  name: string,
  options: ElevenLabsRequestOptions = {},
): Promise<string[]> {
  const wanted = cleanString(name, 100);
  if (!wanted) return [];
  const query = new URLSearchParams({
    search: wanted,
    voice_type: "personal",
    page_size: "100",
  });
  return elevenLabsRequest(
    `/voices?${query.toString()}`,
    { method: "GET", baseUrl: ELEVENLABS_API_V2_BASE_URL },
    async (response) => {
      const payload = (await response.json()) as { voices?: unknown };
      if (!Array.isArray(payload?.voices))
        throw new Error("ElevenLabs answered without a voice list");
      return payload.voices.flatMap((voice: unknown) => {
        const entry = voice as { voice_id?: unknown; name?: unknown } | null;
        const id = cleanString(entry?.voice_id, 64);
        return id && entry?.name === wanted ? [id] : [];
      });
    },
    { timeoutMs: 20_000, ...options },
  );
}

/**
 * Whether ElevenLabs said it has no such voice. A second DELETE (and a GET)
 * of a deleted voice is answered 400 with `voice_not_found` ("A voice with
 * ID '…' was not found."), not 404, as the paid gate saw on 2026-11-03; text
 * to speech answers it 404.
 */
function isVoiceNotFound(error: ElevenLabsSttError): boolean {
  const { status, message } = error.info;
  return (
    status === 404 ||
    (status === 400 &&
      /\bvoice\b/i.test(message) &&
      /not found|does not exist/i.test(message))
  );
}

/**
 * Deletes a voice airi made. A voice ElevenLabs no longer has (404, or 400
 * voice_not_found) counts as deleted: "Remove my voice" pressed again after
 * a delete whose answer was lost, or a voice removed in the dashboard.
 */
export async function deleteElevenLabsVoice(
  voiceId: string,
  options: ElevenLabsRequestOptions = {},
): Promise<{ deleted: true; found: boolean }> {
  const id = cleanString(voiceId, 64);
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id))
    throw new ElevenLabsSttError({
      kind: "invalid_request",
      transient: false,
      message: "Not an ElevenLabs voice id",
    });
  try {
    await elevenLabsRequest(
      `/voices/${encodeURIComponent(id)}`,
      { method: "DELETE" },
      async () => undefined,
      { timeoutMs: 20_000, ...options },
    );
    return { deleted: true, found: true };
  } catch (error) {
    if (error instanceof ElevenLabsSttError && isVoiceNotFound(error))
      return { deleted: true, found: false };
    throw error;
  }
}
