import { SetupWizard } from "@/app/setup/setup-wizard";
import { hasPendingInviteMetadata } from "@/lib/auth/invite-metadata";
import { createReadOnlyClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { hasCompletedProfile } from "../onboarding/setup-router";
import { firstSearchParam } from "@/lib/api/query-params";

type SetupPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SetupPage({ searchParams }: SetupPageProps) {
  const supabase = await createReadOnlyClient();
  const resolvedSearchParams = await searchParams;
  const requestedStep = firstSearchParam(resolvedSearchParams?.step);
  const requestedWorkspaceId = firstSearchParam(
    resolvedSearchParams?.workspaceId
  );
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const metadata = user.user_metadata as Record<string, unknown> | undefined;

  if (hasPendingInviteMetadata(metadata)) {
    redirect("/auth/confirm/process-invite");
  }

  const { data: firstWorkspace } = await supabase
    .from("company_users")
    .select("workspace_id")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1);

  let workspaceId = firstWorkspace?.[0]?.workspace_id as string | undefined;
  if (requestedWorkspaceId) {
    const { data: requestedWorkspace } = await supabase
      .from("company_users")
      .select("workspace_id")
      .eq("user_id", user.id)
      .eq("workspace_id", requestedWorkspaceId)
      .maybeSingle();

    if (requestedWorkspace?.workspace_id) {
      workspaceId = requestedWorkspace.workspace_id as string;
    }
  }

  const requiresProfile = !hasCompletedProfile(metadata);
  const requiresWorkspace = !workspaceId;
  const canOpenTrainingShortcut =
    requestedStep === "train" &&
    Boolean(workspaceId) &&
    (!requestedWorkspaceId || requestedWorkspaceId === workspaceId);

  if (!requiresProfile && !requiresWorkspace && !canOpenTrainingShortcut) {
    redirect("/onboarding");
  }

  const suggestedName =
    typeof metadata?.full_name === "string" && metadata.full_name.trim()
      ? metadata.full_name
      : typeof metadata?.name === "string" && metadata.name.trim()
        ? metadata.name
        : user.email?.split("@")[0] || "";

  return (
    <SetupWizard
      initialFullName={suggestedName}
      initialWorkspaceId={workspaceId}
      initialStep={
        canOpenTrainingShortcut && !requiresProfile ? "product" : "required"
      }
      requiresProfile={requiresProfile}
      requiresWorkspace={requiresWorkspace}
    />
  );
}
