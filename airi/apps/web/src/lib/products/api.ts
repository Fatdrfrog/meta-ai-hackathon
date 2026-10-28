import "server-only";
import { noStoreJson } from "@/lib/http/no-store-json";
import { resolveProductsAccess } from "@/lib/products/access";
import type {
  ProductsErrorBody,
  ProductsErrorCode,
} from "@/lib/products/types";

// What every Products API route shares: its gate and its answers.

const ERROR_MESSAGES: Record<ProductsErrorCode, string> = {
  feature_disabled: "Feature disabled",
  admin_required: "Workspace admin access required",
  load_failed: "Products could not be loaded",
  invalid_request: "The request is invalid",
  video_not_found: "That video wasn't found in this workspace",
  import_not_found: "That import wasn't found",
  import_unavailable: "The import couldn't be started",
  product_not_found: "That product wasn't found",
  save_failed: "The change couldn't be saved",
};

export const productsJson = (data: unknown, status = 200) =>
  noStoreJson(data, status, { cacheControl: "private, no-store" });

export const productsFail = (code: ProductsErrorCode, status: number) =>
  productsJson(
    { error: ERROR_MESSAGES[code], code } satisfies ProductsErrorBody,
    status
  );

/**
 * Admins only, behind the `products` flag. Gives the user id, or the answer
 * to send instead: membership's own 401/403, 404 while the flag is off, 403
 * for a member who isn't an admin.
 */
export async function requireProductsAdmin(
  workspaceId: string
): Promise<{ userId: string } | { response: Response }> {
  const access = await resolveProductsAccess(workspaceId);
  if ("error" in access) return { response: access.error };
  if (!access.enabled)
    return { response: productsFail("feature_disabled", 404) };
  if (!access.isAdmin) return { response: productsFail("admin_required", 403) };
  return { userId: access.userId };
}
