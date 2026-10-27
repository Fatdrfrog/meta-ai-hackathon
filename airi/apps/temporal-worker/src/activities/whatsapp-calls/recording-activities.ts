import { createHash, createSign } from "node:crypto";

import {
  assertContractVersion,
  WHATSAPP_CALL_FINALIZE_RECORDING_ACTIVITY,
  WHATSAPP_CALL_POLL_TRANSCRIPTION_ACTIVITY,
  WHATSAPP_CALL_START_RECORDING_ACTIVITY,
  WHATSAPP_CALL_TRANSCRIPTION_DRAIN_ACTIVITY,
  WHATSAPP_CALL_TRANSCRIPTION_DRAIN_DEFAULT_LIMIT,
  WHATSAPP_CALL_TRANSCRIPTION_DRAIN_MAX_LIMIT,
  WHATSAPP_CALL_TRANSCRIPTION_DRAIN_WORKFLOW_CONTRACT_VERSION,
  type WhatsAppCallAnalyticsExportEvent,
  type WhatsAppCallFinalizeRecordingActivityInput,
  type WhatsAppCallFinalizeRecordingActivityResult,
  type WhatsAppCallLifecycleState,
  type WhatsAppCallPollTranscriptionActivityInput,
  type WhatsAppCallPollTranscriptionActivityResult,
  type WhatsAppCallStartRecordingActivityInput,
  type WhatsAppCallStartRecordingActivityResult,
  type WhatsAppCallTranscriptionDrainActivityInput,
  type WhatsAppCallTranscriptionDrainActivityResult,
} from "@icecore/temporal";
import { readEnv } from "@icecore/shared/lib/env";
import {
  coerceNonEmptyString as compactString,
  readFiniteNumber,
} from "@icecore/shared/lib/value-utils";
import {
  buildWhatsAppCallRoomName,
  mintLiveKitAccessToken,
  normalizeLiveKitHttpUrl,
} from "@icecore/airi-runtime/whatsapp-calling";
import {
  airiWorkerLogger,
  compactLogText,
} from "@icecore/airi-runtime/logging";
import { heartbeat } from "@temporalio/activity";

import { postConnectorJson } from "./connector-client.js";

type EnvLike = Record<string, string | undefined>;

export type WhatsAppCallRecordingSession = {
  _id?: unknown;
  workspaceId?: string | null;
  sourceId?: string | null;
  callId?: string | null;
  conversationId?: unknown;
  phoneNumberId?: string | null;
  state?: WhatsAppCallLifecycleState | null;
  direction?: string | null;
  durationSeconds?: number | null;
  firstSeenAt?: Date | string | null;
  answeredAt?: Date | string | null;
  endedAt?: Date | string | null;
  latestEvent?: string | null;
  latestStatus?: string | null;
  errorCode?: number | null;
  errorMessage?: string | null;
};

export type WhatsAppCallRecordingMetadata = {
  workspaceId: string;
  sourceId: string | null;
  callSessionId: string;
  callId: string;
  conversationId: string | null;
  phoneNumberId: string | null;
  direction: string | null;
  state: WhatsAppCallLifecycleState;
  durationSeconds: number | null;
  answerLatencyMs: number | null;
  terminationReason: string | null;
  errorCode: number | null;
  errorMessage: string | null;
  recordingObjectPath: string | null;
  transcriptStatus: "not_requested" | "pending";
  transcriptTextPath: string | null;
  retentionExpiresAt: string | null;
  finalizedAt: string;
  analyticsEvent: WhatsAppCallAnalyticsExportEvent;
};

export type WhatsAppCallRecordingPipelineRequest = {
  endpoint: string;
  body: {
    schemaVersion: 1;
    provider: "whatsapp";
    idempotencyKey: string;
    workspaceId: string;
    sourceId: string | null;
    callSessionId: string;
    callId: string;
    conversationId: string | null;
    phoneNumberId: string | null;
    roomName: string;
    recordingObjectPath: string;
    transcriptTextPath: string;
    callbackUrl: string | null;
    languageCode: string;
    finalizedAt: string;
    retentionExpiresAt: string | null;
    analyticsRowId: string;
    durationSeconds: number | null;
  };
};

export type WhatsAppCallLiveKitEgressFileType = "MP4" | "OGG" | "WEBM";

export type WhatsAppCallLiveKitEgressStartRequest = {
  endpoint: string;
  headers: {
    "Content-Type": "application/json";
    Authorization: string;
  };
  body: {
    room_name: string;
    audio_only: true;
    file_outputs: Array<{
      file_type: WhatsAppCallLiveKitEgressFileType;
      filepath: string;
      gcp: {
        bucket: string;
        credentials: string;
      };
    }>;
  };
};

export type WhatsAppCallLiveKitEgressStopRequest = {
  endpoint: string;
  headers: {
    "Content-Type": "application/json";
    Authorization: string;
  };
  body: {
    egress_id: string;
  };
};

export type WhatsAppCallGoogleSpeechBatchRecognizeRequest = {
  endpoint: string;
  headers: {
    Authorization: string;
    "Content-Type": "application/json";
  };
  body: {
    config: {
      autoDecodingConfig: Record<string, never>;
      languageCodes: string[];
      model: string;
      features: {
        enableAutomaticPunctuation: true;
        enableWordTimeOffsets: true;
      };
    };
    files: Array<{ uri: string }>;
    recognitionOutputConfig: {
      gcsOutputConfig: {
        uri: string;
      };
    };
    processingStrategy: "DYNAMIC_BATCHING";
  };
};

export type WhatsAppCallGoogleSpeechOperationGetRequest = {
  endpoint: string;
  headers: {
    Authorization: string;
    "Content-Type": "application/json";
  };
};

export type WhatsAppCallGoogleSpeechOperationParseResult = {
  status: "processing" | "completed" | "failed";
  operationName: string | null;
  transcriptTextPath: string | null;
  errorMessage: string | null;
  progressPercent: number | null;
};

type WhatsAppCallRecordingPipelineResponse = {
  requestId?: string | null;
  transcriptionJobId?: string | null;
  status?: string | null;
};

type LiveKitEgressStartResponse = {
  egress_id?: string | null;
  egressId?: string | null;
  status?: string | null;
};

type LiveKitEgressStopResponse = LiveKitEgressStartResponse;

type GoogleSpeechBatchRecognizeResponse = {
  name?: string | null;
};

type GoogleLongRunningOperation = {
  name?: string | null;
  done?: boolean | null;
  metadata?: {
    progressPercent?: number | string | null;
    progress_percent?: number | string | null;
  } | null;
  error?: {
    code?: number | string | null;
    message?: string | null;
  } | null;
  response?: {
    "@type"?: string | null;
    results?: Record<
      string,
      {
        cloudStorageResult?: {
          nativeFormatUri?: string | null;
          uri?: string | null;
        } | null;
        cloud_storage_result?: {
          native_format_uri?: string | null;
          uri?: string | null;
        } | null;
        uri?: string | null;
      }
    > | null;
  } | null;
};

type GoogleServiceAccountCredentials = {
  client_email?: string;
  private_key?: string;
  token_uri?: string;
  project_id?: string;
  type?: string;
};

type WhatsAppCallTranscriptionRecording = {
  _id?: unknown;
  workspaceId?: string | null;
  callSessionId?: unknown;
  callId?: string | null;
  recordingObjectPath?: string | null;
  transcriptTextPath?: string | null;
  transcriptionRequestId?: string | null;
};

type WhatsAppCallTranscriptionDrainModel = {
  find: (filter: Record<string, unknown>) => {
    sort: (sort: Record<string, 1 | -1>) => {
      limit: (limit: number) => {
        lean: () => {
          exec: () => Promise<WhatsAppCallTranscriptionRecording[]>;
        };
      };
    };
  };
};

const STALE_TRANSCRIPTION_POLL_MS = 10 * 60 * 1000;

function logTerminalWhatsAppCallFailure(
  metadata: WhatsAppCallRecordingMetadata,
) {
  const failed =
    metadata.state === "failed" ||
    Boolean(metadata.errorCode) ||
    Boolean(metadata.errorMessage);
  if (!failed) return;

  airiWorkerLogger.error("whatsapp.call.workflow.failure", undefined, {
    failureStage: "terminal_session",
    workspaceId: metadata.workspaceId,
    sourceId: metadata.sourceId,
    callSessionId: metadata.callSessionId,
    callId: metadata.callId,
    commandId: null,
    action: null,
    reason: metadata.state === "failed" ? "session_failed" : "session_error",
    errorCode: metadata.errorCode,
    errorMessage: compactLogText(metadata.errorMessage),
  });
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function dateOrNull(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function numberLikeOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeBucket(value: unknown): string | null {
  const bucket = compactString(value)
    ?.replace(/^gs:\/\//, "")
    .replace(/\/+$/, "");
  return bucket || null;
}

function normalizeBaseUrl(value: unknown): string | null {
  const url = compactString(value)?.replace(/\/+$/, "");
  return url || null;
}

function buildCallbackUrl(env: EnvLike): string | null {
  const explicitUrl = compactString(env.WHATSAPP_CALL_RECORDING_WEBHOOK_URL);
  if (explicitUrl) return explicitUrl;

  const appUrl = normalizeBaseUrl(env.NEXT_PUBLIC_APP_URL);
  return appUrl ? `${appUrl}/api/webhooks/whatsapp/call-recording` : null;
}

function sanitizePathPart(value: string | null): string {
  return (value || "unknown")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 180);
}

function parseRetentionDays(value: unknown): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return 90;
  return Math.min(Math.max(parsed, 1), 3650);
}

function parsePositiveInteger(value: unknown): number | null {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function normalizeWhatsAppCallTranscriptionDrainLimit(
  value: unknown,
): number {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return WHATSAPP_CALL_TRANSCRIPTION_DRAIN_DEFAULT_LIMIT;
  }
  return Math.min(
    Math.trunc(parsed),
    WHATSAPP_CALL_TRANSCRIPTION_DRAIN_MAX_LIMIT,
  );
}

export function buildWhatsAppCallTranscriptionDrainFilter(now: Date) {
  return {
    transcriptStatus: "processing",
    transcriptionRequestId: { $nin: [null, ""] },
    updatedAt: { $lte: new Date(now.getTime() - STALE_TRANSCRIPTION_POLL_MS) },
  };
}

function addDaysIso(value: string, days: number): string {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function buildStableRowId(input: {
  workspaceId: string;
  callSessionId: string;
  callId: string;
}): string {
  return createHash("sha256")
    .update([input.workspaceId, input.callSessionId, input.callId].join(":"))
    .digest("hex");
}

function resolveAnswerLatencyMs(session: WhatsAppCallRecordingSession) {
  const firstSeenAt = dateOrNull(session.firstSeenAt);
  const answeredAt = dateOrNull(session.answeredAt);
  if (!firstSeenAt || !answeredAt) return null;
  return Math.max(0, answeredAt.getTime() - firstSeenAt.getTime());
}

function recordingExtensionFromEnv(env: EnvLike): string {
  return normalizeLiveKitEgressFileType(
    env.WHATSAPP_CALL_RECORDING_FILE_TYPE,
  ).toLowerCase();
}

export function buildWhatsAppCallRecordingMetadata(input: {
  session: WhatsAppCallRecordingSession;
  finalizedAt: string;
  env?: EnvLike;
}): WhatsAppCallRecordingMetadata {
  const env = input.env || process.env;
  const session = input.session;
  const workspaceId = compactString(session.workspaceId) || "unknown-workspace";
  const callSessionId = compactString(session._id) || "unknown-session";
  const callId = compactString(session.callId) || "unknown-call";
  const phoneNumberId = compactString(session.phoneNumberId);
  const bucket = normalizeBucket(env.WHATSAPP_CALL_RECORDING_BUCKET);
  const basePath = bucket
    ? [
        "gs://",
        bucket,
        "/whatsapp-calls/",
        sanitizePathPart(workspaceId),
        "/",
        sanitizePathPart(phoneNumberId),
        "/",
        sanitizePathPart(callId),
        "/",
        sanitizePathPart(callSessionId),
      ].join("")
    : null;
  const finalizedAt =
    dateOrNull(input.finalizedAt)?.toISOString() || new Date().toISOString();
  const retentionExpiresAt = bucket
    ? addDaysIso(
        finalizedAt,
        parseRetentionDays(env.WHATSAPP_CALL_RECORDING_RETENTION_DAYS),
      )
    : null;
  const state = session.state || "unknown";
  const terminationReason =
    compactString(session.latestStatus) || compactString(session.latestEvent);
  const analyticsEvent: WhatsAppCallAnalyticsExportEvent = {
    rowId: buildStableRowId({ workspaceId, callSessionId, callId }),
    workspaceId,
    sourceId: compactString(session.sourceId),
    callId,
    callSessionId,
    conversationId: compactString(session.conversationId),
    phoneNumberId,
    direction: compactString(session.direction),
    state,
    durationSeconds: readFiniteNumber(session.durationSeconds),
    answerLatencyMs: resolveAnswerLatencyMs(session),
    terminationReason,
    errorCode: readFiniteNumber(session.errorCode),
    errorMessage: compactString(session.errorMessage),
    finalizedAt,
  };

  return {
    workspaceId,
    sourceId: analyticsEvent.sourceId,
    callSessionId,
    callId,
    conversationId: analyticsEvent.conversationId,
    phoneNumberId,
    direction: analyticsEvent.direction,
    state,
    durationSeconds: analyticsEvent.durationSeconds,
    answerLatencyMs: analyticsEvent.answerLatencyMs,
    terminationReason,
    errorCode: analyticsEvent.errorCode,
    errorMessage: analyticsEvent.errorMessage,
    recordingObjectPath: basePath
      ? `${basePath}.${recordingExtensionFromEnv(env)}`
      : null,
    transcriptStatus: basePath ? "pending" : "not_requested",
    transcriptTextPath: basePath ? `${basePath}.transcript.json` : null,
    retentionExpiresAt,
    finalizedAt,
    analyticsEvent,
  };
}

function readEnabled(name: string): boolean {
  return readEnv(name)?.toLowerCase() === "true";
}

function parseGcsUri(
  value: string | null,
): { bucket: string; path: string } | null {
  const normalized = compactString(value);
  if (!normalized?.startsWith("gs://")) return null;
  const withoutScheme = normalized.slice("gs://".length);
  const slashIndex = withoutScheme.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= withoutScheme.length - 1) return null;
  return {
    bucket: withoutScheme.slice(0, slashIndex),
    path: withoutScheme.slice(slashIndex + 1),
  };
}

function normalizeLiveKitEgressFileType(
  value: unknown,
): WhatsAppCallLiveKitEgressFileType {
  const normalized = compactString(value)?.toUpperCase();
  return normalized === "MP4" || normalized === "OGG" || normalized === "WEBM"
    ? normalized
    : "WEBM";
}

function replacePathExtension(
  path: string,
  fileType: WhatsAppCallLiveKitEgressFileType,
): string {
  const extension = fileType.toLowerCase();
  const withoutExtension = path.replace(/\.[^./]+$/, "");
  return `${withoutExtension}.${extension}`;
}

async function mintLiveKitRoomRecordToken(input: {
  env: EnvLike;
  apiKey: string;
  apiSecret: string;
  nowSeconds?: number | null;
}): Promise<string> {
  return mintLiveKitAccessToken({
    apiKey: input.apiKey,
    apiSecret: input.apiSecret,
    nowSeconds: input.nowSeconds,
    ttlSeconds: parsePositiveInteger(
      input.env.LIVEKIT_EGRESS_TOKEN_TTL_SECONDS,
    ),
    videoGrant: { roomRecord: true },
  });
}

export async function buildWhatsAppCallLiveKitEgressStartRequest(input: {
  metadata: WhatsAppCallRecordingMetadata;
  env?: EnvLike;
  nowSeconds?: number | null;
}): Promise<WhatsAppCallLiveKitEgressStartRequest | null> {
  const env = input.env || process.env;
  if (String(env.WHATSAPP_CALL_RECORDING_EGRESS_ENABLED || "") !== "true") {
    return null;
  }

  const liveKitUrl = compactString(env.LIVEKIT_URL);
  const apiKey = compactString(env.LIVEKIT_API_KEY);
  const apiSecret = compactString(env.LIVEKIT_API_SECRET);
  const credentials = compactString(
    env.LIVEKIT_EGRESS_GCP_CREDENTIALS_JSON ||
      env.WHATSAPP_CALL_RECORDING_GCP_CREDENTIALS_JSON,
  );
  const gcs = parseGcsUri(input.metadata.recordingObjectPath);
  if (!liveKitUrl || !apiKey || !apiSecret || !credentials || !gcs) {
    return null;
  }

  const host = normalizeLiveKitHttpUrl(liveKitUrl).replace(/\/+$/, "");
  const fileType = normalizeLiveKitEgressFileType(
    env.WHATSAPP_CALL_RECORDING_FILE_TYPE,
  );
  const token = await mintLiveKitRoomRecordToken({
    env,
    apiKey,
    apiSecret,
    nowSeconds: input.nowSeconds,
  });

  return {
    endpoint: `${host}/twirp/livekit.Egress/StartRoomCompositeEgress`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: {
      room_name: buildWhatsAppCallRoomName({
        workspaceId: input.metadata.workspaceId,
        callId: input.metadata.callId,
      }),
      audio_only: true,
      file_outputs: [
        {
          file_type: fileType,
          filepath: replacePathExtension(gcs.path, fileType),
          gcp: {
            bucket: gcs.bucket,
            credentials,
          },
        },
      ],
    },
  };
}

export async function buildWhatsAppCallLiveKitEgressStopRequest(input: {
  egressId: string | null;
  env?: EnvLike;
  nowSeconds?: number | null;
}): Promise<WhatsAppCallLiveKitEgressStopRequest | null> {
  const env = input.env || process.env;
  const egressId = compactString(input.egressId);
  const liveKitUrl = compactString(env.LIVEKIT_URL);
  const apiKey = compactString(env.LIVEKIT_API_KEY);
  const apiSecret = compactString(env.LIVEKIT_API_SECRET);
  if (!egressId || !liveKitUrl || !apiKey || !apiSecret) {
    return null;
  }

  const host = normalizeLiveKitHttpUrl(liveKitUrl).replace(/\/+$/, "");
  const token = await mintLiveKitRoomRecordToken({
    env,
    apiKey,
    apiSecret,
    nowSeconds: input.nowSeconds,
  });

  return {
    endpoint: `${host}/twirp/livekit.Egress/StopEgress`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: { egress_id: egressId },
  };
}

function getGoogleProjectId(env: EnvLike, primaryName: string): string | null {
  return (
    compactString(env[primaryName]) ||
    compactString(env.GOOGLE_CLOUD_PROJECT) ||
    compactString(env.GCP_PROJECT_ID) ||
    compactString(env.GCP_PROJECT)
  );
}

function normalizeSpeechLocation(value: unknown): string {
  return compactString(value) || "global";
}

function normalizeSpeechRecognizer(value: unknown): string {
  return compactString(value) || "_";
}

function normalizeSpeechModel(value: unknown): string {
  return compactString(value) || "long";
}

function parseSpeechLanguageCodes(env: EnvLike): string[] | null {
  const raw =
    compactString(env.WHATSAPP_CALL_TRANSCRIPTION_LANGUAGE_CODES) ||
    compactString(env.WHATSAPP_CALL_TRANSCRIPTION_LANGUAGE_CODE);
  const codes = (raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value && value.toLowerCase() !== "und");
  return codes.length > 0 ? Array.from(new Set(codes)) : null;
}

function encodeSpeechPathPart(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, "%2F");
}

export function buildWhatsAppCallGoogleSpeechBatchRecognizeRequest(input: {
  metadata: WhatsAppCallRecordingMetadata;
  accessToken: string | null;
  env?: EnvLike;
}): WhatsAppCallGoogleSpeechBatchRecognizeRequest | null {
  const env = input.env || process.env;
  if (String(env.WHATSAPP_CALL_TRANSCRIPTION_ENABLED || "") !== "true") {
    return null;
  }
  const accessToken = compactString(input.accessToken);
  const projectId = getGoogleProjectId(
    env,
    "WHATSAPP_CALL_TRANSCRIPTION_PROJECT_ID",
  );
  const languageCodes = parseSpeechLanguageCodes(env);
  const recordingObjectPath = compactString(input.metadata.recordingObjectPath);
  const transcriptTextPath = compactString(input.metadata.transcriptTextPath);
  if (
    !accessToken ||
    !projectId ||
    !languageCodes ||
    !recordingObjectPath ||
    !transcriptTextPath
  ) {
    return null;
  }

  const location = normalizeSpeechLocation(
    env.WHATSAPP_CALL_TRANSCRIPTION_LOCATION,
  );
  const recognizer = normalizeSpeechRecognizer(
    env.WHATSAPP_CALL_TRANSCRIPTION_RECOGNIZER,
  );

  return {
    endpoint: `https://speech.googleapis.com/v2/projects/${encodeSpeechPathPart(
      projectId,
    )}/locations/${encodeSpeechPathPart(
      location,
    )}/recognizers/${encodeSpeechPathPart(recognizer)}:batchRecognize`,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: {
      config: {
        autoDecodingConfig: {},
        languageCodes,
        model: normalizeSpeechModel(env.WHATSAPP_CALL_TRANSCRIPTION_MODEL),
        features: {
          enableAutomaticPunctuation: true,
          enableWordTimeOffsets: true,
        },
      },
      files: [{ uri: recordingObjectPath }],
      recognitionOutputConfig: {
        gcsOutputConfig: {
          uri: transcriptTextPath,
        },
      },
      processingStrategy: "DYNAMIC_BATCHING",
    },
  };
}

export function buildWhatsAppCallGoogleSpeechOperationGetRequest(input: {
  operationName: string | null;
  accessToken: string | null;
}): WhatsAppCallGoogleSpeechOperationGetRequest | null {
  const operationName = compactString(input.operationName);
  const accessToken = compactString(input.accessToken);
  if (!operationName || !accessToken) return null;

  return {
    endpoint: `https://speech.googleapis.com/v2/${operationName
      .split("/")
      .map(encodeSpeechPathPart)
      .join("/")}`,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  };
}

function extractGoogleSpeechTranscriptPath(input: {
  operation: GoogleLongRunningOperation;
  recordingObjectPath: string | null;
  fallbackTranscriptTextPath: string | null;
}): string | null {
  const results = input.operation.response?.results || null;
  if (!results) return compactString(input.fallbackTranscriptTextPath);

  const result =
    (input.recordingObjectPath
      ? results[input.recordingObjectPath]
      : undefined) || Object.values(results)[0];
  return (
    compactString(result?.cloudStorageResult?.nativeFormatUri) ||
    compactString(result?.cloud_storage_result?.native_format_uri) ||
    compactString(result?.cloudStorageResult?.uri) ||
    compactString(result?.cloud_storage_result?.uri) ||
    compactString(result?.uri) ||
    compactString(input.fallbackTranscriptTextPath)
  );
}

export function parseWhatsAppCallGoogleSpeechOperation(input: {
  operation: GoogleLongRunningOperation;
  recordingObjectPath: string | null;
  fallbackTranscriptTextPath: string | null;
}): WhatsAppCallGoogleSpeechOperationParseResult {
  const operationName = compactString(input.operation.name);
  const progressPercent =
    numberLikeOrNull(input.operation.metadata?.progressPercent) ??
    numberLikeOrNull(input.operation.metadata?.progress_percent);

  if (!input.operation.done) {
    return {
      status: "processing",
      operationName,
      transcriptTextPath: null,
      errorMessage: null,
      progressPercent,
    };
  }

  if (input.operation.error) {
    const code = compactString(input.operation.error.code);
    const message = compactString(input.operation.error.message);
    const detail = [code, message].filter(Boolean).join(" ");
    return {
      status: "failed",
      operationName,
      transcriptTextPath: null,
      errorMessage: `Google Speech operation failed:${detail ? ` ${detail}` : ""}`,
      progressPercent: 100,
    };
  }

  return {
    status: "completed",
    operationName,
    transcriptTextPath: extractGoogleSpeechTranscriptPath({
      operation: input.operation,
      recordingObjectPath: input.recordingObjectPath,
      fallbackTranscriptTextPath: input.fallbackTranscriptTextPath,
    }),
    errorMessage: null,
    progressPercent: 100,
  };
}

export function buildWhatsAppCallRecordingPipelineRequest(input: {
  metadata: WhatsAppCallRecordingMetadata;
  env?: EnvLike;
}): WhatsAppCallRecordingPipelineRequest | null {
  const env = input.env || process.env;
  const metadata = input.metadata;
  if (String(env.WHATSAPP_CALL_RECORDING_PIPELINE_ENABLED || "") !== "true") {
    return null;
  }
  if (!metadata.recordingObjectPath || !metadata.transcriptTextPath) {
    return null;
  }

  const explicitEndpoint = normalizeBaseUrl(
    env.WHATSAPP_CALL_RECORDING_PIPELINE_URL,
  );
  if (!explicitEndpoint) return null;

  return {
    endpoint: explicitEndpoint,
    body: {
      schemaVersion: 1,
      provider: "whatsapp",
      idempotencyKey: metadata.analyticsEvent.rowId,
      workspaceId: metadata.workspaceId,
      sourceId: metadata.sourceId,
      callSessionId: metadata.callSessionId,
      callId: metadata.callId,
      conversationId: metadata.conversationId,
      phoneNumberId: metadata.phoneNumberId,
      roomName: buildWhatsAppCallRoomName({
        workspaceId: metadata.workspaceId,
        callId: metadata.callId,
      }),
      recordingObjectPath: metadata.recordingObjectPath,
      transcriptTextPath: metadata.transcriptTextPath,
      callbackUrl: buildCallbackUrl(env),
      languageCode:
        compactString(env.WHATSAPP_CALL_TRANSCRIPTION_LANGUAGE_CODE) || "und",
      finalizedAt: metadata.finalizedAt,
      retentionExpiresAt: metadata.retentionExpiresAt,
      analyticsRowId: metadata.analyticsEvent.rowId,
      durationSeconds: metadata.durationSeconds,
    },
  };
}

async function requestCallRecordingPipeline(
  metadata: WhatsAppCallRecordingMetadata,
): Promise<{
  requested: boolean;
  requestId: string | null;
  reason: string | null;
}> {
  const request = buildWhatsAppCallRecordingPipelineRequest({ metadata });
  if (!request) {
    return { requested: false, requestId: null, reason: "pipeline_disabled" };
  }

  const response =
    await postConnectorJson<WhatsAppCallRecordingPipelineResponse>(
      request.endpoint,
      request.body,
    );
  return {
    requested: true,
    requestId:
      compactString(response.requestId) ||
      compactString(response.transcriptionJobId),
    reason: null,
  };
}

function parseGoogleServiceAccountCredentials(
  raw: string,
): GoogleServiceAccountCredentials {
  const parsed = JSON.parse(raw) as GoogleServiceAccountCredentials;
  if (
    parsed.type !== "service_account" ||
    !parsed.client_email ||
    !parsed.private_key
  ) {
    throw new Error("Google service account JSON is invalid.");
  }
  return parsed;
}

function buildGoogleServiceAccountAssertion(input: {
  credentials: GoogleServiceAccountCredentials;
  scope: string;
  nowSeconds?: number | null;
}): string {
  const nowSeconds = input.nowSeconds || Math.floor(Date.now() / 1000);
  const payload = {
    iss: input.credentials.client_email,
    scope: input.scope,
    aud: input.credentials.token_uri || "https://oauth2.googleapis.com/token",
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const signingInput = [
    base64UrlJson({ alg: "RS256", typ: "JWT" }),
    base64UrlJson(payload),
  ].join(".");
  const privateKey = String(input.credentials.private_key || "").replace(
    /\\n/g,
    "\n",
  );
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .end()
    .sign(privateKey)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

async function requestGoogleServiceAccountAccessToken(input: {
  credentials: GoogleServiceAccountCredentials;
  scope: string;
}): Promise<string> {
  const tokenUri =
    input.credentials.token_uri || "https://oauth2.googleapis.com/token";
  const assertion = buildGoogleServiceAccountAssertion({
    credentials: input.credentials,
    scope: input.scope,
  });
  const response = await fetch(tokenUri, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  const text = await response.text();
  const parsed = text
    ? (JSON.parse(text) as { access_token?: string | null })
    : {};
  if (!response.ok || !parsed.access_token) {
    throw new Error(
      `Google service account token request failed: HTTP ${response.status} ${text.slice(
        0,
        500,
      )}`,
    );
  }
  return parsed.access_token;
}

async function requestMetadataServerAccessToken(): Promise<string> {
  const response = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    {
      headers: {
        "Metadata-Flavor": "Google",
      },
    },
  );
  const text = await response.text();
  const parsed = text
    ? (JSON.parse(text) as { access_token?: string | null })
    : {};
  if (!response.ok || !parsed.access_token) {
    throw new Error(
      `Google metadata token request failed: HTTP ${response.status} ${text.slice(
        0,
        500,
      )}`,
    );
  }
  return parsed.access_token;
}

async function getGoogleCloudAccessTokenForSpeech(
  env: EnvLike = process.env,
): Promise<string> {
  const explicitToken =
    compactString(env.GOOGLE_CLOUD_ACCESS_TOKEN) ||
    compactString(env.GCP_ACCESS_TOKEN);
  if (explicitToken) return explicitToken;

  const serviceAccountJson =
    compactString(env.WHATSAPP_CALL_TRANSCRIPTION_SERVICE_ACCOUNT_JSON) ||
    compactString(env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  if (serviceAccountJson) {
    return requestGoogleServiceAccountAccessToken({
      credentials: parseGoogleServiceAccountCredentials(serviceAccountJson),
      scope: "https://www.googleapis.com/auth/cloud-platform",
    });
  }

  return requestMetadataServerAccessToken();
}

async function postGoogleSpeechBatchRecognize(
  request: WhatsAppCallGoogleSpeechBatchRecognizeRequest,
): Promise<{ operationName: string | null }> {
  const response = await fetch(request.endpoint, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
  });
  const text = await response.text();
  const parsed = text
    ? (JSON.parse(text) as GoogleSpeechBatchRecognizeResponse)
    : {};
  if (!response.ok) {
    throw new Error(
      `Google Speech batchRecognize returned HTTP ${response.status}: ${text.slice(
        0,
        500,
      )}`,
    );
  }
  return { operationName: compactString(parsed.name) };
}

async function getGoogleSpeechOperation(
  request: WhatsAppCallGoogleSpeechOperationGetRequest,
): Promise<GoogleLongRunningOperation> {
  const response = await fetch(request.endpoint, {
    method: "GET",
    headers: request.headers,
  });
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as GoogleLongRunningOperation) : {};
  if (!response.ok) {
    throw new Error(
      `Google Speech operation get returned HTTP ${response.status}: ${text.slice(
        0,
        500,
      )}`,
    );
  }
  return parsed;
}

async function requestGoogleSpeechTranscription(
  metadata: WhatsAppCallRecordingMetadata,
): Promise<{
  requested: boolean;
  operationName: string | null;
  error: string | null;
  reason: string | null;
}> {
  const probe = buildWhatsAppCallGoogleSpeechBatchRecognizeRequest({
    metadata,
    accessToken: "__probe__",
  });
  if (!probe) {
    return {
      requested: false,
      operationName: null,
      error: null,
      reason: "google_speech_disabled",
    };
  }

  try {
    const accessToken = await getGoogleCloudAccessTokenForSpeech();
    const request = buildWhatsAppCallGoogleSpeechBatchRecognizeRequest({
      metadata,
      accessToken,
    });
    if (!request) {
      return {
        requested: false,
        operationName: null,
        error: null,
        reason: "google_speech_not_configured",
      };
    }
    const response = await postGoogleSpeechBatchRecognize(request);
    if (!response.operationName) {
      throw new Error("Google Speech response did not include operation name.");
    }
    return {
      requested: true,
      operationName: response.operationName,
      error: null,
      reason: null,
    };
  } catch (error) {
    return {
      requested: false,
      operationName: null,
      error: error instanceof Error ? error.message : String(error),
      reason: "google_speech_failed",
    };
  }
}

async function postLiveKitEgressStart(
  request: WhatsAppCallLiveKitEgressStartRequest,
): Promise<{ egressId: string | null; status: string | null }> {
  const response = await fetch(request.endpoint, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
  });
  const text = await response.text();
  const parsed = text
    ? (JSON.parse(text) as LiveKitEgressStartResponse)
    : ({} as LiveKitEgressStartResponse);
  if (!response.ok) {
    throw new Error(
      `LiveKit egress start returned HTTP ${response.status}: ${text.slice(
        0,
        500,
      )}`,
    );
  }
  return {
    egressId: compactString(parsed.egress_id) || compactString(parsed.egressId),
    status: compactString(parsed.status),
  };
}

async function postLiveKitEgressStop(
  request: WhatsAppCallLiveKitEgressStopRequest,
): Promise<{ egressId: string | null; status: string | null }> {
  const response = await fetch(request.endpoint, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
  });
  const text = await response.text();
  const parsed = text
    ? (JSON.parse(text) as LiveKitEgressStopResponse)
    : ({} as LiveKitEgressStopResponse);
  if (!response.ok) {
    throw new Error(
      `LiveKit egress stop returned HTTP ${response.status}: ${text.slice(
        0,
        500,
      )}`,
    );
  }
  return {
    egressId: compactString(parsed.egress_id) || compactString(parsed.egressId),
    status: compactString(parsed.status),
  };
}

async function requestLiveKitEgressStart(
  metadata: WhatsAppCallRecordingMetadata,
): Promise<{
  started: boolean;
  egressId: string | null;
  status: string | null;
  reason: string | null;
}> {
  const request = await buildWhatsAppCallLiveKitEgressStartRequest({
    metadata,
  });
  if (!request) {
    return {
      started: false,
      egressId: null,
      status: null,
      reason: "egress_disabled",
    };
  }
  const response = await postLiveKitEgressStart(request);
  if (!response.egressId) {
    throw new Error("LiveKit egress start response did not include egress_id.");
  }
  return {
    started: true,
    egressId: response.egressId,
    status: response.status,
    reason: null,
  };
}

async function requestLiveKitEgressStop(egressId: string | null): Promise<{
  stopped: boolean;
  status: string | null;
  error: string | null;
}> {
  const request = await buildWhatsAppCallLiveKitEgressStopRequest({ egressId });
  if (!request) {
    return { stopped: false, status: null, error: null };
  }
  try {
    const response = await postLiveKitEgressStop(request);
    return {
      stopped: true,
      status: response.status || "stopped",
      error: null,
    };
  } catch (error) {
    return {
      stopped: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function publishCallAnalyticsEvent(
  event: WhatsAppCallAnalyticsExportEvent,
): Promise<{ exported: boolean; messageId: string | null; skipped: boolean }> {
  const projectId =
    readEnv("WHATSAPP_CALL_ANALYTICS_PROJECT_ID") ||
    readEnv("GOOGLE_CLOUD_PROJECT") ||
    readEnv("GCP_PROJECT_ID") ||
    readEnv("GCP_PROJECT");
  const topic =
    readEnv("WHATSAPP_CALL_ANALYTICS_TOPIC") ||
    "icecore-whatsapp-call-analytics";

  if (!readEnabled("WHATSAPP_CALL_ANALYTICS_ENABLED") || !projectId) {
    return { exported: false, messageId: null, skipped: true };
  }

  const { PubSub } = await import("@google-cloud/pubsub");
  const pubsub = new PubSub({ projectId });
  const messageId = await pubsub
    .topic(topic, { messageOrdering: true })
    .publishMessage({
      json: event,
      orderingKey: `${event.workspaceId}:${event.phoneNumberId || "unknown-phone"}:${event.callId}`,
      attributes: {
        workspaceId: event.workspaceId,
        callId: event.callId,
        rowId: event.rowId,
      },
    });
  return { exported: true, messageId, skipped: false };
}

async function getConnectDb() {
  const module = await import("@/lib/mongoose");
  return module.default;
}

export async function startWhatsAppCallRecordingActivity(
  input: WhatsAppCallStartRecordingActivityInput,
): Promise<WhatsAppCallStartRecordingActivityResult> {
  heartbeat({ callId: input.callId, phase: "start_recording" });
  const connectDB = await getConnectDb();
  const { default: WhatsAppCallSession } = await import(
    "@/models/whatsapp-call-session"
  );
  const { default: WhatsAppCallRecording } = await import(
    "@/models/whatsapp-call-recording"
  );

  await connectDB();
  const session = await WhatsAppCallSession.findOne({
    _id: input.callSessionId,
    workspaceId: input.workspaceId,
    callId: input.callId,
  })
    .lean<WhatsAppCallRecordingSession | null>()
    .exec();

  if (!session) {
    return {
      skipped: true,
      recordingId: null,
      recordingObjectPath: null,
      egressStarted: false,
      egressId: null,
      transcriptStatus: "not_requested",
      reason: "session_not_found",
    };
  }

  const startedAt = input.startedAt || new Date().toISOString();
  const metadata = buildWhatsAppCallRecordingMetadata({
    session,
    finalizedAt: startedAt,
  });
  const recording = await WhatsAppCallRecording.findOneAndUpdate(
    {
      workspaceId: metadata.workspaceId,
      callSessionId: metadata.callSessionId,
    },
    {
      $setOnInsert: {
        sourceId: metadata.sourceId,
        callId: metadata.callId,
        conversationId: metadata.conversationId,
        phoneNumberId: metadata.phoneNumberId,
        direction: metadata.direction,
        state: metadata.state,
        recordingObjectPath: metadata.recordingObjectPath,
        transcriptStatus: metadata.transcriptStatus,
        transcriptTextPath: metadata.transcriptTextPath,
        retentionExpiresAt: metadata.retentionExpiresAt
          ? new Date(metadata.retentionExpiresAt)
          : null,
        bigQueryExportRowId: metadata.analyticsEvent.rowId,
      },
      $set: {
        egressLastError: null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )
    .lean<{ _id?: unknown; liveKitEgressId?: string | null } | null>()
    .exec();

  if (recording?.liveKitEgressId) {
    return {
      skipped: false,
      recordingId: compactString(recording._id),
      recordingObjectPath: metadata.recordingObjectPath,
      egressStarted: true,
      egressId: compactString(recording.liveKitEgressId),
      transcriptStatus: metadata.transcriptStatus,
      reason: "egress_already_started",
    };
  }

  const egress = await requestLiveKitEgressStart(metadata);
  if (egress.started) {
    await WhatsAppCallRecording.updateOne(
      {
        workspaceId: metadata.workspaceId,
        callSessionId: metadata.callSessionId,
      },
      {
        $set: {
          liveKitEgressId: egress.egressId,
          liveKitEgressStatus: egress.status || "started",
          egressStartedAt: new Date(startedAt),
          egressLastError: null,
        },
      },
    ).exec();
  }

  return {
    skipped: !egress.started,
    recordingId: compactString(recording?._id),
    recordingObjectPath: metadata.recordingObjectPath,
    egressStarted: egress.started,
    egressId: egress.egressId,
    transcriptStatus: metadata.transcriptStatus,
    reason: egress.reason,
  };
}

export async function finalizeWhatsAppCallRecordingActivity(
  input: WhatsAppCallFinalizeRecordingActivityInput,
): Promise<WhatsAppCallFinalizeRecordingActivityResult> {
  heartbeat({ callId: input.callId, phase: "finalize_recording" });
  const connectDB = await getConnectDb();
  const { default: WhatsAppCallSession } = await import(
    "@/models/whatsapp-call-session"
  );
  const { default: WhatsAppCallRecording } = await import(
    "@/models/whatsapp-call-recording"
  );

  await connectDB();
  const session = await WhatsAppCallSession.findOne({
    _id: input.callSessionId,
    workspaceId: input.workspaceId,
    callId: input.callId,
  })
    .lean<WhatsAppCallRecordingSession | null>()
    .exec();

  if (!session) {
    return {
      skipped: true,
      recordingId: null,
      recordingObjectPath: null,
      transcriptStatus: "not_requested",
      transcriptionRequestId: null,
      transcriptTextPath: null,
      retentionExpiresAt: null,
      bigQueryExportRowId: null,
      analyticsExported: false,
      reason: "session_not_found",
    };
  }

  const metadata = buildWhatsAppCallRecordingMetadata({
    session,
    finalizedAt: input.finalizedAt || new Date().toISOString(),
  });
  logTerminalWhatsAppCallFailure(metadata);
  const recording = await WhatsAppCallRecording.findOneAndUpdate(
    {
      workspaceId: metadata.workspaceId,
      callSessionId: metadata.callSessionId,
    },
    {
      $set: {
        sourceId: metadata.sourceId,
        callId: metadata.callId,
        conversationId: metadata.conversationId,
        phoneNumberId: metadata.phoneNumberId,
        direction: metadata.direction,
        state: metadata.state,
        durationSeconds: metadata.durationSeconds,
        answerLatencyMs: metadata.answerLatencyMs,
        terminationReason: metadata.terminationReason,
        errorCode: metadata.errorCode,
        errorMessage: metadata.errorMessage,
        recordingObjectPath: metadata.recordingObjectPath,
        transcriptStatus: metadata.transcriptStatus,
        transcriptTextPath: metadata.transcriptTextPath,
        retentionExpiresAt: metadata.retentionExpiresAt
          ? new Date(metadata.retentionExpiresAt)
          : null,
        bigQueryExportRowId: metadata.analyticsEvent.rowId,
        finalizedAt: new Date(metadata.finalizedAt),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )
    .lean<{ _id?: unknown; liveKitEgressId?: string | null } | null>()
    .exec();
  const egressStop = await requestLiveKitEgressStop(
    compactString(recording?.liveKitEgressId),
  );

  if (recording?.liveKitEgressId && (egressStop.stopped || egressStop.error)) {
    await WhatsAppCallRecording.updateOne(
      {
        workspaceId: metadata.workspaceId,
        callSessionId: metadata.callSessionId,
      },
      {
        $set: {
          ...(egressStop.stopped
            ? {
                liveKitEgressStatus: egressStop.status || "stopped",
                egressStoppedAt: new Date(),
              }
            : {}),
          egressLastError: egressStop.error,
        },
      },
    ).exec();
  }
  const pipeline = await requestCallRecordingPipeline(metadata);

  if (pipeline.requested) {
    await WhatsAppCallRecording.updateOne(
      {
        workspaceId: metadata.workspaceId,
        callSessionId: metadata.callSessionId,
      },
      {
        $set: {
          transcriptStatus: "processing",
          transcriptionRequestId: pipeline.requestId,
          transcriptionLastError: null,
        },
      },
    ).exec();
  }
  const speech =
    pipeline.requested || !recording?.liveKitEgressId
      ? {
          requested: false,
          operationName: null,
          error: null,
          reason: pipeline.requested
            ? "pipeline_requested"
            : "egress_not_started",
        }
      : await requestGoogleSpeechTranscription(metadata);

  if (speech.requested || speech.error) {
    await WhatsAppCallRecording.updateOne(
      {
        workspaceId: metadata.workspaceId,
        callSessionId: metadata.callSessionId,
      },
      {
        $set: {
          transcriptStatus: speech.requested ? "processing" : "failed",
          transcriptionRequestId: speech.operationName,
          transcriptionLastError: speech.error,
        },
      },
    ).exec();
  }

  const analyticsPublish = await publishCallAnalyticsEvent(
    metadata.analyticsEvent,
  );

  if (analyticsPublish.exported) {
    await WhatsAppCallRecording.updateOne(
      {
        workspaceId: metadata.workspaceId,
        callSessionId: metadata.callSessionId,
      },
      {
        $set: {
          analyticsExportedAt: new Date(),
          analyticsPubSubMessageId: analyticsPublish.messageId,
          analyticsLastError: null,
        },
      },
    ).exec();
  }

  return {
    skipped: false,
    recordingId: compactString(recording?._id),
    recordingObjectPath: metadata.recordingObjectPath,
    transcriptStatus:
      pipeline.requested || speech.requested
        ? "processing"
        : speech.error
          ? "failed"
          : metadata.transcriptStatus,
    transcriptionRequestId: pipeline.requestId || speech.operationName || null,
    transcriptTextPath: metadata.transcriptTextPath,
    retentionExpiresAt: metadata.retentionExpiresAt,
    bigQueryExportRowId: metadata.analyticsEvent.rowId,
    analyticsExported: analyticsPublish.exported,
    reason: analyticsPublish.skipped ? "analytics_disabled" : null,
  };
}

export async function pollWhatsAppCallTranscriptionActivity(
  input: WhatsAppCallPollTranscriptionActivityInput,
): Promise<WhatsAppCallPollTranscriptionActivityResult> {
  heartbeat({ callId: input.callId, phase: "poll_transcription" });
  const connectDB = await getConnectDb();
  const { default: WhatsAppCallRecording } = await import(
    "@/models/whatsapp-call-recording"
  );

  await connectDB();
  const recording = await WhatsAppCallRecording.findOne({
    workspaceId: input.workspaceId,
    callSessionId: input.callSessionId,
    callId: input.callId,
  })
    .lean<WhatsAppCallTranscriptionRecording | null>()
    .exec();

  if (!recording) {
    return {
      skipped: true,
      status: "not_requested",
      transcriptionRequestId: null,
      transcriptTextPath: null,
      reason: "recording_not_found",
    };
  }

  const operationName =
    compactString(input.operationName) ||
    compactString(recording.transcriptionRequestId);
  if (!operationName) {
    return {
      skipped: true,
      status: "not_requested",
      transcriptionRequestId: null,
      transcriptTextPath: compactString(recording.transcriptTextPath),
      reason: "operation_not_found",
    };
  }

  try {
    const accessToken = await getGoogleCloudAccessTokenForSpeech();
    const request = buildWhatsAppCallGoogleSpeechOperationGetRequest({
      operationName,
      accessToken,
    });
    if (!request) {
      return {
        skipped: true,
        status: "not_requested",
        transcriptionRequestId: operationName,
        transcriptTextPath: compactString(recording.transcriptTextPath),
        reason: "google_speech_not_configured",
      };
    }

    const operation = await getGoogleSpeechOperation(request);
    const parsed = parseWhatsAppCallGoogleSpeechOperation({
      operation,
      recordingObjectPath: compactString(recording.recordingObjectPath),
      fallbackTranscriptTextPath: compactString(recording.transcriptTextPath),
    });
    const transcriptionRequestId = parsed.operationName || operationName;
    const transcriptTextPath =
      parsed.transcriptTextPath || compactString(recording.transcriptTextPath);
    const update: Record<string, unknown> = {
      transcriptStatus: parsed.status,
      transcriptionRequestId,
      transcriptionLastError: parsed.errorMessage,
    };
    if (parsed.status === "completed") {
      update.transcriptTextPath = transcriptTextPath;
      update.transcriptCompletedAt = new Date();
    }
    if (parsed.status === "failed") {
      update.transcriptCompletedAt = new Date();
    }

    await WhatsAppCallRecording.updateOne(
      {
        workspaceId: input.workspaceId,
        callSessionId: input.callSessionId,
        callId: input.callId,
      },
      { $set: update },
    ).exec();

    return {
      skipped: false,
      status: parsed.status,
      transcriptionRequestId,
      transcriptTextPath:
        parsed.status === "completed" ? transcriptTextPath : null,
      errorMessage: parsed.errorMessage,
      progressPercent: parsed.progressPercent,
      reason: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await WhatsAppCallRecording.updateOne(
      {
        workspaceId: input.workspaceId,
        callSessionId: input.callSessionId,
        callId: input.callId,
      },
      {
        $set: {
          transcriptStatus: "processing",
          transcriptionRequestId: operationName,
          transcriptionLastError: message,
        },
      },
    ).exec();

    return {
      skipped: false,
      status: "processing",
      transcriptionRequestId: operationName,
      transcriptTextPath: compactString(recording.transcriptTextPath),
      errorMessage: message,
      progressPercent: null,
      reason: "poll_failed",
    };
  }
}

export async function drainWhatsAppCallTranscriptionOperations(params: {
  model: WhatsAppCallTranscriptionDrainModel;
  limit?: number | null;
  now?: Date;
  heartbeat?: (details: Record<string, unknown>) => void;
  pollTranscription?: (
    input: WhatsAppCallPollTranscriptionActivityInput,
  ) => Promise<WhatsAppCallPollTranscriptionActivityResult>;
}): Promise<WhatsAppCallTranscriptionDrainActivityResult> {
  const limit = normalizeWhatsAppCallTranscriptionDrainLimit(params.limit);
  const now = params.now || new Date();
  const recordings = await params.model
    .find(buildWhatsAppCallTranscriptionDrainFilter(now))
    .sort({ updatedAt: 1, _id: 1 })
    .limit(limit)
    .lean()
    .exec();
  const pollTranscription =
    params.pollTranscription || pollWhatsAppCallTranscriptionActivity;
  const result: WhatsAppCallTranscriptionDrainActivityResult = {
    scanned: recordings.length,
    processing: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
  };

  for (const recording of recordings) {
    const recordingId = compactString(recording._id);
    const workspaceId = compactString(recording.workspaceId);
    const callSessionId = compactString(recording.callSessionId);
    const callId = compactString(recording.callId);
    const operationName = compactString(recording.transcriptionRequestId);
    if (!workspaceId || !callSessionId || !callId || !operationName) {
      result.skipped += 1;
      continue;
    }

    params.heartbeat?.({
      recordingId,
      callId,
      phase: "poll_transcription_batch",
    });
    const polled = await pollTranscription({
      workspaceId,
      callSessionId,
      callId,
      operationName,
    });
    if (polled.skipped || polled.status === "not_requested") {
      result.skipped += 1;
    } else if (polled.status === "completed") {
      result.completed += 1;
    } else if (polled.status === "failed") {
      result.failed += 1;
    } else {
      result.processing += 1;
    }
  }

  return result;
}

export async function whatsappCallTranscriptionDrainActivity(
  input: WhatsAppCallTranscriptionDrainActivityInput,
): Promise<WhatsAppCallTranscriptionDrainActivityResult> {
  assertContractVersion(
    input.contractVersion,
    { exact: WHATSAPP_CALL_TRANSCRIPTION_DRAIN_WORKFLOW_CONTRACT_VERSION },
    "WhatsApp call transcription drain activity",
  );

  const connectDB = await getConnectDb();
  const { default: WhatsAppCallRecording } = await import(
    "@/models/whatsapp-call-recording"
  );
  await connectDB();
  return drainWhatsAppCallTranscriptionOperations({
    model:
      WhatsAppCallRecording as unknown as WhatsAppCallTranscriptionDrainModel,
    limit: input.limit,
    heartbeat,
  });
}

export const whatsappCallRecordingActivityHandlers = {
  [WHATSAPP_CALL_START_RECORDING_ACTIVITY]: startWhatsAppCallRecordingActivity,
  [WHATSAPP_CALL_FINALIZE_RECORDING_ACTIVITY]:
    finalizeWhatsAppCallRecordingActivity,
  [WHATSAPP_CALL_POLL_TRANSCRIPTION_ACTIVITY]:
    pollWhatsAppCallTranscriptionActivity,
  [WHATSAPP_CALL_TRANSCRIPTION_DRAIN_ACTIVITY]:
    whatsappCallTranscriptionDrainActivity,
};
