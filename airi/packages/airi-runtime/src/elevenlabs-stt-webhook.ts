import crypto from "node:crypto";

import type {
  ConversationMediaAnalysisType,
  ConversationMediaTranscriptionCompletedSignalInput,
  ElevenLabsCreativeTranscriptionCompletedSignalInput,
  ElevenLabsCreativeTranscriptionMode,
} from "@icecore/temporal";
import { asRecord, readTrimmedString } from "@icecore/shared/lib/value-utils";

const DEFAULT_SIGNATURE_TOLERANCE_MS = 30 * 60 * 1000;
const MAX_TRANSCRIPT_CHARS = 12_000;

export type NormalizedElevenLabsSttWebhookEvent =
  | {
      kind: "conversation_media";
      workflowId: string;
      event: ConversationMediaTranscriptionCompletedSignalInput;
    }
  | {
      kind: "creative_asset";
      assetId: string;
      event: ElevenLabsCreativeTranscriptionCompletedSignalInput;
    };

export class ElevenLabsSttWebhookPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElevenLabsSttWebhookPayloadError";
  }
}

function compactTranscript(value: string): string {
  const compact = value
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (compact.length <= MAX_TRANSCRIPT_CHARS) return compact;
  return `${compact.slice(0, MAX_TRANSCRIPT_CHARS - 3)}...`;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return asRecord(value);
}

function normalizeMediaType(
  value: unknown,
): ConversationMediaAnalysisType | "" {
  const normalized = readTrimmedString(value).toLowerCase();
  return normalized === "audio" ||
    normalized === "voice" ||
    normalized === "video"
    ? normalized
    : "";
}

function normalizeCreativeTranscriptionMode(
  value: unknown,
): ElevenLabsCreativeTranscriptionMode | "" {
  const normalized = readTrimmedString(value).toLowerCase();
  return normalized === "transcript" || normalized === "subtitles"
    ? normalized
    : "";
}

function extractRequestId(data: Record<string, unknown>): string {
  return (
    readTrimmedString(data.request_id) ||
    readTrimmedString(data.requestId) ||
    readTrimmedString(data.transcription_id) ||
    readTrimmedString(data.transcriptionId) ||
    readTrimmedString(data.id)
  );
}

function extractTranscriptText(data: Record<string, unknown>): string {
  const transcription = asRecord(data.transcription);
  const text =
    readTrimmedString(transcription.text) ||
    readTrimmedString(data.text) ||
    readTrimmedString(data.transcript);
  return text ? compactTranscript(text) : "";
}

function extractLanguageCode(data: Record<string, unknown>): string | null {
  const transcription = asRecord(data.transcription);
  return (
    readTrimmedString(transcription.language_code) ||
    readTrimmedString(transcription.languageCode) ||
    readTrimmedString(data.language_code) ||
    readTrimmedString(data.languageCode) ||
    null
  );
}

function normalizeStatus(
  type: string,
  data: Record<string, unknown>,
): ConversationMediaTranscriptionCompletedSignalInput["status"] {
  const status = readTrimmedString(data.status).toLowerCase();
  return status === "failed" || status === "error" || type.includes("failed")
    ? "failed"
    : "completed";
}

function getWebhookSecret(explicitSecret?: string | null): string {
  return (
    explicitSecret ||
    process.env.ELEVENLABS_STT_WEBHOOK_SECRET ||
    process.env.ELEVENLABS_WEBHOOK_SECRET ||
    ""
  ).trim();
}

function parseSignatureHeader(signatureHeader: string): {
  timestamp: string;
  signature: string;
} | null {
  const parsed = new Map<string, string>();
  for (const part of signatureHeader.split(",")) {
    const normalized = part.trim();
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex <= 0) continue;
    parsed.set(
      normalized.slice(0, separatorIndex),
      normalized.slice(separatorIndex + 1),
    );
  }

  const timestamp = parsed.get("t") || "";
  const signature = parsed.get("v0") || "";
  if (!timestamp || !/^\d+$/.test(timestamp)) return null;
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) return null;
  return { timestamp, signature };
}

export function isElevenLabsSttWebhookConfigured(options?: {
  secret?: string | null;
}): boolean {
  return Boolean(getWebhookSecret(options?.secret));
}

export function verifyElevenLabsWebhookSignature(params: {
  rawBody: string;
  signatureHeader?: string | null;
  secret?: string | null;
  nowMs?: number;
  toleranceMs?: number;
}): boolean {
  const secret = getWebhookSecret(params.secret);
  if (!secret) return false;

  const parsed = parseSignatureHeader(params.signatureHeader || "");
  if (!parsed) return false;

  const timestampMs = Number.parseInt(parsed.timestamp, 10) * 1000;
  if (!Number.isFinite(timestampMs)) return false;
  const nowMs = params.nowMs ?? Date.now();
  const toleranceMs = params.toleranceMs ?? DEFAULT_SIGNATURE_TOLERANCE_MS;
  if (Math.abs(nowMs - timestampMs) > toleranceMs) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${parsed.timestamp}.${params.rawBody}`)
    .digest("hex");
  const actualBuffer = Buffer.from(parsed.signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

export function parseElevenLabsSttWebhookPayload(
  payload: unknown,
): NormalizedElevenLabsSttWebhookEvent {
  const envelope = asRecord(payload);
  const type = readTrimmedString(envelope.type);
  const data = asRecord(envelope.data);
  if (!type || Object.keys(data).length === 0) {
    throw new ElevenLabsSttWebhookPayloadError(
      "Invalid ElevenLabs STT webhook payload",
    );
  }

  const metadata = parseMetadata(data.webhook_metadata);
  const requestId = extractRequestId(data);
  if (!requestId) {
    throw new ElevenLabsSttWebhookPayloadError(
      "Missing ElevenLabs transcription request id",
    );
  }

  const status = normalizeStatus(type, data);
  if (
    readTrimmedString(metadata.workflowKind) === "creative_asset_transcription"
  ) {
    const assetId = readTrimmedString(metadata.assetId);
    const mode = normalizeCreativeTranscriptionMode(metadata.mode);
    if (!readTrimmedString(metadata.workspaceId) || !assetId || !mode) {
      throw new ElevenLabsSttWebhookPayloadError(
        "Missing ElevenLabs creative asset metadata",
      );
    }
    return {
      kind: "creative_asset",
      assetId,
      event: {
        requestId,
        status,
        mode,
        webhookType: type,
        data,
        error:
          status === "failed"
            ? readTrimmedString(data.error) ||
              readTrimmedString(data.message) ||
              "ElevenLabs transcription failed"
            : null,
        receivedAt: new Date().toISOString(),
      },
    };
  }

  const workflowId = readTrimmedString(metadata.workflowId);
  const mediaType = normalizeMediaType(metadata.mediaType);
  if (
    !workflowId ||
    !readTrimmedString(metadata.workspaceId) ||
    !readTrimmedString(metadata.conversationId) ||
    !readTrimmedString(metadata.messageId) ||
    !mediaType
  ) {
    throw new ElevenLabsSttWebhookPayloadError(
      "Missing ElevenLabs webhook correlation metadata",
    );
  }

  const text = extractTranscriptText(data);
  if (status === "completed" && !text) {
    throw new ElevenLabsSttWebhookPayloadError(
      "Missing ElevenLabs transcript text",
    );
  }

  return {
    kind: "conversation_media",
    workflowId,
    event: {
      requestId,
      status,
      text: text || null,
      languageCode: extractLanguageCode(data),
      error:
        status === "failed"
          ? readTrimmedString(data.error) ||
            readTrimmedString(data.message) ||
            "ElevenLabs transcription failed"
          : null,
      receivedAt: new Date().toISOString(),
      payload: {
        type,
        eventTimestamp: envelope.event_timestamp ?? null,
        providerStatus: readTrimmedString(data.status) || null,
      },
    },
  };
}
