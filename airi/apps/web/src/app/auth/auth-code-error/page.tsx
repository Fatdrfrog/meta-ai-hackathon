"use client";

import { sendMagicLink } from "@/app/auth/send-magic-link/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { createClient } from "@/lib/supabase/client";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  LogIn,
  Mail,
  RefreshCw,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

function AuthCodeErrorContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const t = useTranslations("Auth");
  const reason = searchParams.get("reason") || t("unknownAuthError");
  const raw = searchParams.get("raw") || "";

  const [email, setEmail] = useState("");
  const [resending, setResending] = useState(false);
  const [resendSuccess, setResendSuccess] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);
  const [sendingMagicLink, setSendingMagicLink] = useState(false);
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [magicLinkError, setMagicLinkError] = useState<string | null>(null);

  const lowerReason = reason.toLowerCase();

  const isLinkIssue =
    lowerReason.includes("already been used") ||
    lowerReason.includes("invalid") ||
    lowerReason.includes("expired") ||
    lowerReason.includes("outdated") ||
    lowerReason.includes("missing code") ||
    lowerReason.includes("missing token");

  const isPkceError =
    lowerReason.includes("code verifier") ||
    raw.toLowerCase().includes("code verifier") ||
    raw.toLowerCase().includes("both auth code and code verifier");

  const handleResendEmail = async () => {
    if (!email || !email.includes("@")) {
      setResendError(t("authCodeError.invalidEmail"));
      return;
    }

    setResending(true);
    setResendError(null);
    setResendSuccess(false);

    try {
      const supabase = createClient();
      const siteUrl =
        typeof window !== "undefined"
          ? window.location.origin
          : process.env.NEXT_PUBLIC_APP_URL || "https://www.airi.chat";

      const { error } = await supabase.auth.resend({
        type: "signup",
        email: email,
        options: {
          emailRedirectTo: `${siteUrl}/auth/callback`,
        },
      });

      if (error) {
        setResendError(error.message || t("authCodeError.failedToSendEmail"));
      } else {
        setResendSuccess(true);
        setEmail("");
      }
    } catch {
      setResendError(t("authCodeError.unexpectedError"));
    } finally {
      setResending(false);
    }
  };

  const handleSendMagicLink = async () => {
    if (!email || !email.includes("@")) {
      setMagicLinkError(t("authCodeError.invalidEmail"));
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
        setMagicLinkError(
          result.error || t("authCodeError.failedToSendMagicLink")
        );
      }
    } catch {
      setMagicLinkError(t("authCodeError.unexpectedError"));
    } finally {
      setSendingMagicLink(false);
    }
  };

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
              <AlertTriangle className="h-6 w-6 text-destructive" />
            </motion.div>
            <CardTitle className="text-2xl font-bold">
              {t("authErrorTitle")}
            </CardTitle>
            <CardDescription>
              {isPkceError
                ? t("authCodeError.descriptionPkce")
                : isLinkIssue
                  ? t("authCodeError.descriptionLinkInvalid")
                  : t("authCodeError.descriptionGeneric")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert variant="destructive">
              <AlertDescription className="text-sm">{reason}</AlertDescription>
            </Alert>

            {raw && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                transition={{ delay: 0.2 }}
              >
                <details className="group">
                  <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
                    {t("authCodeError.showTechnicalDetails")}
                  </summary>
                  <pre className="mt-2 p-3 rounded-md bg-muted text-xs overflow-auto whitespace-pre-wrap max-h-32">
                    {raw}
                  </pre>
                </details>
              </motion.div>
            )}

            <div className="flex flex-col sm:flex-row gap-2 pt-2">
              <Button onClick={() => router.push("/login")} className="flex-1">
                <LogIn className="h-4 w-4 mr-2" />
                {t("goToLogin")}
              </Button>
              <Button
                variant="outline"
                onClick={() => router.back()}
                className="flex-1"
              >
                <ArrowLeft className="h-4 w-4 mr-2" />
                {t("goBack")}
              </Button>
            </div>

            {isLinkIssue || isPkceError ? (
              <div className="text-sm space-y-4 pt-2">
                <div className="text-center space-y-2">
                  {isPkceError ? (
                    <>
                      <p className="font-medium">
                        {t("authCodeError.verificationSessionMismatch")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t("authCodeError.verificationContextHint")}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="font-medium">
                        {lowerReason.includes("already been used")
                          ? t("authCodeError.linkAlreadyUsed")
                          : lowerReason.includes("expired")
                            ? t("authCodeError.linkExpired")
                            : t("authCodeError.linkInvalidOrExpired")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {lowerReason.includes("already been used")
                          ? t("authCodeError.hintAlreadyUsed")
                          : t("authCodeError.hintExpired")}
                      </p>
                    </>
                  )}
                </div>

                {/* Sign-in link option - best for PKCE errors. */}
                {isPkceError && (
                  <div className="space-y-3 pt-2 border-t">
                    <div className="space-y-2">
                      <Label
                        htmlFor="magic-link-email"
                        className="text-xs font-medium"
                      >
                        {t("authCodeError.magicLinkLabel")}
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {t("authCodeError.magicLinkHint")}
                      </p>
                      <div className="flex gap-2">
                        <Input
                          id="magic-link-email"
                          type="email"
                          placeholder={t("authCodeError.emailPlaceholder")}
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
                        <p className="text-xs text-destructive">
                          {magicLinkError}
                        </p>
                      )}
                      {magicLinkSent && (
                        <p className="text-xs text-emerald-600 dark:text-emerald-400">
                          {t("authCodeError.magicLinkSent")}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {/* Resend Email Form */}
                {!isPkceError && (
                  <div className="space-y-3 pt-2 border-t">
                    <div className="space-y-2">
                      <Label htmlFor="resend-email" className="text-xs">
                        {t("authCodeError.requestVerificationEmail")}
                      </Label>
                      <div className="flex gap-2">
                        <Input
                          id="resend-email"
                          type="email"
                          placeholder={t("authCodeError.emailPlaceholder")}
                          value={email}
                          onChange={e => setEmail(e.target.value)}
                          disabled={resending || resendSuccess}
                          className="flex-1"
                        />
                        <Button
                          onClick={handleResendEmail}
                          disabled={resending || resendSuccess || !email}
                          size="default"
                        >
                          {resending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : resendSuccess ? (
                            <CheckCircle2 className="h-4 w-4" />
                          ) : (
                            <Mail className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                      {resendError && (
                        <p className="text-xs text-destructive">
                          {resendError}
                        </p>
                      )}
                      {resendSuccess && (
                        <p className="text-xs text-emerald-600 dark:text-emerald-400">
                          {t("authCodeError.verificationEmailSent")}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                <div className="flex gap-2 pt-2">
                  <Button
                    onClick={() => router.push("/login")}
                    variant="default"
                    className="flex-1"
                  >
                    <LogIn className="h-4 w-4 mr-2" />
                    {t("authCodeError.logIn")}
                  </Button>
                  <Button
                    onClick={() => router.push("/auth/callback-recovery")}
                    variant="outline"
                    className="flex-1"
                  >
                    <RefreshCw className="h-4 w-4 mr-2" />
                    {t("authCodeError.tryRecovery")}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2 pt-2">
                <p className="text-xs text-center text-muted-foreground">
                  {t("authCodeError.contactSupportHint")}
                </p>
                <Button
                  onClick={() => router.push("/auth/callback-recovery")}
                  variant="outline"
                  className="w-full"
                >
                  <RefreshCw className="h-4 w-4 mr-2" />
                  {t("authCodeError.tryAutomaticRecovery")}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}

export default function AuthCodeErrorPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-muted/20 p-6">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      }
    >
      <AuthCodeErrorContent />
    </Suspense>
  );
}
