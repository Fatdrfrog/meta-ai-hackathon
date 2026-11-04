import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import {
  isAdObjectId,
  parseProductAdUpdateRequest,
} from "@/lib/products/ad-request";
import { loadProductAdRecord, updateProductAdWords } from "@/lib/products/ads";
import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import type { ProductAdResponse } from "@/lib/products/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string; adId: string }> };

/**
 * One video ad as the studio shows it, with signed links. The studio asks
 * every 2 s while it's being made.
 */
export async function GET(_request: Request, { params }: Context) {
  const { workspaceId, adId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    if (!isAdObjectId(adId)) return productsFail("ad_not_found", 404);
    await connectDB();
    const ad = await loadProductAdRecord(workspaceId, adId.toLowerCase());
    if (!ad) return productsFail("ad_not_found", 404);
    return productsJson({ ad } satisfies ProductAdResponse);
  } catch (error) {
    logger.error("[Products API] ad GET failed", error, {
      event: "products.ad_load_failed",
      workspaceId,
      adId,
    });
    return productsFail("load_failed", 503);
  }
}

/**
 * The owner's free changes (`ProductAdUpdateRequest`: the words on screen,
 * and each scene's word zone, exact photo or earlier picture): 202 with the
 * ad, its video being made again from the saved pictures, with no AI
 * action. 400 when the words fail the script's checks or a scene choice
 * doesn't fit the ad (with the first issues); 409 ad_not_ready unless the
 * ad is ready. Changes that change nothing answer 200 as it is.
 */
export async function PATCH(request: Request, { params }: Context) {
  const { workspaceId, adId } = await params;
  const body: unknown = await request.json().catch(() => null);
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    if (!isAdObjectId(adId)) return productsFail("ad_not_found", 404);
    const changes = parseProductAdUpdateRequest(body);
    if (!changes) return productsFail("invalid_request", 400);
    await connectDB();
    const result = await updateProductAdWords({
      workspaceId,
      adId: adId.toLowerCase(),
      changes,
    });
    if ("refused" in result) {
      if (result.refused === "invalid_request")
        logger.warn("[Products API] ad words refused", {
          event: "products.ad_words_refused",
          workspaceId,
          adId,
          issues: result.issues ?? [],
        });
      return productsFail(
        result.refused,
        result.refused === "ad_not_found"
          ? 404
          : result.refused === "ad_not_ready"
            ? 409
            : 400,
        result.refused === "invalid_request" && result.issues?.length
          ? { issues: result.issues.slice(0, 3) }
          : {}
      );
    }
    return productsJson(
      { ad: result.ad } satisfies ProductAdResponse,
      result.started ? 202 : 200
    );
  } catch (error) {
    logger.error("[Products API] ad PATCH failed", error, {
      event: "products.ad_update_failed",
      workspaceId,
      adId,
    });
    return productsFail("ad_unavailable", 503);
  }
}
