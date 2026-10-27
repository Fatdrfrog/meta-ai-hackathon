import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { LTVConfigForm } from "./components/ltv-config-form";
import { ErrorState } from "@/components/ui/async-states";
import { PageHeader } from "@/components/ui/page-header";

export default async function LTVConfigSettingsPage({
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

  // Verify workspace access
  const { data: companyUser, error: accessError } = await supabase
    .from("company_users")
    .select("workspace_id")
    .eq("user_id", user.id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (accessError) return <ErrorState message={t("settingsLoadFailed")} />;
  if (!companyUser) redirect("/panel");

  const { data: workspace, error: workspaceError } = await supabase
    .from("workspaces")
    .select("ltv_base_value, ltv_currency")
    .eq("id", workspaceId)
    .single();

  return (
    <div className="max-w-2xl space-y-5">
      <PageHeader
        title={t("ltvConfigTitle")}
        description={t("ltvConfigDescription")}
      />
      {workspaceError || !workspace ? (
        <ErrorState message={t("settingsLoadFailed")} />
      ) : (
        <LTVConfigForm
          key={workspaceId}
          workspaceId={workspaceId}
          initialValues={{
            baseValue: workspace.ltv_base_value ?? null,
            currency: workspace.ltv_currency || "USD",
          }}
        />
      )}
    </div>
  );
}
