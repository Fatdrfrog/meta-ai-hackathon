import { createHash } from "node:crypto";
import { cleanString } from "@icecore/shared/lib/value-utils";

const ELEVENLABS_API_BASE_URL = "https://api.elevenlabs.io/v1";
const DEFAULT_STT_MODEL = "scribe_v2";
const DEFAULT_TIMEOUT_MS = 60_000;

export type ElevenLabsErrorKind =
  | "config"
  | "auth"
  | "rate_limit"
  | "invalid_request"
  | "timeout"
  | "server"
  | "unknown";

export type ElevenLabsErrorInfo = {
  kind: ElevenLabsErrorKind;
  transient: boolean;
  status?: number;
  message: string;
};

export class ElevenLabsSttError extends Error {
  readonly info: ElevenLabsErrorInfo;

  constructor(info: ElevenLabsErrorInfo) {
    super(info.message);
    this.name = "ElevenLabsSttError";
    this.info = info;
  }
}

export function isElevenLabsSttTransientError(
  error: unknown,
): error is ElevenLabsSttError {
  return error instanceof ElevenLabsSttError && error.info.transient;
}

export type ElevenLabsConversationTranscriptionWebhookMetadata = {
  workflowId: string;
  workspaceId: string;
  conversationId: string;
  messageId: string;
  mediaType: "audio" | "voice" | "video";
};

export type ElevenLabsCreativeTranscriptionWebhookMetadata = {
  workflowKind: "creative_asset_transcription";
  workflowId: string;
  workspaceId: string;
  assetId: string;
  sourceAssetId: string;
  mode: "transcript" | "subtitles";
  mediaType: "audio" | "video";
};

/** Always delivered inline (`delivery: "inline"`), so no webhook route reads it. */
export type ElevenLabsProductVideoTranscriptionMetadata = {
  workflowKind: "product_video_import";
  workflowId: string;
  workspaceId: string;
  importId: string;
  mediaType: "audio";
};

export type ElevenLabsTranscriptionWebhookMetadata =
  | ElevenLabsConversationTranscriptionWebhookMetadata
  | ElevenLabsCreativeTranscriptionWebhookMetadata
  | ElevenLabsProductVideoTranscriptionMetadata;

export type ElevenLabsTranscriptionSubmissionResult = {
  requestId: string;
  model: string;
  mimeType: string;
  inputBytes: number | null;
  latencyMs: number;
  mediaKind: "audio" | "video";
  inputMode: "source_url" | "file_upload";
  deliveryMode: "webhook" | "inline";
  transcriptText: string | null;
  languageCode: string | null;
  responsePayload: Record<string, unknown> | null;
};

export type SubmitTranscriptionOptions = {
  modelId?: string;
  allowWebhookFallback?: boolean;
  apiKey?: string | null;
  fileBuffer?: Buffer | null;
  filename?: string | null;
  timestampsGranularity?: "none" | "word" | "character" | null;
  /**
   * "inline" answers in the same request even when a webhook is configured,
   * for a caller that needs the transcript to carry on (a product video
   * import) and has no workflow waiting on the webhook's signal.
   */
  delivery?: "inline";
};

function parseEnabledFlag(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function isElevenLabsSttConfigured(options?: {
  apiKey?: string | null;
}): boolean {
  return (
    Boolean(
      cleanString(options?.apiKey, 4000) || process.env.ELEVENLABS_API_KEY,
    ) && parseEnabledFlag(process.env.ELEVENLABS_STT_ENABLED)
  );
}

function getTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.ELEVENLABS_TIMEOUT_MS || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return parsed;
}

function inferAudioMimeTypeFromUrl(audioUrl: string): string | undefined {
  try {
    const pathname = new URL(audioUrl).pathname.toLowerCase();
    if (pathname.endsWith(".mp3")) return "audio/mpeg";
    if (pathname.endsWith(".m4a")) return "audio/mp4";
    if (pathname.endsWith(".wav")) return "audio/wav";
    if (pathname.endsWith(".ogg")) return "audio/ogg";
    if (pathname.endsWith(".opus")) return "audio/opus";
    if (pathname.endsWith(".webm")) return "audio/webm";
  } catch {
    return undefined;
  }
  return undefined;
}

function inferVideoMimeTypeFromUrl(mediaUrl: string): string | undefined {
  try {
    const pathname = new URL(mediaUrl).pathname.toLowerCase();
    if (pathname.endsWith(".mp4")) return "video/mp4";
    if (pathname.endsWith(".mov")) return "video/quicktime";
    if (pathname.endsWith(".webm")) return "video/webm";
    if (pathname.endsWith(".mkv")) return "video/x-matroska";
    if (pathname.endsWith(".m4v")) return "video/x-m4v";
  } catch {
    return undefined;
  }
  return undefined;
}

export function normalizeElevenLabsTranscriptionMimeType(
  mediaUrl: string,
  mimeType: string | undefined,
  kind: "audio" | "video",
): string {
  if (mimeType && mimeType.trim()) {
    return mimeType.trim().toLowerCase().split(";")[0]?.trim() || "";
  }
  if (kind === "video") {
    return inferVideoMimeTypeFromUrl(mediaUrl) || "video/mp4";
  }
  return inferAudioMimeTypeFromUrl(mediaUrl) || "audio/mpeg";
}

function getTranscriptionFileExtension(
  mimeType: string,
  kind: "audio" | "video",
): string {
  const normalized = mimeType.toLowerCase().split(";")[0]?.trim();
  if (normalized === "audio/mpeg" || normalized === "audio/mp3") return "mp3";
  if (normalized === "audio/mp4" || normalized === "audio/x-m4a") return "m4a";
  if (normalized === "audio/wav" || normalized === "audio/x-wav") return "wav";
  if (normalized === "audio/ogg" || normalized === "application/ogg")
    return "ogg";
  if (normalized === "audio/opus") return "opus";
  if (normalized === "audio/webm") return "webm";
  if (normalized === "video/mp4") return "mp4";
  if (normalized === "video/quicktime") return "mov";
  if (normalized === "video/webm") return "webm";
  if (normalized === "video/x-matroska") return "mkv";
  if (normalized === "video/x-m4v") return "m4v";
  return kind === "video" ? "mp4" : "mp3";
}

export function buildElevenLabsTranscriptionFilename(
  baseName: string,
  mimeType: string,
  kind: "audio" | "video",
): string {
  const trimmed = baseName.trim();
  const extension = getTranscriptionFileExtension(mimeType, kind);
  if (/\.[a-z0-9]{2,5}$/i.test(trimmed)) return trimmed;
  return `${trimmed}.${extension}`;
}

function canUseSourceUrl(mediaUrl: string): boolean {
  try {
    return new URL(mediaUrl).protocol === "https:";
  } catch {
    return false;
  }
}

function bufferToBlobPart(buffer: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(buffer);
}

async function fetchWithTimeout<T>(
  input: string,
  init: RequestInit,
  timeoutMs: number,
  consumeResponse: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    return await consumeResponse(response);
  } finally {
    clearTimeout(timer);
  }
}

function getErrorMessageFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const raw = payload as Record<string, unknown>;
  if (typeof raw.detail === "string") return raw.detail;
  if (Array.isArray(raw.detail)) {
    const details = raw.detail
      .slice(0, 5)
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const detail = item as Record<string, unknown>;
        const location = Array.isArray(detail.loc)
          ? detail.loc
              .filter(
                (part) => typeof part === "string" || typeof part === "number",
              )
              .join(".")
          : "";
        const message = cleanString(detail.msg || detail.message, 500);
        return [location, message].filter(Boolean).join(": ");
      })
      .filter(Boolean);
    if (details.length) return details.join("; ");
  }
  if (raw.detail && typeof raw.detail === "object") {
    const nested = getErrorMessageFromPayload(raw.detail);
    if (nested) return nested;
  }
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

function classifyHttpFailure(
  status: number,
  message: string,
): ElevenLabsSttError {
  if (status === 401 || status === 403) {
    return new ElevenLabsSttError({
      kind: "auth",
      transient: false,
      status,
      message: message || "ElevenLabs authentication failed",
    });
  }
  if (status === 408) {
    return new ElevenLabsSttError({
      kind: "timeout",
      transient: true,
      status,
      message: message || "ElevenLabs request timed out",
    });
  }
  if (status === 429) {
    return new ElevenLabsSttError({
      kind: "rate_limit",
      transient: true,
      status,
      message: message || "ElevenLabs rate limit reached",
    });
  }
  if (status >= 400 && status < 500) {
    return new ElevenLabsSttError({
      kind: "invalid_request",
      transient: false,
      status,
      message: message || "Invalid request sent to ElevenLabs",
    });
  }
  if (status >= 500) {
    return new ElevenLabsSttError({
      kind: "server",
      transient: true,
      status,
      message: message || "ElevenLabs server error",
    });
  }

  return new ElevenLabsSttError({
    kind: "unknown",
    transient: true,
    status,
    message: message || "Unexpected ElevenLabs error",
  });
}

function normalizeElevenLabsError(
  error: unknown,
  fallbackMessage: string,
): ElevenLabsSttError {
  if (error instanceof ElevenLabsSttError) return error;

  if (
    error &&
    typeof error === "object" &&
    "name" in error &&
    (error as { name?: string }).name === "AbortError"
  ) {
    return new ElevenLabsSttError({
      kind: "timeout",
      transient: true,
      message: "ElevenLabs request timed out",
    });
  }

  return new ElevenLabsSttError({
    kind: "unknown",
    transient: true,
    message: error instanceof Error ? error.message : fallbackMessage,
  });
}

function extractTranscriptionRequestId(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const raw = payload as Record<string, unknown>;
  const direct =
    raw.request_id ||
    raw.requestId ||
    raw.transcription_id ||
    raw.transcriptionId ||
    raw.id;
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  if (raw.data && typeof raw.data === "object") {
    return extractTranscriptionRequestId(raw.data);
  }
  return "";
}

function extractTranscriptionText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const raw = payload as Record<string, unknown>;
  if (typeof raw.text === "string") return raw.text.trim();
  if (raw.transcription && typeof raw.transcription === "object") {
    return extractTranscriptionText(raw.transcription);
  }
  if (raw.data && typeof raw.data === "object") {
    return extractTranscriptionText(raw.data);
  }
  return "";
}

function extractTranscriptionLanguageCode(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const raw = payload as Record<string, unknown>;
  const direct = raw.language_code || raw.languageCode;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  if (raw.transcription && typeof raw.transcription === "object") {
    return extractTranscriptionLanguageCode(raw.transcription);
  }
  if (raw.data && typeof raw.data === "object") {
    return extractTranscriptionLanguageCode(raw.data);
  }
  return "";
}

type ElevenLabsSpeechToTextResponse = {
  requestId: string;
  transcriptText: string | null;
  languageCode: string | null;
  payload: Record<string, unknown> | null;
};

async function requestSpeechToTextSubmission(
  formData: FormData,
  apiKey: string,
  timeoutMs: number,
  options: { requireRequestId: boolean },
): Promise<ElevenLabsSpeechToTextResponse> {
  const { response, payload } = await fetchWithTimeout(
    `${ELEVENLABS_API_BASE_URL}/speech-to-text`,
    {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: formData,
    },
    timeoutMs,
    async (response) => ({
      response,
      payload: await response.json().catch((error: unknown) => {
        if (error instanceof SyntaxError) return null;
        throw error;
      }),
    }),
  );

  if (!response.ok) {
    throw classifyHttpFailure(
      response.status,
      getErrorMessageFromPayload(payload),
    );
  }

  const requestId = extractTranscriptionRequestId(payload);
  const transcriptText = extractTranscriptionText(payload) || null;
  if (!requestId && options.requireRequestId) {
    throw new ElevenLabsSttError({
      kind: "unknown",
      transient: true,
      message: "ElevenLabs did not return a transcription request id",
    });
  }
  if (!requestId && !transcriptText) {
    throw new ElevenLabsSttError({
      kind: "unknown",
      transient: true,
      message: "ElevenLabs did not return a transcript",
    });
  }
  return {
    requestId,
    transcriptText,
    languageCode: extractTranscriptionLanguageCode(payload) || null,
    payload:
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : null,
  };
}

function buildInlineTranscriptionRequestId(
  metadata: ElevenLabsTranscriptionWebhookMetadata,
): string {
  return `inline_${createHash("sha256")
    .update(JSON.stringify(metadata))
    .digest("hex")
    .slice(0, 32)}`;
}

function appendTranscriptionFields(
  formData: FormData,
  metadata: ElevenLabsTranscriptionWebhookMetadata,
  options: SubmitTranscriptionOptions,
  webhookId: string,
) {
  formData.append(
    "timestamps_granularity",
    options.timestampsGranularity || "word",
  );
  if (!webhookId) return;
  formData.append("webhook", "true");
  formData.append("webhook_id", webhookId);
  formData.append("webhook_metadata", JSON.stringify(metadata));
}

async function submitMediaTranscriptionFromUrl(
  mediaUrl: string,
  mimeType: string | undefined,
  kind: "audio" | "video",
  metadata: ElevenLabsTranscriptionWebhookMetadata,
  options: SubmitTranscriptionOptions = {},
): Promise<ElevenLabsTranscriptionSubmissionResult> {
  const apiKey =
    cleanString(options.apiKey, 4000) || process.env.ELEVENLABS_API_KEY || "";
  if (!apiKey) {
    throw new ElevenLabsSttError({
      kind: "config",
      transient: false,
      message: "ELEVENLABS_API_KEY is not configured",
    });
  }
  if (!isElevenLabsSttConfigured({ apiKey })) {
    throw new ElevenLabsSttError({
      kind: "config",
      transient: false,
      message: "ElevenLabs STT is disabled (set ELEVENLABS_STT_ENABLED=true).",
    });
  }

  const model = options.modelId || process.env.ELEVENLABS_STT_MODEL || DEFAULT_STT_MODEL;
  const timeoutMs = getTimeoutMs();
  const requestStarted = Date.now();
  const effectiveMimeType = normalizeElevenLabsTranscriptionMimeType(
    mediaUrl,
    mimeType,
    kind,
  );
  const formFilename = buildElevenLabsTranscriptionFilename(
    kind === "video" ? "video-input" : "audio-input",
    effectiveMimeType,
    kind,
  );
  const assetLabel = kind === "video" ? "video" : "audio";
  let attemptedInputMode: "file_upload" | "source_url" | null = null;
  let attemptedDeliveryMode: "webhook" | "inline" | null = null;

  const configuredWebhookId =
    options.delivery === "inline"
      ? ""
      : cleanString(process.env.ELEVENLABS_STT_WEBHOOK_ID, 240);
  const submitPreparedInput = async (params: {
    inputMode: "file_upload" | "source_url";
    inputBytes: number | null;
    appendInput: (formData: FormData) => void;
  }): Promise<ElevenLabsTranscriptionSubmissionResult> => {
    const submit = async (webhookId: string) => {
      attemptedDeliveryMode = webhookId ? "webhook" : "inline";
      const formData = new FormData();
      params.appendInput(formData);
      formData.append("model_id", model);
      appendTranscriptionFields(formData, metadata, options, webhookId);
      return requestSpeechToTextSubmission(formData, apiKey, timeoutMs, {
        requireRequestId: Boolean(webhookId),
      });
    };

    let response: ElevenLabsSpeechToTextResponse;
    let deliveryMode: "webhook" | "inline" = configuredWebhookId
      ? "webhook"
      : "inline";
    try {
      response = await submit(configuredWebhookId);
    } catch (error) {
      if (
        options.allowWebhookFallback === false ||
        !configuredWebhookId ||
        !(error instanceof ElevenLabsSttError) ||
        error.info.kind !== "invalid_request" ||
        !/\bwebhook(?:_id|_metadata)?\b/i.test(error.message)
      ) {
        throw error;
      }

      console.warn("[ElevenLabs STT] webhook_submission_rejected", {
        provider: "elevenlabs",
        model,
        mediaKind: kind,
        inputMode: params.inputMode,
        status: error.info.status,
        message: error.message,
        recovery: "inline",
      });
      deliveryMode = "inline";
      response = await submit("");
    }

    return {
      requestId:
        response.requestId || buildInlineTranscriptionRequestId(metadata),
      model,
      mimeType: effectiveMimeType,
      inputBytes: params.inputBytes,
      latencyMs: Date.now() - requestStarted,
      mediaKind: kind,
      inputMode: params.inputMode,
      deliveryMode,
      transcriptText: response.transcriptText,
      languageCode: response.languageCode,
      responsePayload: response.payload,
    };
  };

  try {
    if (options.fileBuffer) {
      if (!options.fileBuffer.length) {
        throw new ElevenLabsSttError({
          kind: "invalid_request",
          transient: false,
          message: `${assetLabel.charAt(0).toUpperCase()}${assetLabel.slice(1)} file is empty`,
        });
      }
      attemptedInputMode = "file_upload";
      return await submitPreparedInput({
        inputMode: "file_upload",
        inputBytes: options.fileBuffer.length,
        appendInput: (formData) => {
          formData.append(
            "file",
            new Blob([bufferToBlobPart(options.fileBuffer!)], {
              type: effectiveMimeType,
            }),
            buildElevenLabsTranscriptionFilename(
              options.filename?.trim() || formFilename,
              effectiveMimeType,
              kind,
            ),
          );
        },
      });
    }

    if (canUseSourceUrl(mediaUrl)) {
      attemptedInputMode = "source_url";
      return await submitPreparedInput({
        inputMode: "source_url",
        inputBytes: null,
        appendInput: (formData) => {
          formData.append("source_url", mediaUrl);
        },
      });
    }

    attemptedInputMode = "file_upload";
    const fileBuffer = await fetchWithTimeout(
      mediaUrl,
      {},
      timeoutMs,
      async (downloadResponse) => {
        if (!downloadResponse.ok) {
          throw classifyHttpFailure(
            downloadResponse.status,
            `Failed to fetch ${assetLabel} asset (${downloadResponse.status})`,
          );
        }
        return Buffer.from(await downloadResponse.arrayBuffer());
      },
    );
    if (!fileBuffer.length) {
      throw new ElevenLabsSttError({
        kind: "invalid_request",
        transient: false,
        message: `${assetLabel.charAt(0).toUpperCase()}${assetLabel.slice(1)} file is empty`,
      });
    }

    return await submitPreparedInput({
      inputMode: "file_upload",
      inputBytes: fileBuffer.length,
      appendInput: (formData) => {
        formData.append(
          "file",
          new Blob([bufferToBlobPart(fileBuffer)], {
            type: effectiveMimeType,
          }),
          formFilename,
        );
      },
    });
  } catch (error) {
    const normalized = normalizeElevenLabsError(
      error,
      "Unknown ElevenLabs error",
    );

    console.warn("[ElevenLabs STT] transcription_failed", {
      provider: "elevenlabs",
      model,
      mediaKind: kind,
      kind: normalized.info.kind,
      transient: normalized.info.transient,
      status: normalized.info.status,
      message: normalized.message,
      latencyMs: Date.now() - requestStarted,
      inputMode: attemptedInputMode,
      deliveryMode: attemptedDeliveryMode,
      mimeType: effectiveMimeType,
    });

    throw normalized;
  }
}

export async function submitElevenLabsAudioTranscriptionFromUrl(
  audioUrl: string,
  mimeType: string | undefined,
  metadata: ElevenLabsTranscriptionWebhookMetadata,
  options: SubmitTranscriptionOptions = {},
): Promise<ElevenLabsTranscriptionSubmissionResult> {
  return submitMediaTranscriptionFromUrl(
    audioUrl,
    mimeType,
    "audio",
    metadata,
    options,
  );
}

export async function submitElevenLabsVideoTranscriptionFromUrl(
  videoUrl: string,
  mimeType: string | undefined,
  metadata: ElevenLabsTranscriptionWebhookMetadata,
  options: SubmitTranscriptionOptions = {},
): Promise<ElevenLabsTranscriptionSubmissionResult> {
  return submitMediaTranscriptionFromUrl(
    videoUrl,
    mimeType,
    "video",
    metadata,
    options,
  );
}
