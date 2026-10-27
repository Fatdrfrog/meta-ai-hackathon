import "server-only";
import { getAuthenticatedWorkspaceMembership } from "@/lib/auth/workspace-membership";
import { isCompanyAdminRole } from "@/lib/supabase/company-users";
import { isWorkspaceFeatureEnabled } from "@/lib/workspace-feature-flags";

export type ProductsAccess =
  | { error: Response }
  | { userId: string; enabled: boolean; isAdmin: boolean };

/**
 * Products is for the workspace's admins, behind the `products` flag.
 * Membership is checked first (its 401/403 as is), so only a member learns
 * the flag's value.
 */
export async function resolveProductsAccess(
  workspaceId: string
): Promise<ProductsAccess> {
  const access = await getAuthenticatedWorkspaceMembership(workspaceId);
  if (access.error) return { error: access.error };
  const enabled = await isWorkspaceFeatureEnabled(
    workspaceId,
    "products"
  ).catch(() => false);
  return {
    userId: access.user.id,
    enabled,
    isAdmin: isCompanyAdminRole(access.membership.role),
  };
}
