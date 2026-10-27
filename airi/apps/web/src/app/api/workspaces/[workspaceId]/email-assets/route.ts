import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  storeSupabaseWorkspaceBuffer,
  StorageQuotaError,
} from "@icecore/airi-runtime/storage-quota";
import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { sanitizeStorageFilename } from "@icecore/shared/lib/storage-filename";

type Params = Promise<{ workspaceId: string }>;

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const BUCKET_NAME = "email-campaign-assets";
const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;
const ALLOWED_TYPES = new Set<string>(ALLOWED_MIME_TYPES);
const MIME_TYPE_BY_EXTENSION = new Map<string, string>([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

function inferMimeTypeFromFilename(filename: string): string {
  const normalized = filename.trim().toLowerCase();
  for (const [extension, mimeType] of MIME_TYPE_BY_EXTENSION) {
    if (normalized.endsWith(extension)) return mimeType;
  }
  return "";
}

function resolveUploadMimeType(file: File): string {
  const provided = file.type.split(";")[0]?.trim().toLowerCase() || "";
  const inferred = inferMimeTypeFromFilename(file.name || "");
  if (provided && ALLOWED_TYPES.has(provided)) return provided;
  if (inferred && ALLOWED_TYPES.has(inferred)) return inferred;
  return provided || inferred;
}

function bucketAllowsEmailAssetTypes(bucket: {
  allowed_mime_types?: string[] | null;
}) {
  if (!Array.isArray(bucket.allowed_mime_types)) return true;
  const allowed = new Set(
    bucket.allowed_mime_types.map(type => String(type || "").toLowerCase())
  );
  return ALLOWED_MIME_TYPES.every(
    mimeType =>
      allowed.has(mimeType) ||
      (mimeType.startsWith("image/") && allowed.has("image/*"))
  );
}

async function ensureEmailAssetsBucket() {
  const { data, error } = await supabaseAdmin.storage.getBucket(BUCKET_NAME);
  if (data && !error) {
    const needsUpdate =
      data.public !== true || !bucketAllowsEmailAssetTypes(data);

    if (!needsUpdate) return;

    const { error: updateError } = await supabaseAdmin.storage.updateBucket(
      BUCKET_NAME,
      {
        public: true,
        fileSizeLimit: MAX_FILE_SIZE,
        allowedMimeTypes: [...ALLOWED_MIME_TYPES],
      }
    );

    if (updateError) {
      throw new Error(
        `Failed to prepare email asset storage: ${updateError.message}`
      );
    }
    return;
  }

  const { error: createError } = await supabaseAdmin.storage.createBucket(
    BUCKET_NAME,
    {
      public: true,
      fileSizeLimit: MAX_FILE_SIZE,
      allowedMimeTypes: [...ALLOWED_MIME_TYPES],
    }
  );

  if (createError && !/already exists/i.test(createError.message)) {
    throw new Error(
      `Failed to prepare email asset storage: ${createError.message}`
    );
  }
}

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Params }
) {
  try {
    const { workspaceId } = await params;
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;

    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }
    if (file.size <= 0) {
      return NextResponse.json({ error: "Empty file" }, { status: 400 });
    }
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: "File is too large. Maximum size is 10MB" },
        { status: 400 }
      );
    }

    const mimeType = resolveUploadMimeType(file);
    if (!ALLOWED_TYPES.has(mimeType)) {
      return NextResponse.json(
        {
          error:
            "Unsupported file type. Only JPEG, PNG, GIF, and WebP images are allowed.",
        },
        { status: 400 }
      );
    }

    const safeName = sanitizeStorageFilename(
      file.name || "email-image",
      `image-${Date.now()}`
    );
    const random = crypto.randomBytes(8).toString("hex");
    const storagePath = `workspaces/${workspaceId}/email-assets/${Date.now()}-${random}-${safeName}`;

    await ensureEmailAssetsBucket();

    const buffer = Buffer.from(await file.arrayBuffer());
    await storeSupabaseWorkspaceBuffer({
      storage: supabaseAdmin.storage,
      workspaceId,
      bucket: BUCKET_NAME,
      path: storagePath,
      buffer,
      mimeType,
    });

    const {
      data: { publicUrl },
    } = supabaseAdmin.storage.from(BUCKET_NAME).getPublicUrl(storagePath);

    return NextResponse.json({
      success: true,
      image: {
        url: publicUrl,
        bucket: BUCKET_NAME,
        path: storagePath,
        mimeType,
        fileSize: file.size,
        fileName: file.name || safeName,
        safeName,
      },
    });
  } catch (error) {
    if (error instanceof StorageQuotaError)
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status }
      );
    const message =
      error instanceof Error ? error.message : "Failed to upload image";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
