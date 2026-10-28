import mongoose from "mongoose";
import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import {
  parseProductReview,
  reviewImportProducts,
} from "@/lib/products/review";
import type { ProductReviewResponse } from "@/lib/products/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string; importId: string }> };

/**
 * The owner's decision on some of an import's products (`{ productIds,
 * status }`): published adds them to the shelf, rejected skips them, draft
 * undoes either. Answers with how many changed.
 */
export async function POST(request: Request, { params }: Context) {
  const { workspaceId, importId } = await params;
  const review = parseProductReview(await request.json().catch(() => null));
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    if (!mongoose.isValidObjectId(importId))
      return productsFail("import_not_found", 404);
    if (!review) return productsFail("invalid_request", 400);
    await connectDB();
    const changed = await reviewImportProducts(
      workspaceId,
      importId,
      review,
      access.userId
    );
    if (changed === null) return productsFail("import_not_found", 404);
    return productsJson({ changed } satisfies ProductReviewResponse);
  } catch (error) {
    logger.error("[Products API] review POST failed", error, {
      event: "products.review_failed",
      workspaceId,
      importId,
    });
    return productsFail("save_failed", 503);
  }
}
