import "server-only";

import type { createClient } from "@/lib/supabase/server";
import {
  readTrimmedString,
  firstOrSelf,
} from "@icecore/shared/lib/value-utils";

export const AIRI_CHAT_CREATIVE_ASSETS_COMPANY_ID =
  "d81123b4-b2fa-49d3-86af-25b4482b8269";
export const AIRI_CHAT_CREATIVE_ASSETS_WORKSPACE_ID =
  "41b51d55-697c-4455-875a-9a7238bdf272";

type SupabaseWorkspaceClient = Pick<
  Awaited<ReturnType<typeof createClient>>,
  "from"
>;

type WorkspaceCompanyRow = {
  id?: string | null;
  company_id?: string | null;
  companies?: { id?: string | null } | Array<{ id?: string | null }> | null;
};

export function isAiriChatCreativeAssetsWorkspace(params: {
  workspaceId: string | null | undefined;
  workspaceCompanyId: string | null | undefined;
  joinedCompanyId: string | null | undefined;
}): boolean {
  const workspaceId = readTrimmedString(params.workspaceId);
  const workspaceCompanyId = readTrimmedString(params.workspaceCompanyId);
  const joinedCompanyId = readTrimmedString(params.joinedCompanyId);

  return (
    workspaceId === AIRI_CHAT_CREATIVE_ASSETS_WORKSPACE_ID ||
    workspaceCompanyId === AIRI_CHAT_CREATIVE_ASSETS_COMPANY_ID ||
    joinedCompanyId === AIRI_CHAT_CREATIVE_ASSETS_COMPANY_ID
  );
}

export async function canUsePlatformGreenScreenGeneration(params: {
  supabase: SupabaseWorkspaceClient;
  workspaceId: string;
}): Promise<boolean> {
  const { data, error } = await params.supabase
    .from("workspaces")
    .select("id, company_id, companies!workspaces_company_id_fkey(id)")
    .eq("id", params.workspaceId)
    .maybeSingle();

  const workspace = data as WorkspaceCompanyRow | null;
  const company = firstOrSelf(workspace?.companies);

  return (
    isAiriChatCreativeAssetsWorkspace({
      workspaceId: workspace?.id || params.workspaceId,
      workspaceCompanyId: workspace?.company_id || null,
      joinedCompanyId: company?.id || null,
    }) && !error
  );
}
