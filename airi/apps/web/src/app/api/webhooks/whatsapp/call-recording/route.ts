import connectDB from "@/lib/mongoose";
import { createServerLogger } from "@/lib/observability/server-logs";
import { verifySourceWebhookSecret } from "@/lib/webhook-auth";
import WhatsAppCallRecording from "@/models/whatsapp-call-recording";
import { NextResponse } from "next/server";
import { readNonEmptyString } from "@icecore/shared/lib/value-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const recordingWebhookLogger = createServerLogger(
  "whatsapp.call_recording.webhook"
);

type CallRecordingWebhookPayload = {
  workspaceId?: unknown;
  callSessionId?: unknown;
  callId?: unknown;
  idempotencyKey?: unknown;
  status?: unknown;
  recordingObjectPath?: unknown;
  transcriptTextPath?: unknown;
  transcriptionRequestId?: unknown;
  errorMessage?: unknown;
  completedAt?: unknown;
};

const cleanString = (value: unknown, maxLength = 2048) =>
  readNonEmptyString(value, { trim: true, maxLength });

function parseStatus(value: unknown): "processing" | "completed" | "failed" {
  const status = cleanString(value, 64);
  if (
    status === "processing" ||
    status === "completed" ||
    status === "failed"
  ) {
    return status;
  }
  throw new Error("Invalid transcript status");
}

function parseCompletedAt(value: unknown): Date {
  const dateText = cleanString(value, 128);
  if (!dateText) return new Date();
  const date = new Date(dateText);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid completedAt timestamp");
  }
  return date;
}

function normalizePayload(payload: CallRecordingWebhookPayload) {
  const workspaceId = cleanString(payload.workspaceId, 256);
  const callSessionId = cleanString(payload.callSessionId, 256);
  const callId = cleanString(payload.callId, 256);
  if (!workspaceId || !callSessionId || !callId) {
    throw new Error("workspaceId, callSessionId, and callId are required");
  }

  const status = parseStatus(payload.status);
  return {
    workspaceId,
    callSessionId,
    callId,
    idempotencyKey: cleanString(payload.idempotencyKey, 256),
    status,
    recordingObjectPath: cleanString(payload.recordingObjectPath, 2048),
    transcriptTextPath: cleanString(payload.transcriptTextPath, 2048),
    transcriptionRequestId: cleanString(payload.transcriptionRequestId, 512),
    errorMessage:
      status === "failed" ? cleanString(payload.errorMessage, 2048) : null,
    completedAt: parseCompletedAt(payload.completedAt),
  };
}

export async function POST(request: Request) {
  const expectedSecret = (
    process.env.WHATSAPP_CALL_RECORDING_WEBHOOK_SECRET || ""
  ).trim();
  if (!expectedSecret) {
    return NextResponse.json(
      { ok: false, error: "Call recording webhook is not configured" },
      { status: 503 }
    );
  }

  if (!verifySourceWebhookSecret(request, expectedSecret)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  let payload: CallRecordingWebhookPayload;
  try {
    payload = (await request.json()) as CallRecordingWebhookPayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON payload" },
      { status: 400 }
    );
  }

  let normalized: ReturnType<typeof normalizePayload>;
  try {
    normalized = normalizePayload(payload);
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Invalid payload",
      },
      { status: 400 }
    );
  }

  const filter: Record<string, unknown> = {
    workspaceId: normalized.workspaceId,
    callSessionId: normalized.callSessionId,
    callId: normalized.callId,
  };
  if (normalized.idempotencyKey) {
    filter.bigQueryExportRowId = normalized.idempotencyKey;
  }

  const patch: Record<string, unknown> = {
    transcriptStatus: normalized.status,
    transcriptionLastError: normalized.errorMessage,
    transcriptCompletedAt: normalized.completedAt,
  };
  if (normalized.recordingObjectPath) {
    patch.recordingObjectPath = normalized.recordingObjectPath;
  }
  if (normalized.transcriptTextPath) {
    patch.transcriptTextPath = normalized.transcriptTextPath;
  }
  if (normalized.transcriptionRequestId) {
    patch.transcriptionRequestId = normalized.transcriptionRequestId;
  }

  try {
    await connectDB();
    const result = await WhatsAppCallRecording.updateOne(filter, {
      $set: patch,
    }).exec();
    if (!result.matchedCount) {
      return NextResponse.json(
        { ok: false, error: "Call recording not found" },
        { status: 404 }
      );
    }
  } catch (error) {
    recordingWebhookLogger.error(
      "Failed to update WhatsApp call recording from connector callback",
      error,
      {
        workspaceId: normalized.workspaceId,
        callSessionId: normalized.callSessionId,
        callId: normalized.callId,
      }
    );
    return NextResponse.json(
      { ok: false, error: "Failed to update call recording" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    matched: true,
    transcriptStatus: normalized.status,
  });
}
