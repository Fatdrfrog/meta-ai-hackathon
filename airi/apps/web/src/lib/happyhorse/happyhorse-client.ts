import "server-only";
import { assertCreativeCustomerProviderSupported } from "@/lib/google/creative-credentials";

import { assertProviderPrompt } from "@/lib/creative-assets/video-generation-prompt";
import { fetchJsonWithinLimits } from "@/lib/http/bounded-json-response";
import { getAlibabaApiHost, getAlibabaApiKey } from "@/lib/wan/wan-config";
import { asRecord, cleanString } from "@icecore/shared/lib/value-utils";
import {
  getHappyHorseI2VModel,
  getHappyHorseR2VModel,
  getHappyHorseT2VModel,
  HAPPYHORSE_REFERENCE_MAX,
  HAPPYHORSE_REFERENCE_MIN,
  normalizeHappyHorseDuration,
  type HappyHorseRatio,
  type HappyHorseResolution,
} from "./happyhorse-config";

export type HappyHorseTaskStatus =
  | "PENDING"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "UNKNOWN"
  | "CANCELED";

export type HappyHorseSubmitResult = {
  taskId: string;
  taskStatus: HappyHorseTaskStatus | string;
  requestId: string | null;
  raw: unknown;
};

export type HappyHorsePollResult = {
  taskId: string;
  taskStatus: HappyHorseTaskStatus | string;
  videoUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  usage: Record<string, unknown> | null;
  raw: unknown;
};

export class HappyHorseApiError extends Error {
  statusCode: number;
  retryable: boolean;
  payload: unknown;

  constructor(params: {
    message: string;
    statusCode: number;
    retryable: boolean;
    payload?: unknown;
  }) {
    super(params.message);
    this.name = "HappyHorseApiError";
    this.statusCode = params.statusCode;
    this.retryable = params.retryable;
    this.payload = params.payload ?? null;
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RESPONSE_MAX_BYTES = 1024 * 1024;
const DEFAULT_DURATION = 5;

function requireConfiguredAuth(): { apiKey: string; apiHost: string } {
  const apiKey = getAlibabaApiKey();
  const apiHost = getAlibabaApiHost();
  if (!apiKey) {
    throw new HappyHorseApiError({
      message: "ALIBABA_API_KEY is not configured",
      statusCode: 503,
      retryable: false,
    });
  }
  if (!apiHost) {
    throw new HappyHorseApiError({
      message: "ALIBABA_API_HOST is not configured",
      statusCode: 503,
      retryable: false,
    });
  }
  return { apiKey, apiHost };
}

async function fetchHappyHorseJson(
  input: string,
  init: RequestInit
): Promise<{ response: Response; payload: unknown }> {
  return fetchJsonWithinLimits(input, init, {
    maxBytes: DEFAULT_RESPONSE_MAX_BYTES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
}

function extractErrorMessage(payload: unknown, fallback: string): string {
  const raw = asRecord(payload);
  const output = asRecord(raw.output);
  return (
    cleanString(output.message, 4000) ||
    cleanString(raw.message, 4000) ||
    cleanString(raw.error, 4000) ||
    cleanString(asRecord(raw.error).message, 4000) ||
    fallback
  );
}

function isRetryableStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

export function isHappyHorseTerminalStatus(status: string): boolean {
  const normalized = status.trim().toUpperCase();
  return (
    normalized === "SUCCEEDED" ||
    normalized === "FAILED" ||
    normalized === "CANCELED" ||
    normalized === "UNKNOWN"
  );
}

export function isHappyHorseSuccessStatus(status: string): boolean {
  return status.trim().toUpperCase() === "SUCCEEDED";
}

type PreparedHappyHorsePost = () => Promise<HappyHorseSubmitResult>;

type HappyHorseContractV1Input<T extends { model?: string }> = Omit<
  T,
  "model"
> & {
  model: string;
};

function assertHappyHorseContractV1Model(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    value.length > 120
  ) {
    throw new HappyHorseApiError({
      message: "HappyHorse video generation model id is invalid",
      statusCode: 400,
      retryable: false,
    });
  }
  return value;
}

function prepareHappyHorseTask(
  body: Record<string, unknown>
): PreparedHappyHorsePost {
  assertCreativeCustomerProviderSupported("HappyHorse");
  const { apiKey, apiHost } = requireConfiguredAuth();
  const url = `${apiHost}/api/v1/services/aigc/video-generation/video-synthesis`;
  const init: RequestInit = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
    },
    body: JSON.stringify(body),
  };

  return async () => {
    const { response, payload } = await fetchHappyHorseJson(url, init);
    if (!response.ok) {
      throw new HappyHorseApiError({
        message: extractErrorMessage(
          payload,
          `Failed to submit HappyHorse video: HTTP ${response.status}`
        ),
        statusCode: response.status,
        retryable: isRetryableStatus(response.status),
        payload,
      });
    }

    const output = asRecord(asRecord(payload).output);
    const taskId = cleanString(output.task_id, 200);
    if (!taskId) {
      throw new HappyHorseApiError({
        message: "HappyHorse submit response missing task_id",
        statusCode: 502,
        retryable: true,
        payload,
      });
    }

    return {
      taskId,
      taskStatus: cleanString(output.task_status, 40) || "PENDING",
      requestId: cleanString(asRecord(payload).request_id, 200) || null,
      raw: payload,
    };
  };
}

async function submitHappyHorseTask(
  body: Record<string, unknown>
): Promise<HappyHorseSubmitResult> {
  return prepareHappyHorseTask(body)();
}

/**
 * Text-to-video. Supports aspect ratio (default ads: 9:16).
 * Docs: happyhorse-text-to-video-api-reference
 */
export async function submitHappyHorseT2V(params: {
  prompt: string;
  resolution: HappyHorseResolution;
  ratio: HappyHorseRatio;
  duration?: number;
  model?: string;
  watermark?: boolean;
  seed?: number;
}): Promise<HappyHorseSubmitResult> {
  const prompt = cleanString(params.prompt, 5000);
  if (!prompt) {
    throw new HappyHorseApiError({
      message: "prompt is required for HappyHorse text-to-video",
      statusCode: 400,
      retryable: false,
    });
  }

  const duration =
    normalizeHappyHorseDuration(params.duration) ?? DEFAULT_DURATION;
  const model = cleanString(params.model, 120) || getHappyHorseT2VModel();

  return submitHappyHorseTask({
    model,
    input: { prompt },
    parameters: {
      resolution: params.resolution,
      ratio: params.ratio,
      duration,
      watermark: params.watermark === true,
      ...(typeof params.seed === "number" ? { seed: params.seed } : {}),
    },
  });
}

/** Contract-v1 prompts are compiled before this boundary and must not be sliced. */
export async function submitHappyHorseT2VContractV1(
  params: HappyHorseContractV1Input<Parameters<typeof submitHappyHorseT2V>[0]>
): Promise<HappyHorseSubmitResult> {
  return prepareHappyHorseT2VContractV1(params)();
}

export function prepareHappyHorseT2VContractV1(
  params: HappyHorseContractV1Input<Parameters<typeof submitHappyHorseT2V>[0]>
): PreparedHappyHorsePost {
  const prompt = assertProviderPrompt(params.prompt, 5000);
  const duration =
    normalizeHappyHorseDuration(params.duration) ?? DEFAULT_DURATION;
  const model = assertHappyHorseContractV1Model(params.model);
  return prepareHappyHorseTask({
    model,
    input: { prompt },
    parameters: {
      resolution: params.resolution,
      ratio: params.ratio,
      duration,
      watermark: params.watermark === true,
      ...(typeof params.seed === "number" ? { seed: params.seed } : {}),
    },
  });
}

/**
 * Image-to-video from first_frame. Aspect follows the source image.
 * Docs: happyhorse-image-to-video-api-reference
 */
export async function submitHappyHorseI2V(params: {
  prompt: string;
  imageUrl: string;
  resolution: HappyHorseResolution;
  duration?: number;
  model?: string;
  watermark?: boolean;
  seed?: number;
}): Promise<HappyHorseSubmitResult> {
  const prompt = cleanString(params.prompt, 5000);
  const imageUrl = cleanString(params.imageUrl, 4000);
  if (!imageUrl) {
    throw new HappyHorseApiError({
      message: "imageUrl is required for HappyHorse image-to-video",
      statusCode: 400,
      retryable: false,
    });
  }

  const duration =
    normalizeHappyHorseDuration(params.duration) ?? DEFAULT_DURATION;
  const model = cleanString(params.model, 120) || getHappyHorseI2VModel();

  return submitHappyHorseTask({
    model,
    input: {
      prompt:
        prompt || "Animate the product with natural motion for a social ad.",
      media: [{ type: "first_frame", url: imageUrl }],
    },
    parameters: {
      resolution: params.resolution,
      duration,
      watermark: params.watermark === true,
      ...(typeof params.seed === "number" ? { seed: params.seed } : {}),
    },
  });
}

/** Contract-v1 prompts are compiled before this boundary and must not be sliced. */
export async function submitHappyHorseI2VContractV1(
  params: HappyHorseContractV1Input<Parameters<typeof submitHappyHorseI2V>[0]>
): Promise<HappyHorseSubmitResult> {
  return prepareHappyHorseI2VContractV1(params)();
}

export function prepareHappyHorseI2VContractV1(
  params: HappyHorseContractV1Input<Parameters<typeof submitHappyHorseI2V>[0]>
): PreparedHappyHorsePost {
  const prompt = assertProviderPrompt(params.prompt, 5000);
  const imageUrl = cleanString(params.imageUrl, 4000);
  if (!imageUrl) {
    throw new HappyHorseApiError({
      message: "imageUrl is required for HappyHorse image-to-video",
      statusCode: 400,
      retryable: false,
    });
  }
  const duration =
    normalizeHappyHorseDuration(params.duration) ?? DEFAULT_DURATION;
  const model = assertHappyHorseContractV1Model(params.model);
  return prepareHappyHorseTask({
    model,
    input: {
      prompt,
      media: [{ type: "first_frame", url: imageUrl }],
    },
    parameters: {
      resolution: params.resolution,
      duration,
      watermark: params.watermark === true,
      ...(typeof params.seed === "number" ? { seed: params.seed } : {}),
    },
  });
}

/**
 * Reference-to-video from 1–9 reference images.
 * Prompt should cite subjects as [Image 1]…[Image N] matching media order.
 * Docs: happyhorse-reference-to-video-api-reference
 */
export async function submitHappyHorseR2V(params: {
  prompt: string;
  referenceImageUrls: string[];
  resolution: HappyHorseResolution;
  ratio: HappyHorseRatio;
  duration?: number;
  model?: string;
  watermark?: boolean;
  seed?: number;
}): Promise<HappyHorseSubmitResult> {
  const prompt = cleanString(params.prompt, 5000);
  if (!prompt) {
    throw new HappyHorseApiError({
      message: "prompt is required for HappyHorse reference-to-video",
      statusCode: 400,
      retryable: false,
    });
  }

  const referenceImageUrls = (params.referenceImageUrls || [])
    .map(url => cleanString(url, 4000))
    .filter(Boolean);
  if (
    referenceImageUrls.length < HAPPYHORSE_REFERENCE_MIN ||
    referenceImageUrls.length > HAPPYHORSE_REFERENCE_MAX
  ) {
    throw new HappyHorseApiError({
      message: `HappyHorse reference-to-video requires ${HAPPYHORSE_REFERENCE_MIN}–${HAPPYHORSE_REFERENCE_MAX} reference images`,
      statusCode: 400,
      retryable: false,
    });
  }

  const duration =
    normalizeHappyHorseDuration(params.duration) ?? DEFAULT_DURATION;
  const model = cleanString(params.model, 120) || getHappyHorseR2VModel();

  return submitHappyHorseTask({
    model,
    input: {
      prompt,
      media: referenceImageUrls.map(url => ({
        type: "reference_image",
        url,
      })),
    },
    parameters: {
      resolution: params.resolution,
      ratio: params.ratio,
      duration,
      watermark: params.watermark === true,
      ...(typeof params.seed === "number" ? { seed: params.seed } : {}),
    },
  });
}

/** Contract-v1 prompts are compiled before this boundary and must not be sliced. */
export async function submitHappyHorseR2VContractV1(
  params: HappyHorseContractV1Input<Parameters<typeof submitHappyHorseR2V>[0]>
): Promise<HappyHorseSubmitResult> {
  return prepareHappyHorseR2VContractV1(params)();
}

export function prepareHappyHorseR2VContractV1(
  params: HappyHorseContractV1Input<Parameters<typeof submitHappyHorseR2V>[0]>
): PreparedHappyHorsePost {
  const prompt = assertProviderPrompt(params.prompt, 5000);
  const referenceImageUrls = (params.referenceImageUrls || [])
    .map(url => cleanString(url, 4000))
    .filter(Boolean);
  if (
    referenceImageUrls.length < HAPPYHORSE_REFERENCE_MIN ||
    referenceImageUrls.length > HAPPYHORSE_REFERENCE_MAX
  ) {
    throw new HappyHorseApiError({
      message: `HappyHorse reference-to-video requires ${HAPPYHORSE_REFERENCE_MIN}–${HAPPYHORSE_REFERENCE_MAX} reference images`,
      statusCode: 400,
      retryable: false,
    });
  }
  const duration =
    normalizeHappyHorseDuration(params.duration) ?? DEFAULT_DURATION;
  const model = assertHappyHorseContractV1Model(params.model);
  return prepareHappyHorseTask({
    model,
    input: {
      prompt,
      media: referenceImageUrls.map(url => ({
        type: "reference_image",
        url,
      })),
    },
    parameters: {
      resolution: params.resolution,
      ratio: params.ratio,
      duration,
      watermark: params.watermark === true,
      ...(typeof params.seed === "number" ? { seed: params.seed } : {}),
    },
  });
}

export async function pollHappyHorseTask(
  taskId: string
): Promise<HappyHorsePollResult> {
  const normalizedTaskId = cleanString(taskId, 200);
  if (!normalizedTaskId) {
    throw new HappyHorseApiError({
      message: "taskId is required",
      statusCode: 400,
      retryable: false,
    });
  }

  const { apiKey, apiHost } = requireConfiguredAuth();
  const url = `${apiHost}/api/v1/tasks/${encodeURIComponent(normalizedTaskId)}`;

  const { response, payload } = await fetchHappyHorseJson(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new HappyHorseApiError({
      message: extractErrorMessage(
        payload,
        `Failed to poll HappyHorse task: HTTP ${response.status}`
      ),
      statusCode: response.status,
      retryable: isRetryableStatus(response.status),
      payload,
    });
  }

  const output = asRecord(asRecord(payload).output);
  const usageRaw = asRecord(payload).usage;
  const usage =
    usageRaw && typeof usageRaw === "object"
      ? (usageRaw as Record<string, unknown>)
      : null;

  return {
    taskId: cleanString(output.task_id, 200) || normalizedTaskId,
    taskStatus: cleanString(output.task_status, 40) || "UNKNOWN",
    videoUrl: cleanString(output.video_url, 4000) || null,
    errorCode: cleanString(output.code, 120) || null,
    errorMessage: cleanString(output.message, 1000) || null,
    usage,
    raw: payload,
  };
}
