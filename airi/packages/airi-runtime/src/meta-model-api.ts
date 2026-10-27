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
// Temporal retries whole activities; this keeps one blip from costing a rerun.
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [500, 2_000];

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
  | "server"
  | "unknown";

export type MetaModelApiErrorInfo = {
  kind: MetaModelApiErrorKind;
  transient: boolean;
  status?: number;
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
  message: string,
): MetaModelApiError {
  const detail = message || `Meta Model API answered ${status}`;
  if (status === 401 || status === 403) {
    return new MetaModelApiError({
      kind: "auth",
      transient: false,
      status,
      message: detail,
    });
  }
  if (status === 408) {
    return new MetaModelApiError({
      kind: "timeout",
      transient: true,
      status,
      message: detail,
    });
  }
  if (status === 429) {
    return new MetaModelApiError({
      kind: "rate_limit",
      transient: true,
      status,
      message: detail,
    });
  }
  if (status >= 400 && status < 500) {
    return new MetaModelApiError({
      kind: "invalid_request",
      transient: false,
      status,
      message: detail,
    });
  }
  return new MetaModelApiError({
    kind: status >= 500 ? "server" : "unknown",
    transient: true,
    status,
    message: detail,
  });
}

async function errorMessageOf(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const payload = JSON.parse(text) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    const message =
      typeof payload.error === "string"
        ? payload.error
        : (payload.error?.message ?? payload.message);
    if (typeof message === "string") return cleanString(message, 500);
  } catch {
    // An HTML error page; keep its start.
  }
  return cleanString(text, 300);
}

/**
 * POSTs to the API and hands back the open response. The timeout covers the
 * whole exchange, including reading a streamed body: `release` must be called
 * once the caller has finished with the response.
 */
async function post(
  path: string,
  init: { headers?: Record<string, string>; body: BodyInit },
  options: MetaRequestOptions = {},
): Promise<{ response: Response; release: () => void }> {
  const apiKey = getApiKey();
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? getTimeoutMs();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const release = () => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  };

  try {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${META_MODEL_API_BASE_URL}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, ...init.headers },
        body: init.body,
        signal: controller.signal,
      });
      if (response.ok) return { response, release };
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !RETRY_STATUSES.has(response.status)) {
        throw classifyHttpFailure(
          response.status,
          await errorMessageOf(response),
        );
      }
      await response.body?.cancel();
      await sleep(delay, undefined, { signal: controller.signal });
    }
  } catch (error) {
    release();
    throw normalizeError(error, controller.signal, timeoutMs);
  }
}

function normalizeError(
  error: unknown,
  signal: AbortSignal,
  timeoutMs: number,
): unknown {
  if (error instanceof MetaModelApiError) return error;
  if (signal.aborted) {
    return new MetaModelApiError({
      kind: "timeout",
      transient: true,
      message: `Meta Model API request stopped after ${timeoutMs} ms or was cancelled`,
    });
  }
  return new MetaModelApiError({
    kind: "unknown",
    transient: true,
    message:
      error instanceof Error
        ? cleanString(error.message, 300)
        : "Meta Model API request failed",
  });
}

async function postJson<T>(
  path: string,
  body: unknown,
  options?: MetaRequestOptions,
): Promise<T> {
  const { response, release } = await post(
    path,
    {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    options,
  );
  try {
    return (await response.json()) as T;
  } finally {
    release();
  }
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
  output: Array<{
    type: string;
    content?: Array<{ type: string; text?: string }>;
  }>;
  usage?: MetaResponseUsage;
};

/** One Responses API call (Muse Spark); its usage prices it through llm-pricing. */
export function createMetaResponse(
  request: MetaResponseRequest,
  options?: MetaRequestOptions,
): Promise<MetaResponse> {
  return postJson<MetaResponse>("/responses", request, options);
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
  const { response, release } = await post(
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
    if (!response.body) return;
    for await (const data of readSseData(response.body)) {
      if (data === "[DONE]") return;
      yield JSON.parse(data) as MetaStreamEvent;
    }
  } finally {
    release();
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

/** Uploads media (a shop video) for later calls to refer to by id. */
export async function uploadMetaFile(
  file: { data: Uint8Array; filename: string; mimeType: string },
  options?: MetaRequestOptions,
): Promise<{ id: string }> {
  const form = new FormData();
  form.set("purpose", "user_data");
  form.set(
    "file",
    new Blob([new Uint8Array(file.data)], { type: file.mimeType }),
    file.filename,
  );
  const { response, release } = await post("/files", { body: form }, options);
  try {
    const json = (await response.json()) as { id?: unknown };
    if (typeof json.id !== "string" || !json.id) {
      throw new MetaModelApiError({
        kind: "unknown",
        transient: true,
        message: "Meta Model API returned no file id",
      });
    }
    return { id: json.id };
  } finally {
    release();
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
