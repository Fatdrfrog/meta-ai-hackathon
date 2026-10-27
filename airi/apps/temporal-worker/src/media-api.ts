import http from "node:http";
import { fileURLToPath } from "node:url";

import {
  MEDIA_API_PATHS,
  type MediaApiInitiateUploadRequest,
  type MediaApiInitiateUploadResponse,
  type MediaApiObjectDeleteRequest,
  type MediaApiObjectDeleteResponse,
  type MediaApiObjectReadUrlRequest,
  type MediaApiObjectReadUrlResponse,
  type MediaApiObjectStatRequest,
  type MediaApiObjectStatResponse,
} from "@icecore/airi-runtime/media-api";
import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import {
  ElevenLabsSttWebhookPayloadError,
  isElevenLabsSttWebhookConfigured,
  parseElevenLabsSttWebhookPayload,
  type NormalizedElevenLabsSttWebhookEvent,
  verifyElevenLabsWebhookSignature,
} from "@icecore/airi-runtime/elevenlabs-stt-webhook";
import {
  CONVERSATION_MEDIA_TRANSCRIPTION_COMPLETED_SIGNAL,
  ELEVENLABS_CREATIVE_TRANSCRIPTION_COMPLETED_SIGNAL,
  buildElevenLabsCreativeTranscriptionWorkflowId,
} from "@icecore/temporal";
import type { TemporalWorkerConfig } from "./config.js";
import { getTemporalWorkerConfig } from "./config.js";
import {
  authorizeVercelOidcRequest,
  createVercelOidcAuthConfig,
  getHeaderString,
  HttpRequestBodyTooLargeError,
  getOidcErrorStatus,
  parseEnabledFlag,
  readJsonBody,
  readRawBody,
  type VercelOidcAuthConfig,
  writeJson,
} from "./http-service.js";
import { loadTemporalWorkerEnv } from "./load-env.js";
import {
  createGcsCreativeAssetReadUrl,
  createGcsCreativeAssetUpload,
  deleteGcsCreativeAssetObject,
  statGcsCreativeAssetObject,
} from "./gcs-creative-assets.js";
import { getTemporalClient } from "./temporal-client.js";
import { StorageQuotaError } from "@icecore/airi-runtime/storage-quota";

const DEFAULT_PORT = 8080;
const ELEVENLABS_STT_WEBHOOK_PATH = "/webhooks/elevenlabs/speech-to-text";
const MAX_ELEVENLABS_WEBHOOK_BODY_BYTES = 2 * 1024 * 1024;

type TemporalSignalClient = {
  workflow: {
    getHandle: (workflowId: string) => {
      signal: (signalName: string, ...args: unknown[]) => Promise<unknown>;
      describe?: () => Promise<{ status?: { name?: string } }>;
      result?: () => Promise<unknown>;
    };
  };
};

async function signalTemporalWorkflowIdempotently(params: {
  handle: ReturnType<TemporalSignalClient["workflow"]["getHandle"]>;
  signalName: string;
  event: unknown;
}): Promise<void> {
  try {
    await params.handle.signal(params.signalName, params.event);
  } catch (error) {
    if (!params.handle.describe) throw error;

    let statusName = "";
    try {
      const description = await params.handle.describe();
      statusName = String(description.status?.name || "").toUpperCase();
    } catch {
      throw error;
    }
    if (statusName !== "COMPLETED" || !params.handle.result) throw error;

    try {
      const result = await params.handle.result();
      const status =
        result && typeof result === "object" && "status" in result
          ? String((result as { status?: unknown }).status || "").toLowerCase()
          : "";
      if (status === "completed" || status === "complete") return;
    } catch {
      throw error;
    }
    throw error;
  }
}

function getMediaApiAuthConfig(): VercelOidcAuthConfig {
  return createVercelOidcAuthConfig({
    authDisabled: parseEnabledFlag(process.env.MEDIA_API_DISABLE_AUTH, false),
    serviceName: "Media API",
  });
}

async function handleInitiateUpload(
  request: MediaApiInitiateUploadRequest,
): Promise<MediaApiInitiateUploadResponse> {
  const upload = await createGcsCreativeAssetUpload(request);
  return {
    provider: "gcs",
    method: "PUT",
    ...upload,
  };
}

async function handleObjectStat(
  request: MediaApiObjectStatRequest,
): Promise<MediaApiObjectStatResponse> {
  const stat = await statGcsCreativeAssetObject(request);
  return {
    provider: "gcs",
    bucket: request.bucket,
    path: request.path,
    ...stat,
  };
}

async function handleObjectReadUrl(
  request: MediaApiObjectReadUrlRequest,
): Promise<MediaApiObjectReadUrlResponse> {
  const result = await createGcsCreativeAssetReadUrl(request);
  return {
    provider: "gcs",
    bucket: request.bucket,
    path: request.path,
    ...result,
  };
}

async function handleObjectDelete(
  request: MediaApiObjectDeleteRequest,
): Promise<MediaApiObjectDeleteResponse> {
  const result = await deleteGcsCreativeAssetObject(request);
  return {
    provider: "gcs",
    bucket: request.bucket,
    path: request.path,
    ...result,
  };
}

export async function signalElevenLabsSttWebhookEvent(
  client: TemporalSignalClient,
  normalized: NormalizedElevenLabsSttWebhookEvent,
): Promise<void> {
  if (normalized.kind === "creative_asset") {
    const workflowId = buildElevenLabsCreativeTranscriptionWorkflowId({
      assetId: normalized.assetId,
    });
    await signalTemporalWorkflowIdempotently({
      handle: client.workflow.getHandle(workflowId),
      signalName: ELEVENLABS_CREATIVE_TRANSCRIPTION_COMPLETED_SIGNAL,
      event: normalized.event,
    });
    return;
  }

  await signalTemporalWorkflowIdempotently({
    handle: client.workflow.getHandle(normalized.workflowId),
    signalName: CONVERSATION_MEDIA_TRANSCRIPTION_COMPLETED_SIGNAL,
    event: normalized.event,
  });
}

async function handleElevenLabsSttWebhook(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  temporalConfig: TemporalWorkerConfig,
): Promise<void> {
  const startedAt = Date.now();
  const logContext: Record<string, unknown> = {
    method: request.method || "POST",
    path: ELEVENLABS_STT_WEBHOOK_PATH,
    outcome: "rejected",
    statusCode: 500,
  };
  const finish = (params: {
    statusCode: number;
    payload: Record<string, unknown>;
    outcome: "accepted" | "rejected" | "error";
    reason?: string;
    error?: unknown;
  }) => {
    const context = {
      ...logContext,
      outcome: params.outcome,
      statusCode: params.statusCode,
      reason: params.reason || null,
      durationMs: Date.now() - startedAt,
    };
    if (params.error) {
      airiWorkerLogger.error(
        "airi.worker.elevenlabs_stt_webhook",
        params.error,
        context,
      );
    } else if (params.statusCode >= 400) {
      airiWorkerLogger.warn("airi.worker.elevenlabs_stt_webhook", context);
    } else {
      airiWorkerLogger.info("airi.worker.elevenlabs_stt_webhook", context);
    }
    writeJson(response, params.statusCode, params.payload);
  };

  if (!isElevenLabsSttWebhookConfigured()) {
    finish({
      statusCode: 503,
      outcome: "error",
      reason: "not_configured",
      payload: { error: "ElevenLabs STT webhook is not configured" },
    });
    return;
  }

  let rawBody: string;
  try {
    rawBody = await readRawBody(request, {
      maxBytes: MAX_ELEVENLABS_WEBHOOK_BODY_BYTES,
    });
  } catch (error) {
    const bodyTooLarge = error instanceof HttpRequestBodyTooLargeError;
    finish({
      statusCode: bodyTooLarge ? 413 : 400,
      outcome: "rejected",
      reason: bodyTooLarge ? "body_too_large" : "body_read_failed",
      payload: {
        error: error instanceof Error ? error.message : "Invalid body",
      },
    });
    return;
  }
  logContext.bodyBytes = Buffer.byteLength(rawBody, "utf8");

  if (
    !verifyElevenLabsWebhookSignature({
      rawBody,
      signatureHeader: getHeaderString(request, "elevenlabs-signature"),
    })
  ) {
    finish({
      statusCode: 401,
      outcome: "rejected",
      reason: "invalid_signature",
      payload: { error: "Invalid signature" },
    });
    return;
  }
  logContext.signatureVerified = true;

  let normalized: ReturnType<typeof parseElevenLabsSttWebhookPayload>;
  try {
    normalized = parseElevenLabsSttWebhookPayload(JSON.parse(rawBody));
  } catch (error) {
    const message =
      error instanceof SyntaxError
        ? "Invalid JSON body"
        : error instanceof ElevenLabsSttWebhookPayloadError
          ? error.message
          : "Invalid ElevenLabs STT webhook payload";
    finish({
      statusCode: 400,
      outcome: "rejected",
      reason: "invalid_payload",
      payload: { error: message },
    });
    return;
  }

  logContext.kind = normalized.kind;
  logContext.providerRequestId = normalized.event.requestId;
  logContext.transcriptionStatus = normalized.event.status;
  if (normalized.kind === "creative_asset") {
    logContext.assetId = normalized.assetId;
  } else {
    logContext.workflowId = normalized.workflowId;
  }

  try {
    const client = await getTemporalClient(temporalConfig);
    await signalElevenLabsSttWebhookEvent(
      client as unknown as TemporalSignalClient,
      normalized,
    );
  } catch (error) {
    finish({
      statusCode: 503,
      outcome: "error",
      reason: "temporal_signal_failed",
      error,
      payload: { error: "Failed to signal transcription workflow" },
    });
    return;
  }

  finish({
    statusCode: 200,
    outcome: "accepted",
    payload: { status: "ok" },
  });
}

async function routeMediaApiRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  authConfig: VercelOidcAuthConfig,
  temporalConfig: TemporalWorkerConfig,
): Promise<void> {
  const method = request.method || "GET";
  const url = new URL(request.url || "/", "http://127.0.0.1");

  if (
    method === "GET" &&
    (url.pathname === MEDIA_API_PATHS.health ||
      url.pathname === MEDIA_API_PATHS.legacyHealth)
  ) {
    writeJson(response, 200, { ok: true });
    return;
  }

  if (url.pathname === ELEVENLABS_STT_WEBHOOK_PATH) {
    if (method !== "POST") {
      writeJson(response, 405, { error: "Method not allowed" });
      return;
    }
    await handleElevenLabsSttWebhook(request, response, temporalConfig);
    return;
  }

  if (method !== "POST") {
    writeJson(response, 405, { error: "Method not allowed" });
    return;
  }

  await authorizeVercelOidcRequest(request, authConfig);

  if (url.pathname === MEDIA_API_PATHS.initiateUpload) {
    writeJson(
      response,
      200,
      await handleInitiateUpload(
        await readJsonBody<MediaApiInitiateUploadRequest>(request),
      ),
    );
    return;
  }

  if (url.pathname === MEDIA_API_PATHS.objectStat) {
    writeJson(
      response,
      200,
      await handleObjectStat(
        await readJsonBody<MediaApiObjectStatRequest>(request),
      ),
    );
    return;
  }

  if (url.pathname === MEDIA_API_PATHS.objectReadUrl) {
    writeJson(
      response,
      200,
      await handleObjectReadUrl(
        await readJsonBody<MediaApiObjectReadUrlRequest>(request),
      ),
    );
    return;
  }

  if (url.pathname === MEDIA_API_PATHS.objectDelete) {
    writeJson(
      response,
      200,
      await handleObjectDelete(
        await readJsonBody<MediaApiObjectDeleteRequest>(request),
      ),
    );
    return;
  }

  writeJson(response, 404, { error: "Not found" });
}

export async function runMediaApiServer(): Promise<void> {
  const loadedEnvFiles = loadTemporalWorkerEnv();
  const port = Math.max(1, Number(process.env.PORT || DEFAULT_PORT));
  const authConfig = getMediaApiAuthConfig();
  const temporalConfig = getTemporalWorkerConfig();

  const server = http.createServer((request, response) => {
    routeMediaApiRequest(request, response, authConfig, temporalConfig).catch(
      (error) => {
        const url = new URL(request.url || "/", "http://127.0.0.1");
        const statusCode = error instanceof StorageQuotaError ? error.status : getOidcErrorStatus(error);
        airiWorkerLogger.warn("airi.worker.media_api_request_failed", {
          path: url.pathname,
          method: request.method || "GET",
          statusCode,
          error: error instanceof Error ? error.message : String(error),
        });
        writeJson(response, statusCode, {
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof StorageQuotaError ? { code: error.code } : {}),
        });
      },
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve());
  });

  airiWorkerLogger.info("airi.worker.media_api", {
    port,
    note: "started",
    authDisabled: authConfig.authDisabled,
    issuerUrl: authConfig.issuerUrl,
    audience: authConfig.audience,
    allowedSubjects: authConfig.allowedSubjects,
    elevenLabsSttWebhookPath: ELEVENLABS_STT_WEBHOOK_PATH,
    loadedEnvFiles,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMediaApiServer().catch((error) => {
    airiWorkerLogger.error("airi.worker.media_api", error, {
      note: "start_failed",
    });
    process.exit(1);
  });
}
