import { setCompanyProperties, trackUserSignIn } from "@/lib/analytics";
import {
  getPanelEntryRedirectPath,
  panelWorkspaceAiriHref,
} from "@/features/panel/shared/routing";
import {
  type AccountMergeSupabaseClient,
  getAccountMergeRedirectPath,
} from "@/lib/auth/account-merge";
import { captureAuthCallbackFunnelEvent } from "@/lib/auth/auth-funnel-events";
import { hasPendingInviteMetadata } from "@/lib/auth/invite-metadata";
import { processInvite } from "@/lib/auth/invite-processor";
import { readPendingTeamInviteTokenFromCookieHeader } from "@/lib/auth/pending-invite-cookie";
import { getSafeAuthReturnPath } from "@/lib/auth/safe-return-path";
import { verifyTeamInviteToken } from "@/lib/auth/team-invite-link";
import { getUserCompany } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { readServerTrackingConsent } from "@/lib/tracking-consent-server";
import type { EmailOtpType, User } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

const supportedEmailOtpTypes = new Set<EmailOtpType>([
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
]);

function getPendingInviteNextPath(request: Request): string | null {
  const token = readPendingTeamInviteTokenFromCookieHeader(
    request.headers.get("cookie")
  );
  if (!token) {
    return null;
  }

  let verification: ReturnType<typeof verifyTeamInviteToken>;
  try {
    verification = verifyTeamInviteToken(token);
  } catch {
    return null;
  }

  if (!verification.valid || !verification.payload) {
    return null;
  }

  return `/auth/joined?token=${encodeURIComponent(token)}`;
}

function isAuthContinuationNextPath(nextPath: string | null): boolean {
  return Boolean(nextPath?.startsWith("/auth/joined?"));
}

/** True when Supabase invite email populated company/workspace ids but company_users is not yet linked. */
function userHasPendingTeamInvite(user: {
  user_metadata?: Record<string, unknown> | null;
}): boolean {
  return hasPendingInviteMetadata(user.user_metadata);
}

function userHasNonEmailProvider(user: {
  app_metadata?: Record<string, unknown> | null;
}): boolean {
  const providers = user.app_metadata?.providers;
  return (
    Array.isArray(providers) && providers.some(provider => provider !== "email")
  );
}

function getWorkspaceAiriPath(workspaceId: string): string {
  return panelWorkspaceAiriHref(workspaceId);
}

function shouldCompleteInviteProfile(
  user: Pick<User, "app_metadata">,
  inviteResult: Awaited<ReturnType<typeof processInvite>>
): boolean {
  return Boolean(
    inviteResult.workspaceId &&
      !inviteResult.alreadyProcessed &&
      !userHasNonEmailProvider(user)
  );
}

async function getAccountMergeResponse(
  origin: string,
  supabase: AccountMergeSupabaseClient,
  user: Pick<User, "id" | "email" | "confirmed_at" | "email_confirmed_at"> &
    Partial<Pick<User, "app_metadata" | "user_metadata">>,
  nextPath: string
) {
  const mergeRedirectPath = await getAccountMergeRedirectPath(user, nextPath, {
    supabase,
  });
  if (!mergeRedirectPath) {
    return null;
  }

  return NextResponse.redirect(`${origin}${mergeRedirectPath}`);
}

/**
 * Auth callback handler for email verification and OAuth flows
 *
 * Handles multiple scenarios:
 * 1. Direct token verification (token_hash parameter) - works cross-browser
 * 2. PKCE flow with code parameter (same browser/device only)
 * 3. Server-side token processing (different browser/device or no code)
 *
 * Note: Refresh token errors in logs are expected when users have stale cookies
 * and are not a problem - they're handled gracefully by redirecting to recovery.
 *
 * IMPORTANT: For best cross-browser support, configure Supabase email templates
 * to use token_hash instead of default PKCE flow:
 * - Go to Supabase Dashboard > Authentication > Email Templates
 * - Update "Confirm Signup" template to use: {{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email
 * - This bypasses PKCE and works in any browser/device
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const token = searchParams.get("token");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const isLegacy = searchParams.get("legacy") === "true";
  const nextPath =
    getSafeAuthReturnPath(searchParams.get("next")) ??
    getPendingInviteNextPath(request);

  // Handle direct token verification (bypasses PKCE, works cross-browser)
  // This happens when email template uses token_hash or token parameter
  if ((token || tokenHash) && type) {
    const supabase = await createClient();
    const otpType = supportedEmailOtpTypes.has(type as EmailOtpType)
      ? (type as EmailOtpType)
      : null;

    if (!otpType) {
      const params = new URLSearchParams({
        reason: "Unsupported authentication link type",
        raw: type,
      });
      return NextResponse.redirect(
        `${origin}/auth/auth-code-error?${params.toString()}`
      );
    }

    try {
      // Use verifyOtp for token_hash (recommended) or try to verify token directly
      const verifyResult = tokenHash
        ? await supabase.auth.verifyOtp({
            token_hash: tokenHash,
            type: otpType,
          })
        : // If we have a raw token, we might need to use admin client
          // For now, redirect to recovery which will handle client-side
          null;

      if (verifyResult && !verifyResult.error && verifyResult.data?.user) {
        if (otpType === "recovery") {
          return NextResponse.redirect(`${origin}/auth/reset-password`);
        }

        // Verification successful - proceed with post-auth flow
        const companyData = await getUserCompany(
          supabase,
          verifyResult.data.user.id
        );
        const hasWorkspace =
          companyData?.company_id &&
          ((Array.isArray(companyData.workspaces) &&
            companyData.workspaces.length > 0) ||
            (!Array.isArray(companyData.workspaces) && companyData.workspaces));

        if (isAuthContinuationNextPath(nextPath)) {
          return NextResponse.redirect(`${origin}${nextPath}`);
        }

        if (
          !hasWorkspace &&
          !userHasPendingTeamInvite(verifyResult.data.user)
        ) {
          await captureAuthCallbackFunnelEvent(
            verifyResult.data.user,
            "token_hash"
          );
          const mergeResponse = await getAccountMergeResponse(
            origin,
            supabase,
            verifyResult.data.user,
            "/onboarding"
          );
          if (mergeResponse) {
            return mergeResponse;
          }

          return NextResponse.redirect(`${origin}/onboarding`);
        }

        return await handlePostAuthRedirect(
          origin,
          verifyResult.data.user,
          nextPath
        );
      }

      // If token verification failed or we have raw token, try recovery
      if (token && !tokenHash) {
        // Raw token - redirect to recovery which might handle it client-side
        return NextResponse.redirect(`${origin}/auth/callback-recovery`);
      }
    } catch {
      return NextResponse.redirect(`${origin}/auth/callback-recovery`);
    }
  }

  if (isLegacy) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.redirect(
        `${origin}/auth/auth-code-error?reason=User+not+found`
      );
    }

    return await handlePostAuthRedirect(origin, user, nextPath);
  }

  const supabase = await createClient();

  // If code is present, use PKCE flow.
  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (error || !data?.user) {
      // Missing PKCE verifier means the verification context is unavailable.
      // This is often different browser/device, but can also be host/domain
      // mismatch, cleared cookies, or email-link prefetch by a client.
      const isPkceError =
        error?.message?.includes("code verifier") ||
        error?.message?.includes("both auth code and code verifier");

      if (isPkceError) {
        const reason =
          "Verification context is missing. Open the link from the same app/domain where signup started, or request a new sign-in link.";
        return NextResponse.redirect(
          `${origin}/auth/callback-recovery?pkce_error=true&reason=${encodeURIComponent(reason)}`
        );
      }

      // Other errors - show error page
      const params = new URLSearchParams({
        reason: "Failed to exchange code for session",
        raw: error?.message || "",
      });
      return NextResponse.redirect(
        `${origin}/auth/auth-code-error?${params.toString()}`
      );
    }

    // Check if this is a signup flow (new user, no workspace yet)
    // Self-signups go straight to the setup router; invites stay separate.
    const companyData = await getUserCompany(supabase, data.user.id);
    const hasWorkspace =
      companyData?.company_id &&
      ((Array.isArray(companyData.workspaces) &&
        companyData.workspaces.length > 0) ||
        (!Array.isArray(companyData.workspaces) && companyData.workspaces));

    if (isAuthContinuationNextPath(nextPath)) {
      return NextResponse.redirect(`${origin}${nextPath}`);
    }

    if (!hasWorkspace && !userHasPendingTeamInvite(data.user)) {
      await captureAuthCallbackFunnelEvent(data.user, "pkce");
      const mergeResponse = await getAccountMergeResponse(
        origin,
        supabase,
        data.user,
        "/onboarding"
      );
      if (mergeResponse) {
        return mergeResponse;
      }

      return NextResponse.redirect(`${origin}/onboarding`);
    }

    return await handlePostAuthRedirect(origin, data.user, nextPath);
  }

  // If no code, check if user is already authenticated
  // This happens when Supabase processes PKCE token server-side and redirects
  // without a code parameter (common when clicking email link in different browser)
  const {
    data: { user },
    error: getUserError,
  } = await supabase.auth.getUser();

  // Ignore refresh token errors - they're expected with stale cookies
  // Only proceed if we actually have a user
  if (!user || getUserError) {
    // Check if it's a refresh token error (stale cookies)
    const isRefreshTokenError =
      getUserError?.message?.includes("refresh_token_not_found") ||
      getUserError?.message?.includes("Invalid Refresh Token");

    if (isRefreshTokenError) {
      // Stale cookies - redirect to recovery page which will handle client-side
      return NextResponse.redirect(`${origin}/auth/callback-recovery`);
    }

    // No code and no session - redirect to recovery page for client-side recovery
    // This gives users a chance for automatic recovery if session was established
    return NextResponse.redirect(`${origin}/auth/callback-recovery`);
  }

  // User is authenticated (Supabase processed PKCE server-side)
  // Proceed with post-auth flow
  const companyData = await getUserCompany(supabase, user.id);
  const hasWorkspace =
    companyData?.company_id &&
    ((Array.isArray(companyData.workspaces) &&
      companyData.workspaces.length > 0) ||
      (!Array.isArray(companyData.workspaces) && companyData.workspaces));

  if (isAuthContinuationNextPath(nextPath)) {
    return NextResponse.redirect(`${origin}${nextPath}`);
  }

  if (!hasWorkspace && !userHasPendingTeamInvite(user)) {
    await captureAuthCallbackFunnelEvent(user, "session");
    const mergeResponse = await getAccountMergeResponse(
      origin,
      supabase,
      user,
      "/onboarding"
    );
    if (mergeResponse) {
      return mergeResponse;
    }

    return NextResponse.redirect(`${origin}/onboarding`);
  }

  return await handlePostAuthRedirect(origin, user, nextPath);
}

async function handlePostAuthRedirect(
  origin: string,
  user: Pick<User, "id" | "email" | "user_metadata">,
  nextPath: string | null
) {
  const supabase = await createClient();

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.redirect(
      `${origin}/auth/auth-code-error?reason=User+not+found`
    );
  }

  const inviteResult = await processInvite(userData.user);

  if (!inviteResult.success) {
    return NextResponse.redirect(
      `${origin}/auth/auth-code-error?reason=${encodeURIComponent(inviteResult.error || "Unknown error")}`
    );
  }

  if (inviteResult.workspaceId) {
    if (!shouldCompleteInviteProfile(userData.user, inviteResult)) {
      return NextResponse.redirect(
        `${origin}${getWorkspaceAiriPath(inviteResult.workspaceId)}`
      );
    }

    return NextResponse.redirect(
      `${origin}/auth/complete-invite?workspaceId=${encodeURIComponent(inviteResult.workspaceId)}`
    );
  }

  if (isAuthContinuationNextPath(nextPath)) {
    return NextResponse.redirect(`${origin}${nextPath}`);
  }

  const companyData = await getUserCompany(supabase, user.id);
  if (companyData?.company_id && companyData.companies) {
    const company = Array.isArray(companyData.companies)
      ? companyData.companies[0]
      : companyData.companies;
    if (company) {
      setCompanyProperties(companyData.company_id, {
        company_name: company.name,
        company_slug: company.slug,
        business_context: company.business_context,
        airi_language: company.airi_language,
        trial_starts_at: company.trial_starts_at,
        trial_ends_at: company.trial_ends_at,
        dynamic_context_tags: company.dynamic_context_tags,
        created_at: company.created_at,
      });
    }

    const ws = companyData.workspaces;
    const workspace = Array.isArray(ws) ? ws[0] : ws;
    if (workspace?.id) {
      const defaultRedirectPath = getWorkspaceAiriPath(workspace.id);
      const redirectPath =
        nextPath ??
        (await getPanelEntryRedirectPath(supabase, userData.user)) ??
        defaultRedirectPath;
      const mergeResponse = await getAccountMergeResponse(
        origin,
        supabase,
        userData.user,
        redirectPath
      );
      if (mergeResponse) {
        return mergeResponse;
      }

      // Track OAuth sign in (Google, etc.)
      trackUserSignIn(
        user.id,
        companyData.company_id,
        workspace.id,
        "oauth",
        userData.user.email,
        { consent: await readServerTrackingConsent() }
      );

      return NextResponse.redirect(`${origin}${redirectPath}`);
    }
  }

  const mergeResponse = await getAccountMergeResponse(
    origin,
    supabase,
    userData.user,
    "/onboarding"
  );
  if (mergeResponse) {
    return mergeResponse;
  }

  return NextResponse.redirect(`${origin}/onboarding`);
}
