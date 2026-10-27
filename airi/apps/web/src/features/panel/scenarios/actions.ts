"use server";

import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import { getRegisteredBusinessPhoneAudienceSummary } from "@/lib/customers/registration-contact";
import { isRegisteredUsersEmailAudienceEnabledForWorkspace } from "@/lib/email/registered-users-audience";
import type { RegisteredBusinessPhonesAudienceSummary } from "@/lib/campaign/bulk-campaign-contracts";

export async function loadRegisteredBusinessPhonesAudienceAction(
  workspaceId: string
): Promise<RegisteredBusinessPhonesAudienceSummary | null> {
  const { supabase, user } = await getReadOnlySupabaseContext();
  if (!user) return null;

  const { data: membership } = await supabase
    .from("company_users")
    .select("workspace_id")
    .eq("user_id", user.id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!membership) return null;

  const enabled = await isRegisteredUsersEmailAudienceEnabledForWorkspace({
    workspaceId,
  });
  if (!enabled) return null;

  return getRegisteredBusinessPhoneAudienceSummary({
    workspaceId,
    previewLimit: 50,
  }).catch(() => null);
}
