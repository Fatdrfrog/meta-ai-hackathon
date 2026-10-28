import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import { ensureBusinessMediaBucket } from "@/lib/media/business-media-bucket";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  createReservedSupabaseUpload,
  StorageQuotaError,
} from "@icecore/airi-runtime/storage-quota";
import { createClient } from "@/lib/supabase/server";
import {
  getWhatsAppOfficialMediaMaxBytes,
  getWhatsAppOfficialMediaType,
  resolveWhatsAppUploadMimeType,
  type WhatsAppTemplateHeaderMediaFormat,
} from "@/lib/whatsapp/media-types";
import { getWhatsAppTemplateHeaderMediaValidationIssue } from "@/lib/whatsapp/templates/header-media-constraints";
import {
  createWhatsAppTemplateHeaderMediaPath,
  getWhatsAppTemplateHeaderMediaBucket,
  storeWhatsAppTemplateHeaderMedia,
} from "@/lib/whatsapp/templates/header-media-storage";
import { NextRequest, NextResponse } from "next/server";
import { sanitizeStorageFilename } from "@icecore/shared/lib/storage-filename";

type Params = Promise<{ workspaceId: string }>;
type HeaderFormat = WhatsAppTemplateHeaderMediaFormat;
type DirectUploadInitPayload = {
  mode?: "direct";
  fileName?: string;
  fileSize?: number;
  format?: string;
  mimeType?: string;
};

const MAX_BYTES_BY_FORMAT: Record<HeaderFormat, number> = {
  IMAGE: getWhatsAppOfficialMediaMaxBytes("image"),
  VIDEO: getWhatsAppOfficialMediaMaxBytes("video"),
  DOCUMENT: getWhatsAppOfficialMediaMaxBytes("document"),
};
const MEDIA_TYPE_BY_FORMAT: Record<
  HeaderFormat,
  "image" | "video" | "document"
> = {
  IMAGE: "image",
  VIDEO: "video",
  DOCUMENT: "document",
};

function parseHeaderFormat(
  value: FormDataEntryValue | null
): HeaderFormat | null {
  return value === "IMAGE" || value === "VIDEO" || value === "DOCUMENT"
    ? value
    : null;
}

function formatLimit(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

function getFormatLabel(format: HeaderFormat): string {
  if (format === "IMAGE") return "Image";
  if (format === "VIDEO") return "Video";
  return "Document";
}

function getArticle(format: HeaderFormat): string {
  return format === "IMAGE" ? "an" : "a";
}

function getMetadataValidationError(params: {
  fileName: string;
  fileSize: number;
  format: HeaderFormat;
  mimeType?: string | null;
}): { error: string; status: number } | null {
  if (params.fileSize <= 0) {
    return { error: "Empty file", status: 400 };
  }

  const maxBytes = MAX_BYTES_BY_FORMAT[params.format];
  if (params.fileSize > maxBytes) {
    return {
      error: `${getFormatLabel(params.format)} header media is too large. Maximum size is ${formatLimit(maxBytes)}.`,
      status: 400,
    };
  }

  const { mimeType } = resolveWhatsAppUploadMimeType({
    mimeType: params.mimeType,
    fileName: params.fileName,
  });
  const validationIssue = getWhatsAppTemplateHeaderMediaValidationIssue({
    format: params.format,
    fileName: params.fileName,
    mimeType,
    size: params.fileSize,
  });

  if (validationIssue === "templateVideoUnsupported") {
    return {
      error:
        "Video template headers support MP4 or 3GP files only. MOV is not supported.",
      status: 400,
    };
  }

  const mediaType = getWhatsAppOfficialMediaType(mimeType);
  const expectedMediaType = MEDIA_TYPE_BY_FORMAT[params.format];
  if (mediaType !== expectedMediaType) {
    return {
      error: `${getFormatLabel(params.format)} headers require ${getArticle(params.format)} ${expectedMediaType} file.`,
      status: 400,
    };
  }

  return null;
}

export const runtime = "nodejs";
export const maxDuration = 60;

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

    const contentType = request.headers.get("content-type") || "";
    if (contentType.toLowerCase().includes("application/json")) {
      const payload = (await request
        .json()
        .catch(() => null)) as DirectUploadInitPayload | null;
      if (payload?.mode !== "direct") {
        return NextResponse.json(
          { error: "Unsupported upload request" },
          { status: 400 }
        );
      }

      const format = parseHeaderFormat(payload.format || null);
      if (!format) {
        return NextResponse.json(
          { error: "Header media format is required." },
          { status: 400 }
        );
      }

      const safeName = sanitizeStorageFilename(
        payload.fileName || "template-media",
        `template-media-${Date.now()}`
      );
      const fileSize =
        typeof payload.fileSize === "number" &&
        Number.isFinite(payload.fileSize)
          ? Math.max(0, payload.fileSize)
          : 0;
      const { mimeType } = resolveWhatsAppUploadMimeType({
        mimeType: payload.mimeType,
        fileName: safeName,
      });
      const validationError = getMetadataValidationError({
        fileName: safeName,
        fileSize,
        format,
        mimeType,
      });
      if (validationError) {
        return NextResponse.json(
          { error: validationError.error },
          { status: validationError.status }
        );
      }

      const bucketName = getWhatsAppTemplateHeaderMediaBucket();
      await ensureBusinessMediaBucket(supabaseAdmin.storage, bucketName);
      const storagePath = createWhatsAppTemplateHeaderMediaPath({
        fileName: safeName,
        workspaceId,
      });
      const data = await createReservedSupabaseUpload({
        storage: supabaseAdmin.storage,
        workspaceId,
        bucket: bucketName,
        path: storagePath,
        declaredBytes: fileSize,
      });

      const {
        data: { publicUrl },
      } = supabaseAdmin.storage.from(bucketName).getPublicUrl(storagePath);

      return NextResponse.json({
        success: true,
        upload: {
          bucket: bucketName,
          path: storagePath,
          token: data.token,
        },
        media: {
          url: publicUrl,
          bucket: bucketName,
          path: storagePath,
          mimeType,
          fileName: payload.fileName || safeName,
          fileSize,
          format,
        },
      });
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const format = parseHeaderFormat(formData.get("format"));

    if (!format) {
      return NextResponse.json(
        { error: "Header media format is required." },
        { status: 400 }
      );
    }

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const safeName = sanitizeStorageFilename(
      file.name || "template-media",
      `template-media-${Date.now()}`
    );
    const { mimeType } = resolveWhatsAppUploadMimeType({
      mimeType: file.type,
      fileName: safeName,
    });
    const validationError = getMetadataValidationError({
      format,
      fileName: safeName,
      mimeType,
      fileSize: file.size,
    });
    if (validationError) {
      return NextResponse.json(
        { error: validationError.error },
        { status: validationError.status }
      );
    }

    const stored = await storeWhatsAppTemplateHeaderMedia({
      workspaceId,
      fileName: safeName,
      buffer: Buffer.from(await file.arrayBuffer()),
      mimeType,
    });

    return NextResponse.json({
      success: true,
      media: {
        url: stored.url,
        bucket: stored.bucket,
        path: stored.path,
        mimeType,
        fileName: file.name || safeName,
        fileSize: file.size,
        format,
      },
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
