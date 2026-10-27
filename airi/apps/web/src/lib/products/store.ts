import "server-only";
import {
  productPhotoUrl,
  withProductPhotoUrls,
} from "@/lib/products/photo-urls";
import { WorkspaceProduct } from "@/models/workspace-product";
import {
  MAX_LISTED_PRODUCTS,
  PRODUCT_PHOTO_METHODS,
  WORKSPACE_PRODUCT_STATUSES,
  type DraftProductRecord,
  type ProductPhotoMethod,
  type StoredFileRef,
  type WorkspaceProductRecord,
  type WorkspaceProductStatus,
} from "./types";

type ProductRow = Record<string, unknown> & {
  photo?: {
    method?: unknown;
    cutout?: Partial<StoredFileRef>;
    thumb?: Partial<StoredFileRef>;
    original?: Partial<StoredFileRef>;
    frameTimeSeconds?: unknown;
  };
};

function toIsoOrNull(value: unknown): string | null {
  return value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString()
    : null;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

async function toRecord(
  workspaceId: string,
  row: ProductRow
): Promise<WorkspaceProductRecord> {
  return {
    id: String(row._id),
    name: text(row.name) ?? "",
    price: finite(row.price),
    // The small copy: the shelf shows products about 176 px tall.
    imageUrl: await productPhotoUrl(workspaceId, row.photo?.thumb),
    updatedAt: toIsoOrNull(row.updatedAt),
  };
}

/** The workspace's published products, in shelf order, as the Products page lists them. */
export async function listPublishedProducts(
  workspaceId: string
): Promise<WorkspaceProductRecord[]> {
  const rows = await WorkspaceProduct.find({ workspaceId, status: "published" })
    .sort({ position: 1, _id: 1 })
    .limit(MAX_LISTED_PRODUCTS)
    .select("name price updatedAt photo.thumb")
    .lean<ProductRow[]>();
  return withProductPhotoUrls(() =>
    Promise.all(rows.map(row => toRecord(workspaceId, row)))
  );
}

/** The products one import found, in the order they were filmed, for the owner to check. */
export async function listImportProducts(
  workspaceId: string,
  importId: string
): Promise<DraftProductRecord[]> {
  const rows = await WorkspaceProduct.find({ workspaceId, importId })
    .sort({ importIndex: 1, _id: 1 })
    .select("status name englishName price priceQuote doubts photo updatedAt")
    .lean<ProductRow[]>();
  return withProductPhotoUrls(() =>
    Promise.all(
      rows.map(async (row): Promise<DraftProductRecord> => {
        const method = row.photo?.method;
        return {
          ...(await toRecord(workspaceId, row)),
          status: (WORKSPACE_PRODUCT_STATUSES as readonly unknown[]).includes(
            row.status
          )
            ? (row.status as WorkspaceProductStatus)
            : "draft",
          englishName: text(row.englishName),
          priceQuote: text(row.priceQuote),
          doubts: Array.isArray(row.doubts)
            ? row.doubts.filter(
                (doubt): doubt is string => typeof doubt === "string"
              )
            : [],
          photoMethod: (PRODUCT_PHOTO_METHODS as readonly unknown[]).includes(
            method
          )
            ? (method as ProductPhotoMethod)
            : "pending",
          photoUrl: await productPhotoUrl(workspaceId, row.photo?.cutout),
          originalUrl: await productPhotoUrl(workspaceId, row.photo?.original),
          videoMomentSeconds: finite(row.photo?.frameTimeSeconds),
        };
      })
    )
  );
}
