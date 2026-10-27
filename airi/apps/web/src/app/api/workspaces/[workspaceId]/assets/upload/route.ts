import {
  assertCreativeAssetMimeTypeAllowed,
  CreativeAssetValidationError,
  CREATIVE_ASSET_COMPANY_STORAGE_LIMIT_BYTES,
  CREATIVE_ASSET_COMPANY_STORAGE_LIMIT_LABEL,
  resolveCreativeAssetMimeType,
} from "@/lib/higgsfield/creative-asset-storage";
import { serializeCreativeAssetForResponse } from "@/lib/higgsfield/creative-asset-serialization";
import {
  createRemoteCreativeAssetUpload,
  statRemoteCreativeAssetObject,
} from "@/lib/google/gcp-media-api";
import connectDB from "@/lib/mongoose";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { canonicalGcsUri } from "@icecore/airi-runtime/media-api";
import { getCompanyIdForWorkspace } from "@/lib/supabase/company-users";
import {
  readStorageObject,
  settleStorageObject,
  storageObjectId,
  StorageQuotaError,
  getStorageQuotaStore,
  getStorageQuotaRolloutMode,
} from "@icecore/airi-runtime/storage-quota";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import { readJsonBodyWithinLimit } from "@/lib/api/json-body";
import { CreativeAsset, type CreativeAssetKind } from "@/models/creative-asset";
import { readStringOrEmpty } from "@icecore/shared/lib/value-utils";
import { Types } from "mongoose";
import { NextRequest, NextResponse } from "next/server";

type Params = Promise<{ workspaceId: string }>;
type UploadAction = "initiate" | "complete";

type UploadRequestBody = {
  action?: unknown;
  provider?: unknown;
  assetId?: unknown;
  bucket?: unknown;
  path?: unknown;
  kind?: unknown;
  fileName?: unknown;
  mimeType?: unknown;
  fileSize?: unknown;
};

export const runtime = "nodejs";
export const maxDuration = 60;

function inferKind(mimeType: string): CreativeAssetKind | null {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/x-subrip" ||
    mimeType === "application/json"
  ) {
    return "text";
  }
  return null;
}

function isKind(value: unknown): value is CreativeAssetKind {
  return (
    value === "image" ||
    value === "video" ||
    value === "audio" ||
    value === "text"
  );
}

function readFileSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return 0;
  return value;
}

function invalidJsonResponse(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function unsupportedUploadResponse(): NextResponse {
  return NextResponse.json(
    {
      error:
        "Use the creative asset direct upload flow. Send JSON metadata first, then upload directly to storage.",
      code: "creative_asset_signed_upload_required",
    },
    { status: 415 }
  );
}

function expectedStoragePrefix(params: {
  workspaceId: string;
  kind: CreativeAssetKind;
  assetId: string;
}): string {
  return `workspaces/${params.workspaceId}/creative-assets/${params.kind}/${params.assetId}/`;
}

function parseAction(value: unknown): UploadAction | null {
  return value === "initiate" || value === "complete" ? value : null;
}

function validateUploadMetadata(params: {
  fileName: unknown;
  mimeType: unknown;
  fileSize: unknown;
  kind?: unknown;
}): {
  fileName: string;
  mimeType: string;
  kind: CreativeAssetKind;
  fileSize: number;
} {
  const fileName =
    readStringOrEmpty(params.fileName, { trim: true }) || "creative-asset";
  const mimeType = resolveCreativeAssetMimeType({
    fileName,
    mimeType: readStringOrEmpty(params.mimeType, { trim: true }),
  });
  const inferredKind = inferKind(mimeType);
  const kind = isKind(params.kind) ? params.kind : inferredKind;

  if (!kind) {
    throw new CreativeAssetValidationError(
      "Only image, video, audio, and text assets are supported"
    );
  }

  assertCreativeAssetMimeTypeAllowed(kind, mimeType);

  const fileSize = readFileSize(params.fileSize);
  if (fileSize <= 0) {
    throw new CreativeAssetValidationError("Creative asset file is empty");
  }

  if (fileSize > CREATIVE_ASSET_COMPANY_STORAGE_LIMIT_BYTES) {
    throw new CreativeAssetValidationError(
      `Creative asset storage limit exceeded. Company limit is ${CREATIVE_ASSET_COMPANY_STORAGE_LIMIT_LABEL}.`
    );
  }

  return { fileName, mimeType, kind, fileSize };
}

async function readJsonBody(request: NextRequest): Promise<UploadRequestBody> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new CreativeAssetValidationError("signed_upload_required");
  }

  const payload = await readJsonBodyWithinLimit(request, 16 * 1024).catch(
    () => null
  );
  if (!payload || typeof payload !== "object") {
    throw new CreativeAssetValidationError("Invalid JSON upload request");
  }

  return payload as UploadRequestBody;
}

async function readStoredObjectMetadata(params: {
  bucket: string;
  path: string;
  workspaceId: string;
}): Promise<{ fileSize: number | null; mimeType: string | null }> {
  const object = await statRemoteCreativeAssetObject({
    provider: "gcs",
    bucket: params.bucket,
    path: params.path,
    workspaceId: params.workspaceId,
  });

  if (!object.exists) {
    throw new CreativeAssetValidationError(
      "Uploaded creative asset was not found in storage"
    );
  }

  return {
    fileSize: object.fileSize,
    mimeType: object.mimeType,
  };
}

async function handleInitiateUpload(params: {
  workspaceId: string;
  body: UploadRequestBody;
  origin: string | null;
}): Promise<NextResponse> {
  const metadata = validateUploadMetadata({
    fileName: params.body.fileName,
    mimeType: params.body.mimeType,
    fileSize: params.body.fileSize,
  });

  const requestedAssetId = readStringOrEmpty(params.body.assetId, {
    trim: true,
  });
  if (requestedAssetId && !Types.ObjectId.isValid(requestedAssetId))
    return invalidJsonResponse("Invalid creative asset id");
  const assetId = requestedAssetId || new Types.ObjectId().toString();
  const upload = await createRemoteCreativeAssetUpload({
    workspaceId: params.workspaceId,
    assetId,
    kind: metadata.kind,
    fileName: metadata.fileName,
    mimeType: metadata.mimeType,
    fileSize: metadata.fileSize,
    origin: params.origin,
  });

  return NextResponse.json({
    success: true,
    upload: {
      provider: "gcs",
      assetId,
      bucket: upload.bucket,
      path: upload.path,
      uploadUrl: upload.uploadUrl,
      method: upload.method,
      kind: metadata.kind,
      mimeType: metadata.mimeType,
      fileName: metadata.fileName,
      fileSize: metadata.fileSize,
      expiresInSeconds: upload.expiresInSeconds,
      mode: upload.mode,
      headers: upload.headers,
    },
  });
}

async function handleCompleteUpload(params: {
  workspaceId: string;
  userId: string | null | undefined;
  body: UploadRequestBody;
  companyId: string;
}): Promise<NextResponse> {
  const assetId = readStringOrEmpty(params.body.assetId, { trim: true });
  if (!Types.ObjectId.isValid(assetId)) {
    return invalidJsonResponse("Invalid creative asset id");
  }

  const metadata = validateUploadMetadata({
    fileName: params.body.fileName,
    mimeType: params.body.mimeType,
    fileSize: params.body.fileSize,
    kind: params.body.kind,
  });
  const bucket = readStringOrEmpty(params.body.bucket, { trim: true });
  const path = readStringOrEmpty(params.body.path, { trim: true });
  const provider = readStringOrEmpty(params.body.provider, { trim: true });

  if (provider !== "gcs") {
    return invalidJsonResponse("Invalid creative asset storage provider");
  }
  if (
    !path.startsWith(
      expectedStoragePrefix({
        ...metadata,
        assetId,
        workspaceId: params.workspaceId,
      })
    )
  ) {
    return invalidJsonResponse("Invalid creative asset path");
  }

  const objectId = new Types.ObjectId(assetId);
  const existingAsset = await CreativeAsset.findOne({
    _id: objectId,
    workspaceId: params.workspaceId,
  });
  if (existingAsset) {
    return NextResponse.json({
      success: true,
      asset: await serializeCreativeAssetForResponse(existingAsset),
    });
  }

  const storedObject = await readStoredObjectMetadata({
    bucket,
    path,
    workspaceId: params.workspaceId,
  });
  const reservation = await readStorageObject(
    storageObjectId({ provider: "gcs", bucket, path })
  );
  if (
    !reservation ||
    reservation.workspaceId !== params.workspaceId ||
    reservation.companyId !== params.companyId
  ) {
    return invalidJsonResponse(
      "Upload reservation was not found. Storage inventory may be required.",
      409
    );
  }
  if (reservation.status === "tombstoned")
    throw new StorageQuotaError(
      "storage_object_deleted",
      "Storage object was deleted; use a new object identity"
    );
  const fileSize = storedObject.fileSize;
  if (
    !Number.isSafeInteger(fileSize) ||
    !fileSize ||
    fileSize !== reservation.bytes ||
    fileSize !== metadata.fileSize ||
    storedObject.mimeType !== metadata.mimeType
  ) {
    if (
      typeof fileSize === "number" &&
      Number.isSafeInteger(fileSize) &&
      fileSize >= 0 &&
      reservation.status === "reserved"
    )
      await settleStorageObject(reservation._id, fileSize);
    return invalidJsonResponse(
      "Uploaded object does not match its reserved size or type",
      409
    );
  }
  const document = {
    _id: objectId,
    workspaceId: params.workspaceId,
    kind: metadata.kind,
    source: "uploaded",
    provider: null,
    status: "complete",
    url: canonicalGcsUri(bucket, path),
    storageProvider: "gcs",
    bucket,
    path,
    mimeType: metadata.mimeType,
    fileName: metadata.fileName,
    fileSize,
    createdBy: params.userId || null,
    updatedBy: params.userId || null,
    completedAt: new Date(),
  };
  let asset;
  try {
    await settleStorageObject(reservation._id, fileSize, async session => {
      [asset] = await CreativeAsset.create([document], { session });
    });
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) throw error;
    asset = await CreativeAsset.findOne({
      _id: objectId,
      workspaceId: params.workspaceId,
    });
    if (!asset) throw error;
  }

  return NextResponse.json({
    success: true,
    asset: await serializeCreativeAssetForResponse(asset),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Params }
): Promise<NextResponse> {
  try {
    const { workspaceId } = await params;
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;

    let body: UploadRequestBody;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      if (
        error instanceof CreativeAssetValidationError &&
        error.message === "signed_upload_required"
      ) {
        return unsupportedUploadResponse();
      }
      throw error;
    }

    const action = parseAction(body.action);
    if (!action) {
      return invalidJsonResponse("Invalid creative asset upload action");
    }

    const companyId = await getCompanyIdForWorkspace(
      access.supabase,
      workspaceId
    );
    if (!companyId) {
      return NextResponse.json(
        { error: "Workspace company was not found" },
        { status: 404 }
      );
    }

    await connectDB();

    if (action === "initiate") {
      return await handleInitiateUpload({
        workspaceId,
        body,
        origin: request.headers.get("origin"),
      });
    }

    return await handleCompleteUpload({
      workspaceId,
      userId: access.userId,
      body,
      companyId,
    });
  } catch (error) {
    if (error instanceof StorageQuotaError)
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status }
      );
    const message =
      error instanceof Error ? error.message : "Failed to upload asset";
    if (error instanceof CreativeAssetValidationError) {
      const status = message.includes("storage limit exceeded") ? 409 : 400;
      return NextResponse.json({ error: message }, { status });
    }
    const isMediaConfig =
      /GCP_MEDIA_API_URL|Vercel OIDC|local media API|not configured/i.test(
        message
      );
    return NextResponse.json(
      {
        error: message,
        code: isMediaConfig
          ? "creative_asset_media_api_unavailable"
          : "creative_asset_upload_failed",
      },
      { status: isMediaConfig ? 503 : 500 }
    );
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Params }
): Promise<NextResponse> {
  const { workspaceId } = await params;
  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) return access.response;
  const companyId = await getCompanyIdForWorkspace(
    access.supabase,
    workspaceId
  );
  if (!companyId)
    return NextResponse.json(
      { error: "Workspace company was not found" },
      { status: 404 }
    );
  const usage = await (await getStorageQuotaStore()).usage(companyId);
  const recording = !usage?.ready && getStorageQuotaRolloutMode() === "record";
  return NextResponse.json({
    storage: usage
      ? {
          ready: usage.ready,
          recording,
          limitBytes: usage.limitBytes,
          storedBytes: usage.storedBytes,
          reservedBytes: usage.chargedBytes - usage.storedBytes,
          remainingBytes: Math.max(0, usage.limitBytes - usage.chargedBytes),
        }
      : {
          ready: false,
          recording,
          limitBytes: CREATIVE_ASSET_COMPANY_STORAGE_LIMIT_BYTES,
        },
    code: usage?.ready || recording ? null : "storage_inventory_required",
  });
}
