"use client";

import { sendMagicLink } from "@/app/auth/send-magic-link/actions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { panelWorkspaceAiriHref } from "@/features/panel/shared/routing/hrefs";
import { createClient } from "@/lib/supabase/client";
import { motion } from "framer-motion";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  Mail,
  RefreshCw,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";

function CallbackRecoveryContent() {
  const t = useTranslations("Auth.callbackRecovery");
  const router = useRouter();
  const searchParams = useSearchParams();
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState(false);
  const [email, setEmail] = useState("");
  const [sendingMagicLink, setSendingMagicLink] = useState(false);
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [magicLinkError, setMagicLinkError] = useState<string | null>(null);

  const isPkceError = searchParams.get("pkce_error") === "true";
  const pkceReason = searchParams.get("reason") || null;

  const checkSessionAndRedirect = useCallback(
    async (isRetry = false) => {
      setChecking(true);
      setError(null);

      // Wait a bit for session to potentially establish
      // Give Supabase time to process the verification token server-side
      // Longer wait on retry to give more time
      await new Promise(resolve => setTimeout(resolve, isRetry ? 2000 : 1000));

      // Re-check session multiple times (Supabase might be processing in background)
      const supabase = createClient();
      let attempts = 0;
      const maxAttempts = isRetry ? 5 : 3; // More attempts on retry

      while (attempts < maxAttempts) {
        const {
          data: { user: currentUser },
        } = await supabase.auth.getUser();
        const {
          data: { session: currentSession },
        } = await supabase.auth.getSession();

        if (currentUser && currentSession) {
          // Session exists! Check user state and redirect
          setRedirecting(true);

          // Check if user has workspace (client-side check)
          const supabaseClient = createClient();
          const { data: companyData } = await supabaseClient
            .from("company_users")
            .select("workspace_id")
            .eq("user_id", currentUser.id)
            .order("created_at", { ascending: true })
            .limit(1);

          if (
            companyData &&
            companyData.length > 0 &&
            companyData[0].workspace_id
          ) {
            // Existing user - redirect to dashboard
            router.push(panelWorkspaceAiriHref(companyData[0].workspace_id));
            return;
          }

          const meta = currentUser.user_metadata as
            | Record<string, unknown>
            | undefined;
          const invitedCompany =
            typeof meta?.company_id === "string" && meta.company_id.length > 0;
          const invitedWorkspace =
            typeof meta?.workspace_id === "string" &&
            meta.workspace_id.length > 0;
          if (invitedCompany && invitedWorkspace) {
            // Team invite: link company_users on the server, then complete-invite or panel
            router.push("/auth/confirm/process-invite");
            return;
          }

          router.push("/onboarding");
          return;
        }

        // Session not ready yet, wait and retry
        attempts++;
        if (attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      // No session found after all attempts - show error with recovery options
      if (isPkceError && pkceReason) {
        setError(pkceReason);
      } else {
        setError(t("noSessionError"));
      }
      setChecking(false);
    },
    [isPkceError, pkceReason, router, t]
  );

  const handleSendMagicLink = async () => {
    if (!email || !email.includes("@")) {
      setMagicLinkError(t("invalidEmail"));
      return;
    }

    setSendingMagicLink(true);
    setMagicLinkError(null);
    setMagicLinkSent(false);

    try {
      const result = await sendMagicLink(email);
      if (result.success) {
        setMagicLinkSent(true);
        setEmail("");
      } else {
        setMagicLinkError(result.error || t("failedToSendMagicLink"));
      }
    } catch {
      setMagicLinkError(t("unexpectedError"));
    } finally {
      setSendingMagicLink(false);
    }
  };

  useEffect(() => {
    void checkSessionAndRedirect();
  }, [checkSessionAndRedirect]);

  if (checking || redirecting) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-muted/20 p-6">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
          className="w-full max-w-lg"
        >
          <Card className="shadow-lg">
            <CardHeader className="text-center space-y-3">
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.1, type: "spring", stiffness: 200 }}
                className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center"
              >
                <Loader2 className="h-6 w-6 text-primary animate-spin" />
              </motion.div>
              <CardTitle className="text-2xl font-bold">
                {redirecting ? t("redirecting") : t("checkingAuth")}
              </CardTitle>
              <CardDescription>
                {redirecting ? t("sessionFound") : t("pleaseWait")}
              </CardDescription>
            </CardHeader>
          </Card>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-muted/20 p-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className="w-full max-w-lg"
      >
        <Card className="border-destructive/50 shadow-lg">
          <CardHeader className="text-center space-y-3">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.1, type: "spring", stiffness: 200 }}
              className="mx-auto w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center"
            >
              <AlertCircle className="h-6 w-6 text-destructive" />
            </motion.div>
            <CardTitle className="text-2xl font-bold">
              {isPkceError ? t("verificationLinkIssue") : t("authRecovery")}
            </CardTitle>
            <CardDescription>
              {isPkceError ? t("pkceDescription") : t("genericDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                {error || t("linkExpiredFallback")}
              </p>
            </div>

            {/* Sign-in link option - especially useful for PKCE errors. */}
            {isPkceError && (
              <div className="space-y-3 pt-2 border-t">
                <div className="space-y-2">
                  <Label
                    htmlFor="magic-link-email"
                    className="text-sm font-medium"
                  >
                    {t("sendMagicLinkLabel")}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t("magicLinkHintShort")}
                  </p>
                  <div className="flex gap-2">
                    <Input
                      id="magic-link-email"
                      type="email"
                      placeholder={t("emailPlaceholder")}
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      disabled={sendingMagicLink || magicLinkSent}
                      className="flex-1"
                    />
                    <Button
                      onClick={handleSendMagicLink}
                      disabled={sendingMagicLink || magicLinkSent || !email}
                      size="default"
                    >
                      {sendingMagicLink ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : magicLinkSent ? (
                        <CheckCircle2 className="h-4 w-4" />
                      ) : (
                        <Mail className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  {magicLinkError && (
                    <p className="text-xs text-destructive">{magicLinkError}</p>
                  )}
                  {magicLinkSent && (
                    <p className="text-xs text-emerald-600 dark:text-emerald-400">
                      {t("magicLinkSent")}
                    </p>
                  )}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-2 pt-2">
              <Button
                onClick={() => router.push("/login")}
                className="w-full"
                size="lg"
              >
                <span className="flex items-center justify-center gap-2">
                  Go to Login
                  <ArrowRight className="h-4 w-4" />
                </span>
              </Button>

              <Button
                onClick={() => checkSessionAndRedirect(true)}
                variant="outline"
                className="w-full"
                disabled={checking}
              >
                <span className="flex items-center justify-center gap-2">
                  {checking ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Try Again
                </span>
              </Button>

              <Button
                onClick={() =>
                  router.push(
                    "/auth/auth-code-error?reason=Session+not+found&raw=Please+try+logging+in+or+request+a+new+verification+email."
                  )
                }
                variant="ghost"
                className="w-full"
              >
                Get Help
              </Button>
            </div>

            <div className="text-xs text-center text-muted-foreground pt-2 space-y-2 border-t pt-4">
              <p className="font-medium">Why did this happen?</p>
              <p>
                {isPkceError
                  ? "Verification links depend on PKCE context from the signup/login session. If the host/app changed, cookies were cleared, or the link was pre-opened by an email client, verification can fail."
                  : "Verification links rely on the original signup/login context. Opening from a different browser/app/domain can fail authentication."}
              </p>
              <p className="font-medium mt-2">What can you do?</p>
              <ul className="list-disc list-inside space-y-1 text-left max-w-md mx-auto">
                {isPkceError ? (
                  <>
                    <li>
                      Use the sign-in link option above (works in any browser)
                    </li>
                    <li>
                      Open the verification link from the same host and browser
                      where signup/login started
                    </li>
                    <li>
                      Or try logging in directly if your account is already
                      verified
                    </li>
                  </>
                ) : (
                  <>
                    <li>
                      Open the verification link from the same host and browser
                      where signup/login started
                    </li>
                    <li>
                      Or request a new verification email and open it from the
                      same host/browser context
                    </li>
                    <li>
                      Or try logging in directly if your account is already
                      verified
                    </li>
                  </>
                )}
              </ul>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}

export default function CallbackRecoveryPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-muted/20 p-6">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      }
    >
      <CallbackRecoveryContent />
    </Suspense>
  );
}
