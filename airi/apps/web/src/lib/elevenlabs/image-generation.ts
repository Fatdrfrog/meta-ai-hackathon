import "server-only";

import { fetchJsonWithinLimits } from "@/lib/http/bounded-json-response";
import {
  findGenerativeAIReferenceImageIssue,
  GENERATIVE_AI_IMAGE_ASPECT_RATIOS,
  isGenerativeAIImageModel,
} from "@icecore/scenario-contracts";
import { asRecord, readTrimmedString } from "@icecore/shared/lib/value-utils";

/**
 * ElevenLabs' image API (`/v1/flows/image`): a submitted generation is a job
 * read back until it completes, with the image at a signed URL that expires
 * about an hour after each read. Failed generations are not charged.
 */
const ELEVENLABS_IMAGE_URL = "https://api.elevenlabs.io/v1/flows/image";
const REQUEST_TIMEOUT_MS = 60_000;
const RESPONSE_MAX_BYTES = 64 * 1024;
/** Hosts ElevenLabs serves finished images from. */
const IMAGE_HOST_ALLOWLIST = ["storage.googleapis.com", "*.elevenlabs.io"];

export class ElevenLabsImageApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly payload: unknown
  ) {
    super(`ElevenLabs image request failed: HTTP ${statusCode}`);
    this.name = "ElevenLabsImageApiError";
  }
}

/** A generation ElevenLabs reports as failed: certain, and not charged. */
export class ElevenLabsImageGenerationFailedError extends Error {
  constructor(readonly failureReason: string) {
    super(`ElevenLabs image generation failed: ${failureReason}`);
    this.name = "ElevenLabsImageGenerationFailedError";
  }
}

/** The generation was still running, or unreadable, when the wait ended. */
export class ElevenLabsImageStillRunningError extends Error {
  constructor(readonly generationId: string) {
    super("ElevenLabs image generation did not finish in time");
    this.name = "ElevenLabsImageStillRunningError";
  }
}

export type ElevenLabsImageGeneration =
  | { status: "pending" | "generating" }
  | { status: "completed"; contentUrl: string; mimeType: string }
  | { status: "failed"; failureReason: string };

function headers(apiKey: string) {
  return { "Content-Type": "application/json", "xi-api-key": apiKey };
}

/** ElevenLabs' answer for logs: bounded, with the request key redacted. */
export function describeElevenLabsImageApiError(
  error: ElevenLabsImageApiError,
  apiKey?: string
): { httpStatus: number; status: string | null; message: string | null } {
  const detail = asRecord(asRecord(error.payload).detail);
  const redact = (value: unknown) => {
    const text = readTrimmedString(value);
    return (
      (apiKey ? text.replaceAll(apiKey, "[redacted]") : text).slice(0, 500) ||
      null
    );
  };
  return {
    httpStatus: error.statusCode,
    status: redact(detail.status),
    message: redact(detail.message),
  };
}

/**
 * What to tell the merchant when ElevenLabs refused to start a generation:
 * any 4xx but a timeout. Nothing was generated or charged. Null for answers
 * whose outcome is uncertain.
 */
export function readElevenLabsImageRejectionMessage(
  error: ElevenLabsImageApiError
): string | null {
  const status = error.statusCode;
  if (status < 400 || status >= 500 || status === 408) return null;
  if (status === 402) {
    return "ElevenLabs rejected the request: image generation needs a Pro plan or above with credits left. Check the ElevenLabs plan, then try again.";
  }
  if (status === 401 || status === 403) {
    return "ElevenLabs rejected the key, or it lacks the Image & Video permission. Check the ElevenLabs source in Settings > Integrations.";
  }
  if (status === 429) {
    return "ElevenLabs is limiting requests for this key. Try again later.";
  }
  return "ElevenLabs rejected the image request.";
}

/** What to tell the merchant about a generation ElevenLabs reports as failed. */
export function readElevenLabsImageFailureMessage(
  failureReason: string
): string {
  if (failureReason === "moderated") {
    return "ElevenLabs declined to generate this image under its content policy.";
  }
  if (failureReason === "charging_failed") {
    return "ElevenLabs could not charge the workspace's credits. Add credits, then try again.";
  }
  if (failureReason === "invalid_parameters") {
    return "ElevenLabs rejected the image settings.";
  }
  return "ElevenLabs could not generate the image this time.";
}

function hostMatches(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === pattern;
}

/** A finished image's download URL, only over HTTPS from ElevenLabs' storage. */
export function assertElevenLabsImageUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !IMAGE_HOST_ALLOWLIST.some(pattern => hostMatches(url.hostname, pattern))
  ) {
    throw new Error("ElevenLabs returned an image from an unexpected host");
  }
  return url;
}

/** Starts one generation and returns its id; the POST is the paid step. */
export async function submitElevenLabsImageGeneration(input: {
  apiKey: string;
  modelId: string;
  prompt: string;
  aspectRatio: string;
  images: Array<{ data: string; mimeType: string }>;
}): Promise<{ generationId: string }> {
  if (!input.prompt.trim()) {
    throw new Error("Prompt is required for ElevenLabs image generation");
  }
  if (!isGenerativeAIImageModel("elevenlabs", input.modelId)) {
    throw new Error("Unsupported ElevenLabs image generation model");
  }
  if (
    !GENERATIVE_AI_IMAGE_ASPECT_RATIOS.some(
      ratio => ratio === input.aspectRatio
    )
  ) {
    throw new Error("Unsupported ElevenLabs image aspect ratio");
  }
  if (
    findGenerativeAIReferenceImageIssue(
      input.images.map(image => ({
        mimeType: image.mimeType,
        fileSize: Buffer.byteLength(image.data, "base64"),
      }))
    )
  ) {
    throw new Error("Reference images do not meet the image limits");
  }

  const { response, payload } = await fetchJsonWithinLimits(
    ELEVENLABS_IMAGE_URL,
    {
      method: "POST",
      headers: headers(input.apiKey),
      body: JSON.stringify({
        model_id: input.modelId,
        prompt: input.prompt,
        aspect_ratio: input.aspectRatio,
        // 1K keeps a finished image well under WhatsApp's 5 MiB.
        resolution: "1K",
        ...(input.images.length > 0
          ? {
              images: input.images.map(image => ({
                type: "inline_base64",
                content_base64: image.data,
                mime_type: image.mimeType,
              })),
            }
          : {}),
      }),
    },
    { maxBytes: RESPONSE_MAX_BYTES, timeoutMs: REQUEST_TIMEOUT_MS }
  );
  if (!response.ok) throw new ElevenLabsImageApiError(response.status, payload);
  const generationId = readTrimmedString(asRecord(payload).id);
  if (!generationId) {
    throw new Error("ElevenLabs did not return an image generation id");
  }
  return { generationId };
}

/** One read of a generation's state. */
export async function readElevenLabsImageGeneration(input: {
  apiKey: string;
  generationId: string;
}): Promise<ElevenLabsImageGeneration> {
  const { response, payload } = await fetchJsonWithinLimits(
    `${ELEVENLABS_IMAGE_URL}/${encodeURIComponent(input.generationId)}`,
    { method: "GET", headers: headers(input.apiKey) },
    { maxBytes: RESPONSE_MAX_BYTES, timeoutMs: REQUEST_TIMEOUT_MS }
  );
  if (!response.ok) throw new ElevenLabsImageApiError(response.status, payload);
  const body = asRecord(payload);
  if (body.status === "pending" || body.status === "generating") {
    return { status: body.status };
  }
  if (body.status === "completed") {
    const contentUrl = readTrimmedString(body.content_url);
    const mimeType = readTrimmedString(body.content_mime_type);
    if (contentUrl && mimeType) {
      return { status: "completed", contentUrl, mimeType };
    }
  }
  if (body.status === "failed") {
    return {
      status: "failed",
      failureReason: readTrimmedString(body.failure_reason) || "unknown",
    };
  }
  throw new Error("ElevenLabs returned an unexpected image generation state");
}

const FIRST_POLL_DELAY_MS = 2_000;
const MAX_POLL_DELAY_MS = 15_000;
const DEFAULT_WAIT_MS = 5 * 60_000;

/** A read that may succeed later: throttling, a server error or transport. */
function isTransientReadError(error: unknown): boolean {
  return error instanceof ElevenLabsImageApiError
    ? error.statusCode === 408 ||
        error.statusCode === 429 ||
        error.statusCode >= 500
    : true;
}

/**
 * Reads a generation until it completes, no faster than every 2 s and backing
 * off to 15 s, as ElevenLabs asks. A failed generation throws
 * ElevenLabsImageGenerationFailedError; a definite read refusal (unknown id,
 * revoked key) throws its ElevenLabsImageApiError; still running or
 * unreadable at the deadline throws ElevenLabsImageStillRunningError.
 */
export async function waitForElevenLabsImageGeneration(input: {
  apiKey: string;
  generationId: string;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<{ contentUrl: string; mimeType: string }> {
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = input.now ?? Date.now;
  const deadline = now() + (input.timeoutMs ?? DEFAULT_WAIT_MS);
  let delay = FIRST_POLL_DELAY_MS;
  while (now() + delay <= deadline) {
    await sleep(delay);
    delay = Math.min(delay * 2, MAX_POLL_DELAY_MS);
    let generation: ElevenLabsImageGeneration;
    try {
      generation = await readElevenLabsImageGeneration(input);
    } catch (error) {
      if (isTransientReadError(error)) continue;
      throw error;
    }
    if (generation.status === "completed") {
      return {
        contentUrl: generation.contentUrl,
        mimeType: generation.mimeType,
      };
    }
    if (generation.status === "failed") {
      throw new ElevenLabsImageGenerationFailedError(generation.failureReason);
    }
  }
  throw new ElevenLabsImageStillRunningError(input.generationId);
}
