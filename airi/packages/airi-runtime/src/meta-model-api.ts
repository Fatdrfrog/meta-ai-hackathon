import { setTimeout as sleep } from "node:timers/promises";
import { cleanString } from "@icecore/shared/lib/value-utils";

// Meta's Model API (api.meta.ai): Muse Spark reads text, images and video,
// Muse Image draws and edits images, SAM 3.1 segments images and video.
// The client records no spend; callers reserve and settle it with the costs
// below, the way the ElevenLabs transcription callers do.

const META_MODEL_API_BASE_URL = "https://api.meta.ai/v1";
// Muse Image edits took 9–29 s in testing; Muse Spark over a whole shop video
// takes longer.
const DEFAULT_TIMEOUT_MS = 180_000;
// The API sometimes answers with a 5xx HTML page that a short retry gets past.
// A 502 or 504 may come after the request was billed, so a retry can charge
// twice; at a cent or two per call that beats failing a product, which
// Temporal would then retry whole.
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [500, 2_000];
const MAX_RETRY_AFTER_MS = 10_000;
// Uploaded shop videos delete themselves after a day even if a job dies
// before deleting them; the API keeps files forever by default.
const UPLOAD_EXPIRY_SECONDS = 86_400;

const DEFAULT_MODELS = {
  museSpark: "muse-spark-1.3",
  museImage: "muse-image-1.0",
  sam: "sam-3.1",
} as const;

// List prices from dev.meta.ai, verified 2026-10-27. Muse Spark is billed by
// token, through llm-pricing.ts.
export const META_MUSE_IMAGE_COST_USD = 0.01;
export const META_SAM_IMAGE_COST_USD = 0.0025;
const META_SAM_VIDEO_COST_USD_PER_FRAME = 0.0002;
const META_SAM_VIDEO_MIN_BILLED_FRAMES = 50;

export function metaSamVideoCostUsd(frameCount: number): number {
  return (
    Math.max(Math.ceil(frameCount), META_SAM_VIDEO_MIN_BILLED_FRAMES) *
    META_SAM_VIDEO_COST_USD_PER_FRAME
  );
}

export type MetaModelApiErrorKind =
  | "config"
  | "auth"
  | "rate_limit"
  | "invalid_request"
  | "timeout"
  | "cancelled"
  | "server"
  | "unknown";

export type MetaModelApiErrorInfo = {
  kind: MetaModelApiErrorKind;
  transient: boolean;
  status?: number;
  /**
   * What exactly went wrong, when known: the API's error code, `refusal`, or
   * why an answer stopped (`max_output_tokens`).
   */
  code?: string;
  message: string;
};

export class MetaModelApiError extends Error {
  readonly info: MetaModelApiErrorInfo;

  constructor(info: MetaModelApiErrorInfo) {
    super(info.message);
    this.name = "MetaModelApiError";
    this.info = info;
  }
}

export function isMetaModelApiTransientError(
  error: unknown,
): error is MetaModelApiError {
  return error instanceof MetaModelApiError && error.info.transient;
}

/** A model declined the content itself (a safety filter), as opposed to a malformed request. */
export function isMetaModelRefusal(error: unknown): error is MetaModelApiError {
  if (!(error instanceof MetaModelApiError)) return false;
  if (error.info.kind !== "invalid_request" || error.info.status === 404)
    return false;
  return /refus|polic|safety|moderat|blocked/i.test(
    `${error.info.code ?? ""} ${error.message}`,
  );
}

export function isMetaModelApiConfigured(): boolean {
  return Boolean(cleanString(process.env.META_MODEL_API_KEY, 4000));
}

export function getMetaModels(): {
  museSpark: string;
  museImage: string;
  sam: string;
} {
  return {
    museSpark:
      cleanString(process.env.META_MUSE_SPARK_MODEL, 120) ||
      DEFAULT_MODELS.museSpark,
    museImage:
      cleanString(process.env.META_MUSE_IMAGE_MODEL, 120) ||
      DEFAULT_MODELS.museImage,
    sam: cleanString(process.env.META_SAM_MODEL, 120) || DEFAULT_MODELS.sam,
  };
}

function getApiKey(): string {
  const apiKey = cleanString(process.env.META_MODEL_API_KEY, 4000);
  if (!apiKey) {
    throw new MetaModelApiError({
      kind: "config",
      transient: false,
      message: "META_MODEL_API_KEY is not set",
    });
  }
  return apiKey;
}

function getTimeoutMs(): number {
  const parsed = Number.parseInt(
    process.env.META_MODEL_API_TIMEOUT_MS || "",
    10,
  );
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return parsed;
}

export type MetaRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

function classifyHttpFailure(
  status: number,
  failure: { message: string; code?: string },
): MetaModelApiError {
  const message = failure.message || `Meta Model API answered ${status}`;
  const base = { status, message, code: failure.code };
  if (status === 401 || status === 403)
    return new MetaModelApiError({ ...base, kind: "auth", transient: false });
  if (status === 408)
    return new MetaModelApiError({ ...base, kind: "timeout", transient: true });
  if (status === 429)
    return new MetaModelApiError({
      ...base,
      kind: "rate_limit",
      transient: true,
    });
  if (status >= 400 && status < 500)
    return new MetaModelApiError({
      ...base,
      kind: "invalid_request",
      transient: false,
    });
  return new MetaModelApiError({
    ...base,
    kind: status >= 500 ? "server" : "unknown",
    transient: true,
  });
}

async function failureOf(
  response: Response,
): Promise<{ message: string; code?: string }> {
  const text = await response.text().catch(() => "");
  try {
    const payload = JSON.parse(text) as {
      error?: { message?: unknown; code?: unknown; type?: unknown } | string;
      message?: unknown;
    };
    const error = typeof payload.error === "object" ? payload.error : null;
    const message =
      typeof payload.error === "string"
        ? payload.error
        : (error?.message ?? payload.message);
    const code = error?.code ?? error?.type;
    return {
      message: typeof message === "string" ? cleanString(message, 500) : "",
      code: typeof code === "string" ? cleanString(code, 120) : undefined,
    };
  } catch {
    // An HTML error page; keep its start.
    return { message: cleanString(text, 300) };
  }
}

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(ms)
    ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms))
    : null;
}

type OpenResponse = {
  response: Response;
  /** Classifies an error met while reading the body, like one met before it. */
  fail: (error: unknown) => unknown;
  /** Stops the timer; call once the body has been read. */
  release: () => void;
};

/**
 * Sends a request and hands back the open response. One timeout covers the
 * whole exchange, retries and reading a streamed body included.
 */
async function send(
  method: "POST" | "DELETE",
  path: string,
  init: { headers?: Record<string, string>; body?: BodyInit },
  options: MetaRequestOptions = {},
): Promise<OpenResponse> {
  const apiKey = getApiKey();
  const timeoutMs = options.timeoutMs ?? getTimeoutMs();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const release = () => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  };
  const fail = (error: unknown): unknown => {
    if (error instanceof MetaModelApiError) return error;
    if (controller.signal.aborted) {
      return timedOut
        ? new MetaModelApiError({
            kind: "timeout",
            transient: true,
            message: `Meta Model API request stopped after ${timeoutMs} ms`,
          })
        : new MetaModelApiError({
            kind: "cancelled",
            transient: false,
            message: "Meta Model API request was cancelled",
          });
    }
    return new MetaModelApiError({
      kind: error instanceof SyntaxError ? "server" : "unknown",
      transient: true,
      message:
        error instanceof SyntaxError
          ? "Meta Model API sent a response that couldn't be read"
          : error instanceof Error
            ? cleanString(error.message, 300)
            : "Meta Model API request failed",
    });
  };

  try {
    if (controller.signal.aborted) throw new Error("aborted before sending");
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${META_MODEL_API_BASE_URL}${path}`, {
        method,
        headers: { authorization: `Bearer ${apiKey}`, ...init.headers },
        body: init.body,
        signal: controller.signal,
      });
      if (response.ok) return { response, fail, release };
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !RETRY_STATUSES.has(response.status)) {
        throw classifyHttpFailure(response.status, await failureOf(response));
      }
      const wait = retryAfterMs(response) ?? delay;
      await response.body?.cancel();
      await sleep(wait, undefined, { signal: controller.signal });
    }
  } catch (error) {
    release();
    throw fail(error);
  }
}

async function readJson<T>(open: OpenResponse): Promise<T> {
  try {
    return (await open.response.json()) as T;
  } catch (error) {
    throw open.fail(error);
  } finally {
    open.release();
  }
}

function postJson<T>(
  path: string,
  body: unknown,
  options?: MetaRequestOptions,
): Promise<T> {
  return send(
    "POST",
    path,
    {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    options,
  ).then((open) => readJson<T>(open));
}

export type MetaResponseRequest = {
  model: string;
  input: unknown;
  [field: string]: unknown;
};

export type MetaResponseUsage = {
  input_tokens: number;
  output_tokens: number;
  input_tokens_details?: { cached_tokens?: number };
};

export type MetaResponse = {
  id: string;
  status: string;
  incomplete_details?: { reason?: string } | null;
  output: Array<{
    type: string;
    content?: Array<{ type: string; text?: string; refusal?: string }>;
  }>;
  usage?: MetaResponseUsage;
};

/**
 * One Responses API call (Muse Spark); its usage prices it through
 * llm-pricing. Throws unless the answer is complete: a refusal, or an answer
 * cut off at `max_output_tokens`, would otherwise reach the caller as text.
 */
export async function createMetaResponse(
  request: MetaResponseRequest,
  options?: MetaRequestOptions,
): Promise<MetaResponse> {
  const response = await postJson<MetaResponse>("/responses", request, options);
  const refusal = response.output
    .flatMap((item) => item.content ?? [])
    .find((part) => part.type === "refusal");
  if (refusal) {
    throw new MetaModelApiError({
      kind: "invalid_request",
      transient: false,
      code: "refusal",
      message: cleanString(refusal.refusal, 500) || "The model refused",
    });
  }
  if (response.status === "incomplete") {
    const reason = cleanString(response.incomplete_details?.reason, 120);
    throw new MetaModelApiError({
      kind: "invalid_request",
      transient: false,
      code: reason || "incomplete",
      message: `The model's answer was cut off${reason ? ` (${reason})` : ""}`,
    });
  }
  if (response.status !== "completed") {
    throw new MetaModelApiError({
      kind: "server",
      transient: true,
      code: cleanString(response.status, 40) || undefined,
      message: `The model's answer ended as "${response.status}"`,
    });
  }
  return response;
}

export function metaResponseText(response: MetaResponse): string {
  return response.output
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("");
}

export type MetaStreamEvent = { type: string; [field: string]: unknown };

/**
 * A streamed Responses API call, as the server-sent events arrive. SAM 3.1
 * answers this way; the request is billed once accepted, even if the reader
 * stops early.
 */
export async function* streamMetaResponse(
  request: MetaResponseRequest,
  options?: MetaRequestOptions,
): AsyncGenerator<MetaStreamEvent> {
  const open = await send(
    "POST",
    "/responses",
    {
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({ ...request, stream: true }),
    },
    options,
  );
  try {
    if (!open.response.body) return;
    for await (const data of readSseData(open.response.body)) {
      if (data === "[DONE]") return;
      yield JSON.parse(data) as MetaStreamEvent;
    }
  } catch (error) {
    throw open.fail(error);
  } finally {
    open.release();
  }
}

// The data payload of each server-sent event, joining multi-line data fields.
async function* readSseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll(
        "\r\n",
        "\n",
      );
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        const data = sseDataOf(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (data !== undefined) yield data;
        end = buffer.indexOf("\n\n");
      }
    }
    const data = sseDataOf(
      (buffer + decoder.decode()).replaceAll("\r\n", "\n"),
    );
    if (data !== undefined) yield data;
  } finally {
    // Stopping early (a [DONE] event, or the reader quitting) cancels the body.
    await reader.cancel().catch(() => undefined);
  }
}

function sseDataOf(block: string): string | undefined {
  const lines = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5));
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/**
 * Uploads media (a shop video) for later calls to refer to by id. It expires
 * after a day; delete it with `deleteMetaFile` once it isn't needed.
 */
export async function uploadMetaFile(
  file: { data: Uint8Array; filename: string; mimeType: string },
  options?: MetaRequestOptions,
): Promise<{ id: string }> {
  const form = new FormData();
  form.set("purpose", "user_data");
  form.set("expires_after[anchor]", "created_at");
  form.set("expires_after[seconds]", String(UPLOAD_EXPIRY_SECONDS));
  form.set(
    "file",
    new Blob([new Uint8Array(file.data)], { type: file.mimeType }),
    file.filename,
  );
  const json = await readJson<{ id?: unknown }>(
    await send("POST", "/files", { body: form }, options),
  );
  if (typeof json.id !== "string" || !json.id) {
    throw new MetaModelApiError({
      kind: "unknown",
      transient: true,
      message: "Meta Model API returned no file id",
    });
  }
  return { id: json.id };
}

/** Removes an uploaded file from Meta's servers; one that is already gone counts as removed. */
export async function deleteMetaFile(
  fileId: string,
  options?: MetaRequestOptions,
): Promise<void> {
  try {
    const open = await send(
      "DELETE",
      `/files/${encodeURIComponent(fileId)}`,
      {},
      options,
    );
    await open.response.body?.cancel();
    open.release();
  } catch (error) {
    if (error instanceof MetaModelApiError && error.info.status === 404) return;
    throw error;
  }
}

export type MetaImageInput = { data: Uint8Array; mimeType: string };

export type MetaImageOptions = MetaRequestOptions & {
  /** "WxH". Sets the aspect ratio; the returned size may differ. */
  size?: string;
};

export type MetaImageResult = {
  image: Buffer;
  mimeType: "image/png";
  costUsd: number;
};

type MetaImagesJson = { data?: Array<{ b64_json?: unknown }> };

function imageResult(json: MetaImagesJson): MetaImageResult {
  const encoded = json.data?.[0]?.b64_json;
  if (typeof encoded !== "string" || !encoded) {
    throw new MetaModelApiError({
      kind: "unknown",
      transient: true,
      message: "Muse Image returned no image",
    });
  }
  return {
    image: Buffer.from(encoded, "base64"),
    mimeType: "image/png",
    costUsd: META_MUSE_IMAGE_COST_USD,
  };
}

/**
 * Muse Image edits 1–10 input images by instruction. It takes no mask and
 * returns an opaque image, so a transparent cut-out needs segmenting again.
 */
export async function editMetaImage(
  request: { prompt: string; images: MetaImageInput[] },
  options: MetaImageOptions = {},
): Promise<MetaImageResult> {
  const { size, ...requestOptions } = options;
  if (request.images.length < 1 || request.images.length > 10) {
    throw new MetaModelApiError({
      kind: "invalid_request",
      transient: false,
      message: "Muse Image edits take 1 to 10 images",
    });
  }
  const json = await postJson<MetaImagesJson>(
    "/images/edits",
    {
      model: getMetaModels().museImage,
      prompt: request.prompt,
      images: request.images.map((image) => ({
        image_url: `data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")}`,
      })),
      n: 1,
      output_format: "png",
      ...(size ? { size } : {}),
    },
    requestOptions,
  );
  return imageResult(json);
}

export async function generateMetaImage(
  request: { prompt: string },
  options: MetaImageOptions = {},
): Promise<MetaImageResult> {
  const { size, ...requestOptions } = options;
  const json = await postJson<MetaImagesJson>(
    "/images/generations",
    {
      model: getMetaModels().museImage,
      prompt: request.prompt,
      n: 1,
      output_format: "png",
      ...(size ? { size } : {}),
    },
    requestOptions,
  );
  return imageResult(json);
}
