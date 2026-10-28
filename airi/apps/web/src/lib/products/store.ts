import "server-only";
import {
  productPhotoUrl,
  withProductPhotoUrls,
} from "@/lib/products/photo-urls";
import { WorkspaceProduct } from "@/models/workspace-product";
import {
  MAX_LISTED_PRODUCTS,
  PRODUCT_PHOTO_METHODS,
  PRODUCT_TEXT_SOURCES,
  WORKSPACE_PRODUCT_STATUSES,
  type DraftProductOptionRecord,
  type DraftProductRecord,
  type ProductPhotoMethod,
  type ProductTextSource,
  type StoredFileRef,
  type WorkspaceProductRecord,
  type WorkspaceProductStatus,
} from "./types";

type OptionRow = Record<string, unknown> & {
  photo?: {
    method?: unknown;
    cutout?: Partial<StoredFileRef>;
    thumb?: Partial<StoredFileRef>;
    original?: Partial<StoredFileRef>;
    frameTimeSeconds?: unknown;
    straightenedDegrees?: unknown;
  };
};

type ProductRow = Record<string, unknown> & {
  options?: OptionRow[];
  featuredOption?: unknown;
};

const featuredIndex = (row: ProductRow): number => {
  const options = row.options ?? [];
  const featured = row.featuredOption;
  return typeof featured === "number" &&
    Number.isInteger(featured) &&
    featured >= 0 &&
    featured < options.length
    ? featured
    : 0;
};

const texts = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

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
    priceIsFrom: row.priceIsFrom === true,
    // The featured option's small copy: the shelf shows products about
    // 176 px tall.
    imageUrl: await productPhotoUrl(
      workspaceId,
      row.options?.[featuredIndex(row)]?.photo?.thumb
    ),
    updatedAt: toIsoOrNull(row.updatedAt),
  };
}

async function toOptionRecord(
  workspaceId: string,
  option: OptionRow
): Promise<DraftProductOptionRecord> {
  const method = option.photo?.method;
  return {
    description: text(option.description) ?? "",
    photoMethod: (PRODUCT_PHOTO_METHODS as readonly unknown[]).includes(method)
      ? (method as ProductPhotoMethod)
      : "pending",
    imageUrl: await productPhotoUrl(workspaceId, option.photo?.thumb),
    photoUrl: await productPhotoUrl(workspaceId, option.photo?.cutout),
    originalUrl: await productPhotoUrl(workspaceId, option.photo?.original),
    videoMomentSeconds: finite(option.photo?.frameTimeSeconds),
    straightenedDegrees: finite(option.photo?.straightenedDegrees) ?? 0,
    notes: texts(option.notes),
  };
}

/** The workspace's published products, in shelf order, as the Products page lists them. */
export async function listPublishedProducts(
  workspaceId: string
): Promise<WorkspaceProductRecord[]> {
  const rows = await WorkspaceProduct.find({ workspaceId, status: "published" })
    .sort({ position: 1, _id: 1 })
    .limit(MAX_LISTED_PRODUCTS)
    .select(
      "name price priceIsFrom updatedAt featuredOption options.photo.thumb"
    )
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
    .select(
      "status name englishName nameSource price priceIsFrom priceQuote priceSource doubts options featuredOption updatedAt"
    )
    .lean<ProductRow[]>();
  return withProductPhotoUrls(() =>
    Promise.all(
      rows.map(async (row): Promise<DraftProductRecord> => {
        return {
          ...(await toRecord(workspaceId, row)),
          status: (WORKSPACE_PRODUCT_STATUSES as readonly unknown[]).includes(
            row.status
          )
            ? (row.status as WorkspaceProductStatus)
            : "draft",
          englishName: text(row.englishName),
          nameSource: (PRODUCT_TEXT_SOURCES as readonly unknown[]).includes(
            row.nameSource
          )
            ? (row.nameSource as ProductTextSource)
            : null,
          priceQuote: text(row.priceQuote),
          priceSource: (PRODUCT_TEXT_SOURCES as readonly unknown[]).includes(
            row.priceSource
          )
            ? (row.priceSource as ProductTextSource)
            : null,
          doubts: texts(row.doubts),
          options: await Promise.all(
            (row.options ?? []).map(option =>
              toOptionRecord(workspaceId, option)
            )
          ),
          featuredOption: featuredIndex(row),
        };
      })
    )
  );
}
