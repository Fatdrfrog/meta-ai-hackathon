import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import { isAdObjectId } from "@/lib/products/ad-request";
import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import { advanceProductAdPost } from "@/lib/products/meta-publish";
import type { ProductAdPublishResponse } from "@/lib/products/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One request advances the post at most about 8 s; the page polls the rest.
export const maxDuration = 30;

type Context = {
  params: Promise<{ workspaceId: string; adId: string; postId: string }>;
};

/**
 * One Instagram post of the ad, advanced first as far as one request goes
 * (Instagram processing it, then published with its permalink, or failed
 * with Meta's reason). The workbench asks every 3 s while it's in flight.
 * 404 ad_not_found or post_not_found.
 */
export async function GET(_request: Request, { params }: Context) {
  const { workspaceId, adId, postId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    if (!isAdObjectId(adId)) return productsFail("ad_not_found", 404);
    if (!isAdObjectId(postId)) return productsFail("post_not_found", 404);
    await connectDB();
    const result = await advanceProductAdPost({
      workspaceId,
      adId: adId.toLowerCase(),
      postId: postId.toLowerCase(),
    });
    if ("refused" in result) return productsFail(result.refused, 404);
    return productsJson({
      post: result.post,
    } satisfies ProductAdPublishResponse);
  } catch (error) {
    logger.error("[Products API] ad post GET failed", error, {
      event: "products.ad_post_load_failed",
      workspaceId,
      adId,
      postId,
    });
    return productsFail("load_failed", 503);
  }
}
