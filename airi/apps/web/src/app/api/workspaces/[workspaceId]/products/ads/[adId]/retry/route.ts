import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import { isAdObjectId } from "@/lib/products/ad-request";
import { retryProductAd } from "@/lib/products/ads";
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
 * "Try again" on a failed ad: 202 with the ad, a new run resuming it that
 * reuses the pictures already made. 409 when the workspace can't pay for AI
 * now (trial_ended, spend_limit, ai_actions_used). On a ready ad whose
 * latest "Update the video" or "New picture" failed, 202 with the video
 * being made again from what's saved, for free. Any other ad answers 200 as
 * it is.
 */
export async function POST(_request: Request, { params }: Context) {
  const { workspaceId, adId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    if (!isAdObjectId(adId)) return productsFail("ad_not_found", 404);
    await connectDB();
    const result = await retryProductAd({
      workspaceId,
      adId: adId.toLowerCase(),
    });
    if ("refused" in result)
      return productsFail(
        result.refused,
        result.refused === "ad_not_found" ? 404 : 409
      );
    return productsJson(
      { ad: result.ad } satisfies ProductAdResponse,
      result.started ? 202 : 200
    );
  } catch (error) {
    logger.error("[Products API] ad retry failed", error, {
      event: "products.ad_retry_failed",
      workspaceId,
      adId,
    });
    return productsFail("ad_unavailable", 503);
  }
}
