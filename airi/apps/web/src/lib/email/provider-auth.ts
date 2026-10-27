import { createClient } from "@/lib/supabase/server";
import { isCompanyAdminRole } from "@/lib/supabase/company-users";
import { getWorkspaceMemberRole } from "@/lib/supabase/queries";

export function getWorkspaceMembershipRole(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
  workspaceId: string;
}): Promise<string | null> {
  return getWorkspaceMemberRole(
    params.supabase,
    params.userId,
    params.workspaceId
  );
}

export function canManageEmailProvider(role: string | null): boolean {
  return isCompanyAdminRole(role);
}
