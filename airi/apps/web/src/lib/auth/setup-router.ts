import { panelWorkspaceAiriHref } from "@/features/panel/shared/routing/hrefs";
import { hasPendingInviteMetadata } from "@/lib/auth/invite-metadata";

type SetupRouterUser = {
  user_metadata?: Record<string, unknown> | null;
} | null;

export type SetupRouterState = {
  user: SetupRouterUser;
  firstWorkspaceId: string | null;
};

export function hasCompletedProfile(
  metadata: Record<string, unknown> | null | undefined
): boolean {
  const fullName = metadata?.full_name;
  return typeof fullName === "string" && fullName.trim().length > 0;
}

export function resolveSetupRouterRedirect({
  user,
  firstWorkspaceId,
}: SetupRouterState): string {
  if (!user) {
    return "/login";
  }

  const metadata = user.user_metadata;

  if (!firstWorkspaceId && hasPendingInviteMetadata(metadata)) {
    return "/auth/confirm/process-invite";
  }

  if (!hasCompletedProfile(metadata) || !firstWorkspaceId) {
    return "/setup";
  }

  return panelWorkspaceAiriHref(firstWorkspaceId);
}
