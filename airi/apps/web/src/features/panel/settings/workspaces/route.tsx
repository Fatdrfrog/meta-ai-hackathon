import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/async-states";
import { panelWorkspaceAiriHref } from "@/features/panel/shared/routing/hrefs";
import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import {
  getCompanyIdForWorkspace,
  getSingleRelation,
  isCompanyAdminRole,
} from "@/lib/supabase/company-users";
import { createClient } from "@/lib/supabase/server";
import { createWorkspaceForCompany } from "@/lib/workspaces/create-workspace";
import { getTranslations } from "next-intl/server";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { WorkspaceCreateForm } from "./workspace-create-form";

type WorkspaceSettingsSearchParams = {
  createWorkspaceError?: string | string[];
};
type WorkspaceItem = { id: string; name: string; company_id: string };
type MembershipRow = {
  role: string;
  workspaces: WorkspaceItem | WorkspaceItem[] | null;
};

export default async function WorkspaceSettings({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<WorkspaceSettingsSearchParams>;
}) {
  const [{ workspaceId }, { supabase, user }, t, query] = await Promise.all([
    params,
    getReadOnlySupabaseContext(),
    getTranslations("Workspaces"),
    searchParams ?? Promise.resolve({} as WorkspaceSettingsSearchParams),
  ]);
  if (!user) redirect("/login");

  const [membership, memberships] = await Promise.all([
    supabase
      .from("company_users")
      .select("workspace_id")
      .eq("user_id", user.id)
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
    supabase
      .from("company_users")
      .select("role, workspaces!fk_workspace(id, name, company_id)")
      .eq("user_id", user.id),
  ]);
  if (membership.error || memberships.error)
    return <ErrorState message={t("loadError")} />;
  if (!membership.data) redirect("/panel");
  const companyId = await getCompanyIdForWorkspace(supabase, workspaceId);
  if (!companyId) return <ErrorState message={t("loadError")} />;
  const rows = (memberships.data ?? []) as unknown as MembershipRow[];
  const items = Array.from(
    new Map(
      rows.flatMap(row => {
        const workspace = getSingleRelation(row.workspaces);
        return workspace ? [[workspace.id, workspace] as const] : [];
      })
    ).values()
  );
  const canCreate = rows.some(
    row =>
      getSingleRelation(row.workspaces)?.company_id === companyId &&
      isCompanyAdminRole(row.role)
  );
  const rawError = query.createWorkspaceError;
  const error = Array.isArray(rawError) ? rawError[0] : rawError;
  const errorKey =
    error === "trial"
      ? "trialError"
      : error === "limit"
        ? "limitError"
        : error === "forbidden"
          ? "permissionError"
          : error === "invalid"
            ? "nameError"
            : error === "failed"
              ? "createError"
              : null;

  async function createWorkspace(formData: FormData) {
    "use server";
    const client = await createClient();
    const {
      data: { user: currentUser },
    } = await client.auth.getUser();
    if (!currentUser) redirect("/login");
    const name = String(formData.get("name") || "").trim();
    if (name.length < 2 || name.length > 100)
      redirect(
        `/panel/w/${workspaceId}/settings/workspaces?createWorkspaceError=invalid`
      );
    let result;
    try {
      result = await createWorkspaceForCompany({
        supabase: client,
        user: currentUser,
        name,
        companyId: companyId!,
      });
    } catch {
      redirect(
        `/panel/w/${workspaceId}/settings/workspaces?createWorkspaceError=failed`
      );
    }
    if (!result.ok) {
      const code =
        result.status === 402
          ? result.limit.trialExpired
            ? "trial"
            : "limit"
          : result.status === 403
            ? "forbidden"
            : "failed";
      redirect(
        `/panel/w/${workspaceId}/settings/workspaces?createWorkspaceError=${code}`
      );
    }
    redirect(panelWorkspaceAiriHref(result.workspace.id));
  }

  return (
    <div className="min-w-0 max-w-3xl space-y-4">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold tracking-tight">
          {t("workspaces")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t("workspaceRoutingDescription")}
        </p>
      </div>
      <Card className="gap-0 overflow-hidden shadow-none">
        {items.length ? (
          <ul className="divide-y">
            {items.map(workspace => (
              <li
                key={workspace.id}
                className="flex min-w-0 items-center gap-3 px-4 py-3 sm:px-5"
              >
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium">
                    {workspace.name}
                  </p>
                  {workspace.id === workspaceId && (
                    <Badge variant="secondary" className="mt-1 text-xs">
                      {t("currentWorkspace")}
                    </Badge>
                  )}
                </div>
                <Button asChild variant="ghost" size="sm" className="shrink-0">
                  <Link
                    href={panelWorkspaceAiriHref(workspace.id)}
                    aria-label={t("openWorkspaceNamed", {
                      name: workspace.name,
                    })}
                  >
                    {t("openWorkspace")}
                    <ArrowUpRight className="size-4" />
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="p-5 text-sm text-muted-foreground">
            {t("emptyWorkspaces")}
          </p>
        )}
      </Card>
      {errorKey && <ErrorState message={t(errorKey)} />}
      {canCreate ? (
        <Card className="gap-0 shadow-none">
          <CardContent className="space-y-3 p-4 sm:p-5">
            <h4 className="text-sm font-medium">{t("createWorkspace")}</h4>
            <WorkspaceCreateForm action={createWorkspace} />
          </CardContent>
        </Card>
      ) : (
        <p className="text-xs text-muted-foreground">{t("permissionError")}</p>
      )}
    </div>
  );
}
