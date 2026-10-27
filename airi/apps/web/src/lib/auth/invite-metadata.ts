/**
 * Detects pending invite routing hints, including legacy invites that need
 * reissuing. This is not authorization: processInvite verifies signed proof.
 */
export function hasPendingInviteMetadata(
  metadata: Record<string, unknown> | null | undefined
): boolean {
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  const companyId = metadata.company_id;
  const workspaceId = metadata.workspace_id;
  if (
    typeof metadata.team_invite_token === "string" &&
    metadata.team_invite_token.length > 0
  ) {
    return true;
  }
  return (
    typeof companyId === "string" &&
    companyId.length > 0 &&
    typeof workspaceId === "string" &&
    workspaceId.length > 0
  );
}
