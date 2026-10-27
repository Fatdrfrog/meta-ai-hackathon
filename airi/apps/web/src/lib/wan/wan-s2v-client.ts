import "server-only";
import { assertCreativeCustomerProviderSupported } from "@/lib/google/creative-credentials";
import { asRecord, cleanString } from "@icecore/shared/lib/value-utils";

import {
  getAlibabaApiHost,
  getAlibabaApiKey,
  getWanI2VModel,
  getWanS2VModel,
  normalizeWanS2VDuration,
  type WanS2VResolution,
} from "./wan-config";

export type WanS2VTaskStatus =
  | "PENDING"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "UNKNOWN"
  | "CANCELED";

export type WanS2VSubmitResult = {
  taskId: string;
  taskStatus: WanS2VTaskStatus | string;
  requestId: string | null;
  raw: unknown;
};

export type WanS2VPollResult = {
  taskId: string;
  taskStatus: WanS2VTaskStatus | string;
  videoUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  usage: Record<string, unknown> | null;
  raw: unknown;
};

export class WanS2VApiError extends Error {
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
    this.name = "WanS2VApiError";
    this.statusCode = params.statusCode;
    this.retryable = params.retryable;
    this.payload = params.payload ?? null;
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_TALKING_AVATAR_DURATION = 15;
const DEFAULT_TALKING_AVATAR_PROMPT =
  "A person speaking naturally to the camera with realistic lip sync and natural facial expression.";

function requireConfiguredAuth(): { apiKey: string; apiHost: string } {
  const apiKey = getAlibabaApiKey();
  const apiHost = getAlibabaApiHost();
  if (!apiKey) {
    throw new WanS2VApiError({
      message: "ALIBABA_API_KEY is not configured",
      statusCode: 503,
      retryable: false,
    });
  }
  if (!apiHost) {
    throw new WanS2VApiError({
      message: "ALIBABA_API_HOST is not configured",
      statusCode: 503,
      retryable: false,
    });
  }
  return { apiKey, apiHost };
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
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

export function isWanS2VTerminalStatus(status: string): boolean {
  const normalized = status.trim().toUpperCase();
  return (
    normalized === "SUCCEEDED" ||
    normalized === "FAILED" ||
    normalized === "CANCELED" ||
    normalized === "UNKNOWN"
  );
}

export function isWanS2VSuccessStatus(status: string): boolean {
  return status.trim().toUpperCase() === "SUCCEEDED";
}

/**
 * Submit Wan2.7 image-to-video job with driving_audio (image + audio → talking video).
 * Singapore Model Studio host/key/model required (same region).
 */
export async function submitWanS2V(params: {
  imageUrl: string;
  audioUrl: string;
  resolution: WanS2VResolution;
  model?: string;
  prompt?: string;
  duration?: number;
  promptExtend?: boolean;
  watermark?: boolean;
}): Promise<WanS2VSubmitResult> {
  assertCreativeCustomerProviderSupported("Wan");
  const imageUrl = cleanString(params.imageUrl, 4000);
  const audioUrl = cleanString(params.audioUrl, 4000);
  if (!imageUrl || !audioUrl) {
    throw new WanS2VApiError({
      message: "imageUrl and audioUrl are required for Wan talking avatar",
      statusCode: 400,
      retryable: false,
    });
  }

  const { apiKey, apiHost } = requireConfiguredAuth();
  const model = cleanString(params.model, 120) || getWanS2VModel();
  const prompt =
    cleanString(params.prompt, 2000) || DEFAULT_TALKING_AVATAR_PROMPT;
  const duration =
    normalizeWanS2VDuration(params.duration) ?? DEFAULT_TALKING_AVATAR_DURATION;
  const url = `${apiHost}/api/v1/services/aigc/video-generation/video-synthesis`;

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
    },
    body: JSON.stringify({
      model,
      input: {
        prompt,
        media: [
          { type: "first_frame", url: imageUrl },
          { type: "driving_audio", url: audioUrl },
        ],
      },
      parameters: {
        resolution: params.resolution,
        duration,
        prompt_extend: params.promptExtend !== false,
        watermark: params.watermark === true,
      },
    }),
  });

  const payload = await readJson(response);
  if (!response.ok) {
    throw new WanS2VApiError({
      message: extractErrorMessage(
        payload,
        `Failed to submit Wan talking avatar: HTTP ${response.status}`
      ),
      statusCode: response.status,
      retryable: isRetryableStatus(response.status),
      payload,
    });
  }

  const output = asRecord(asRecord(payload).output);
  const taskId = cleanString(output.task_id, 200);
  if (!taskId) {
    throw new WanS2VApiError({
      message: "Wan submit response missing task_id",
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
}

/**
 * First + last frame morph via Wan 2.7 i2v (before/after ads).
 * Docs: image-to-video-general-api-reference (first_frame + last_frame).
 */
export async function submitWanFirstLastI2V(params: {
  prompt: string;
  firstFrameUrl: string;
  lastFrameUrl: string;
  resolution: WanS2VResolution;
  duration?: number;
  model?: string;
  promptExtend?: boolean;
  watermark?: boolean;
  seed?: number;
}): Promise<WanS2VSubmitResult> {
  assertCreativeCustomerProviderSupported("Wan");
  const prompt = cleanString(params.prompt, 5000);
  const firstFrameUrl = cleanString(params.firstFrameUrl, 4000);
  const lastFrameUrl = cleanString(params.lastFrameUrl, 4000);
  if (!prompt) {
    throw new WanS2VApiError({
      message: "prompt is required for Wan first+last morph",
      statusCode: 400,
      retryable: false,
    });
  }
  if (!firstFrameUrl || !lastFrameUrl) {
    throw new WanS2VApiError({
      message: "firstFrameUrl and lastFrameUrl are required for Wan morph",
      statusCode: 400,
      retryable: false,
    });
  }

  const { apiKey, apiHost } = requireConfiguredAuth();
  const model = cleanString(params.model, 120) || getWanI2VModel();
  const duration = normalizeWanS2VDuration(params.duration) ?? 5;
  const url = `${apiHost}/api/v1/services/aigc/video-generation/video-synthesis`;

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
    },
    body: JSON.stringify({
      model,
      input: {
        prompt,
        media: [
          { type: "first_frame", url: firstFrameUrl },
          { type: "last_frame", url: lastFrameUrl },
        ],
      },
      parameters: {
        resolution: params.resolution,
        duration,
        prompt_extend: params.promptExtend !== false,
        watermark: params.watermark === true,
        ...(typeof params.seed === "number" ? { seed: params.seed } : {}),
      },
    }),
  });

  const payload = await readJson(response);
  if (!response.ok) {
    throw new WanS2VApiError({
      message: extractErrorMessage(
        payload,
        `Failed to submit Wan first+last morph: HTTP ${response.status}`
      ),
      statusCode: response.status,
      retryable: isRetryableStatus(response.status),
      payload,
    });
  }

  const output = asRecord(asRecord(payload).output);
  const taskId = cleanString(output.task_id, 200);
  if (!taskId) {
    throw new WanS2VApiError({
      message: "Wan morph submit response missing task_id",
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
}

export async function pollWanS2VTask(
  taskId: string
): Promise<WanS2VPollResult> {
  const normalizedTaskId = cleanString(taskId, 200);
  if (!normalizedTaskId) {
    throw new WanS2VApiError({
      message: "taskId is required",
      statusCode: 400,
      retryable: false,
    });
  }

  const { apiKey, apiHost } = requireConfiguredAuth();
  const url = `${apiHost}/api/v1/tasks/${encodeURIComponent(normalizedTaskId)}`;

  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  const payload = await readJson(response);
  if (!response.ok) {
    throw new WanS2VApiError({
      message: extractErrorMessage(
        payload,
        `Failed to poll Wan talking avatar task: HTTP ${response.status}`
      ),
      statusCode: response.status,
      retryable: isRetryableStatus(response.status),
      payload,
    });
  }

  const output = asRecord(asRecord(payload).output);
  const results = asRecord(output.results);
  const usageRaw = asRecord(payload).usage;
  const usage =
    usageRaw && typeof usageRaw === "object"
      ? (usageRaw as Record<string, unknown>)
      : null;

  // Wan2.7 i2v: output.video_url. Older S2V shapes used output.results.video_url.
  const videoUrl =
    cleanString(output.video_url, 4000) ||
    cleanString(results.video_url, 4000) ||
    null;

  return {
    taskId: cleanString(output.task_id, 200) || normalizedTaskId,
    taskStatus: cleanString(output.task_status, 40) || "UNKNOWN",
    videoUrl,
    errorCode: cleanString(output.code, 120) || null,
    errorMessage: cleanString(output.message, 1000) || null,
    usage,
    raw: payload,
  };
}
