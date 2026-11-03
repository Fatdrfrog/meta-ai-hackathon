import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import { readProductKit } from "@/lib/products/kits";
import type { ProductKitResponse } from "@/lib/products/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string; kitId: string }> };

/**
 * One kit as it now is: a part stuck making times out, and a carousel Meta
 * is still checking has its verdict read again (at most once a minute).
 */
export async function GET(_request: Request, { params }: Context) {
  const { workspaceId, kitId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    await connectDB();
    const kit = await readProductKit(workspaceId, kitId);
    if (!kit) return productsFail("kit_not_found", 404);
    return productsJson({ kit } satisfies ProductKitResponse);
  } catch (error) {
    logger.error("[Products API] kit GET failed", error, {
      event: "products.kit_read_failed",
      workspaceId,
      kitId,
    });
    return productsFail("load_failed", 503);
  }
}
