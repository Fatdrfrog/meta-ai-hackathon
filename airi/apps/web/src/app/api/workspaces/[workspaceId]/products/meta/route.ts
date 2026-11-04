import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import { productsMetaReadiness } from "@/lib/products/meta-publish";
import type { ProductsMetaReadinessResponse } from "@/lib/products/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string }> };

/**
 * What the workspace can do on Meta now (`ProductsMetaReadiness`):
 * Instagram, Meta Ads and the Page's WhatsApp link, the WhatsApp number, and
 * whether AI is stopped. Booleans, names and counts only, never a token or
 * an id. Cached 60 s per workspace (15 s while something isn't ready);
 * `?fresh=1` reads again ("Check again").
 */
export async function GET(request: Request, { params }: Context) {
  const { workspaceId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    const fresh = new URL(request.url).searchParams.get("fresh") === "1";
    // The admission check reads the ledger; the WhatsApp number reads Mongo.
    await connectDB();
    const meta = await productsMetaReadiness(workspaceId, { fresh });
    return productsJson({ meta } satisfies ProductsMetaReadinessResponse);
  } catch (error) {
    logger.error("[Products API] meta readiness failed", error, {
      event: "products.meta_readiness_failed",
      workspaceId,
    });
    return productsFail("load_failed", 503);
  }
}
