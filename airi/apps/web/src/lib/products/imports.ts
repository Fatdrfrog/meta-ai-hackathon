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
import { WorkspaceProduct } from "@/models/workspace-product";

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

const IMPORT_FIELDS =
  "status stage productTotal photoTotal photoDone errorCode presenter createdAt finishedAt";

async function toImportRecord(
  workspaceId: string,
  doc: Record<string, unknown>
): Promise<ProductVideoImportRecord> {
  return {
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
}

export async function loadProductVideoImport(
  workspaceId: string,
  importId: string
): Promise<ProductVideoImportResponse | null> {
  const doc = await ProductVideoImport.findOne({ _id: importId, workspaceId })
    .select(IMPORT_FIELDS)
    .lean<Record<string, unknown>>();
  if (!doc) return null;
  return {
    import: await toImportRecord(workspaceId, doc),
    products: await listImportProducts(workspaceId, importId),
  };
}

// The Products page shows imports from the last week: running ones, finished
// ones with products left to check, and, for a day, those that failed or
// found nothing, so the owner learns why. A few at most.
const SHOWN_IMPORTS_DAYS = 7;
const MAX_SHOWN_IMPORTS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The imports the Products page shows, newest first. */
export async function listShownProductVideoImports(
  workspaceId: string,
  now: Date = new Date()
): Promise<ProductVideoImportRecord[]> {
  const docs = await ProductVideoImport.find({
    workspaceId,
    createdAt: { $gte: new Date(now.getTime() - SHOWN_IMPORTS_DAYS * DAY_MS) },
  })
    .sort({ createdAt: -1 })
    .limit(20)
    .select(IMPORT_FIELDS)
    .lean<Record<string, unknown>[]>();
  const ready = docs.filter(doc => doc.status === "ready").map(doc => doc._id);
  const withDrafts = new Set(
    ready.length
      ? (
          await WorkspaceProduct.distinct("importId", {
            workspaceId,
            importId: { $in: ready },
            status: "draft",
          })
        ).map(String)
      : []
  );
  const recent = (doc: Record<string, unknown>) => {
    const at = doc.finishedAt instanceof Date ? doc.finishedAt : doc.createdAt;
    return at instanceof Date && now.getTime() - at.getTime() <= DAY_MS;
  };
  const shown = docs
    .filter(doc => {
      if (doc.status === "queued" || doc.status === "processing") return true;
      if (doc.status === "ready")
        return (
          withDrafts.has(String(doc._id)) ||
          (doc.productTotal === 0 && recent(doc))
        );
      return doc.status === "failed" && recent(doc);
    })
    .slice(0, MAX_SHOWN_IMPORTS);
  return withProductPhotoUrls(() =>
    Promise.all(shown.map(doc => toImportRecord(workspaceId, doc)))
  );
}
