import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import { noStoreJson } from "@/lib/http/no-store-json";
import { resolveProductsAccess } from "@/lib/products/access";
import { listPublishedProducts } from "@/lib/products/store";
import type {
  ProductsErrorBody,
  ProductsErrorCode,
  ProductsListResponse,
} from "@/lib/products/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string }> };

const ERROR_MESSAGES: Record<ProductsErrorCode, string> = {
  feature_disabled: "Feature disabled",
  admin_required: "Workspace admin access required",
  load_failed: "Products could not be loaded",
};

const json = (data: unknown, status = 200) =>
  noStoreJson(data, status, { cacheControl: "private, no-store" });

const fail = (code: ProductsErrorCode, status: number) =>
  json(
    { error: ERROR_MESSAGES[code], code } satisfies ProductsErrorBody,
    status
  );

/** The workspace's published products (Products). Admins only, behind the flag. */
export async function GET(_request: Request, { params }: Context) {
  const { workspaceId } = await params;
  try {
    const access = await resolveProductsAccess(workspaceId);
    if ("error" in access) return access.error;
    if (!access.enabled) return fail("feature_disabled", 404);
    if (!access.isAdmin) return fail("admin_required", 403);
    await connectDB();
    const products = await listPublishedProducts(workspaceId);
    return json({ products } satisfies ProductsListResponse);
  } catch (error) {
    logger.error("[Products API] GET failed", error, {
      event: "products.list_failed",
      workspaceId,
    });
    return fail("load_failed", 503);
  }
}
