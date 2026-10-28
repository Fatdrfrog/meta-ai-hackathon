import "server-only";
import mongoose from "mongoose";
import { logger } from "@/lib/logger";
import { withProductPhotoUrls } from "@/lib/products/photo-urls";
import {
  DRAFT_PRODUCT_FIELDS,
  toDraftRecord,
  type ProductRow,
} from "@/lib/products/store";
import {
  MAX_PRODUCT_NAME_LENGTH,
  MAX_PRODUCT_PRICE,
  PRODUCT_VIDEO_IMPORT_MAX_PRODUCTS,
  WORKSPACE_PRODUCT_STATUSES,
  type DraftProductRecord,
  type ProductChanges,
  type ProductReviewRequest,
  type WorkspaceProductStatus,
} from "@/lib/products/types";
import { emitProductsChangedRealtimeEvent } from "@/lib/realtime/server";
import { ProductVideoImport } from "@/models/product-video-import";
import { WorkspaceProduct } from "@/models/workspace-product";

// The owner's review of the products a video import found: fixing a name or
// a price, choosing the option the shelf shows, and adding products to the
// shelf or skipping them, one at a time or all at once.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The changes a request asks for; null when one is invalid or there are none. */
export function parseProductChanges(body: unknown): ProductChanges | null {
  if (!isRecord(body)) return null;
  const changes: ProductChanges = {};
  if ("name" in body) {
    if (typeof body.name !== "string") return null;
    const name = body.name.trim();
    if (!name || name.length > MAX_PRODUCT_NAME_LENGTH) return null;
    changes.name = name;
  }
  if ("price" in body) {
    const { price } = body;
    if (price === null) changes.price = null;
    else if (
      typeof price === "number" &&
      Number.isInteger(price) &&
      price >= 0 &&
      price <= MAX_PRODUCT_PRICE
    )
      changes.price = price;
    else return null;
  }
  if ("featuredOption" in body) {
    const { featuredOption } = body;
    if (
      typeof featuredOption !== "number" ||
      !Number.isInteger(featuredOption) ||
      featuredOption < 0
    )
      return null;
    changes.featuredOption = featuredOption;
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

/** The decision a request asks for; null when it's invalid. */
export function parseProductReview(body: unknown): ProductReviewRequest | null {
  if (!isRecord(body)) return null;
  const { productIds, status } = body;
  if (!(WORKSPACE_PRODUCT_STATUSES as readonly unknown[]).includes(status))
    return null;
  if (
    !Array.isArray(productIds) ||
    productIds.length === 0 ||
    productIds.length > PRODUCT_VIDEO_IMPORT_MAX_PRODUCTS ||
    !productIds.every(
      id => typeof id === "string" && mongoose.isValidObjectId(id)
    )
  )
    return null;
  return {
    productIds: [...new Set(productIds as string[])],
    status: status as WorkspaceProductStatus,
  };
}

/** Tells the panel on every device that the owner checked an import's products. */
async function announceReview(
  workspaceId: string,
  importId: string,
  productId: string | null = null
): Promise<void> {
  try {
    await emitProductsChangedRealtimeEvent({
      workspaceId,
      importId,
      reason: "review",
      productId,
    });
  } catch (error) {
    // Other panels also refresh on their own; a lost event only delays them.
    logger.warn("[Products] review event failed", {
      event: "products.review_emit_failed",
      workspaceId,
      importId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Applies the owner's changes to one of the workspace's products, and gives
 * it back as the review shows it. Setting the price settles the doubts
 * about it. Null when the product isn't this workspace's; "invalid" when the
 * option to show doesn't exist.
 */
export async function updateWorkspaceProduct(
  workspaceId: string,
  productId: string,
  changes: ProductChanges
): Promise<DraftProductRecord | "invalid" | null> {
  const filter = { _id: productId, workspaceId };
  if (changes.featuredOption !== undefined) {
    const current = await WorkspaceProduct.findOne(filter)
      .select("options.description")
      .lean<{ options?: unknown[] }>();
    if (!current) return null;
    if (changes.featuredOption >= (current.options?.length ?? 0))
      return "invalid";
  }
  const row = await WorkspaceProduct.findOneAndUpdate(
    filter,
    {
      $set: changes,
      ...(changes.price !== undefined
        ? { $pull: { doubts: { about: "price" } } }
        : {}),
    },
    { new: true, runValidators: true }
  )
    .select(`${DRAFT_PRODUCT_FIELDS} importId`)
    .lean<ProductRow>();
  if (!row) return null;
  if (row.importId)
    await announceReview(workspaceId, String(row.importId), productId);
  return withProductPhotoUrls(() => toDraftRecord(workspaceId, row));
}

/**
 * Adds some of an import's products to the shelf (published), skips them
 * (rejected), or puts them back to be checked (draft). Only the import's own
 * products change. Gives how many did, or null when the import isn't this
 * workspace's.
 */
export async function reviewImportProducts(
  workspaceId: string,
  importId: string,
  { productIds, status }: ProductReviewRequest,
  userId: string
): Promise<number | null> {
  if (!(await ProductVideoImport.exists({ _id: importId, workspaceId })))
    return null;
  const { modifiedCount } = await WorkspaceProduct.updateMany(
    {
      workspaceId,
      importId,
      _id: { $in: productIds },
      status: { $ne: status },
    },
    status === "published"
      ? { $set: { status, publishedAt: new Date(), publishedBy: userId } }
      : { $set: { status }, $unset: { publishedAt: "", publishedBy: "" } }
  );
  if (modifiedCount > 0) await announceReview(workspaceId, importId);
  return modifiedCount;
}
