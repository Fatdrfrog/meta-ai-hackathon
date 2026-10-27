import { TeamManagementClientPage } from "@/components/team/team-management-client-page";
import { ErrorState } from "@/components/ui/async-states";
import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import type { TeamMembers } from "@/types/supabase";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

async function getTeamData(workspaceId: string) {
  const { supabase, user } = await getReadOnlySupabaseContext();
  if (!user) redirect("/login");
  const { data: membership, error: membershipError } = await supabase
    .from("company_users")
    .select("workspace_id, role")
    .eq("user_id", user.id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (membershipError) return { error: true as const };
  if (!membership) redirect("/panel");

  const { data, error } = await supabase
    .from("company_users")
    .select("id, role, user_id, email, users(id, full_name, avatar_url)")
    .eq("workspace_id", workspaceId);
  if (!error)
    return {
      members: (data ?? []) as TeamMembers,
      userId: user.id,
      role: membership.role,
    };

  const fallback = await supabase
    .from("company_users")
    .select("id, role, user_id, email")
    .eq("workspace_id", workspaceId);
  if (fallback.error) return { error: true as const };
  return {
    members: (fallback.data ?? []).map(member => ({
      ...member,
      users: null,
    })) as TeamMembers,
    userId: user.id,
    role: membership.role,
  };
}

export default async function TeamSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const [t, team] = await Promise.all([
    getTranslations("TeamSettings"),
    getTeamData(workspaceId),
  ]);
  return (
    <div className="min-w-0 space-y-4">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold tracking-tight">{t("title")}</h3>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      {"error" in team ? (
        <ErrorState message={t("loadError")} />
      ) : (
        <TeamManagementClientPage
          key={workspaceId}
          initialMembers={team.members}
          workspaceId={workspaceId}
          currentUserId={team.userId}
          currentRole={team.role}
        />
      )}
    </div>
  );
}
