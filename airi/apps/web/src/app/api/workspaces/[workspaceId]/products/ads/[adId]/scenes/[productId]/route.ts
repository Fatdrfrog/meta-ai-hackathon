import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import {
  isAdObjectId,
  parseProductAdSceneRequest,
} from "@/lib/products/ad-request";
import { redoProductAdScene } from "@/lib/products/ads";
import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import type { ProductAdResponse } from "@/lib/products/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Context = {
  params: Promise<{ workspaceId: string; adId: string; productId: string }>;
};

/**
 * "New picture" on one scene of a ready ad (`ProductAdSceneRequest`): 202
 * with the ad, a scene run started that pays only for that scene, with any
 * pending free changes in it. The same press sent again answers 200 with
 * the ad as it is. 400 for a body it can't read or changes that don't fit
 * (with the first issues); 404 for another workspace's ad or a product the
 * ad doesn't show; 409 ad_not_ready unless the ad is ready, no_pictures_left
 * when its AI action has no room for another picture, and the AI ledger's
 * refusals (trial_ended, spend_limit).
 */
export async function POST(request: Request, { params }: Context) {
  const { workspaceId, adId, productId } = await params;
  const body: unknown = await request.json().catch(() => null);
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    if (!isAdObjectId(adId)) return productsFail("ad_not_found", 404);
    if (!isAdObjectId(productId)) return productsFail("product_not_found", 404);
    const press = parseProductAdSceneRequest(body);
    if (!press) return productsFail("invalid_request", 400);
    await connectDB();
    const result = await redoProductAdScene({
      workspaceId,
      adId: adId.toLowerCase(),
      productId: productId.toLowerCase(),
      request: press,
    });
    if ("refused" in result) {
      const { refused } = result;
      if (refused === "invalid_request")
        logger.warn("[Products API] ad scene changes refused", {
          event: "products.ad_scene_refused",
          workspaceId,
          adId,
          issues: result.issues ?? [],
        });
      return productsFail(
        refused,
        refused === "ad_not_found" || refused === "product_not_found"
          ? 404
          : refused === "invalid_request"
            ? 400
            : 409,
        refused === "invalid_request" && result.issues?.length
          ? { issues: result.issues.slice(0, 3) }
          : {}
      );
    }
    return productsJson(
      { ad: result.ad } satisfies ProductAdResponse,
      result.started ? 202 : 200
    );
  } catch (error) {
    logger.error("[Products API] ad scene POST failed", error, {
      event: "products.ad_scene_failed",
      workspaceId,
      adId,
    });
    return productsFail("ad_unavailable", 503);
  }
}
