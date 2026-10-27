import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import {
  completeScenarioAssetUpload,
  initiateScenarioAssetUpload,
  storeScenarioAssetBuffer,
  type ScenarioAssetUploadResult,
} from "@/lib/scenarios/scenario-asset-storage";
import {
  ScenarioAssetUploadError,
  validateScenarioAssetUploadMetadata,
} from "@/lib/scenarios/scenario-asset-upload-validation";
import {
  InvalidJsonBodyError,
  JsonBodyTooLargeError,
  readJsonBodyWithinLimit,
} from "@/lib/api/json-body";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

type Params = Promise<{ workspaceId: string }>;

const UPLOAD_CHANNEL_SCHEMA = z.enum(["whatsapp"]).optional();
const DIRECT_UPLOAD_BODY_SCHEMA = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("initiate"),
      channel: UPLOAD_CHANNEL_SCHEMA,
      fileName: z.string().min(1).max(512),
      mimeType: z.string().max(256),
      fileSize: z.number().int().positive().safe(),
    })
    .strict(),
  z
    .object({
      action: z.literal("complete"),
      uploadToken: z.string().min(1).max(16_384),
    })
    .strict(),
]);
const MAX_DIRECT_UPLOAD_BODY_BYTES = 24 * 1024;

function uploadedImageResponse(stored: ScenarioAssetUploadResult) {
  return NextResponse.json({
    success: true,
    image: {
      // Signed HTTPS previews expire; bucket/path and gcs:// survive scenario saves.
      url: stored.displayUrl,
      durableUrl: stored.url,
      bucket: stored.bucket,
      path: stored.path,
      mediaType: stored.mediaType,
      mimeType: stored.mimeType,
      fileSize: stored.fileSize,
      fileName: stored.fileName,
    },
  });
}

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Params }
) {
  try {
    const { workspaceId } = await params;
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) {
      return access.response;
    }

    if (
      request.headers
        .get("content-type")
        ?.toLowerCase()
        .includes("application/json")
    ) {
      const parsed = DIRECT_UPLOAD_BODY_SCHEMA.safeParse(
        await readJsonBodyWithinLimit(request, MAX_DIRECT_UPLOAD_BODY_BYTES)
      );
      if (!parsed.success) {
        return NextResponse.json(
          {
            error: "Invalid upload metadata",
            code: "scenario_asset_upload_rejected",
          },
          { status: 400 }
        );
      }
      if (parsed.data.action === "initiate") {
        const upload = await initiateScenarioAssetUpload({
          fileName: parsed.data.fileName,
          mimeType: parsed.data.mimeType,
          fileSize: parsed.data.fileSize,
          channel: parsed.data.channel,
          workspaceId,
          origin: request.headers.get("origin"),
        });
        return NextResponse.json({ success: true, upload });
      }
      const stored = await completeScenarioAssetUpload({
        workspaceId,
        uploadToken: parsed.data.uploadToken,
      });
      return uploadedImageResponse(stored);
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const channelResult = UPLOAD_CHANNEL_SCHEMA.safeParse(
      formData.get("channel") || undefined
    );
    if (!channelResult.success) {
      return NextResponse.json(
        { error: "Unsupported upload channel" },
        { status: 400 }
      );
    }
    const uploadChannel = channelResult.data;

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    if (file.size <= 0) {
      return NextResponse.json({ error: "Empty file" }, { status: 400 });
    }

    let metadata;
    try {
      metadata = validateScenarioAssetUploadMetadata({
        fileName: file.name || "scenario-asset",
        mimeType: file.type,
        fileSize: file.size,
        channel: uploadChannel,
      });
    } catch (error) {
      if (error instanceof ScenarioAssetUploadError) {
        // Legacy multipart consumers keep their validation HTTP status.
        return NextResponse.json(
          { error: error.message, code: error.code },
          { status: 400 }
        );
      }
      throw error;
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const stored = await storeScenarioAssetBuffer({
      workspaceId,
      buffer,
      mimeType: metadata.mimeType,
      fileName: metadata.fileName,
    });

    return uploadedImageResponse({ ...stored, ...metadata });
  } catch (error) {
    if (error instanceof ScenarioAssetUploadError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status }
      );
    }
    if (
      error instanceof InvalidJsonBodyError ||
      error instanceof JsonBodyTooLargeError
    ) {
      const tooLarge = error instanceof JsonBodyTooLargeError;
      return NextResponse.json(
        {
          error: "Invalid upload metadata",
          code: tooLarge
            ? "scenario_asset_upload_too_large"
            : "scenario_asset_upload_rejected",
        },
        { status: tooLarge ? 413 : 400 }
      );
    }
    const message =
      error instanceof Error ? error.message : "Failed to upload file";
    return NextResponse.json(
      { error: message, code: "scenario_asset_upload_unavailable" },
      { status: 500 }
    );
  }
}
