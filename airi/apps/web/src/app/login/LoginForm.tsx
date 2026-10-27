"use client";

import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { sendMagicLink } from "@/app/auth/send-magic-link/actions";
import { login, resendSignupConfirmation, signup } from "./actions";

import {
  AUTH_PRIMARY_BUTTON_CLASS,
  AUTH_SECONDARY_BUTTON_CLASS,
} from "@/components/auth/auth-styles";
import { ForgotPasswordDialog } from "@/components/auth/forgot-password-dialog";
import { landingDisplayFont } from "@/components/landing/landing-display-font";
import { LandingLightTheme } from "@/components/landing/landing-light-theme";
import { LanguageSwitcher } from "@/components/settings/language-switcher";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createClient } from "@/lib/supabase/client";
import { parseAuthEmailCooldownParam } from "@/lib/auth/auth-email-cooldown";
import { buildPendingTeamInviteCookie } from "@/lib/auth/pending-invite-cookie";
import { getSafeAuthReturnPath } from "@/lib/auth/safe-return-path";
import {
  parseSignInErrorParam,
  type SignInErrorCode,
} from "@/lib/auth/sign-in-error";
import {
  parseSignUpErrorParam,
  type SignUpErrorCode,
} from "@/lib/auth/sign-up-error";
import type { TeamInviteContext } from "@/lib/auth/team-invite-context";
import { cn } from "@/lib/utils";
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Mail,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { GoogleLogo } from "../../components/integrations/assets/google_logo";

const IN_APP_BROWSER_MARKERS = [
  "barcelona", // Threads
  "threads",
  "instagram",
  "fb_iab",
  "fban",
  "fbav",
  "fbios",
  "fb4a",
  "messenger",
  "tiktok",
  "musical_ly",
  "bytedancewebview",
  "telegram",
  "linkedinapp",
  "twitter",
  "snapchat",
  "pinterest",
  "reddit",
  "discord",
  "line/",
  "micromessenger",
  "whatsapp",
  "gmail",
  "gsa/",
] as const;

// `signup` search param values that show the "check your email" step.
const PENDING_SIGNUP_STATUSES = new Set([
  "pending",
  "unconfirmed",
  "recently_sent",
  "email_not_confirmed",
]);

const SIGN_IN_ERROR_MESSAGE_KEYS = {
  invalid_credentials: "signInErrorInvalidCredentials",
  rate_limited: "signInErrorRateLimited",
  unknown: "signInErrorUnknown",
} as const satisfies Record<SignInErrorCode, string>;

const SIGN_UP_ERROR_MESSAGE_KEYS = {
  invalid_email: "signUpErrorInvalidEmail",
  weak_password: "signUpErrorWeakPassword",
  rate_limited: "signUpErrorRateLimited",
  signup_disabled: "signUpErrorSignupDisabled",
  unknown: "signUpErrorUnknown",
} as const satisfies Record<SignUpErrorCode, string>;

const AUTH_INPUT_CLASS =
  "h-12 rounded-xl border-[#d7d8d1] bg-white text-[#0f100e] shadow-none placeholder:text-[#74776e] focus-visible:border-[var(--airi-rose-ink)] focus-visible:ring-[var(--airi-rose-ink)]/15";

function isLikelyInAppBrowser(userAgent: string): boolean {
  const normalizedUserAgent = userAgent.toLowerCase();

  return IN_APP_BROWSER_MARKERS.some(marker =>
    normalizedUserAgent.includes(marker)
  );
}

// Submit button component that shows loading state
function SubmitButton({
  children,
  loadingText,
  className = "",
}: {
  children: React.ReactNode;
  loadingText: string;
  className?: string;
}) {
  const { pending } = useFormStatus();

  return (
    <Button
      type="submit"
      variant="outline"
      className={className}
      disabled={pending}
      aria-busy={pending}
    >
      {pending ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
          {loadingText}
        </>
      ) : (
        children
      )}
    </Button>
  );
}

// Password input with visibility toggle
function PasswordInput({
  id,
  name,
  required = true,
  placeholder,
  autoComplete,
  className,
  minLength,
  describedBy,
  inputRef,
}: {
  id: string;
  name: string;
  required?: boolean;
  placeholder?: string;
  autoComplete?: string;
  className?: string;
  minLength?: number;
  describedBy?: string;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const t = useTranslations("LoginPage");
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        id={id}
        name={name}
        type={showPassword ? "text" : "password"}
        required={required}
        placeholder={placeholder}
        autoComplete={autoComplete}
        minLength={minLength}
        aria-describedby={describedBy}
        className={cn(AUTH_INPUT_CLASS, "pr-12", className)}
      />
      <button
        type="button"
        onClick={() => setShowPassword(!showPassword)}
        className="absolute right-0.5 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-lg text-[#606459] transition-colors hover:text-[#0f100e] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--airi-rose-ink)]"
        aria-label={showPassword ? t("hidePassword") : t("showPassword")}
        aria-pressed={showPassword}
        aria-controls={id}
      >
        {showPassword ? (
          <EyeOff className="h-4 w-4" />
        ) : (
          <Eye className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}

export default function LoginForm({
  inviteToken,
  inviteContext,
  nextPath,
}: {
  inviteToken?: string;
  inviteContext?: TeamInviteContext | null;
  nextPath?: string;
}) {
  const t = useTranslations("LoginPage");
  const authCodeErrorT = useTranslations("Auth.authCodeError");
  const router = useRouter();
  const searchParams = useSearchParams();
  const message = searchParams.get("message");
  const signInErrorCode = parseSignInErrorParam(searchParams.get("error"));
  const signUpErrorParam = searchParams.get("signup_error");
  const signUpErrorCode = parseSignUpErrorParam(signUpErrorParam);
  const signInErrorMessage = signInErrorCode
    ? t(SIGN_IN_ERROR_MESSAGE_KEYS[signInErrorCode])
    : null;
  const signInAttempt = searchParams.get("attempt");
  const tab = searchParams.get("tab");
  const signupStatus = searchParams.get("signup");
  const inviteTokenFromUrl = searchParams.get("invite_token");
  const resolvedInviteToken = inviteToken || inviteTokenFromUrl || "";
  const requestedNextPath = getSafeAuthReturnPath(
    nextPath || searchParams.get("next")
  );
  const pendingSignupEmail = searchParams.get("email")?.trim() || "";
  const isExistingSignup = tab !== "signup" && signupStatus === "existing";
  const isPendingSignup =
    tab === "signup" &&
    (PENDING_SIGNUP_STATUSES.has(signupStatus ?? "") ||
      message?.includes("Check email") === true);
  // Password sign-in can't finish here: Supabase did not keep the password
  // typed on this attempt (the address already had an unconfirmed account, or
  // an email went out moments ago), or the account's email is not confirmed
  // yet. The emailed link is the way in.
  const pendingSignupNeedsEmailLink =
    isPendingSignup &&
    (signupStatus === "unconfirmed" ||
      signupStatus === "recently_sent" ||
      signupStatus === "email_not_confirmed");
  const initialEmailCooldownSeconds = parseAuthEmailCooldownParam(
    searchParams.get("retry_after")
  );
  const showsUrlError = !isPendingSignup && !isExistingSignup;
  const urlSignInError =
    showsUrlError && tab !== "signup"
      ? (signInErrorMessage ?? (message ? t("signInErrorUnknown") : null))
      : null;
  const urlSignUpError =
    showsUrlError && tab === "signup" && (signUpErrorParam || message)
      ? t(SIGN_UP_ERROR_MESSAGE_KEYS[signUpErrorCode ?? "unknown"])
      : null;
  const urlShowsSignInRecovery =
    urlSignInError !== null && signInErrorCode === "invalid_credentials";

  const [activeTab, setActiveTab] = useState(
    tab === "signup" ? "signup" : "signin"
  );
  // Seeded from the URL so the server HTML already shows the error: a sign-in
  // posted before hydration (slow network) reloads the page with it.
  const [signInError, setSignInError] = useState<string | null>(urlSignInError);
  const [showSignInRecovery, setShowSignInRecovery] = useState(
    urlShowsSignInRecovery
  );
  const [signUpError, setSignUpError] = useState<string | null>(urlSignUpError);
  const [authEmail, setAuthEmail] = useState(pendingSignupEmail);
  const [signInFocusField, setSignInFocusField] = useState<
    "email" | "password" | null
  >(null);
  // Tabs mount their inputs after the selection changes. Focus from the ref
  // so the request is kept until the requested field is actually available.
  const focusSignInInput = useCallback(
    (input: HTMLInputElement | null) => {
      if (!input || input.name !== signInFocusField) {
        return;
      }
      input.focus();
      setSignInFocusField(null);
    },
    [signInFocusField]
  );
  const showExistingAccountNotice =
    isExistingSignup && authEmail.trim() === pendingSignupEmail;
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [showGoogleBrowserWarning, setShowGoogleBrowserWarning] =
    useState(false);
  const [resendingVerificationEmail, setResendingVerificationEmail] =
    useState(false);
  const [resendVerificationError, setResendVerificationError] = useState<
    string | null
  >(null);
  const [resendVerificationSuccess, setResendVerificationSuccess] =
    useState(false);
  const [sendingInviteSignInLink, setSendingInviteSignInLink] = useState(false);
  const [inviteSignInLinkError, setInviteSignInLinkError] = useState<
    string | null
  >(null);
  const [inviteSignInLinkSent, setInviteSignInLinkSent] = useState(false);
  const [emailCooldownSeconds, setEmailCooldownSeconds] = useState(
    initialEmailCooldownSeconds
  );
  const [emailRecentlySent, setEmailRecentlySent] = useState(false);
  const inviteCanBeAccepted =
    !resolvedInviteToken || inviteContext?.status === "valid";
  const formInviteToken = inviteCanBeAccepted ? resolvedInviteToken : "";
  const inviteWorkspaceName =
    inviteContext?.status === "valid"
      ? inviteContext.workspaceName || inviteContext.companyName || "workspace"
      : "workspace";
  const inviteSubtitle =
    inviteContext?.status === "valid"
      ? t("inviteSubtitle", { workspace: inviteWorkspaceName })
      : inviteContext
        ? t("inviteInvalidDescription")
        : t("inviteGenericSubtitle");
  const signInTitle = formInviteToken
    ? t("inviteSignInTitle")
    : t("welcomeTitle");
  const signInDescription = formInviteToken
    ? t("inviteSignInDescription", { workspace: inviteWorkspaceName })
    : t("welcomeDescription");
  const signUpTitle = formInviteToken
    ? t("inviteSignUpTitle")
    : t("createAccount");
  const signUpDescription = formInviteToken
    ? t("inviteSignUpDescription", { workspace: inviteWorkspaceName })
    : t("fillFormToStart");
  const signInButtonLabel = formInviteToken
    ? t("inviteSignInButton")
    : t("signInButton");
  const signUpButtonLabel = formInviteToken
    ? t("inviteSignUpButton")
    : t("createAccount");
  const pendingSignupDescription =
    signupStatus === "unconfirmed"
      ? t("signupUnconfirmedDescription")
      : signupStatus === "recently_sent"
        ? t("signupRecentlySentDescription")
        : signupStatus === "email_not_confirmed"
          ? t("signinUnconfirmedDescription")
          : t("signupPendingDescription");
  const showEmailRecentlySent = emailRecentlySent && emailCooldownSeconds > 0;

  const buildLoginHref = (nextTab: "signin" | "signup") => {
    const params = new URLSearchParams();

    if (nextTab === "signup") {
      params.set("tab", "signup");
    }

    if (formInviteToken) {
      params.set("invite_token", formInviteToken);
    }

    if (requestedNextPath) {
      params.set("next", requestedNextPath);
    }

    const query = params.toString();
    return query ? `/login?${query}` : "/login";
  };

  const handleUseDifferentEmail = () => {
    setAuthEmail(pendingSignupEmail);
    setSignUpError(null);
    setResendVerificationError(null);
    setResendVerificationSuccess(false);
    setActiveTab("signup");
    router.replace(buildLoginHref("signup"));
  };

  const handleGoToSignIn = () => {
    setSignInFocusField(authEmail.trim() ? "password" : "email");
    setSignInError(null);
    setSignUpError(null);
    setResendVerificationError(null);
    setResendVerificationSuccess(false);
    setActiveTab("signin");
    router.replace(buildLoginHref("signin"));
  };

  const handleTabChange = (value: string) => {
    const nextTab = value === "signup" ? "signup" : "signin";
    setActiveTab(nextTab);
    router.replace(buildLoginHref(nextTab));
  };

  useEffect(() => {
    setActiveTab(tab === "signup" ? "signup" : "signin");
  }, [tab]);

  useEffect(() => {
    if (pendingSignupEmail) {
      setAuthEmail(pendingSignupEmail);
    }
  }, [pendingSignupEmail]);

  useEffect(() => {
    if (isExistingSignup) {
      setSignInFocusField("password");
    }
  }, [isExistingSignup, pendingSignupEmail]);

  useEffect(() => {
    setEmailCooldownSeconds(initialEmailCooldownSeconds);
  }, [initialEmailCooldownSeconds]);

  useEffect(() => {
    if (emailCooldownSeconds <= 0) {
      return;
    }

    const timer = window.setTimeout(() => {
      setEmailCooldownSeconds(seconds => Math.max(0, seconds - 1));
    }, 1000);

    return () => window.clearTimeout(timer);
  }, [emailCooldownSeconds]);

  useEffect(() => {
    if (!formInviteToken || typeof document === "undefined") {
      return;
    }

    document.cookie = buildPendingTeamInviteCookie(formInviteToken);
  }, [formInviteToken]);

  // `signInAttempt` changes on every failed attempt, so a repeat failure shows
  // its error again even though the message is the same.
  useEffect(() => {
    setSignInError(urlSignInError);
    setShowSignInRecovery(urlShowsSignInRecovery);
    setSignUpError(urlSignUpError);
  }, [signInAttempt, urlShowsSignInRecovery, urlSignInError, urlSignUpError]);

  const handleSignInSubmit = () => {
    // Drop the previous attempt's error so the next result reads as new.
    setSignInError(null);
    setShowSignInRecovery(false);
  };

  const handleSignUpSubmit = () => setSignUpError(null);

  const handleCreateAccountFromSignIn = () => {
    setAuthEmail(authEmail.trim());
    handleTabChange("signup");
  };

  const handleResendVerificationEmail = async () => {
    if (!pendingSignupEmail || !pendingSignupEmail.includes("@")) {
      setResendVerificationError(authCodeErrorT("invalidEmail"));
      return;
    }

    setResendingVerificationEmail(true);
    setResendVerificationError(null);
    setResendVerificationSuccess(false);
    setEmailRecentlySent(false);

    try {
      const result = await resendSignupConfirmation(
        pendingSignupEmail,
        formInviteToken || undefined,
        requestedNextPath || undefined
      );

      if (result.success) {
        setResendVerificationSuccess(true);
      } else if (result.retryAfterSeconds) {
        setEmailCooldownSeconds(result.retryAfterSeconds);
        setEmailRecentlySent(true);
      } else {
        setResendVerificationError(
          result.errorCode && result.errorCode !== "unknown"
            ? t(SIGN_UP_ERROR_MESSAGE_KEYS[result.errorCode])
            : t("failedToResendVerificationEmail")
        );
      }
    } catch {
      setResendVerificationError(t("failedToResendVerificationEmail"));
    } finally {
      setResendingVerificationEmail(false);
    }
  };

  const handleSendInviteSignInLink = async () => {
    const email = authEmail.trim();
    if (!email || !email.includes("@")) {
      setInviteSignInLinkError(t("inviteEmailRequired"));
      return;
    }
    if (!formInviteToken) {
      return;
    }

    setSendingInviteSignInLink(true);
    setInviteSignInLinkError(null);
    setInviteSignInLinkSent(false);
    setEmailRecentlySent(false);

    try {
      const invitePath = `/auth/joined?token=${encodeURIComponent(formInviteToken)}`;
      const result = await sendMagicLink(email, invitePath);
      if (result.success) {
        setInviteSignInLinkSent(true);
      } else if (result.retryAfterSeconds) {
        setEmailCooldownSeconds(result.retryAfterSeconds);
        setEmailRecentlySent(true);
      } else {
        setInviteSignInLinkError(t("failedToSendInviteSignInLink"));
      }
    } catch {
      setInviteSignInLinkError(authCodeErrorT("unexpectedError"));
    } finally {
      setSendingInviteSignInLink(false);
    }
  };

  const handleGoogleLogin = async () => {
    setSignInError(null);
    setShowSignInRecovery(false);
    setSignUpError(null);
    setShowGoogleBrowserWarning(false);

    if (
      typeof navigator !== "undefined" &&
      isLikelyInAppBrowser(navigator.userAgent)
    ) {
      setShowGoogleBrowserWarning(true);
      return;
    }

    setIsGoogleLoading(true);

    const siteUrl =
      typeof window !== "undefined"
        ? window.location.origin
        : process.env.NEXT_PUBLIC_APP_URL || "https://www.airi.chat";
    const invitePath = formInviteToken
      ? `/auth/joined?token=${encodeURIComponent(formInviteToken)}`
      : "";
    const callbackNextPath = invitePath || requestedNextPath;
    const callbackPath = callbackNextPath
      ? `/auth/callback?next=${encodeURIComponent(callbackNextPath)}`
      : "/auth/callback";

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${siteUrl}${callbackPath}`,
        },
      });

      if (error) {
        const message = t("googleSignInError");
        if (activeTab === "signup") {
          setSignUpError(message);
        } else {
          setSignInError(message);
        }
        setIsGoogleLoading(false);
      }
    } catch {
      const message = t("googleSignInError");
      if (activeTab === "signup") {
        setSignUpError(message);
      } else {
        setSignInError(message);
      }
      setIsGoogleLoading(false);
    }
  };

  return (
    <div
      className={cn(
        landingDisplayFont.variable,
        "min-h-dvh bg-[#f3f3ef] text-[#0f100e]"
      )}
    >
      <LandingLightTheme />
      <div className="flex min-h-dvh flex-col">
        <header className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
          <Link
            href="/"
            className="flex min-w-0 shrink-0 items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--airi-rose-ink)]"
            aria-label="airi.chat"
          >
            <Image
              src="/logo_short_black.svg"
              alt=""
              width={200}
              height={50}
              className="h-7 w-auto"
              style={{ width: "auto" }}
              priority
            />
            <span className="truncate font-medium">airi.chat</span>
          </Link>
          <LanguageSwitcher />
        </header>

        <main className="mx-auto flex w-full max-w-6xl flex-1 items-center px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
          <div className="grid w-full min-w-0 gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(360px,440px)] lg:items-center lg:gap-20">
            <section
              className="hidden min-w-0 max-w-lg space-y-6 lg:block"
              aria-label={t("productIntroLabel")}
            >
              <p className="text-balance font-[family-name:var(--font-landing-display)] text-5xl font-semibold leading-[1.12] tracking-tight xl:text-6xl">
                {t("productIntroTitle")}
              </p>
              <p className="max-w-md text-lg leading-8 text-[#606459]">
                {t("productIntroDescription")}
              </p>
            </section>

            <section className="mx-auto w-full min-w-0 max-w-md">
              {resolvedInviteToken ? (
                <div className="mb-4 rounded-2xl border border-[#d7d8d1] bg-white/60 px-4 py-3 text-[#0f100e]">
                  <p className="break-words text-sm font-semibold">
                    {inviteContext?.status === "valid"
                      ? t("inviteTitle", { workspace: inviteWorkspaceName })
                      : t("inviteInvalidTitle")}
                  </p>
                  <p className="mt-1 break-words text-sm leading-6 text-[#606459]">
                    {inviteSubtitle}
                  </p>
                </div>
              ) : null}

              <Tabs
                value={activeTab}
                onValueChange={handleTabChange}
                className="w-full"
              >
                <TabsList className="grid h-12 w-full grid-cols-2 rounded-xl bg-[#e8e8e2] p-1">
                  <TabsTrigger
                    value="signin"
                    className="rounded-lg font-medium text-[#606459] data-[state=active]:bg-white data-[state=active]:text-[#0f100e] data-[state=active]:shadow-sm"
                  >
                    {t("signinTab")}
                  </TabsTrigger>
                  <TabsTrigger
                    value="signup"
                    className="rounded-lg font-medium text-[#606459] data-[state=active]:bg-white data-[state=active]:text-[#0f100e] data-[state=active]:shadow-sm"
                  >
                    {t("signupTab")}
                  </TabsTrigger>
                </TabsList>

                <div className="mt-4 rounded-3xl border border-[#dedfd8] bg-white p-5 text-[#0f100e] sm:p-8">
                  <TabsContent value="signin" className="m-0">
                    <div className="space-y-5">
                      <div className="text-center">
                        <h1 className="text-balance font-[family-name:var(--font-landing-display)] text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
                          {signInTitle}
                        </h1>
                        <p className="mt-3 text-sm leading-6 text-[#606459]">
                          {signInDescription}
                        </p>
                      </div>
                      <form
                        action={login}
                        onSubmit={handleSignInSubmit}
                        className="space-y-4"
                      >
                        {formInviteToken ? (
                          <input
                            type="hidden"
                            name="invite_token"
                            value={formInviteToken}
                          />
                        ) : null}
                        {requestedNextPath ? (
                          <input
                            type="hidden"
                            name="next"
                            value={requestedNextPath}
                          />
                        ) : null}
                        {showExistingAccountNotice ? (
                          <Alert
                            id="existing-account-notice"
                            role="status"
                            aria-live="polite"
                            className="border-[#d7d8d1] bg-[#f3f3ef] text-[#0f100e]"
                          >
                            <CheckCircle2 className="h-4 w-4 text-[#075e54]" />
                            <AlertTitle className="line-clamp-none font-semibold">
                              {t("existingAccountTitle")}
                            </AlertTitle>
                            <AlertDescription className="leading-6 text-[#606459]">
                              {t("existingAccountDescription")}
                            </AlertDescription>
                          </Alert>
                        ) : null}
                        <div className="space-y-2">
                          <Label htmlFor="email-signin">{t("email")}</Label>
                          <Input
                            ref={focusSignInInput}
                            id="email-signin"
                            name="email"
                            type="email"
                            placeholder={t("emailPlaceholder")}
                            required
                            autoComplete="email"
                            className={AUTH_INPUT_CLASS}
                            value={authEmail}
                            onChange={e => {
                              setAuthEmail(e.target.value);
                              setInviteSignInLinkError(null);
                              setInviteSignInLinkSent(false);
                            }}
                          />
                        </div>
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <Label htmlFor="password-signin">
                              {t("password")}
                            </Label>
                            <ForgotPasswordDialog>
                              <Button
                                type="button"
                                variant="link"
                                className="h-auto min-h-[44px] px-0 text-xs font-bold text-slate-700 sm:min-h-0"
                              >
                                {t("forgotPassword")}
                              </Button>
                            </ForgotPasswordDialog>
                          </div>
                          <PasswordInput
                            inputRef={focusSignInInput}
                            id="password-signin"
                            name="password"
                            autoComplete="current-password"
                            describedBy={
                              showExistingAccountNotice
                                ? "existing-account-notice"
                                : undefined
                            }
                          />
                        </div>
                        {signInError && (
                          // A new key per attempt remounts the alert, so it
                          // animates in and is announced again.
                          <Alert
                            key={signInAttempt ?? "sign-in-error"}
                            variant="destructive"
                            className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1"
                          >
                            <AlertCircle className="h-4 w-4" />
                            <AlertDescription>{signInError}</AlertDescription>
                          </Alert>
                        )}
                        {signInError &&
                        showSignInRecovery &&
                        !formInviteToken ? (
                          <div className="space-y-3 rounded-xl border border-[#dedfd8] bg-[#f3f3ef] p-3 text-sm">
                            <p className="font-medium text-slate-700">
                              {t("signInRecoveryHint")}
                            </p>
                            <div className="grid gap-2 sm:grid-cols-2">
                              <ForgotPasswordDialog>
                                <Button
                                  type="button"
                                  variant="outline"
                                  className={cn(
                                    "w-full",
                                    AUTH_SECONDARY_BUTTON_CLASS
                                  )}
                                >
                                  {t("resetPassword")}
                                </Button>
                              </ForgotPasswordDialog>
                              <Button
                                type="button"
                                variant="outline"
                                className={cn(
                                  "w-full",
                                  AUTH_SECONDARY_BUTTON_CLASS
                                )}
                                onClick={handleCreateAccountFromSignIn}
                              >
                                {t("createAccount")}
                              </Button>
                            </div>
                          </div>
                        ) : null}
                        {signInError && formInviteToken ? (
                          <div className="space-y-3 rounded-xl border border-[#dedfd8] bg-[#f3f3ef] p-3 text-sm">
                            <p className="font-medium text-slate-700">
                              {t("inviteSignInLinkHint")}
                            </p>
                            <Button
                              type="button"
                              variant="outline"
                              className={cn(
                                "w-full",
                                AUTH_SECONDARY_BUTTON_CLASS
                              )}
                              onClick={handleSendInviteSignInLink}
                              disabled={
                                sendingInviteSignInLink ||
                                inviteSignInLinkSent ||
                                emailCooldownSeconds > 0
                              }
                            >
                              {sendingInviteSignInLink ? (
                                <>
                                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                  {t("sendingInviteSignInLink")}
                                </>
                              ) : (
                                <>
                                  <Mail className="mr-2 h-4 w-4" />
                                  {emailCooldownSeconds > 0 &&
                                  !inviteSignInLinkSent
                                    ? t("sendAgainIn", {
                                        seconds: emailCooldownSeconds,
                                      })
                                    : t("sendInviteSignInLink")}
                                </>
                              )}
                            </Button>
                            {inviteSignInLinkError ? (
                              <p
                                role="alert"
                                className="text-sm leading-6 text-destructive"
                              >
                                {inviteSignInLinkError}
                              </p>
                            ) : null}
                            <div
                              role="status"
                              aria-live="polite"
                              aria-atomic="true"
                            >
                              {showEmailRecentlySent ? (
                                <p className="text-sm leading-6 text-[#606459]">
                                  {t("emailRecentlySent")}
                                </p>
                              ) : null}
                              {inviteSignInLinkSent ? (
                                <p className="text-sm leading-6 text-[var(--airi-green-ink)]">
                                  {t("inviteSignInLinkSent")}
                                </p>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                        <SubmitButton
                          className={cn("w-full", AUTH_PRIMARY_BUTTON_CLASS)}
                          loadingText={t("signingIn")}
                        >
                          {signInButtonLabel}
                        </SubmitButton>
                      </form>
                    </div>
                  </TabsContent>

                  <TabsContent value="signup" className="m-0">
                    <div className="space-y-5">
                      <div className="text-center">
                        <h1 className="text-balance font-[family-name:var(--font-landing-display)] text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
                          {isPendingSignup
                            ? t("signupPendingTitle")
                            : signUpTitle}
                        </h1>
                        <p className="mt-3 text-sm leading-6 text-[#606459]">
                          {isPendingSignup
                            ? pendingSignupDescription
                            : signUpDescription}
                        </p>
                      </div>

                      {!isPendingSignup ? (
                        <p className="flex flex-wrap items-center justify-center gap-x-2 text-center text-sm text-[#606459]">
                          {t("alreadyHaveAccount")}
                          <Button
                            type="button"
                            variant="link"
                            className="h-auto min-h-11 whitespace-normal px-0 font-semibold text-[var(--airi-rose-ink)] underline underline-offset-4"
                            onClick={handleGoToSignIn}
                          >
                            {t("signInButton")}
                          </Button>
                        </p>
                      ) : null}

                      {isPendingSignup ? (
                        <div className="space-y-5">
                          <div className="rounded-2xl border border-[#dedfd8] bg-[#f3f3ef] p-4 text-left">
                            <div className="flex gap-3">
                              <Mail
                                className="mt-0.5 h-5 w-5 shrink-0 text-[var(--airi-green-ink)]"
                                aria-hidden
                              />
                              <div className="min-w-0 flex-1 space-y-2">
                                <p className="text-sm font-semibold text-[#0f100e]">
                                  {signupStatus === "email_not_confirmed"
                                    ? t("confirmEmailTitle")
                                    : t("checkInboxTitle")}
                                </p>
                                {signupStatus === "unconfirmed" ? (
                                  <p className="text-sm leading-6 text-[#606459]">
                                    {t("unconfirmedAccountHint")}
                                  </p>
                                ) : null}
                                {pendingSignupEmail ? (
                                  <p className="text-sm font-medium leading-6 text-[#0f100e] [overflow-wrap:anywhere]">
                                    {pendingSignupEmail}
                                  </p>
                                ) : null}
                              </div>
                            </div>
                          </div>

                          <div className="space-y-2">
                            <Button
                              type="button"
                              variant="outline"
                              className={cn(
                                "w-full",
                                AUTH_SECONDARY_BUTTON_CLASS
                              )}
                              onClick={handleResendVerificationEmail}
                              disabled={
                                resendingVerificationEmail ||
                                pendingSignupEmail.length === 0 ||
                                emailCooldownSeconds > 0
                              }
                            >
                              {resendingVerificationEmail ? (
                                <>
                                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                  {t("resendingVerificationEmail")}
                                </>
                              ) : emailCooldownSeconds > 0 ? (
                                t("sendAgainIn", {
                                  seconds: emailCooldownSeconds,
                                })
                              ) : (
                                t("resendVerificationEmail")
                              )}
                            </Button>
                            {resendVerificationError ? (
                              <p
                                role="alert"
                                className="px-2 text-center text-sm leading-6 text-destructive"
                              >
                                {resendVerificationError}
                              </p>
                            ) : null}
                            <div
                              role="status"
                              aria-live="polite"
                              aria-atomic="true"
                            >
                              {resendVerificationSuccess ? (
                                <p className="px-2 text-center text-sm leading-6 text-[var(--airi-green-ink)]">
                                  {t("verificationEmailResent")}
                                </p>
                              ) : null}
                              {showEmailRecentlySent ? (
                                <p className="px-2 text-center text-sm leading-6 text-[#606459]">
                                  {t("emailRecentlySent")}
                                </p>
                              ) : null}
                            </div>
                            {pendingSignupNeedsEmailLink ? null : (
                              <Button
                                type="button"
                                variant="outline"
                                className={cn(
                                  "w-full",
                                  AUTH_PRIMARY_BUTTON_CLASS
                                )}
                                onClick={handleGoToSignIn}
                              >
                                {t("signInWithThisEmail")}
                              </Button>
                            )}
                            <div className="space-y-3 pt-1 text-center">
                              <p className="text-xs font-medium leading-5 text-slate-600">
                                {t("checkSpamHint")}
                              </p>
                              <Button
                                type="button"
                                variant="link"
                                className="h-auto min-h-[44px] p-0 text-xs font-bold text-slate-700 sm:min-h-0"
                                onClick={handleUseDifferentEmail}
                              >
                                {t("wrongEmail")}
                              </Button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <form
                          action={signup}
                          onSubmit={handleSignUpSubmit}
                          className="space-y-4"
                        >
                          {formInviteToken ? (
                            <input
                              type="hidden"
                              name="invite_token"
                              value={formInviteToken}
                            />
                          ) : null}
                          {requestedNextPath ? (
                            <input
                              type="hidden"
                              name="next"
                              value={requestedNextPath}
                            />
                          ) : null}
                          <div className="space-y-2">
                            <Label htmlFor="email-signup">{t("email")}</Label>
                            <Input
                              id="email-signup"
                              name="email"
                              type="email"
                              placeholder={t("emailPlaceholder")}
                              required
                              autoComplete="email"
                              className={AUTH_INPUT_CLASS}
                              value={authEmail}
                              onChange={e => setAuthEmail(e.target.value)}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="password-signup">
                              {t("password")}
                            </Label>
                            <PasswordInput
                              id="password-signup"
                              name="password"
                              placeholder={t("passwordPlaceholder")}
                              autoComplete="new-password"
                              minLength={6}
                              describedBy="signup-password-requirements"
                            />
                            <p
                              id="signup-password-requirements"
                              className="text-xs leading-5 text-[#606459]"
                            >
                              {t("passwordRequirements")}
                            </p>
                          </div>
                          {signUpError && (
                            <Alert
                              key={signInAttempt ?? "sign-up-error"}
                              variant="destructive"
                            >
                              <AlertCircle className="h-4 w-4" />
                              <AlertDescription>{signUpError}</AlertDescription>
                            </Alert>
                          )}
                          <SubmitButton
                            className={cn("w-full", AUTH_PRIMARY_BUTTON_CLASS)}
                            loadingText={t("creating")}
                          >
                            {signUpButtonLabel}
                          </SubmitButton>
                        </form>
                      )}
                    </div>
                  </TabsContent>

                  {!isPendingSignup ? (
                    <div className="w-full pt-6">
                      <div className="relative my-2">
                        <div className="absolute inset-0 flex items-center">
                          <span className="w-full border-t border-[#dedfd8]" />
                        </div>
                        <div className="relative flex justify-center text-xs uppercase">
                          <span className="bg-white px-3 font-medium text-[#606459]">
                            {t("or")}
                          </span>
                        </div>
                      </div>
                      <div className="mt-4 w-full">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={handleGoogleLogin}
                          disabled={isGoogleLoading}
                          aria-busy={isGoogleLoading}
                          className={cn("w-full", AUTH_SECONDARY_BUTTON_CLASS)}
                        >
                          <span
                            className="size-5 shrink-0 [&>svg]:size-5"
                            aria-hidden
                          >
                            {isGoogleLoading ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <GoogleLogo />
                            )}
                          </span>
                          <span>{t("signUpWithGoogle")}</span>
                        </Button>
                      </div>
                      {showGoogleBrowserWarning ? (
                        <Alert variant="destructive" className="mt-3">
                          <AlertCircle className="h-4 w-4" />
                          <AlertTitle>
                            {t("inAppBrowserGoogleTitle")}
                          </AlertTitle>
                          <AlertDescription>
                            {t("inAppBrowserGoogleDescription")}
                          </AlertDescription>
                        </Alert>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </Tabs>
              <div className="mt-6 flex flex-wrap justify-center gap-x-5 gap-y-2 text-xs text-[#606459]">
                <Link
                  href="/terms"
                  className="rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--airi-rose-ink)]"
                >
                  {t("termsLink")}
                </Link>
                <Link
                  href="/privacy"
                  className="rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--airi-rose-ink)]"
                >
                  {t("privacyLink")}
                </Link>
              </div>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}
