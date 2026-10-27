import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import {
  productsFail,
  productsJson,
  requireProductsAdmin,
} from "@/lib/products/api";
import { listPublishedProducts } from "@/lib/products/store";
import type { ProductsListResponse } from "@/lib/products/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string }> };

/** The workspace's published products (Products). Admins only, behind the flag. */
export async function GET(_request: Request, { params }: Context) {
  const { workspaceId } = await params;
  try {
    const access = await requireProductsAdmin(workspaceId);
    if ("response" in access) return access.response;
    await connectDB();
    const products = await listPublishedProducts(workspaceId);
    return productsJson({ products } satisfies ProductsListResponse);
  } catch (error) {
    logger.error("[Products API] GET failed", error, {
      event: "products.list_failed",
      workspaceId,
    });
    return productsFail("load_failed", 503);
  }
}
