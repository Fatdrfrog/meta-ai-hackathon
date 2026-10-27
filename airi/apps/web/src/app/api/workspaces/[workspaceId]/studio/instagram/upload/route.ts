import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import {
  BUSINESS_MEDIA_BUCKET,
  ensureBusinessMediaBucket,
} from "@/lib/media/business-media-bucket";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  storeSupabaseWorkspaceBuffer,
  StorageQuotaError,
} from "@icecore/airi-runtime/storage-quota";
import { createClient } from "@/lib/supabase/server";
import { isWorkspaceFeatureEnabled } from "@/lib/workspace-feature-flags";
import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { sanitizeStorageFilename } from "@icecore/shared/lib/storage-filename";

type Params = Promise<{ workspaceId: string }>;

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_VIDEO_SIZE = 100 * 1024 * 1024; // 100MB (Instagram Reels limit ~4GB, we cap for upload UX)

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const ALLOWED_VIDEO_TYPES = new Set([
  "video/mp4",
  "video/quicktime", // MOV
  "video/webm",
]);

function isImage(mimeType: string): boolean {
  return ALLOWED_IMAGE_TYPES.has(mimeType);
}

function isVideo(mimeType: string): boolean {
  return ALLOWED_VIDEO_TYPES.has(mimeType);
}

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Params }
) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { workspaceId } = await params;
    const hasAccess = await verifyWorkspaceAccess(
      supabase,
      user.id,
      workspaceId
    );
    if (!hasAccess) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const studioEnabled = await isWorkspaceFeatureEnabled(
      workspaceId,
      "instagram_studio"
    );
    if (!studioEnabled) {
      return NextResponse.json(
        { error: "Instagram Studio is disabled for this workspace" },
        { status: 403 }
      );
    }

    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    if (file.size <= 0) {
      return NextResponse.json({ error: "Empty file" }, { status: 400 });
    }

    const mimeType = file.type || "application/octet-stream";

    if (!isImage(mimeType) && !isVideo(mimeType)) {
      return NextResponse.json(
        {
          error:
            "Unsupported file type. Allowed: JPG, PNG, WebP, GIF (images); MP4, MOV, WebM (videos/reels)",
        },
        { status: 400 }
      );
    }

    const maxSize = isVideo(mimeType) ? MAX_VIDEO_SIZE : MAX_IMAGE_SIZE;
    if (file.size > maxSize) {
      const limitMB = Math.round(maxSize / (1024 * 1024));
      return NextResponse.json(
        { error: `File is too large. Maximum size is ${limitMB}MB` },
        { status: 400 }
      );
    }

    const safeName = sanitizeStorageFilename(
      file.name || "media",
      `media-${Date.now()}.bin`
    );
    const random = crypto.randomBytes(8).toString("hex");
    const storagePath = `studio/instagram/${workspaceId}/${Date.now()}-${random}-${safeName}`;

    await ensureBusinessMediaBucket(
      supabaseAdmin.storage,
      BUSINESS_MEDIA_BUCKET
    );
    const buffer = Buffer.from(await file.arrayBuffer());
    await storeSupabaseWorkspaceBuffer({
      storage: supabaseAdmin.storage,
      workspaceId,
      bucket: BUSINESS_MEDIA_BUCKET,
      path: storagePath,
      buffer,
      mimeType,
    });

    const {
      data: { publicUrl },
    } = supabaseAdmin.storage
      .from(BUSINESS_MEDIA_BUCKET)
      .getPublicUrl(storagePath);

    return NextResponse.json({
      success: true,
      url: publicUrl,
      mediaType: isVideo(mimeType) ? ("video" as const) : ("image" as const),
      mimeType,
      fileName: file.name || safeName,
      fileSize: file.size,
    });
  } catch (error) {
    if (error instanceof StorageQuotaError)
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status }
      );
    const message =
      error instanceof Error ? error.message : "Failed to upload media";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
