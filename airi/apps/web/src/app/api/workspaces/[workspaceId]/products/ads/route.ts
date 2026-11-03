import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import { parseProductAdCreateRequest } from "@/lib/products/ad-request";
import { createProductAd } from "@/lib/products/ads";
import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import type { ProductAdResponse } from "@/lib/products/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string }> };

/**
 * Makes a video ad of 1 to 3 shelf products from the owner's brief
 * (`ProductAdCreateRequest`) and starts its first run: 201 with the ad. The
 * same requestId answers with the ad it already made. Refused with 409 when
 * a product has no photo or price (not_enough_products), when the ad would
 * draw letters its fonts lack (ad_letters_unsupported), or when the
 * workspace can't pay for the AI action (trial_ended, spend_limit,
 * ai_actions_used).
 */
export async function POST(request: Request, { params }: Context) {
  const { workspaceId } = await params;
  const body: unknown = await request.json().catch(() => null);
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    const brief = parseProductAdCreateRequest(body);
    if (!brief) return productsFail("invalid_request", 400);
    await connectDB();
    const result = await createProductAd({
      workspaceId,
      userId: access.userId,
      request: brief,
    });
    if ("refused" in result) return productsFail(result.refused, 409);
    return productsJson(
      { ad: result.ad } satisfies ProductAdResponse,
      result.created ? 201 : 200
    );
  } catch (error) {
    logger.error("[Products API] ad POST failed", error, {
      event: "products.ad_create_failed",
      workspaceId,
    });
    return productsFail("ad_unavailable", 503);
  }
}
