"use client";

import {
  AUTH_PRIMARY_BUTTON_CLASS,
  AUTH_SECONDARY_BUTTON_CLASS,
} from "@/components/auth/auth-styles";
import { LandingLightTheme } from "@/components/landing/landing-light-theme";
import { LandingStaticBackground } from "@/components/landing/landing-static-background";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { isFetchNetworkError } from "@/lib/fetch-network-error";
import { captureClientException } from "@/lib/posthog/client";
import { cn } from "@/lib/utils";
import { AlertCircle, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import Image from "next/image";
import Link from "next/link";
import { useEffect } from "react";

type LoginErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

// A sign-in request that dies on the network (flaky Wi-Fi, a VPN) rejects the
// server action. Catching it here keeps the user on a branded page with a
// retry instead of Next's generic "This page couldn't load".
export default function LoginError({ error, reset }: LoginErrorProps) {
  const t = useTranslations("LoginPage");
  const isConnectionError = isFetchNetworkError(error);

  useEffect(() => {
    console.error("[login] page error boundary", error);
    captureClientException(error, { error_boundary: "login" });
  }, [error]);

  return (
    <div className="relative isolate min-h-dvh overflow-hidden bg-background text-slate-950">
      <LandingLightTheme />
      <div aria-hidden className="pointer-events-none fixed inset-0 z-0">
        <LandingStaticBackground />
      </div>

      <main className="relative z-10 mx-auto flex min-h-dvh w-full max-w-md items-center px-4 py-10">
        <section className="w-full space-y-5 rounded-[1.75rem] border-2 border-slate-950 bg-white/90 p-5 shadow-[7px_7px_0px_#111827] backdrop-blur sm:p-6">
          <Link
            href="/"
            className="flex w-fit items-center gap-2"
            aria-label="airi.chat"
          >
            <Image
              src="/logo_short_black.svg"
              alt=""
              width={200}
              height={50}
              className="h-7 w-auto"
              style={{ width: "auto" }}
            />
            <span className="font-medium">airi.chat</span>
          </Link>

          <Alert
            variant="destructive"
            className="border-2 border-slate-950 bg-white"
          >
            <AlertCircle className="h-4 w-4" />
            <AlertTitle className="line-clamp-none font-black">
              {isConnectionError
                ? t("signInConnectionErrorTitle")
                : t("signInPageErrorTitle")}
            </AlertTitle>
            <AlertDescription className="font-medium">
              {isConnectionError
                ? t("signInConnectionErrorDescription")
                : t("signInPageErrorDescription")}
            </AlertDescription>
          </Alert>

          <div className="grid gap-2">
            <Button
              type="button"
              variant="outline"
              className={cn("w-full", AUTH_PRIMARY_BUTTON_CLASS)}
              onClick={reset}
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              {t("tryAgain")}
            </Button>
            <Button
              type="button"
              variant="outline"
              className={cn("w-full", AUTH_SECONDARY_BUTTON_CLASS)}
              onClick={() => window.location.reload()}
            >
              {t("reloadPage")}
            </Button>
          </div>
        </section>
      </main>
    </div>
  );
}
