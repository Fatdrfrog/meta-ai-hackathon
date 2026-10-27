"use client";

import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

function getSafeNextPath(searchParams: URLSearchParams): string | null {
  const next = searchParams.get("next")?.trim();
  if (!next || !next.startsWith("/") || next.startsWith("//")) {
    return null;
  }

  return next;
}

function buildCallbackHref(
  searchParams: URLSearchParams,
  params: Record<string, string>
) {
  const callbackParams = new URLSearchParams(params);
  const next = getSafeNextPath(searchParams);
  if (next) {
    callbackParams.set("next", next);
  }

  return `/auth/callback?${callbackParams.toString()}`;
}

export default function ConfirmPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleAuth = async () => {
      const urlSearchParams = new URLSearchParams(window.location.search);

      // Handle error redirects from Supabase (e.g. expired/invalid invite token)
      const supabaseError = urlSearchParams.get("error");
      const supabaseErrorDescription =
        urlSearchParams.get("error_description") ||
        urlSearchParams.get("error_code") ||
        "";
      if (supabaseError) {
        const reason =
          supabaseErrorDescription || supabaseError || "Authentication failed";
        setError(reason);
        const params = new URLSearchParams({ reason });
        if (supabaseErrorDescription) {
          params.set("raw", supabaseErrorDescription);
        }
        router.push(`/auth/auth-code-error?${params.toString()}`);
        return;
      }

      // Check if we have a PKCE code in URL params
      const code = urlSearchParams.get("code");

      if (code) {
        // Modern PKCE flow - redirect to callback for secure code exchange
        window.location.href = buildCallbackHref(urlSearchParams, { code });
        return;
      }

      // Check for token_hash in query params (SSR email templates)
      const tokenHash = urlSearchParams.get("token_hash");
      const type = urlSearchParams.get("type");

      if (tokenHash && type) {
        try {
          const supabase = createClient();
          const { error: verifyError } = await supabase.auth.verifyOtp({
            token_hash: tokenHash,
            type: type as EmailOtpType,
          });

          if (verifyError) {
            throw verifyError;
          }

          // Session established, redirect to callback for post-auth handling
          window.location.href = buildCallbackHref(urlSearchParams, {
            legacy: "true",
          });
          return;
        } catch (err) {
          console.error("Failed to verify OTP:", err);
          setError(
            "This link is outdated. Please request a new confirmation email."
          );
          router.push(
            "/auth/auth-code-error?reason=Outdated+confirmation+link&raw=Please+sign+up+again+or+request+a+new+confirmation+email"
          );
          return;
        }
      }

      // Legacy support: Handle deprecated hash-based tokens (URL fragments)
      // These hash tokens are only available client-side
      const hashParams = new URLSearchParams(window.location.hash.substring(1));
      const accessToken = hashParams.get("access_token");

      if (accessToken) {
        try {
          const supabase = createClient();

          // Set session from hash-based token
          const { data, error: sessionError } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: hashParams.get("refresh_token") || "",
          });

          if (sessionError) {
            throw sessionError;
          }

          if (data?.user) {
            // Session established successfully, redirect to callback for post-auth handling
            window.location.href = buildCallbackHref(urlSearchParams, {
              legacy: "true",
            });
            return;
          }

          throw new Error("Failed to establish session");
        } catch (err) {
          console.error("Failed to process legacy auth link:", err);
          setError(
            "This link is outdated. Please request a new confirmation email."
          );
          router.push(
            "/auth/auth-code-error?reason=Outdated+confirmation+link&raw=Please+sign+up+again+or+request+a+new+confirmation+email"
          );
          return;
        }
      }

      // No valid auth parameters found - this could be a subscription flow
      // Let the user know and provide guidance
      setError("Invalid or missing authentication parameters");
      router.push(
        "/auth/auth-code-error?reason=Invalid+link&raw=Please+try+signing+up+or+logging+in+again"
      );
    };

    handleAuth();
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-muted/20 p-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className="max-w-lg w-full space-y-6 text-center"
      >
        {error ? (
          <>
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: "spring", stiffness: 200 }}
              className="mx-auto w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center"
            >
              <svg
                className="w-8 h-8 text-destructive"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </motion.div>
            <h1 className="text-2xl font-semibold">Authentication Error</h1>
            <p className="text-sm text-muted-foreground">{error}</p>
          </>
        ) : (
          <>
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
              className="mx-auto w-12 h-12 rounded-full border-2 border-primary border-t-transparent"
            />
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.2 }}
            >
              <p className="text-sm font-medium">
                Confirming your invitation...
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                This will only take a moment
              </p>
            </motion.div>
          </>
        )}
      </motion.div>
    </div>
  );
}
