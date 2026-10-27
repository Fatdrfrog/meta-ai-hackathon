"use client";

import { setLocale } from "@/app/actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isLocale, languageSwitcherLocales, type Locale } from "@/i18n/locales";
import { appendKBLocaleQuery } from "@/lib/kb/kb-route-prefetch";
import { Languages, Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

type LanguageSwitcherProps = {
  activeLocale?: Locale;
  availableLocales?: readonly Locale[];
  /** Prefer false inside scroll/transform shells that break portal unmount. */
  menuPortalled?: boolean;
  /** When true, also write `?locale=` on the current URL. */
  syncSearchParam?: boolean;
};

const LANGUAGE_MESSAGE_KEYS: Record<Locale, string> = {
  kz: "kazakh",
  en: "english",
  ru: "russian",
};

export function LanguageSwitcher({
  activeLocale,
  availableLocales,
  menuPortalled = true,
  syncSearchParam = false,
}: LanguageSwitcherProps = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const locale = useLocale();
  const [isPending, startTransition] = useTransition();
  const t = useTranslations("LanguageSwitcher");
  const resolvedActiveLocale =
    activeLocale ?? (isLocale(locale) ? locale : "en");
  const availableLocaleSet = availableLocales
    ? new Set<Locale>(availableLocales)
    : null;

  const changeLocale = (nextLocale: Locale) => {
    if (availableLocaleSet && !availableLocaleSet.has(nextLocale)) {
      return;
    }

    startTransition(() => {
      setLocale(nextLocale).then(() => {
        if (syncSearchParam && pathname) {
          const currentQuery = searchParams.toString();
          router.push(
            appendKBLocaleQuery(
              currentQuery ? `${pathname}?${currentQuery}` : pathname,
              nextLocale
            )
          );
          return;
        }

        router.refresh();
      });
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          disabled={isPending}
        >
          {isPending ? (
            <Loader2 className="h-[1.2rem] w-[1.2rem] animate-spin" />
          ) : (
            <Languages className="h-[1.2rem] w-[1.2rem]" />
          )}
          <span className="sr-only">{t("changeLanguage")}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" portalled={menuPortalled}>
        {languageSwitcherLocales.map(nextLocale => {
          const disabled =
            resolvedActiveLocale === nextLocale ||
            (availableLocaleSet !== null &&
              !availableLocaleSet.has(nextLocale));

          return (
            <DropdownMenuItem
              key={nextLocale}
              onClick={() => changeLocale(nextLocale)}
              disabled={disabled}
            >
              {t(LANGUAGE_MESSAGE_KEYS[nextLocale])}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
