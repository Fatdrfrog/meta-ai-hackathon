import { CreativeAssetEditorWorkspace } from "@/components/assets/creative-asset-editor-workspace";
import { panelWorkspaceAiriHref } from "@/features/panel/shared/routing/hrefs";
import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import { redirect } from "next/navigation";

type Params = Promise<{ workspaceId: string; assetId: string }>;

export default async function CreativeAssetEditorPage({
  params,
}: {
  params: Params;
}) {
  const [{ workspaceId, assetId }, { supabase, user }] = await Promise.all([
    params,
    getReadOnlySupabaseContext(),
  ]);

  if (!user) {
    redirect("/login");
  }

  const { data: membership } = await supabase
    .from("company_users")
    .select("workspace_id")
    .eq("user_id", user.id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (!membership?.workspace_id) {
    redirect(panelWorkspaceAiriHref(workspaceId));
  }

  return (
    <CreativeAssetEditorWorkspace workspaceId={workspaceId} assetId={assetId} />
  );
}
