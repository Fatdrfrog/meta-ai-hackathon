import "server-only";

export { resolveGoogleCreativeWorkerApiKey } from "./creative-credentials";

import { assertProviderPrompt } from "@/lib/creative-assets/video-generation-prompt";
import { OwnCreativeAiSourceRequiredError } from "./creative-credentials";
import { fetchJsonWithinLimits } from "@/lib/http/bounded-json-response";
import {
  findGenerativeAIReferenceImageIssue,
  GENERATIVE_AI_IMAGE_MODELS,
  GENERATIVE_AI_IMAGE_ASPECT_RATIOS,
  type GenerativeAIReferenceImageIssue,
} from "@icecore/scenario-contracts";
import { asRecord, readTrimmedString } from "@icecore/shared/lib/value-utils";
import { readEnvOrEmpty } from "@icecore/shared/lib/env";

export type GoogleGeneratedImage = {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  raw: unknown;
};
export type GoogleVideoOperation = {
  name: string;
  done: boolean;
  response?: unknown;
  error?: unknown;
  raw: unknown;
};
export type GoogleVideoResult = {
  uri?: string;
  videoBytes?: string;
  mimeType: string;
};

export class GoogleCreativeApiError extends Error {
  readonly statusCode: number;
  readonly payload: unknown;
  readonly retryable: boolean;

  constructor(input: {
    message: string;
    statusCode: number;
    payload: unknown;
  }) {
    super(input.message);
    this.name = "GoogleCreativeApiError";
    this.statusCode = input.statusCode;
    this.payload = input.payload;
    this.retryable =
      input.statusCode === 408 ||
      input.statusCode === 429 ||
      input.statusCode >= 500;
  }
}

export class GoogleCreativeProtocolError extends Error {
  constructor(readonly value: unknown) {
    super("Google returned an invalid video operation response");
    this.name = "GoogleCreativeProtocolError";
  }
}

const GOOGLE_GENERATIVE_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_IMAGE_MODEL = "gemini-3.1-flash-image";
const DEFAULT_VIDEO_MODEL = "veo-3.1-generate-preview";
const DEFAULT_FREE_GENERATION_LIMIT = 10;
const GOOGLE_INTERACTIONS_API_REVISION = "2026-05-20";
const CONTRACT_V1_RESPONSE_TIMEOUT_MS = 60_000;
const CONTRACT_V1_SUBMIT_RESPONSE_MAX_BYTES = 1024 * 1024;
const MAX_GOOGLE_INLINE_VIDEO_BYTES = 50 * 1024 * 1024;
const CONTRACT_V1_OPERATION_RESPONSE_MAX_BYTES =
  Math.ceil(MAX_GOOGLE_INLINE_VIDEO_BYTES / 3) * 4 + 1024 * 1024;
const DEFAULT_MEDIA_HOST_ALLOWLIST = [
  "generativelanguage.googleapis.com",
  "*.googleapis.com",
  "*.googleusercontent.com",
];

const GOOGLE_API_KEY_PATTERN = /AIza[0-9A-Za-z_-]{20,}/g;

/** Google's error answer for logs: bounded, with the request key and any Google-shaped key redacted. */
export function describeGoogleCreativeApiError(
  error: GoogleCreativeApiError,
  apiKey?: string
): {
  httpStatus: number;
  status: string | null;
  reason: string | null;
  message: string | null;
} {
  const payload = asRecord(error.payload);
  const body = asRecord(payload.error);
  const details = Array.isArray(body.details) ? body.details : [];
  const redact = (value: unknown) => {
    const text = readTrimmedString(value);
    return (
      (apiKey ? text.replaceAll(apiKey, "[redacted]") : text)
        .replace(GOOGLE_API_KEY_PATTERN, "[redacted]")
        .slice(0, 500) || null
    );
  };
  return {
    httpStatus: error.statusCode,
    status: redact(body.status),
    reason: redact(
      details.map(detail => asRecord(detail).reason).find(readTrimmedString)
    ),
    message: redact(body.message),
  };
}

/**
 * What to tell the merchant when Google answered an image request with a
 * rejection: any 4xx but a timeout. Nothing was generated or charged. Null
 * for answers whose outcome is uncertain.
 */
export function readGoogleImageRejectionMessage(
  error: GoogleCreativeApiError
): string | null {
  const status = error.statusCode;
  if (status < 400 || status >= 500 || status === 408) return null;
  if (status === 402 || status === 429) {
    return "Google AI rejected the request: the key's project is out of credits or quota. Add credits or raise the quota in Google AI Studio, then try again.";
  }
  if (status === 401 || status === 403) {
    return "Google AI rejected the key. Check the Google AI source in Settings > Integrations.";
  }
  if (status === 404) {
    return "Google AI does not offer this image model to the key's project.";
  }
  return "Google AI rejected the image request.";
}

export function getGoogleMediaHostAllowlist(): readonly string[] {
  const configured = (process.env.GOOGLE_GENERATIVE_MEDIA_HOST_ALLOWLIST || "")
    .split(",")
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_MEDIA_HOST_ALLOWLIST;
}

function hostMatchesAllowlist(hostname: string, pattern: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  const normalizedPattern = pattern.trim().toLowerCase().replace(/\.$/, "");
  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === normalizedPattern;
}

export function assertGoogleMediaUrl(uri: string): URL {
  const url = new URL(uri);
  if (url.protocol !== "https:") {
    throw new Error("Google generated media URL must use HTTPS");
  }
  if (
    !getGoogleMediaHostAllowlist().some(pattern =>
      hostMatchesAllowlist(url.hostname, pattern)
    )
  ) {
    throw new Error(
      `Google generated media URL host is not allowed: ${url.hostname}`
    );
  }
  return url;
}

export function getGoogleGenerativeApiKey(): string {
  return readEnvOrEmpty("GEMINI_API_KEY") || readEnvOrEmpty("GOOGLE_API_KEY");
}

export function isGoogleCreativeGenerationConfigured(): boolean {
  return Boolean(getGoogleGenerativeApiKey());
}

export function getGoogleImageGenerationModel(): string {
  return readEnvOrEmpty("GOOGLE_IMAGE_GENERATION_MODEL") || DEFAULT_IMAGE_MODEL;
}

export function getGoogleVideoGenerationModel(): string {
  return readEnvOrEmpty("GOOGLE_VIDEO_GENERATION_MODEL") || DEFAULT_VIDEO_MODEL;
}

export function getGoogleFreeGenerationLimit(): number {
  const parsed = Number.parseInt(
    process.env.GOOGLE_CREATIVE_FREE_GENERATION_LIMIT || "",
    10
  );
  if (!Number.isFinite(parsed)) return DEFAULT_FREE_GENERATION_LIMIT;
  return Math.max(0, Math.min(1000, parsed));
}

export function normalizeGoogleVideoDurationSeconds(value: unknown): 4 | 6 | 8 {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 6;
  if (parsed <= 4) return 4;
  if (parsed <= 6) return 6;
  return 8;
}

function requireGoogleApiKey(
  apiKey?: string,
  allowLegacyPlatform = false
): string {
  const key =
    apiKey?.trim() || (allowLegacyPlatform ? getGoogleGenerativeApiKey() : "");
  if (!key) {
    throw new OwnCreativeAiSourceRequiredError("google");
  }
  return key;
}

function googleHeaders(apiKey?: string) {
  return {
    "Content-Type": "application/json",
    "x-goog-api-key": requireGoogleApiKey(apiKey),
  };
}

async function fetchGoogleVideoJson(
  input: RequestInfo | URL,
  init: RequestInit,
  strict: boolean,
  maxBytes: number
): Promise<{ response: Response; payload: unknown }> {
  if (strict) {
    return fetchJsonWithinLimits(input, init, {
      maxBytes,
      timeoutMs: CONTRACT_V1_RESPONSE_TIMEOUT_MS,
    });
  }
  const response = await fetch(input, init);
  return {
    response,
    payload: await response.json().catch(() => null),
  };
}

const REFERENCE_IMAGE_ISSUE_MESSAGES: Record<
  GenerativeAIReferenceImageIssue,
  string
> = {
  count: "Too many reference images",
  mime_type: "Unsupported reference image data or type",
  file_size: "Reference image exceeds the size limit",
  total_size: "Reference images exceed the combined size limit",
};

/**
 * The interaction's latest generated image, read as Google's SDKs derive
 * their `output_image` convenience property: the last image of the latest
 * `model_output` steps since the last `user_input`. The REST body carries
 * only `steps`; a top-level `output_image` is still read when present.
 */
function readLatestStepImage(steps: unknown): Record<string, unknown> | null {
  if (!Array.isArray(steps)) return null;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = asRecord(steps[index]);
    if (step.type === "user_input") return null;
    if (step.type !== "model_output" || !Array.isArray(step.content)) continue;
    for (let item = step.content.length - 1; item >= 0; item -= 1) {
      const content = asRecord(step.content[item]);
      if (content.type === "image") return content;
    }
  }
  return null;
}

function extractOutputImage(payload: unknown): {
  data: string;
  mimeType: string;
} | null {
  const raw = asRecord(payload);
  for (const candidate of [
    readLatestStepImage(raw.steps),
    raw.output_image || raw.outputImage,
  ]) {
    const image = asRecord(candidate);
    const data = readTrimmedString(image.data);
    if (data) {
      return {
        data,
        mimeType:
          readTrimmedString(image.mime_type) ||
          readTrimmedString(image.mimeType) ||
          "image/png",
      };
    }
  }
  return null;
}

export async function submitGoogleImageGeneration(input: {
  apiKey?: string;
  prompt: string;
  modelId?: string;
  aspectRatio?: string | null;
  image?: { data: string; mimeType: string } | null;
  images?: Array<{ data: string; mimeType: string }>;
}): Promise<GoogleGeneratedImage> {
  const prompt = input.prompt;
  if (!prompt.trim()) {
    throw new Error("Prompt is required for Google image generation");
  }

  const modelId = input.modelId ?? getGoogleImageGenerationModel();
  if (
    input.modelId &&
    !GENERATIVE_AI_IMAGE_MODELS.some(model => model.id === modelId)
  ) {
    throw new Error("Unsupported Google image generation model");
  }
  const aspectRatio = input.aspectRatio || "9:16";
  if (!GENERATIVE_AI_IMAGE_ASPECT_RATIOS.some(ratio => ratio === aspectRatio)) {
    throw new Error("Unsupported Google image aspect ratio");
  }
  if (input.images && input.image) {
    throw new Error("Provide either image or images, not both");
  }
  const images = input.images ?? (input.image ? [input.image] : []);
  if (
    images.some(
      image =>
        !image.data ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) ||
        image.data.length % 4 !== 0
    )
  ) {
    throw new Error(REFERENCE_IMAGE_ISSUE_MESSAGES.mime_type);
  }
  const referenceIssue = findGenerativeAIReferenceImageIssue(
    images.map(image => ({
      mimeType: image.mimeType,
      fileSize: Buffer.byteLength(image.data, "base64"),
    }))
  );
  if (referenceIssue) {
    throw new Error(REFERENCE_IMAGE_ISSUE_MESSAGES[referenceIssue]);
  }

  const requestInput: unknown[] = [{ type: "text", text: prompt }];
  for (const image of images) {
    requestInput.push({
      type: "image",
      mime_type: image.mimeType,
      data: image.data,
    });
  }

  const { response, payload } = await fetchJsonWithinLimits(
    `${GOOGLE_GENERATIVE_BASE_URL}/interactions`,
    {
      method: "POST",
      headers: {
        ...googleHeaders(input.apiKey),
        "Api-Revision": GOOGLE_INTERACTIONS_API_REVISION,
      },
      body: JSON.stringify({
        model: modelId,
        input: requestInput,
        response_format: {
          type: "image",
          mime_type: "image/png",
          aspect_ratio: aspectRatio,
        },
      }),
    },
    { maxBytes: 30 * 1024 * 1024, timeoutMs: 120_000 }
  );

  if (!response.ok) {
    throw new GoogleCreativeApiError({
      message: `Google image generation failed: HTTP ${response.status}`,
      statusCode: response.status,
      payload,
    });
  }

  const outputImage = extractOutputImage(payload);
  if (!outputImage?.data) {
    throw new Error("Google image generation did not return image data");
  }

  if (!/^(image\/jpeg|image\/png|image\/webp)$/.test(outputImage.mimeType)) {
    throw new Error(
      "Google image generation returned an unsupported image type"
    );
  }
  const extension =
    outputImage.mimeType === "image/jpeg"
      ? "jpg"
      : outputImage.mimeType === "image/webp"
        ? "webp"
        : "png";
  const interactionId = readTrimmedString(asRecord(payload).id);

  return {
    buffer: Buffer.from(outputImage.data, "base64"),
    mimeType: outputImage.mimeType,
    fileName: `google-generated-image.${extension}`,
    // Never persist generated base64 or echoed prompts in MongoDB diagnostics.
    raw: interactionId ? { id: interactionId } : {},
  };
}

type GoogleVideoGenerationInput = {
  apiKey?: string;
  modelId?: string;
  prompt: string;
  aspectRatio?: string | null;
  durationSeconds?: number | null;
  image?: { data: string; mimeType: string } | null;
};

type PreparedGoogleVideoPost = () => Promise<GoogleVideoOperation>;

type GoogleVideoGenerationContractV1Input = Omit<
  GoogleVideoGenerationInput,
  "modelId"
> & {
  modelId: string;
};

function resolveGoogleVideoGenerationModel(
  value: unknown,
  strict: boolean
): string {
  const modelId = typeof value === "string" ? value.trim() : "";
  if (!modelId || modelId.length > 200 || (strict && modelId !== value)) {
    throw new Error("Google video generation model id is invalid");
  }
  return modelId;
}

function prepareGoogleVideoGeneration(
  input: GoogleVideoGenerationInput,
  strictErrors: boolean
): PreparedGoogleVideoPost {
  const prompt = input.prompt.trim();
  if (!prompt) {
    throw new Error("Prompt is required for Google video generation");
  }

  const instance: Record<string, unknown> = { prompt };
  if (input.image?.data) {
    instance.image = {
      inlineData: {
        mimeType: input.image.mimeType || "image/png",
        data: input.image.data,
      },
    };
  }

  const modelId = resolveGoogleVideoGenerationModel(
    strictErrors
      ? input.modelId
      : input.modelId || getGoogleVideoGenerationModel(),
    strictErrors
  );
  const url = `${GOOGLE_GENERATIVE_BASE_URL}/models/${encodeURIComponent(
    modelId
  )}:predictLongRunning`;
  const init: RequestInit = {
    method: "POST",
    headers: googleHeaders(input.apiKey),
    body: JSON.stringify({
      instances: [instance],
      parameters: {
        aspectRatio: input.aspectRatio || "9:16",
        durationSeconds: String(
          normalizeGoogleVideoDurationSeconds(input.durationSeconds)
        ),
        resolution: "720p",
      },
    }),
  };

  return async () => {
    const { response, payload } = await fetchGoogleVideoJson(
      url,
      init,
      strictErrors,
      CONTRACT_V1_SUBMIT_RESPONSE_MAX_BYTES
    );

    if (!response.ok) {
      if (strictErrors) {
        throw new GoogleCreativeApiError({
          message: `Google video generation failed to start: HTTP ${response.status}`,
          statusCode: response.status,
          payload,
        });
      }
      throw new Error(
        `Google video generation failed to start: ${
          payload && typeof payload === "object"
            ? JSON.stringify(payload)
            : `HTTP ${response.status}`
        }`
      );
    }

    const raw = asRecord(payload);
    const name = readTrimmedString(raw.name);
    if (!name) {
      if (strictErrors) throw new GoogleCreativeProtocolError(payload);
      throw new Error(
        "Google video generation did not return an operation name"
      );
    }
    if (
      strictErrors &&
      raw.done !== undefined &&
      typeof raw.done !== "boolean"
    ) {
      throw new GoogleCreativeProtocolError(payload);
    }

    return {
      name,
      done: Boolean(raw.done),
      response: raw.response,
      error: raw.error,
      raw: payload,
    };
  };
}

export function prepareGoogleVideoGenerationContractV1(
  input: GoogleVideoGenerationContractV1Input
): PreparedGoogleVideoPost {
  return prepareGoogleVideoGeneration(
    {
      ...input,
      prompt: assertProviderPrompt(input.prompt, 1200),
    },
    true
  );
}

async function pollGoogleVideoOperationInternal(
  operationName: string,
  strictErrors: boolean,
  apiKey?: string
): Promise<GoogleVideoOperation> {
  const normalizedName = operationName.trim().replace(/^\/+/, "");
  if (!normalizedName) {
    throw new Error("Google video operation name is required");
  }

  const { response, payload } = await fetchGoogleVideoJson(
    `${GOOGLE_GENERATIVE_BASE_URL}/${normalizedName}`,
    {
      method: "GET",
      headers: {
        "x-goog-api-key": requireGoogleApiKey(apiKey, apiKey === undefined),
      },
    },
    strictErrors,
    CONTRACT_V1_OPERATION_RESPONSE_MAX_BYTES
  );
  if (!response.ok) {
    if (strictErrors) {
      throw new GoogleCreativeApiError({
        message: `Google video operation fetch failed: HTTP ${response.status}`,
        statusCode: response.status,
        payload,
      });
    }
    throw new Error(
      `Google video operation fetch failed: ${
        payload && typeof payload === "object"
          ? JSON.stringify(payload)
          : `HTTP ${response.status}`
      }`
    );
  }

  const raw = asRecord(payload);
  const name = readTrimmedString(raw.name);
  if (
    strictErrors &&
    (!name || (raw.done !== undefined && typeof raw.done !== "boolean"))
  ) {
    throw new GoogleCreativeProtocolError(payload);
  }
  return {
    name: name || normalizedName,
    done: Boolean(raw.done),
    response: raw.response,
    error: raw.error,
    raw: payload,
  };
}

export async function pollGoogleVideoOperation(
  operationName: string,
  apiKey?: string
): Promise<GoogleVideoOperation> {
  return pollGoogleVideoOperationInternal(operationName, false, apiKey);
}

export async function pollGoogleVideoOperationContractV1(
  operationName: string,
  apiKey?: string
): Promise<GoogleVideoOperation> {
  return pollGoogleVideoOperationInternal(operationName, true, apiKey);
}

export function extractGoogleVideoResult(
  response: unknown
): GoogleVideoResult | null {
  const raw = asRecord(response);
  const generateVideoResponse = asRecord(raw.generateVideoResponse);
  const samples = Array.isArray(generateVideoResponse.generatedSamples)
    ? generateVideoResponse.generatedSamples
    : Array.isArray(raw.generatedVideos)
      ? raw.generatedVideos
      : [];
  const first = asRecord(samples[0]);
  const video = asRecord(first.video);
  const uri = readTrimmedString(video.uri);
  const videoBytes =
    readTrimmedString(video.videoBytes) ||
    readTrimmedString(video.bytesBase64Encoded);
  if (!uri && !videoBytes) return null;
  return {
    uri: uri || undefined,
    videoBytes: videoBytes || undefined,
    mimeType: readTrimmedString(video.mimeType) || "video/mp4",
  };
}

export async function downloadGoogleVideoResult(
  result: GoogleVideoResult,
  apiKey?: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (result.videoBytes) {
    return {
      buffer: Buffer.from(result.videoBytes, "base64"),
      mimeType: result.mimeType || "video/mp4",
    };
  }

  if (!result.uri) {
    throw new Error("Google video result did not include bytes or a URI");
  }

  const mediaUrl = assertGoogleMediaUrl(result.uri);
  const response = await fetch(mediaUrl, {
    redirect: "follow",
    headers: {
      "x-goog-api-key": requireGoogleApiKey(apiKey, apiKey === undefined),
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to download Google video: HTTP ${response.status}`);
  }

  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    mimeType:
      response.headers.get("content-type") || result.mimeType || "video/mp4",
  };
}
