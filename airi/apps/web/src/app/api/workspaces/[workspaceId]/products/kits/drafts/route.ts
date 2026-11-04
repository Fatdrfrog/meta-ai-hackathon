import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import { parseProductKitDraftsRequest } from "@/lib/products/kit-request";
import { prepareProductKitDrafts } from "@/lib/products/kits";
import type { ProductKitDraftsResponse } from "@/lib/products/types";
import { StorageQuotaError } from "@icecore/airi-runtime/storage-quota";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The cards' pictures are made on white and stored: a few seconds for 10.
export const maxDuration = 60;

type Context = { params: Promise<{ workspaceId: string }> };

/**
 * "Edit cards" before Make ({productIds, language}): the carousel the shelf
 * would make for these products, as template components for airi's
 * template editor to open. Nothing goes to Meta. 409 not_enough_products
 * when fewer than 2 have photos; 409 storage_full when the company's media
 * storage can't take the pictures.
 */
export async function POST(request: Request, { params }: Context) {
  const { workspaceId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    const drafts = parseProductKitDraftsRequest(
      await request.json().catch(() => null)
    );
    if (!drafts) return productsFail("invalid_request", 400);
    await connectDB();
    const outcome = await prepareProductKitDrafts(workspaceId, drafts);
    if ("refused" in outcome) return productsFail(outcome.refused, 409);
    return productsJson(outcome satisfies ProductKitDraftsResponse);
  } catch (error) {
    if (error instanceof StorageQuotaError)
      return productsFail("storage_full", 409);
    logger.error("[Products API] kit drafts failed", error, {
      event: "products.kit_drafts_failed",
      workspaceId,
    });
    return productsFail("draft_failed", 503);
  }
}
