import { getPanelEntryWorkspaceId } from "@/features/panel/shared/routing";
import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import { redirect } from "next/navigation";

export default async function AiContextSourcesRedirectPage() {
  const { supabase, user } = await getReadOnlySupabaseContext();

  if (!user) {
    redirect("/login");
  }

  const workspaceId = await getPanelEntryWorkspaceId(supabase, user);
  if (!workspaceId) {
    redirect("/onboarding");
  }

  redirect(`/panel/w/${workspaceId}/settings/ai-context/sources`);
}
