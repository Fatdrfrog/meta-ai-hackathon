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
  hasAtMostDecimals,
  MAX_PRODUCT_NAME_LENGTH,
  MAX_PRODUCT_PRICE,
  PRODUCT_UNKNOWN_CURRENCY_DOUBT,
  PRODUCT_VIDEO_IMPORT_MAX_PRODUCTS,
  productCurrency,
  productPriceDecimals,
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
  // A currency comes only with a price, as an ISO code. A price alone keeps
  // the product's currency: tabs from before currencies could be typed send
  // their prices that way. They send only whole ones, so a price alone must
  // be whole; with cents it could have more decimals than the product's
  // currency has (4.999 on a USD product).
  if ("currency" in body) {
    const currency = productCurrency(body.currency);
    if (!currency || typeof body.price !== "number") return null;
    changes.currency = currency;
  }
  if ("price" in body) {
    const { price } = body;
    if (price === null) changes.price = null;
    else if (
      typeof price === "number" &&
      price >= 0 &&
      price <= MAX_PRODUCT_PRICE &&
      hasAtMostDecimals(
        price,
        changes.currency ? productPriceDecimals(changes.currency) : 0
      )
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
 * The products a price sent without a currency may be set on: those priced
 * in whole tenge, in no currency, or not at all. Only a tab opened before
 * prices had currencies sends such a price, and its editor shows the stored
 * price as digits, drops any decimal point ("4.99" comes back as 499) and
 * calls every price tenge.
 */
const preCurrencyPriceFilter = () => ({
  currency: { $in: [null, "KZT"] },
  $expr: {
    $or: [
      { $eq: [{ $ifNull: ["$price", null] }, null] },
      { $eq: ["$price", { $trunc: ["$price", 0] }] },
    ],
  },
});

/**
 * Applies the owner's changes to one of the workspace's products, and gives
 * it back as the review shows it. Setting the price settles the doubts about
 * it, its currency's among them; taking the price away keeps the currency,
 * for the next price. A price without a currency, from a tab opened before
 * prices had currencies, keeps the product's currency and the doubts that say
 * it isn't known, and is set only where that tab reads prices right. Null
 * when the product isn't this workspace's; "invalid" when the option to show
 * doesn't exist; "conflict" when a price without a currency would be set over
 * one that tab misreads.
 */
export async function updateWorkspaceProduct(
  workspaceId: string,
  productId: string,
  changes: ProductChanges
): Promise<DraftProductRecord | "invalid" | "conflict" | null> {
  const filter = { _id: productId, workspaceId };
  if (changes.featuredOption !== undefined) {
    const current = await WorkspaceProduct.findOne(filter)
      .select("options.description")
      .lean<{ options?: unknown[] }>();
    if (!current) return null;
    if (changes.featuredOption >= (current.options?.length ?? 0))
      return "invalid";
  }
  const preCurrency =
    typeof changes.price === "number" && changes.currency === undefined;
  const row = await WorkspaceProduct.findOneAndUpdate(
    preCurrency ? { ...filter, ...preCurrencyPriceFilter() } : filter,
    {
      $set: changes,
      ...(changes.price !== undefined
        ? {
            $pull: {
              doubts: preCurrency
                ? {
                    about: "price",
                    // Not `text: { $not }`: update validators would take
                    // that for a doubt's text, and refuse it.
                    $nor: [{ text: PRODUCT_UNKNOWN_CURRENCY_DOUBT }],
                  }
                : { about: "price" },
            },
          }
        : {}),
    },
    { new: true, runValidators: true }
  )
    .select(`${DRAFT_PRODUCT_FIELDS} importId`)
    .lean<ProductRow>();
  if (!row) {
    if (preCurrency && (await WorkspaceProduct.exists(filter)))
      return "conflict";
    return null;
  }
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
