import { AiContextManager } from "@/components/settings/ai-context-manager";
import { AiriQAManager } from "@/components/settings/airi-qa-manager";
import { PublicUrlIndexer } from "@/components/settings/public-url-indexer";
import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { isCompanyAdminRole } from "@/lib/supabase/company-users";

async function getCompanyContext(workspaceId: string) {
  const { supabase, user } = await getReadOnlySupabaseContext();

  if (!user) {
    redirect("/login");
  }

  try {
    const { data: companyUser, error } = await supabase
      .from("company_users")
      .select(
        "role, workspaces!fk_workspace(companies!workspaces_company_id_fkey(dynamic_context_tags))"
      )
      .eq("user_id", user.id)
      .eq("workspace_id", workspaceId)
      .single();

    if (error || !companyUser) return null;

    const workspace = Array.isArray(companyUser?.workspaces)
      ? companyUser.workspaces[0]
      : companyUser?.workspaces;
    const companyData = Array.isArray(workspace?.companies)
      ? workspace.companies[0]
      : workspace?.companies;

    return companyData
      ? {
          tags: companyData.dynamic_context_tags || [],
          canManage: isCompanyAdminRole(companyUser.role),
        }
      : null;
  } catch {
    return null;
  }
}

export default async function AiContextSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const [initialTags, tPage] = await Promise.all([
    getCompanyContext(workspaceId),
    getTranslations("AiContextPage"),
  ]);

  return (
    <div className="@container/ai-context min-w-0 space-y-5 animate-in fade-in-50 duration-500">
      <div className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-xl font-semibold tracking-tight flex items-center gap-2">
            {tPage("pageHeader")}
          </h3>
          <p className="text-sm text-muted-foreground">
            {tPage("pageDescription")}
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <div className="grid min-w-0 items-start gap-4 @min-[48rem]/ai-context:grid-cols-2">
          {initialTags ? (
            <AiContextManager
              key={workspaceId}
              initialTags={initialTags.tags}
              readOnly={!initialTags.canManage}
            />
          ) : (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 p-4 text-sm"
            >
              {tPage("loadFailed")}
            </p>
          )}
          <PublicUrlIndexer />
        </div>
        <AiriQAManager workspaceId={workspaceId} />
      </div>
    </div>
  );
}
