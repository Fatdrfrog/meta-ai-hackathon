"use client";

import { LanguageSwitcher } from "@/components/settings/language-switcher";
import { ThemeSwitcher } from "@/components/settings/theme-switcher";
import { Button, buttonVariants } from "@/components/ui/button";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/locales";
import { getPublicTemplatePath } from "@/lib/landing/public-template-seo";
import {
  LOGIN_HREF,
  START_FREE_HREF,
  type LandingHeaderViewer,
} from "@/lib/landing/landing-header-viewer";
import { BOOK_DEMO_URL } from "@/lib/links";
import { cn } from "@/lib/utils";
import { BotMessageSquare, LogIn } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { LandingLightTheme } from "./landing-light-theme";

type LandingPageHeaderProps = {
  variant?: "landing" | "docs";
  sticky?: boolean;
  leadingSlot?: ReactNode;
  trailingSlot?: ReactNode;
  brandHref?: string;
  languageSwitcherActiveLocale?: Locale;
  languageSwitcherAvailableLocales?: readonly Locale[];
  languageSwitcherSyncSearchParam?: boolean;
  viewer?: LandingHeaderViewer;
};

export function LandingPageHeader({
  variant = "landing",
  sticky = true,
  leadingSlot,
  trailingSlot,
  brandHref = "/",
  languageSwitcherActiveLocale,
  languageSwitcherAvailableLocales,
  languageSwitcherSyncSearchParam,
  viewer,
}: LandingPageHeaderProps = {}) {
  const t = useTranslations("LandingDemo");
  const landingPageT = useTranslations("LandingPage");
  const locale = useLocale();
  const templateLocale =
    languageSwitcherActiveLocale ??
    (isLocale(locale) ? locale : DEFAULT_LOCALE);

  const isDocs = variant === "docs";
  const isStickyDocs = isDocs && sticky;
  const isAuthenticated = Boolean(viewer?.isAuthenticated);
  const showStartFree = !isAuthenticated && !viewer?.hasKnownAccount;
  const panelHref = viewer?.panelHref || "/panel";
  const panelLabel = landingPageT("header.openWorkspace");
  const bookDemoLabel = t("header.bookDemo");
  const languageSwitcher = (
    <LanguageSwitcher
      activeLocale={languageSwitcherActiveLocale}
      availableLocales={languageSwitcherAvailableLocales}
      syncSearchParam={languageSwitcherSyncSearchParam}
    />
  );

  return (
    <>
      {!isDocs ? <LandingLightTheme /> : null}
      <header
        className={cn(
          "w-full",
          isDocs && "border-b border-border/70 bg-background/95",
          isStickyDocs &&
            "sticky top-0 z-50 backdrop-blur supports-[backdrop-filter]:bg-background/80"
        )}
      >
        <div className="mx-auto flex h-14 w-full max-w-full items-center justify-between gap-3 px-4 md:px-8">
          <div className="flex min-w-0 items-center gap-2">
            {leadingSlot ? (
              <div className="flex shrink-0 items-center">{leadingSlot}</div>
            ) : null}
            <Link
              href={brandHref}
              className="flex min-w-0 shrink-0 items-center gap-2"
            >
              <Image
                src="/logo_short_black.svg"
                alt=""
                width={200}
                height={50}
                className="h-7 w-auto dark:hidden"
                style={{ width: "auto" }}
              />
              <Image
                src="/logo_short_white.svg"
                alt=""
                width={200}
                height={50}
                className="hidden h-7 w-auto dark:block"
                style={{ width: "auto" }}
              />
              <span className="truncate font-medium">airi.chat</span>
            </Link>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {!isDocs ? (
              <Link
                href={getPublicTemplatePath(templateLocale)}
                className="inline-flex h-9 items-center rounded-md px-2 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3"
              >
                {t("templates.navigation")}
              </Link>
            ) : null}
            {trailingSlot ? (
              <div className="flex shrink-0 items-center">{trailingSlot}</div>
            ) : null}
            <div className="hidden h-9 items-center gap-2 lg:flex">
              {isAuthenticated ? (
                <Button asChild variant="ghost" size="sm" className="h-9 px-3">
                  <Link href={panelHref}>
                    <BotMessageSquare className="h-4 w-4" />
                    {panelLabel}
                  </Link>
                </Button>
              ) : (
                <Button asChild variant="ghost" size="sm" className="h-9 px-3">
                  <Link href={LOGIN_HREF}>{t("header.signIn")}</Link>
                </Button>
              )}
              {!isAuthenticated ? (
                <>
                  <Button
                    asChild
                    variant="secondary"
                    size="sm"
                    className="h-9 px-3"
                  >
                    <a href={BOOK_DEMO_URL} target="_blank" rel="noreferrer">
                      {bookDemoLabel}
                    </a>
                  </Button>
                  {showStartFree ? (
                    <Link
                      href={START_FREE_HREF}
                      className={cn(
                        buttonVariants({ variant: "default", size: "sm" }),
                        "h-9 px-4"
                      )}
                    >
                      {t("header.startFree")}
                    </Link>
                  ) : null}
                </>
              ) : null}
              {languageSwitcher}
              {isDocs ? <ThemeSwitcher /> : null}
            </div>
            <div className="flex shrink-0 items-center gap-1 lg:hidden">
              {!isDocs ? (
                <>
                  {languageSwitcher}
                  <Button asChild variant="ghost" size="icon">
                    <Link
                      href={isAuthenticated ? panelHref : LOGIN_HREF}
                      aria-label={
                        isAuthenticated ? panelLabel : t("header.signIn")
                      }
                    >
                      {isAuthenticated ? (
                        <BotMessageSquare
                          className="h-4 w-4"
                          aria-hidden="true"
                        />
                      ) : (
                        <LogIn className="h-4 w-4" aria-hidden="true" />
                      )}
                    </Link>
                  </Button>
                </>
              ) : null}
              {isDocs ? (
                <>
                  {languageSwitcher}
                  <ThemeSwitcher />
                  <Button asChild variant="ghost" size="icon">
                    <Link
                      href={isAuthenticated ? panelHref : LOGIN_HREF}
                      aria-label={
                        isAuthenticated ? panelLabel : t("header.signIn")
                      }
                    >
                      {isAuthenticated ? (
                        <BotMessageSquare
                          className="h-4 w-4"
                          aria-hidden="true"
                        />
                      ) : (
                        <LogIn className="h-4 w-4" aria-hidden="true" />
                      )}
                    </Link>
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        </div>
      </header>
    </>
  );
}
