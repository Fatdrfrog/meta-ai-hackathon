import mongoose from "mongoose";
import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import {
  parseProductChanges,
  updateWorkspaceProduct,
} from "@/lib/products/review";
import type { ProductUpdateResponse } from "@/lib/products/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string; productId: string }> };

/**
 * Changes a product as the owner checks it (`{ name?, price?, currency?,
 * featuredOption? }`, a currency only with a price), and answers with it as
 * the review shows it. A price without a currency, which only tabs opened
 * before prices had currencies send, must be whole, and is refused with 409
 * where such a tab misreads the product's price: one with decimals, or in
 * another currency than tenge.
 */
export async function PATCH(request: Request, { params }: Context) {
  const { workspaceId, productId } = await params;
  const changes = parseProductChanges(await request.json().catch(() => null));
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    if (!mongoose.isValidObjectId(productId))
      return productsFail("product_not_found", 404);
    if (!changes) return productsFail("invalid_request", 400);
    await connectDB();
    const product = await updateWorkspaceProduct(
      workspaceId,
      productId,
      changes
    );
    if (product === "invalid") return productsFail("invalid_request", 400);
    if (product === "conflict") return productsFail("currency_required", 409);
    if (!product) return productsFail("product_not_found", 404);
    return productsJson({ product } satisfies ProductUpdateResponse);
  } catch (error) {
    logger.error("[Products API] product PATCH failed", error, {
      event: "products.product_update_failed",
      workspaceId,
      productId,
    });
    return productsFail("save_failed", 503);
  }
}
