import { logger } from "@/lib/logger";
import { noStoreJson } from "@/lib/http/no-store-json";
import { resolveProductsAccess } from "@/lib/products/access";
import type { ProductsAccessResponse } from "@/lib/products/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ workspaceId: string }> };

const json = (data: ProductsAccessResponse) =>
  noStoreJson(data, 200, { cacheControl: "private, no-store" });

/**
 * Whether the sidebar shows Products to this member: the flag is on and
 * they're an admin. The sidebar has no role of its own to decide with.
 */
export async function GET(_request: Request, { params }: Context) {
  const { workspaceId } = await params;
  try {
    const access = await resolveProductsAccess(workspaceId);
    if ("error" in access) return access.error;
    return json({ available: access.enabled && access.isAdmin });
  } catch (error) {
    logger.error("[Products API] access check failed", error, {
      event: "products.access_failed",
      workspaceId,
    });
    // Hiding an entry is the safe answer; the page itself checks again.
    return json({ available: false });
  }
}
