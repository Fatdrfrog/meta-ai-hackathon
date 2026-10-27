import "server-only";

import { assertProviderPrompt } from "@/lib/creative-assets/video-generation-prompt";
import { fetchJsonWithinLimits } from "@/lib/http/bounded-json-response";
import { asRecord, readTrimmedString } from "@icecore/shared/lib/value-utils";
import { readEnvOrEmpty } from "@icecore/shared/lib/env";

export type HiggsfieldGenerationMode = "text_to_image" | "image_to_video";
export type HiggsfieldAssetKind = "image" | "video";
export type HiggsfieldProviderStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "nsfw"
  | "cancelled";

export type HiggsfieldStartResponse = {
  status: HiggsfieldProviderStatus;
  requestId: string;
  statusUrl: string | null;
  cancelUrl: string | null;
};

export type HiggsfieldGenerationRequest = {
  modelId: string;
  body: Record<string, unknown>;
};

export class HiggsfieldApiError extends Error {
  statusCode: number;
  detail: string | null;
  payload: unknown;
  retryable: boolean;

  constructor(params: {
    message: string;
    statusCode: number;
    detail?: string | null;
    payload: unknown;
    retryable: boolean;
  }) {
    super(params.message);
    this.name = "HiggsfieldApiError";
    this.statusCode = params.statusCode;
    this.detail = params.detail || null;
    this.payload = params.payload;
    this.retryable = params.retryable;
  }
}

export class HiggsfieldProtocolError extends Error {
  readonly code = "unknown_provider_status";
  readonly retryable = false;

  constructor(readonly value: unknown) {
    super(`Higgsfield returned an unknown provider status: ${String(value)}`);
    this.name = "HiggsfieldProtocolError";
  }
}

const HIGGSFIELD_BASE_URL = "https://platform.higgsfield.ai";
const DEFAULT_IMAGE_MODEL = "higgsfield-ai/soul/standard";
const DEFAULT_IMAGE_TO_VIDEO_MODEL = "higgsfield-ai/dop/standard";
const HIGGSFIELD_ORIGIN = new URL(HIGGSFIELD_BASE_URL).origin;
const CONTRACT_V1_RESPONSE_MAX_BYTES = 1024 * 1024;
const CONTRACT_V1_RESPONSE_TIMEOUT_MS = 60_000;

async function fetchHiggsfieldJson(
  input: RequestInfo | URL,
  init: RequestInit,
  strict: boolean
): Promise<{ response: Response; payload: unknown }> {
  if (strict) {
    return fetchJsonWithinLimits(input, init, {
      maxBytes: CONTRACT_V1_RESPONSE_MAX_BYTES,
      timeoutMs: CONTRACT_V1_RESPONSE_TIMEOUT_MS,
    });
  }
  const response = await fetch(input, init);
  return {
    response,
    payload: await response.json().catch(() => null),
  };
}

function errorDetail(payload: unknown): string | null {
  const raw = asRecord(payload);
  return (
    readTrimmedString(raw.detail) ||
    readTrimmedString(raw.error) ||
    readTrimmedString(raw.message) ||
    null
  );
}

function isPermanentSubmitFailure(statusCode: number, detail: string | null) {
  if (detail === "not_enough_credits") return true;
  return (
    statusCode >= 400 &&
    statusCode < 500 &&
    statusCode !== 408 &&
    statusCode !== 429
  );
}

function higgsfieldSubmitErrorMessage(params: {
  statusCode: number;
  detail: string | null;
  payload: unknown;
}): string {
  if (params.detail === "not_enough_credits") {
    return "Higgsfield account has no generation credits. Add credits in Higgsfield and try again.";
  }
  const errorText =
    params.payload && typeof params.payload === "object"
      ? JSON.stringify(params.payload)
      : `HTTP ${params.statusCode}`;
  return `Higgsfield generation failed to start: ${errorText}`;
}

export function isPermanentHiggsfieldApiError(
  error: unknown
): error is HiggsfieldApiError {
  return error instanceof HiggsfieldApiError && !error.retryable;
}

export function getHiggsfieldKey(): string {
  const single = readEnvOrEmpty("HIGGSFIELD_KEY");
  if (single) return single;

  const apiKey = readEnvOrEmpty("HIGGSFIELD_API_KEY");
  const apiSecret = readEnvOrEmpty("HIGGSFIELD_API_SECRET");
  return apiKey && apiSecret ? `${apiKey}:${apiSecret}` : "";
}

export function getHiggsfieldAuthHeader(authKey?: string | null): string {
  const key = readTrimmedString(authKey) || getHiggsfieldKey();
  if (!key) {
    throw new Error(
      "Higgsfield credentials are not configured. Set HIGGSFIELD_KEY or HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET."
    );
  }
  return `Key ${key}`;
}

export function getHiggsfieldImageModel(): string {
  return readEnvOrEmpty("HIGGSFIELD_IMAGE_MODEL") || DEFAULT_IMAGE_MODEL;
}

export function getHiggsfieldImageToVideoModel(): string {
  return (
    readEnvOrEmpty("HIGGSFIELD_IMAGE_TO_VIDEO_MODEL") ||
    DEFAULT_IMAGE_TO_VIDEO_MODEL
  );
}

export function normalizeHiggsfieldProviderStatus(
  value: unknown
): HiggsfieldProviderStatus {
  const status = readTrimmedString(value).toLowerCase();
  return status === "in_progress" ||
    status === "completed" ||
    status === "failed" ||
    status === "nsfw" ||
    status === "cancelled"
    ? status
    : "queued";
}

export function normalizeHiggsfieldProviderStatusContractV1(
  value: unknown
): HiggsfieldProviderStatus {
  const status = readTrimmedString(value).toLowerCase();
  if (
    status === "queued" ||
    status === "in_progress" ||
    status === "completed" ||
    status === "failed" ||
    status === "nsfw" ||
    status === "cancelled"
  ) {
    return status;
  }
  throw new HiggsfieldProtocolError(value);
}

export function buildHiggsfieldGenerationRequest(input: {
  mode: HiggsfieldGenerationMode;
  modelId?: string;
  prompt: string;
  aspectRatio?: string;
  resolution?: string;
  imageUrl?: string;
  duration?: number;
}): HiggsfieldGenerationRequest {
  const prompt = input.prompt.trim();
  if (!prompt) {
    throw new Error("Prompt is required for Higgsfield generation");
  }

  if (input.mode === "text_to_image") {
    return {
      modelId: input.modelId?.trim() || getHiggsfieldImageModel(),
      body: {
        prompt,
        aspect_ratio: input.aspectRatio || "9:16",
        resolution: input.resolution || "720p",
      },
    };
  }

  const imageUrl = (input.imageUrl || "").trim();
  if (!imageUrl) {
    throw new Error("Source image URL is required for image-to-video");
  }

  return {
    modelId: input.modelId?.trim() || getHiggsfieldImageToVideoModel(),
    body: {
      image_url: imageUrl,
      prompt,
      duration: input.duration || 5,
    },
  };
}

export function normalizeHiggsfieldStartResponse(
  value: unknown
): HiggsfieldStartResponse {
  const raw = asRecord(value);
  const requestId = readTrimmedString(raw.request_id);
  if (!requestId) {
    throw new Error("Higgsfield response did not include request_id");
  }

  return {
    status: normalizeHiggsfieldProviderStatus(raw.status),
    requestId,
    statusUrl: readTrimmedString(raw.status_url) || null,
    cancelUrl: readTrimmedString(raw.cancel_url) || null,
  };
}

export function normalizeHiggsfieldStartResponseContractV1(
  value: unknown
): HiggsfieldStartResponse {
  const raw = asRecord(value);
  const requestId = readTrimmedString(raw.request_id);
  if (!requestId) {
    throw new HiggsfieldProtocolError(value);
  }

  return {
    status: normalizeHiggsfieldProviderStatusContractV1(raw.status),
    requestId,
    statusUrl: readTrimmedString(raw.status_url) || null,
    cancelUrl: readTrimmedString(raw.cancel_url) || null,
  };
}

export function extractHiggsfieldResultUrl(
  payload: unknown,
  kind: HiggsfieldAssetKind
): string {
  const raw = asRecord(payload);

  if (kind === "image") {
    const first = Array.isArray(raw.images) ? raw.images[0] : null;
    if (first && typeof first === "object") {
      return readTrimmedString((first as Record<string, unknown>).url);
    }
    return "";
  }

  const video =
    raw.video && typeof raw.video === "object" && !Array.isArray(raw.video)
      ? (raw.video as Record<string, unknown>)
      : {};
  return readTrimmedString(video.url);
}

type HiggsfieldStatusInput = {
  statusUrl?: string | null;
  requestId?: string | null;
  authKey?: string | null;
};

async function fetchHiggsfieldRequestStatusInternal(
  input: HiggsfieldStatusInput,
  strictErrors: boolean
): Promise<Record<string, unknown>> {
  const statusUrl = readTrimmedString(input.statusUrl);
  const requestId = readTrimmedString(input.requestId);
  if (!statusUrl && !requestId) {
    throw new Error("Higgsfield status URL or request id is required");
  }

  const url = statusUrl
    ? new URL(statusUrl, HIGGSFIELD_BASE_URL)
    : new URL(
        `/requests/${encodeURIComponent(requestId)}/status`,
        HIGGSFIELD_BASE_URL
      );
  if (url.origin !== HIGGSFIELD_ORIGIN) {
    throw new Error("Higgsfield status URL must use the Higgsfield platform");
  }

  const { response, payload } = await fetchHiggsfieldJson(
    url.toString(),
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: getHiggsfieldAuthHeader(input.authKey),
      },
    },
    strictErrors
  );
  if (!response.ok) {
    if (strictErrors) {
      throw new HiggsfieldApiError({
        message: `Higgsfield status fetch failed: HTTP ${response.status}`,
        statusCode: response.status,
        detail: errorDetail(payload),
        payload,
        retryable:
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500,
      });
    }
    const errorText =
      payload && typeof payload === "object"
        ? JSON.stringify(payload)
        : `HTTP ${response.status}`;
    throw new Error(`Higgsfield status fetch failed: ${errorText}`);
  }

  return asRecord(payload);
}

export async function fetchHiggsfieldRequestStatus(
  input: HiggsfieldStatusInput
): Promise<Record<string, unknown>> {
  return fetchHiggsfieldRequestStatusInternal(input, false);
}

export async function fetchHiggsfieldRequestStatusContractV1(
  input: HiggsfieldStatusInput
): Promise<Record<string, unknown>> {
  return fetchHiggsfieldRequestStatusInternal(input, true);
}

type HiggsfieldGenerationSubmitInput = {
  mode: HiggsfieldGenerationMode;
  modelId?: string;
  prompt: string;
  webhookUrl: string;
  authKey?: string | null;
  aspectRatio?: string;
  resolution?: string;
  imageUrl?: string;
  duration?: number;
};

type HiggsfieldGenerationContractV1Input = Omit<
  HiggsfieldGenerationSubmitInput,
  "modelId"
> & {
  modelId: string;
};

type PreparedHiggsfieldPost = () => Promise<HiggsfieldStartResponse>;

function prepareHiggsfieldGenerationInternal(
  input: HiggsfieldGenerationSubmitInput,
  strictStatus: boolean
): PreparedHiggsfieldPost {
  if (
    strictStatus &&
    (typeof input.modelId !== "string" ||
      !input.modelId ||
      input.modelId.trim() !== input.modelId ||
      input.modelId.length > 200)
  ) {
    throw new Error("Higgsfield generation model id is invalid");
  }
  const request = buildHiggsfieldGenerationRequest(input);
  const url = new URL(
    `${HIGGSFIELD_BASE_URL}/${request.modelId.replace(/^\/+/, "")}`
  );
  url.searchParams.set("hf_webhook", input.webhookUrl);
  const requestUrl = url.toString();
  const init: RequestInit = {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: getHiggsfieldAuthHeader(input.authKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request.body),
  };

  return async () => {
    const { response, payload } = await fetchHiggsfieldJson(
      requestUrl,
      init,
      strictStatus
    );
    if (!response.ok) {
      const detail = errorDetail(payload);
      const retryable = !isPermanentSubmitFailure(response.status, detail);
      throw new HiggsfieldApiError({
        message: higgsfieldSubmitErrorMessage({
          statusCode: response.status,
          detail,
          payload,
        }),
        statusCode: response.status,
        detail,
        payload,
        retryable,
      });
    }

    return strictStatus
      ? normalizeHiggsfieldStartResponseContractV1(payload)
      : normalizeHiggsfieldStartResponse(payload);
  };
}

export async function submitHiggsfieldGeneration(
  input: HiggsfieldGenerationSubmitInput
): Promise<HiggsfieldStartResponse> {
  return prepareHiggsfieldGenerationInternal(input, false)();
}

export function prepareHiggsfieldGenerationContractV1(
  input: HiggsfieldGenerationContractV1Input
): PreparedHiggsfieldPost {
  return prepareHiggsfieldGenerationInternal(
    { ...input, prompt: assertProviderPrompt(input.prompt, 1200) },
    true
  );
}
