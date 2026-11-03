import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import { isProductKitPart } from "@/lib/products/kit-request";
import { retryProductKitPart } from "@/lib/products/kits";
import type { ProductKitResponse } from "@/lib/products/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The part is made again inside the request, as the kit made it.
export const maxDuration = 60;

type Context = { params: Promise<{ workspaceId: string; kitId: string }> };

/**
 * Makes one part of a kit again ({part: "orderForm" | "carousel"}): one that
 * wasn't made, or a carousel Meta turned down. The other part is left as it
 * is, and any other part answers with the kit unchanged.
 */
export async function POST(request: Request, { params }: Context) {
  const { workspaceId, kitId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    const body = (await request.json().catch(() => null)) as {
      part?: unknown;
    } | null;
    const part = body?.part;
    if (!isProductKitPart(part)) return productsFail("invalid_request", 400);
    await connectDB();
    const outcome = await retryProductKitPart({
      workspaceId,
      userId: access.userId,
      kitId,
      part,
    });
    if (!outcome) return productsFail("kit_not_found", 404);
    if ("refused" in outcome) return productsFail(outcome.refused, 409);
    return productsJson({ kit: outcome.kit } satisfies ProductKitResponse);
  } catch (error) {
    logger.error("[Products API] kit retry failed", error, {
      event: "products.kit_retry_failed",
      workspaceId,
      kitId,
    });
    return productsFail("draft_failed", 503);
  }
}
