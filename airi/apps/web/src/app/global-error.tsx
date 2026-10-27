"use client";

import {
  AUTH_PRIMARY_BUTTON_CLASS,
  AUTH_SECONDARY_BUTTON_CLASS,
} from "@/components/auth/auth-styles";
import { Button } from "@/components/ui/button";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/locales";
import { isFetchNetworkError } from "@/lib/fetch-network-error";
import { captureClientException } from "@/lib/posthog/client";
import { cn } from "@/lib/utils";
import { RefreshCw } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { inter } from "./fonts";
import "./globals.css";

type GlobalErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

type GlobalErrorCopy = {
  title: string;
  description: string;
  connectionDescription: string;
  retry: string;
  reload: string;
};

// This boundary replaces the root layout, so NextIntlClientProvider and the
// message catalogs are not available: the copy is inlined per locale.
const GLOBAL_ERROR_COPY: Record<Locale, GlobalErrorCopy> = {
  en: {
    title: "This page didn't load",
    description:
      "Something went wrong while loading this page. Try again, or reload the page.",
    connectionDescription:
      "We couldn't reach airi.chat. Check your internet connection or VPN, then try again.",
    retry: "Try again",
    reload: "Reload page",
  },
  ru: {
    title: "Страница не загрузилась",
    description:
      "При загрузке страницы что-то пошло не так. Попробуйте снова или перезагрузите страницу.",
    connectionDescription:
      "Не удалось связаться с airi.chat. Проверьте интернет или VPN и попробуйте снова.",
    retry: "Попробовать снова",
    reload: "Перезагрузить страницу",
  },
  kz: {
    title: "Бет жүктелмеді",
    description:
      "Бетті жүктеу кезінде қате орын алды. Қайталап көріңіз немесе бетті қайта жүктеңіз.",
    connectionDescription:
      "airi.chat-қа қосылу мүмкін болмады. Интернетті немесе VPN-ді тексеріп, қайталап көріңіз.",
    retry: "Қайталау",
    reload: "Бетті қайта жүктеу",
  },
};

function readLocaleCookie(): Locale {
  const match = document.cookie.match(/(?:^|;\s*)NEXT_LOCALE=([^;]*)/);
  const value = match ? decodeURIComponent(match[1]) : "";
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

function subscribeToNothing() {
  return () => {};
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  // The server snapshot keeps hydration on the default locale; the cookie
  // locale applies right after.
  const locale = useSyncExternalStore(
    subscribeToNothing,
    readLocaleCookie,
    () => DEFAULT_LOCALE
  );
  const copy = GLOBAL_ERROR_COPY[locale];

  useEffect(() => {
    console.error("[app] global error boundary", error);
    captureClientException(error, { error_boundary: "global" });
  }, [error]);

  return (
    <html lang={locale} className={inter.variable}>
      <body className="min-h-dvh bg-background font-sans text-slate-950 antialiased">
        <main className="mx-auto flex min-h-dvh w-full max-w-md items-center px-4 py-10">
          <section
            role="alert"
            className="w-full space-y-4 rounded-[1.75rem] border-2 border-slate-950 bg-white p-5 shadow-[7px_7px_0px_#111827] sm:p-6"
          >
            <p className="text-xs font-black uppercase tracking-[0.14em] text-[#075e54]">
              airi.chat
            </p>
            <h1 className="text-2xl font-black tracking-tight">{copy.title}</h1>
            <p className="text-sm font-medium leading-6 text-slate-700">
              {isFetchNetworkError(error)
                ? copy.connectionDescription
                : copy.description}
            </p>
            <div className="grid gap-2">
              <Button
                type="button"
                variant="outline"
                className={cn("w-full", AUTH_PRIMARY_BUTTON_CLASS)}
                onClick={reset}
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                {copy.retry}
              </Button>
              <Button
                type="button"
                variant="outline"
                className={cn("w-full", AUTH_SECONDARY_BUTTON_CLASS)}
                onClick={() => window.location.reload()}
              >
                {copy.reload}
              </Button>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
}
