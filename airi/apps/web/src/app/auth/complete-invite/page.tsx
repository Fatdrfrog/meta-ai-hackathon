"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
import { panelWorkspaceAiriHref } from "@/features/panel/shared/routing/hrefs";
import { zodResolver } from "@hookform/resolvers/zod";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, Check, Eye, EyeOff, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import {
  buildCompleteInviteSchema,
  scorePasswordStrength,
  type CompleteInviteForm,
  type PasswordStrengthLevel,
} from "./complete-invite-schema";

const STRENGTH_COLORS: Record<PasswordStrengthLevel, string> = {
  weak: "bg-red-500",
  fair: "bg-orange-500",
  good: "bg-yellow-500",
  strong: "bg-green-500",
};

// Password strength indicator component
function PasswordStrength({ password }: { password: string }) {
  const t = useTranslations("Auth.completeInvite");
  const strength = useMemo(() => {
    if (!password) return null;
    const { score, level } = scorePasswordStrength(password);
    return {
      score,
      label: t(`strength.${level}`),
      color: STRENGTH_COLORS[level],
    };
  }, [password, t]);

  if (!strength) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-2"
    >
      <div className="flex gap-1">
        {[1, 2, 3, 4].map(bar => (
          <div
            key={bar}
            className={`h-1 flex-1 rounded-full transition-colors ${
              bar <= Math.ceil(strength.score / 1.5)
                ? strength.color
                : "bg-muted"
            }`}
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {t.rich("strengthLabel", {
          strength: strength.label,
          value: chunks => <span className="font-medium">{chunks}</span>,
        })}
      </p>
    </motion.div>
  );
}

export default function CompleteInvitePage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center items-center min-h-screen bg-gradient-to-br from-background via-background to-muted/20 p-4">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      }
    >
      <CompleteInviteContent />
    </Suspense>
  );
}

function CompleteInviteContent() {
  const searchParams = useSearchParams();
  const workspaceId = searchParams.get("workspaceId");
  const supabase = useMemo(() => createClient(), []);
  const t = useTranslations("Auth.completeInvite");
  const completeInviteSchema = useMemo(() => buildCompleteInviteSchema(t), [t]);

  const [isSuccess, setIsSuccess] = useState(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const form = useForm<CompleteInviteForm>({
    resolver: zodResolver(completeInviteSchema),
    defaultValues: {
      fullName: "",
      password: "",
      confirmPassword: "",
    },
    mode: "onBlur", // Validate on blur for better UX
  });

  useEffect(() => {
    let active = true;

    const checkAuthState = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!active) {
        return;
      }

      if (!user) {
        window.location.href = "/login";
        return;
      }

      const providers = user.app_metadata?.providers;
      const hasNonEmailProvider =
        Array.isArray(providers) &&
        providers.some(provider => provider !== "email");

      if (workspaceId && hasNonEmailProvider) {
        window.location.href = panelWorkspaceAiriHref(workspaceId);
        return;
      }

      setIsCheckingAuth(false);
    };

    checkAuthState().catch(() => {
      if (active) {
        setIsCheckingAuth(false);
      }
    });

    return () => {
      active = false;
    };
  }, [supabase, workspaceId]);

  const onSubmit = async (values: CompleteInviteForm) => {
    try {
      // Update user's password and profile
      const { error: updateError } = await supabase.auth.updateUser({
        password: values.password,
        data: { full_name: values.fullName },
      });

      if (updateError) {
        throw updateError;
      }
      await fetch("/api/auth/sync-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      setIsSuccess(true);
      toast.success(t("toast.successTitle"), {
        description: t("toast.redirecting"),
      });

      setTimeout(() => {
        if (workspaceId) {
          window.location.href = panelWorkspaceAiriHref(workspaceId);
        } else {
          window.location.href = "/panel";
        }
      }, 1200);
    } catch (err) {
      const errorMessage =
        err instanceof Error && err.message
          ? err.message
          : t("toast.failedFallback");

      if (
        workspaceId &&
        /new password should be different from the old password/i.test(
          errorMessage
        )
      ) {
        toast.success(t("toast.alreadySetUpTitle"), {
          description: t("toast.redirecting"),
        });
        window.location.href = panelWorkspaceAiriHref(workspaceId);
        return;
      }

      toast.error(t("toast.failedTitle"), { description: errorMessage });
      form.setError("root", { message: errorMessage });
    }
  };

  const passwordValue = form.watch("password");

  if (isCheckingAuth) {
    return (
      <div className="flex justify-center items-center min-h-screen bg-gradient-to-br from-background via-background to-muted/20 p-4">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex justify-center items-center min-h-screen bg-gradient-to-br from-background via-background to-muted/20 p-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="w-full max-w-md"
      >
        <Card className="border-border/50 shadow-lg">
          <CardHeader className="text-center space-y-2">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.2, type: "spring", stiffness: 200 }}
            >
              <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-2">
                <svg
                  className="w-6 h-6 text-primary"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"
                  />
                </svg>
              </div>
            </motion.div>
            <CardTitle className="text-2xl font-bold">{t("title")}</CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                className="space-y-5"
              >
                <FormField
                  control={form.control}
                  name="fullName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("fullNameLabel")}</FormLabel>
                      <FormControl>
                        <Input
                          placeholder={t("fullNamePlaceholder")}
                          {...field}
                          disabled={form.formState.isSubmitting || isSuccess}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("passwordLabel")}</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Input
                            type={showPassword ? "text" : "password"}
                            placeholder={t("passwordPlaceholder")}
                            {...field}
                            disabled={form.formState.isSubmitting || isSuccess}
                          />
                          <button
                            type="button"
                            onClick={() => setShowPassword(!showPassword)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                            tabIndex={-1}
                            aria-label={
                              showPassword
                                ? t("hidePassword")
                                : t("showPassword")
                            }
                          >
                            {showPassword ? (
                              <EyeOff className="h-4 w-4" />
                            ) : (
                              <Eye className="h-4 w-4" />
                            )}
                          </button>
                        </div>
                      </FormControl>
                      <PasswordStrength password={passwordValue} />
                      <FormDescription>{t("passwordHint")}</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="confirmPassword"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("confirmPasswordLabel")}</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <Input
                            type={showConfirmPassword ? "text" : "password"}
                            placeholder={t("confirmPasswordPlaceholder")}
                            {...field}
                            disabled={form.formState.isSubmitting || isSuccess}
                          />
                          <button
                            type="button"
                            onClick={() =>
                              setShowConfirmPassword(!showConfirmPassword)
                            }
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                            tabIndex={-1}
                            aria-label={
                              showConfirmPassword
                                ? t("hidePassword")
                                : t("showPassword")
                            }
                          >
                            {showConfirmPassword ? (
                              <EyeOff className="h-4 w-4" />
                            ) : (
                              <Eye className="h-4 w-4" />
                            )}
                          </button>
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <AnimatePresence mode="wait">
                  {form.formState.errors.root && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                    >
                      <Alert variant="destructive">
                        <AlertCircle className="h-4 w-4" />
                        <AlertDescription>
                          {form.formState.errors.root.message}
                        </AlertDescription>
                      </Alert>
                    </motion.div>
                  )}
                </AnimatePresence>

                <Button
                  type="submit"
                  className="w-full relative overflow-hidden"
                  disabled={form.formState.isSubmitting || isSuccess}
                >
                  <AnimatePresence mode="wait">
                    {isSuccess ? (
                      <motion.span
                        key="success"
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        className="flex items-center gap-2"
                      >
                        <Check className="h-4 w-4" />
                        {t("submitted")}
                      </motion.span>
                    ) : form.formState.isSubmitting ? (
                      <motion.span
                        key="loading"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="flex items-center gap-2"
                      >
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t("submitting")}
                      </motion.span>
                    ) : (
                      <motion.span
                        key="default"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                      >
                        {t("submit")}
                      </motion.span>
                    )}
                  </AnimatePresence>
                </Button>

                <p className="text-xs text-center text-muted-foreground">
                  {t.rich("legal", {
                    terms: chunks => (
                      <Link href="/terms" className="underline">
                        {chunks}
                      </Link>
                    ),
                    privacy: chunks => (
                      <Link href="/privacy" className="underline">
                        {chunks}
                      </Link>
                    ),
                  })}
                </p>
              </form>
            </Form>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
