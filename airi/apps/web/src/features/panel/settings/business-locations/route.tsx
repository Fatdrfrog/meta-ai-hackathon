import { BusinessLocationsManager } from "@/components/settings/business-locations/business-locations-manager";
import { ErrorState } from "@/components/ui/async-states";
import { panelSettingsHref } from "@/features/panel/shared/routing/hrefs";
import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import { isWorkspaceFeatureEnabled } from "@/lib/workspace-feature-flags";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

export default async function BusinessLocationsSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const [{ workspaceId }, { supabase, user }, t] = await Promise.all([
    params,
    getReadOnlySupabaseContext(),
    getTranslations("Settings"),
  ]);

  if (!user) redirect("/login");

  // The flag is read alongside membership, but only a member learns its value.
  const [{ data: companyUser, error: accessError }, enabled] =
    await Promise.all([
      supabase
        .from("company_users")
        .select("workspace_id")
        .eq("user_id", user.id)
        .eq("workspace_id", workspaceId)
        .maybeSingle(),
      isWorkspaceFeatureEnabled(workspaceId, "scenario_location_routing").catch(
        () => false
      ),
    ]);

  if (accessError) return <ErrorState message={t("settingsLoadFailed")} />;
  if (!companyUser) redirect("/panel");
  // Redirect rather than 404, so a saved or switched-to Offices path is safe.
  if (!enabled) redirect(panelSettingsHref(workspaceId));

  return (
    <BusinessLocationsManager key={workspaceId} workspaceId={workspaceId} />
  );
}
