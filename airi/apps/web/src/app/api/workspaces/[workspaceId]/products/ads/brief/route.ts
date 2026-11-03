import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import { parseAdProductIds } from "@/lib/products/ad-request";
import { loadProductAdBrief } from "@/lib/products/ads";
import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import type { ProductAdBriefResponse } from "@/lib/products/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string }> };

/**
 * What the brief for a new ad starts from, before anything is spent
 * (`?products=<id>,<id>`, 1 to 3): the products as the ad would show them
 * and whether each can be in one, the language, the person from the video,
 * the ending, and what stops the workspace paying for the AI action now.
 */
export async function GET(request: Request, { params }: Context) {
  const { workspaceId } = await params;
  const asked = new URL(request.url).searchParams.get("products") ?? "";
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    const productIds = parseAdProductIds(
      asked
        .split(",")
        .map(id => id.trim())
        .filter(Boolean)
    );
    if (!productIds) return productsFail("invalid_request", 400);
    await connectDB();
    const brief = await loadProductAdBrief(workspaceId, productIds);
    return productsJson({ brief } satisfies ProductAdBriefResponse);
  } catch (error) {
    logger.error("[Products API] ad brief GET failed", error, {
      event: "products.ad_brief_failed",
      workspaceId,
    });
    return productsFail("load_failed", 503);
  }
}
