import { Alert, AlertDescription } from "@/components/ui/alert";
import { ErrorState } from "@/components/ui/async-states";
import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import { isCompanyAdminRole } from "@/lib/supabase/company-users";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { CustomerApiSettings } from "./customer-api-settings";

export default async function CustomerApiSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const [t, { supabase, user }] = await Promise.all([
    getTranslations("CustomerApiSettings"),
    getReadOnlySupabaseContext(),
  ]);
  if (!user) redirect("/login");
  const { data: membership, error } = await supabase
    .from("company_users")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!error && !membership) redirect("/panel");
  const canManage = isCompanyAdminRole(membership?.role);

  return (
    <div className="min-w-0 space-y-5">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold tracking-tight">{t("title")}</h3>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      {error ? (
        <ErrorState message={t("loadError")} />
      ) : canManage ? (
        <CustomerApiSettings key={workspaceId} workspaceId={workspaceId} />
      ) : (
        <Alert>
          <AlertDescription>{t("adminOnly")}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
