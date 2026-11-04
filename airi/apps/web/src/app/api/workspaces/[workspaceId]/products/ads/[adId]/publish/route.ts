import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import {
  isAdObjectId,
  parseProductAdPublishRequest,
} from "@/lib/products/ad-request";
import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import { publishProductAd } from "@/lib/products/meta-publish";
import type { ProductAdPublishResponse } from "@/lib/products/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One request advances the post at most about 8 s; the page polls the rest.
export const maxDuration = 30;

type Context = { params: Promise<{ workspaceId: string; adId: string }> };

/**
 * "Post" on Instagram (`ProductAdPublishRequest`), after its confirm: 202
 * with the post, stored and advanced as far as one request goes (its
 * container made; a picture may already be live). The same request id
 * answers the same post (200). Refusals, before anything is stored: 400
 * invalid_request (with the first issues: a picture the latest video
 * hasn't, a caption too long), 404 ad_not_found, 409 ad_not_ready,
 * price_to_check, instagram_not_connected, instagram_quota or post_busy.
 */
export async function POST(request: Request, { params }: Context) {
  const { workspaceId, adId } = await params;
  const body: unknown = await request.json().catch(() => null);
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    if (!isAdObjectId(adId)) return productsFail("ad_not_found", 404);
    const parsed = parseProductAdPublishRequest(body);
    if ("issues" in parsed)
      return productsFail("invalid_request", 400, {
        issues: parsed.issues.slice(0, 3),
      });
    await connectDB();
    const result = await publishProductAd({
      workspaceId,
      adId: adId.toLowerCase(),
      request: parsed.request,
    });
    if ("refused" in result) {
      if (result.refused === "invalid_request")
        return productsFail("invalid_request", 400, {
          issues: result.issues.slice(0, 3),
        });
      return productsFail(
        result.refused,
        result.refused === "ad_not_found" ? 404 : 409
      );
    }
    return productsJson(
      { post: result.post } satisfies ProductAdPublishResponse,
      result.created ? 202 : 200
    );
  } catch (error) {
    logger.error("[Products API] ad publish failed", error, {
      event: "products.ad_publish_failed",
      workspaceId,
      adId,
    });
    return productsFail("post_failed", 503);
  }
}
