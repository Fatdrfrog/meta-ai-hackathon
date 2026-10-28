import "server-only";
import { logger } from "@/lib/logger";
import {
  productPhotoUrl,
  withProductPhotoUrls,
} from "@/lib/products/photo-urls";
import { listImportProducts } from "@/lib/products/store";
import {
  PRODUCT_VIDEO_IMPORT_ERROR_CODES,
  PRODUCT_VIDEO_IMPORT_STAGES,
  type ProductVideoImportErrorCode,
  type ProductVideoImportRecord,
  type ProductVideoImportResponse,
  type ProductVideoImportSource,
  type ProductVideoImportStage,
  type StoredFileRef,
} from "@/lib/products/types";
import { startProductVideoImportWorkflow } from "@/lib/temporal/product-video-import";
import { CreativeAsset } from "@/models/creative-asset";
import { ProductVideoImport } from "@/models/product-video-import";

type StoredVideo = StoredFileRef & { mimeType?: string; fileName?: string };

/**
 * A finished video upload in this workspace's media storage, as the import
 * reads it; null when it isn't one.
 */
export async function findUploadedVideo(
  workspaceId: string,
  assetId: string
): Promise<StoredVideo | null> {
  const asset = await CreativeAsset.findOne({
    _id: assetId,
    workspaceId,
    kind: "video",
    status: "complete",
    storageProvider: "gcs",
  })
    .select("bucket path mimeType fileName")
    .lean<{
      bucket?: string | null;
      path?: string | null;
      mimeType?: string | null;
      fileName?: string | null;
    }>();
  if (!asset?.bucket || !asset.path) return null;
  return {
    bucket: asset.bucket,
    path: asset.path,
    ...(asset.mimeType ? { mimeType: asset.mimeType } : {}),
    ...(asset.fileName ? { fileName: asset.fileName } : {}),
  };
}

/**
 * Records an import of `video` and starts the job that turns it into draft
 * products. If the job can't start, the import is marked failed and the
 * error goes to the caller.
 */
export async function createProductVideoImport(params: {
  workspaceId: string;
  source: ProductVideoImportSource;
  video: StoredVideo;
  createdBy?: string;
}): Promise<{ importId: string }> {
  const created = await ProductVideoImport.create({
    workspaceId: params.workspaceId,
    source: params.source,
    video: params.video,
    status: "queued",
    ...(params.createdBy ? { createdBy: params.createdBy } : {}),
  });
  const importId = String(created._id);
  try {
    const started = await startProductVideoImportWorkflow({
      workspaceId: params.workspaceId,
      importId,
    });
    await ProductVideoImport.updateOne(
      { _id: importId },
      { $set: { workflowId: started.workflowId } }
    );
  } catch (error) {
    logger.error("[Products] import start failed", error, {
      event: "products.import_start_failed",
      workspaceId: params.workspaceId,
      importId,
    });
    await ProductVideoImport.updateOne(
      { _id: importId },
      {
        $set: {
          status: "failed",
          errorCode: "failed",
          errorMessage: "The import job couldn't be started",
          finishedAt: new Date(),
        },
      }
    );
    throw error;
  }
  return { importId };
}

const toIso = (value: unknown): string | null =>
  value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString()
    : null;

/** One import with the products it found so far; null when it isn't this workspace's. */
type PresenterPhoto = {
  cutout?: Partial<StoredFileRef>;
  thumb?: Partial<StoredFileRef>;
  original?: Partial<StoredFileRef>;
};

/** The presenter's photos as links, or null until their cut-out is made. */
async function presenterRecord(
  workspaceId: string,
  presenter: unknown
): Promise<ProductVideoImportRecord["presenter"]> {
  const photo = (presenter as { photo?: PresenterPhoto | null } | null)?.photo;
  if (!photo) return null;
  return withProductPhotoUrls(async () => ({
    imageUrl: await productPhotoUrl(workspaceId, photo.thumb),
    photoUrl: await productPhotoUrl(workspaceId, photo.cutout),
    originalUrl: await productPhotoUrl(workspaceId, photo.original),
  }));
}

export async function loadProductVideoImport(
  workspaceId: string,
  importId: string
): Promise<ProductVideoImportResponse | null> {
  const doc = await ProductVideoImport.findOne({ _id: importId, workspaceId })
    .select(
      "status stage productTotal photoTotal photoDone errorCode presenter createdAt finishedAt"
    )
    .lean<Record<string, unknown>>();
  if (!doc) return null;
  const record: ProductVideoImportRecord = {
    id: String(doc._id),
    status: doc.status as ProductVideoImportRecord["status"],
    stage: (PRODUCT_VIDEO_IMPORT_STAGES as readonly unknown[]).includes(
      doc.stage
    )
      ? (doc.stage as ProductVideoImportStage)
      : null,
    productTotal: typeof doc.productTotal === "number" ? doc.productTotal : 0,
    photoTotal: typeof doc.photoTotal === "number" ? doc.photoTotal : 0,
    photoDone: typeof doc.photoDone === "number" ? doc.photoDone : 0,
    errorCode: (
      PRODUCT_VIDEO_IMPORT_ERROR_CODES as readonly unknown[]
    ).includes(doc.errorCode)
      ? (doc.errorCode as ProductVideoImportErrorCode)
      : null,
    presenter: await presenterRecord(workspaceId, doc.presenter),
    createdAt: toIso(doc.createdAt),
    finishedAt: toIso(doc.finishedAt),
  };
  return {
    import: record,
    products: await listImportProducts(workspaceId, importId),
  };
}
