import { captureFunnelEvent } from "@/lib/funnel-analytics";
import type { User } from "@supabase/supabase-js";

// The callback runs right after Supabase confirms an email or creates an
// OAuth user; older timestamps mean a returning user, not a new step.
const EMAIL_CONFIRMATION_WINDOW_MS = 15 * 60 * 1000;
const NEW_OAUTH_USER_WINDOW_MS = 60 * 1000;

export type AuthCallbackBranch = "token_hash" | "pkce" | "session";

export type AuthFunnelUser = Pick<
  User,
  | "id"
  | "app_metadata"
  | "created_at"
  | "last_sign_in_at"
  | "email_confirmed_at"
>;

type AuthFunnelEvent = "email_confirmed" | "account_created";

function readTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** For a user without a workspace who is heading to setup. */
export function classifyAuthCallbackFunnelEvent(
  user: AuthFunnelUser,
  now: Date = new Date()
): AuthFunnelEvent | null {
  const provider = user.app_metadata?.provider;
  if (provider === "email") {
    const confirmedAt = readTime(user.email_confirmed_at);
    return confirmedAt !== null &&
      now.getTime() - confirmedAt <= EMAIL_CONFIRMATION_WINDOW_MS
      ? "email_confirmed"
      : null;
  }
  if (typeof provider !== "string" || !provider) return null;

  const createdAt = readTime(user.created_at);
  const lastSignInAt = readTime(user.last_sign_in_at);
  return createdAt !== null &&
    lastSignInAt !== null &&
    Math.abs(lastSignInAt - createdAt) <= NEW_OAUTH_USER_WINDOW_MS
    ? "account_created"
    : null;
}

export async function captureAuthCallbackFunnelEvent(
  user: AuthFunnelUser,
  branch: AuthCallbackBranch
): Promise<void> {
  const event = classifyAuthCallbackFunnelEvent(user);
  if (!event) return;
  await captureFunnelEvent({
    event,
    userId: user.id,
    properties:
      event === "account_created"
        ? { method: String(user.app_metadata?.provider), branch }
        : { branch },
    insertId: `${event}:${user.id}`,
  });
}
