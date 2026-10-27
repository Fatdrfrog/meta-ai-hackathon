import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { CONVERSATION_IMAGES_BUCKET_NAME } from "@/lib/storage-buckets";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  InvalidJsonBodyError,
  JsonBodyTooLargeError,
  readBodyBytesWithinLimit,
  readJsonBodyWithinLimit,
} from "@/lib/api/json-body";
import { handleCorsOptions, jsonWithCors } from "@/lib/widget/cors";
import { resolveAuthorizedWidgetSource } from "@/lib/widget/source-context";
import {
  generateWidgetUploadToken,
  verifyVisitorToken,
  verifyWidgetUploadToken,
} from "@/lib/widget/visitor-auth";
import {
  checkCriticalRateLimit,
  createRateLimiter,
} from "@icecore/shared/lib/rate-limiter";
import {
  readStorageObject,
  reserveWorkspaceStorage,
  settleStorageObject,
  storeSupabaseWorkspaceBuffer,
  StorageQuotaError,
} from "@icecore/airi-runtime/storage-quota";

const BUCKET = CONVERSATION_IMAGES_BUCKET_NAME;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const AUDIO_TYPES = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
]);
const companyLimiter = createRateLimiter({
  requests: 60,
  window: "1 m",
  prefix: "widget:upload:company",
  analytics: false,
});
const visitorLimiter = createRateLimiter({
  requests: 10,
  window: "1 m",
  prefix: "widget:upload:visitor",
  analytics: false,
});

export const runtime = "nodejs";
export async function OPTIONS(req: NextRequest) {
  return handleCorsOptions(req);
}

function mediaType(mimeType: string): "image" | "audio" | null {
  return IMAGE_TYPES.has(mimeType)
    ? "image"
    : AUDIO_TYPES.has(mimeType)
      ? "audio"
      : null;
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const fail = (error: string, status: number, code?: string) =>
    jsonWithCors({ error, code }, { status, origin });
  try {
    const clientKey = req.headers.get("x-client-key") || "";
    if (clientKey.length < 10) return fail("Invalid client key", 401);
    const authorization = await resolveAuthorizedWidgetSource({
      request: req,
      clientKey,
    });
    if (!authorization.ok)
      return fail(authorization.error, authorization.status);
    const { source } = authorization;
    const admission = await checkCriticalRateLimit(
      companyLimiter,
      source.company_id
    );
    if (admission.status === "unavailable")
      return fail(
        "Uploads are temporarily unavailable. Please retry later.",
        503,
        "widget_upload_admission_unavailable"
      );
    if (admission.status === "limited")
      return fail(
        "Too many uploads. Please retry later.",
        429,
        "widget_upload_rate_limited"
      );

    if (req.headers.get("content-type")?.includes("application/json")) {
      const body = (await readJsonBodyWithinLimit(req, 8 * 1024)) as Record<
        string,
        unknown
      >;
      if (body.action !== "initiate") return fail("Invalid upload action", 400);
      const mimeType =
        typeof body.mimeType === "string"
          ? body.mimeType.split(";")[0].trim().toLowerCase()
          : "";
      const kind = mediaType(mimeType);
      const bytes = body.fileSize;
      if (
        !kind ||
        typeof bytes !== "number" ||
        !Number.isSafeInteger(bytes) ||
        bytes <= 0 ||
        bytes > (kind === "audio" ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES)
      ) {
        return fail(
          "Invalid upload type or size. Images allow 5 MiB and audio allows 20 MiB.",
          400
        );
      }
      const visitorToken = req.headers.get("x-visitor-token");
      const visitor = visitorToken
        ? await verifyVisitorToken(visitorToken)
        : null;
      if (
        visitorToken &&
        (!visitor ||
          visitor.workspaceId !== source.workspace_id ||
          visitor.sourceId !== source.id)
      )
        return fail("Invalid visitor session", 403);
      const visitorId = visitor?.visitorId || randomUUID();
      const visitorAdmission = await checkCriticalRateLimit(
        visitorLimiter,
        `${source.id}:${visitorId}`
      );
      if (visitorAdmission.status !== "granted")
        return fail(
          "Uploads are temporarily limited. Please retry later.",
          visitorAdmission.status === "limited" ? 429 : 503
        );
      const fileName =
        typeof body.fileName === "string"
          ? body.fileName.slice(0, 200)
          : "attachment";
      const uploadId =
        typeof body.uploadId === "string" &&
        /^[a-f0-9-]{36}$/i.test(body.uploadId)
          ? body.uploadId
          : randomUUID();
      const path = `web_widget/${source.workspace_id}/${source.id}/${uploadId}`;
      const reservation = await reserveWorkspaceStorage({
        workspaceId: source.workspace_id,
        provider: "supabase",
        bucket: BUCKET,
        path,
        bytes,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      });
      const uploadToken = await generateWidgetUploadToken({
        visitorId,
        workspaceId: source.workspace_id,
        companyId: source.company_id,
        sourceId: source.id,
        reservationId: reservation._id,
        path,
        bytes,
        mimeType,
        fileName: fileName || "attachment",
      });
      return jsonWithCors({ success: true, uploadToken }, { origin });
    }

    const bytes = await readBodyBytesWithinLimit(
      req,
      MAX_AUDIO_BYTES + 64 * 1024
    );
    const form = await new Request(req.url, {
      method: "POST",
      headers: { "content-type": req.headers.get("content-type") || "" },
      body: Uint8Array.from(bytes).buffer,
    }).formData();
    const token = form.get("uploadToken");
    if (typeof token !== "string" || !token)
      return fail(
        "Refresh this page before uploading a file.",
        409,
        "widget_upload_client_outdated"
      );
    const ticket = await verifyWidgetUploadToken(token);
    if (
      !ticket ||
      ticket.sourceId !== source.id ||
      ticket.workspaceId !== source.workspace_id ||
      ticket.companyId !== source.company_id
    )
      return fail("Invalid upload session", 403);
    const file = form.get("file");
    if (!(file instanceof File)) return fail("No file provided", 400);
    const buffer = Buffer.from(await file.arrayBuffer());
    if (
      buffer.byteLength !== ticket.bytes ||
      file.type.split(";")[0].trim().toLowerCase() !== ticket.mimeType ||
      !mediaType(ticket.mimeType)
    )
      return fail("File does not match the upload session", 400);
    const reservation = await readStorageObject(ticket.reservationId);
    if (
      !reservation ||
      reservation.workspaceId !== ticket.workspaceId ||
      reservation.companyId !== ticket.companyId ||
      reservation.path !== ticket.path ||
      reservation.bucket !== BUCKET ||
      reservation.provider !== "supabase" ||
      reservation.status === "tombstoned" ||
      reservation.bytes !== ticket.bytes
    )
      return fail("Upload reservation was not found", 409);
    const storage = supabaseAdmin.storage.from(BUCKET);
    try {
      await storeSupabaseWorkspaceBuffer({
        storage: supabaseAdmin.storage,
        workspaceId: ticket.workspaceId,
        bucket: BUCKET,
        path: ticket.path,
        buffer,
        mimeType: ticket.mimeType,
        quota: {
          reserve: async () => reservation,
          settle: settleStorageObject,
        },
      });
    } catch {
      return fail(
        "Upload could not be confirmed. Please retry this upload.",
        503,
        "widget_upload_outcome_unknown"
      );
    }
    const {
      data: { publicUrl },
    } = storage.getPublicUrl(ticket.path);
    return jsonWithCors(
      {
        success: true,
        url: publicUrl,
        mediaType: mediaType(ticket.mimeType),
        mimeType: ticket.mimeType,
        fileName: ticket.fileName,
        fileSize: ticket.bytes,
        size: ticket.bytes,
        type: ticket.mimeType,
      },
      { origin }
    );
  } catch (error) {
    if (error instanceof StorageQuotaError)
      return fail(error.message, error.status, error.code);
    if (error instanceof JsonBodyTooLargeError)
      return fail("Upload body is too large", 413);
    if (error instanceof InvalidJsonBodyError)
      return fail("Invalid upload body", 400);
    console.error("[Widget Upload] Upload failed", error);
    return fail("Upload is temporarily unavailable", 503);
  }
}
