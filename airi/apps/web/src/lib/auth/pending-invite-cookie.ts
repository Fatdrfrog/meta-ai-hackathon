export const PENDING_TEAM_INVITE_COOKIE_NAME = "airi_pending_team_invite";
export const PENDING_TEAM_INVITE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export function buildPendingTeamInviteCookie(token: string): string {
  return [
    `${PENDING_TEAM_INVITE_COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Max-Age=${PENDING_TEAM_INVITE_COOKIE_MAX_AGE_SECONDS}`,
    "Path=/",
    "SameSite=Lax",
  ].join("; ");
}

export function buildClearPendingTeamInviteCookie(): string {
  return [
    `${PENDING_TEAM_INVITE_COOKIE_NAME}=`,
    "Max-Age=0",
    "Path=/",
    "SameSite=Lax",
  ].join("; ");
}

export function readPendingTeamInviteTokenFromCookieHeader(
  cookieHeader: string | null | undefined
): string {
  if (!cookieHeader) {
    return "";
  }

  const cookie = cookieHeader
    .split(";")
    .map(part => part.trim())
    .find(part => part.startsWith(`${PENDING_TEAM_INVITE_COOKIE_NAME}=`));

  if (!cookie) {
    return "";
  }

  const value = cookie.slice(PENDING_TEAM_INVITE_COOKIE_NAME.length + 1);

  try {
    return decodeURIComponent(value).trim();
  } catch {
    return "";
  }
}
