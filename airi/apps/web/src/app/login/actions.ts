"use server";

import {
  getPanelEntryRedirectPath,
  getWorkspaceIdFromPanelPath,
} from "@/features/panel/shared/routing";
import { trackUserSignIn } from "@/lib/analytics";
import { getAccountMergeRedirectPath } from "@/lib/auth/account-merge";
import { getAuthEmailCooldownSeconds } from "@/lib/auth/auth-email-cooldown";
import { hasPendingInviteMetadata } from "@/lib/auth/invite-metadata";
import { getAuthRedirectBaseUrl } from "@/lib/auth/redirect-base-url";
import { getSafeAuthReturnPath } from "@/lib/auth/safe-return-path";
import {
  classifySignInError,
  createSignInAttemptId,
  type SignInErrorCode,
} from "@/lib/auth/sign-in-error";
import {
  classifySignUpError,
  type SignUpErrorCode,
} from "@/lib/auth/sign-up-error";
import { captureFunnelEvent } from "@/lib/funnel-analytics";
import { getCompanyIdForWorkspace } from "@/lib/supabase/company-users";
import { createClient } from "@/lib/supabase/server";
import { readServerTrackingConsent } from "@/lib/tracking-consent-server";
import {
  checkRateLimit,
  createRateLimiter,
  rateLimitPresets,
} from "@icecore/shared/lib/rate-limiter";
import type { AuthResponse, User } from "@supabase/supabase-js";
import { headers } from "next/headers";
import { RedirectType, redirect } from "next/navigation";
import { z } from "zod";

const authLimiter = createRateLimiter(rateLimitPresets.auth);
const emailSchema = z.string().email("Invalid email address");

function addAuthContinuation(params: URLSearchParams, nextPath: string | null) {
  if (nextPath) {
    params.set("next", nextPath);
  }
}

function getSignupCallbackPath(inviteToken: string, nextPath: string | null) {
  const invitePath = inviteToken
    ? `/auth/joined?token=${encodeURIComponent(inviteToken)}`
    : "";
  const callbackNextPath = invitePath || nextPath;

  return callbackNextPath
    ? `/auth/callback?next=${encodeURIComponent(callbackNextPath)}`
    : "/auth/callback";
}

type SignInContinuation = {
  email: string;
  inviteToken: string;
  nextPath: string | null;
};

// Failed attempts replace the history entry, so retries don't stack /login
// entries behind the back button.
function redirectToSignInError(
  errorCode: SignInErrorCode,
  { email, inviteToken, nextPath }: SignInContinuation
): never {
  const params = new URLSearchParams({
    error: errorCode,
    attempt: createSignInAttemptId(),
  });

  if (inviteToken) {
    params.set("invite_token", inviteToken);
    if (email) {
      params.set("email", email);
    }
  }
  addAuthContinuation(params, nextPath);

  redirect(`/login?${params.toString()}`, RedirectType.replace);
}

function redirectToSignUpError(
  errorCode: SignUpErrorCode,
  { email, inviteToken, nextPath }: SignInContinuation
): never {
  const params = new URLSearchParams({
    tab: "signup",
    signup_error: errorCode,
    attempt: createSignInAttemptId(),
    email,
  });

  if (inviteToken) {
    params.set("invite_token", inviteToken);
  }
  addAuthContinuation(params, nextPath);

  redirect(`/login?${params.toString()}`, RedirectType.replace);
}

// Supabase only reports `email_not_confirmed` for the right password, so the
// account just needs its emailed link: reuse the signup resend step.
function redirectToEmailConfirmation({
  email,
  inviteToken,
  nextPath,
}: SignInContinuation): never {
  const params = new URLSearchParams({
    tab: "signup",
    signup: "email_not_confirmed",
    email,
  });

  if (inviteToken) {
    params.set("invite_token", inviteToken);
  }
  addAuthContinuation(params, nextPath);

  redirect(`/login?${params.toString()}`, RedirectType.replace);
}

const EXISTING_ACCOUNT_MIN_AGE_MS = 30_000;

type SignupResponseUser = {
  identities?: unknown[];
  created_at?: string;
  confirmation_sent_at?: string;
} | null;

function isObfuscatedExistingSignup(user: SignupResponseUser) {
  return Array.isArray(user?.identities) && user.identities.length === 0;
}

// Supabase never changes an existing unconfirmed account on signUp (an email
// invite or an unfinished signup): it drops the new password and only sends a
// fresh confirmation email. That response keeps the account's original
// created_at and, for invited accounts, empty identities, while brand-new and
// obfuscated confirmed-account responses are created within the same request.
function isExistingUnconfirmedSignup(user: SignupResponseUser) {
  const createdAt = Date.parse(user?.created_at ?? "");
  const confirmationSentAt = Date.parse(user?.confirmation_sent_at ?? "");

  return (
    Number.isFinite(createdAt) &&
    Number.isFinite(confirmationSentAt) &&
    confirmationSentAt - createdAt > EXISTING_ACCOUNT_MIN_AGE_MS
  );
}

// Login must be public; account-scoped routing starts only after getUser verifies the new session.
// react-doctor-disable-next-line react-doctor/server-auth-actions
export async function login(formData: FormData) {
  const supabase = await createClient();
  const inviteToken = String(formData.get("invite_token") || "").trim();
  const nextPath = getSafeAuthReturnPath(String(formData.get("next") || ""));
  const email = String(formData.get("email") || "").trim();
  const continuation = { email, inviteToken, nextPath };

  const data = {
    email,
    password: formData.get("password") as string,
  };

  const { error } = await supabase.auth.signInWithPassword(data);

  if (error) {
    const signInError = classifySignInError(error);
    if (signInError === "email_not_confirmed") {
      redirectToEmailConfirmation(continuation);
    }

    redirectToSignInError(signInError, continuation);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirectToSignInError("unknown", continuation);
  }

  if (inviteToken) {
    redirect(`/auth/joined?token=${encodeURIComponent(inviteToken)}`);
  }

  const redirectPath = await getPanelEntryRedirectPath(supabase, user);

  if (!redirectPath) {
    // Check if the user was invited via inviteUserByEmail — their user_metadata
    // will contain company_id and workspace_id.  Process the invite so they
    // join the correct workspace rather than being sent to self-signup setup.
    if (
      hasPendingInviteMetadata(
        user.user_metadata as Record<string, unknown> | undefined
      )
    ) {
      redirect("/auth/confirm/process-invite");
    }

    const mergeRedirectPath = await getAccountMergeRedirectPath(
      user,
      "/onboarding",
      { supabase }
    );
    if (mergeRedirectPath) {
      redirect(mergeRedirectPath);
    }

    redirect("/onboarding");
  }

  const destinationPath = nextPath ?? redirectPath;
  const workspaceId = getWorkspaceIdFromPanelPath(redirectPath);
  const companyId = workspaceId
    ? await getCompanyIdForWorkspace(supabase, workspaceId)
    : null;

  // Track sign in event
  if (companyId && workspaceId) {
    trackUserSignIn(
      user.id,
      companyId,
      workspaceId,
      "email_password",
      user.email,
      { consent: await readServerTrackingConsent() }
    );
  }

  const mergeRedirectPath = await getAccountMergeRedirectPath(
    user,
    destinationPath,
    { supabase }
  );
  if (mergeRedirectPath) {
    redirect(mergeRedirectPath);
  }

  redirect(destinationPath);
}

// Only the two branches that created a new auth user call this.
async function captureEmailAccountCreated(
  user: User | null,
  inviteToken: string
): Promise<void> {
  if (!user?.id) return;
  await captureFunnelEvent({
    event: "account_created",
    userId: user.id,
    properties: { method: "email", invited: Boolean(inviteToken) },
    insertId: `account_created:${user.id}`,
  });
}

// Public signup action is email-validated, rate-limited, and delegates account creation to Supabase Auth.
// react-doctor-disable-next-line react-doctor/server-auth-actions
export async function signup(formData: FormData) {
  const email = String(formData.get("email") || "").trim();
  const inviteToken = String(formData.get("invite_token") || "").trim();
  const nextPath = getSafeAuthReturnPath(String(formData.get("next") || ""));
  const continuation = { email, inviteToken, nextPath };

  // 1. Zod Email Validation
  const emailResult = emailSchema.safeParse(email);
  if (!emailResult.success) {
    redirectToSignUpError("invalid_email", continuation);
  }

  // 2. Upstash Rate Limiting
  let rateLimitAllowed = false;
  try {
    const headerStore = await headers();
    const ip = headerStore.get("x-forwarded-for") || "127.0.0.1";
    const rateLimitResult = await checkRateLimit(
      authLimiter,
      `signup:${ip}`,
      5
    );
    rateLimitAllowed = rateLimitResult.success;
  } catch {
    redirectToSignUpError("unknown", continuation);
  }

  if (!rateLimitAllowed) {
    redirectToSignUpError("rate_limited", continuation);
  }

  let signupResult: AuthResponse;
  try {
    const supabase = await createClient();
    const siteUrl = await getAuthRedirectBaseUrl();
    const callbackPath = getSignupCallbackPath(inviteToken, nextPath);

    signupResult = await supabase.auth.signUp({
      email,
      password: formData.get("password") as string,
      options: {
        // The callback verifies the PKCE session and routes new signups to setup.
        emailRedirectTo: `${siteUrl}${callbackPath}`,
      },
    });
  } catch {
    redirectToSignUpError("unknown", continuation);
  }

  // Keep redirects outside the request catch so Next's redirect signal propagates.
  const { data: signupData, error } = signupResult;

  if (error) {
    const retryAfterSeconds = getAuthEmailCooldownSeconds(error);
    if (retryAfterSeconds !== null) {
      // An email already went to this address moments ago: point to it
      // instead of showing Supabase's raw rate-limit message.
      const params = new URLSearchParams({
        tab: "signup",
        signup: "recently_sent",
        email,
        retry_after: String(retryAfterSeconds),
      });

      if (inviteToken) {
        params.set("invite_token", inviteToken);
      }
      addAuthContinuation(params, nextPath);

      redirect(`/login?${params.toString()}`);
    }

    redirectToSignUpError(classifySignUpError(error), continuation);
  }

  if (signupData.session) {
    await captureEmailAccountCreated(signupData.user, inviteToken);
    if (inviteToken) {
      redirect(`/auth/joined?token=${encodeURIComponent(inviteToken)}`);
    }

    redirect("/onboarding");
  }

  // Must run before the obfuscation check: invited accounts also come back
  // with empty identities, but they have no usable password to sign in with.
  if (isExistingUnconfirmedSignup(signupData.user)) {
    const params = new URLSearchParams({
      tab: "signup",
      signup: "unconfirmed",
      email,
    });

    if (inviteToken) {
      params.set("invite_token", inviteToken);
    }
    addAuthContinuation(params, nextPath);

    redirect(`/login?${params.toString()}`);
  }

  if (isObfuscatedExistingSignup(signupData.user)) {
    const params = new URLSearchParams({
      signup: "existing",
      email,
    });

    if (inviteToken) {
      params.set("invite_token", inviteToken);
    }
    addAuthContinuation(params, nextPath);

    redirect(`/login?${params.toString()}`);
  }

  await captureEmailAccountCreated(signupData.user, inviteToken);

  const params = new URLSearchParams({
    tab: "signup",
    signup: "pending",
    email,
    message: "Check email to continue sign in process",
  });

  if (inviteToken) {
    params.set("invite_token", inviteToken);
  }
  addAuthContinuation(params, nextPath);

  redirect(`/login?${params.toString()}`);
}

// Public resend action is email-validated, rate-limited, and only asks Supabase Auth to resend confirmation.
// react-doctor-disable-next-line react-doctor/server-auth-actions
export async function resendSignupConfirmation(
  email: string,
  inviteToken?: string,
  nextPath?: string
): Promise<{
  success: boolean;
  errorCode?: SignUpErrorCode;
  retryAfterSeconds?: number;
}> {
  const normalizedEmail = email.trim();

  // 1. Zod Email Validation
  const emailResult = emailSchema.safeParse(normalizedEmail);
  if (!emailResult.success) {
    return { success: false, errorCode: "invalid_email" };
  }

  try {
    // 2. Upstash Rate Limiting
    const headerStore = await headers();
    const ip = headerStore.get("x-forwarded-for") || "127.0.0.1";
    const rateLimitResult = await checkRateLimit(
      authLimiter,
      `resend:${ip}`,
      5
    );
    if (!rateLimitResult.success) {
      return { success: false, errorCode: "rate_limited" };
    }

    const supabase = await createClient();
    const siteUrl = await getAuthRedirectBaseUrl();
    const callbackPath = getSignupCallbackPath(
      (inviteToken || "").trim(),
      getSafeAuthReturnPath(nextPath)
    );

    const { error } = await supabase.auth.resend({
      type: "signup",
      email: normalizedEmail,
      options: {
        emailRedirectTo: `${siteUrl}${callbackPath}`,
      },
    });

    if (error) {
      const retryAfterSeconds = getAuthEmailCooldownSeconds(error);
      return {
        success: false,
        errorCode: classifySignUpError(error),
        ...(retryAfterSeconds !== null ? { retryAfterSeconds } : {}),
      };
    }

    return { success: true };
  } catch {
    return { success: false, errorCode: "unknown" };
  }
}
