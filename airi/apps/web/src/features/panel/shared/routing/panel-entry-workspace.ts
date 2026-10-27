import type { SupabaseClient, User } from "@supabase/supabase-js";
import { panelWorkspaceAiriHref } from "./hrefs";
import {
  getWorkspaceIdFromPanelPath,
  normalizeStoredLastVisitedPath,
} from "./last-visited-page";

type UserMetadata = { last_workspace_id?: string } & Record<string, unknown>;
type PanelEntrySupabaseClient = Pick<SupabaseClient, "from">;
type PanelEntryUser = Pick<User, "id" | "user_metadata">;

type UserNavigationStateRow = {
  last_visited_path?: string | null;
  last_visited_workspace_id?: string | null;
};

async function hasWorkspaceAccess(
  supabase: PanelEntrySupabaseClient,
  userId: string,
  workspaceId: string
): Promise<boolean> {
  const { data: access, error } = await supabase
    .from("company_users")
    .select("user_id")
    .eq("user_id", userId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  return !error && Boolean(access);
}

async function getFirstWorkspaceId(
  supabase: PanelEntrySupabaseClient,
  userId: string
): Promise<string | null> {
  const { data: firstWorkspace } = await supabase
    .from("company_users")
    .select("workspace_id")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1);

  return firstWorkspace?.[0]?.workspace_id ?? null;
}

export async function getPanelEntryRedirectPath(
  supabase: PanelEntrySupabaseClient,
  user: PanelEntryUser
): Promise<string | null> {
  const { data: navigationState } = await supabase
    .from("user_navigation_state")
    .select("last_visited_path, last_visited_workspace_id")
    .eq("user_id", user.id)
    .maybeSingle();
  const savedState = (navigationState as UserNavigationStateRow | null) ?? null;

  if (savedState?.last_visited_path && savedState.last_visited_workspace_id) {
    const normalized = normalizeStoredLastVisitedPath(
      savedState.last_visited_path
    );
    if (
      normalized.ok &&
      normalized.workspaceId === savedState.last_visited_workspace_id &&
      (await hasWorkspaceAccess(supabase, user.id, normalized.workspaceId))
    ) {
      return normalized.path;
    }
  }

  const metadata = (user.user_metadata || null) as UserMetadata | null;
  const lastWorkspaceId = metadata?.last_workspace_id;

  if (lastWorkspaceId) {
    if (await hasWorkspaceAccess(supabase, user.id, lastWorkspaceId)) {
      return panelWorkspaceAiriHref(lastWorkspaceId);
    }
  }

  const firstWorkspaceId = await getFirstWorkspaceId(supabase, user.id);
  return firstWorkspaceId ? panelWorkspaceAiriHref(firstWorkspaceId) : null;
}

export async function getPanelEntryWorkspaceId(
  supabase: PanelEntrySupabaseClient,
  user: PanelEntryUser
) {
  const path = await getPanelEntryRedirectPath(supabase, user);
  return path ? getWorkspaceIdFromPanelPath(path) : null;
}
