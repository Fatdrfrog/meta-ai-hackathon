import { panelWorkspaceAiriHref } from "@/features/panel/shared/routing/hrefs";

export type PublicKBHeaderViewer = {
  isAuthenticated: boolean;
  panelHref?: string;
};

type PublicKBUser = {
  id: string;
};

export type PublicKBMembership = {
  workspace_id: string | null;
};

export function buildPublicKBHeaderViewer(
  user: PublicKBUser | null,
  memberships: readonly PublicKBMembership[] | null | undefined,
  currentWorkspaceId: string
): PublicKBHeaderViewer {
  if (!user) {
    return { isAuthenticated: false };
  }

  const workspaceId =
    memberships?.find(
      membership => membership.workspace_id === currentWorkspaceId
    )?.workspace_id ??
    memberships?.find(membership => Boolean(membership.workspace_id))
      ?.workspace_id ??
    null;

  return {
    isAuthenticated: true,
    panelHref: workspaceId ? panelWorkspaceAiriHref(workspaceId) : "/panel",
  };
}

export async function getPublicKBHeaderViewer(params: {
  currentWorkspaceId: string;
  getUser: () => Promise<PublicKBUser | null>;
  getMemberships: (
    userId: string
  ) => Promise<readonly PublicKBMembership[] | null | undefined>;
}): Promise<PublicKBHeaderViewer> {
  const user = await params.getUser();

  if (!user) {
    return buildPublicKBHeaderViewer(null, [], params.currentWorkspaceId);
  }

  const memberships = await params.getMemberships(user.id);

  return buildPublicKBHeaderViewer(
    user,
    memberships,
    params.currentWorkspaceId
  );
}
