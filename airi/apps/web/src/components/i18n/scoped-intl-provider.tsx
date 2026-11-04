"use client";

import { NextIntlClientProvider, useLocale, useMessages } from "next-intl";
import { useMemo, type ReactNode } from "react";

type MessageMap = Record<string, unknown>;

type ScopedIntlProviderProps = {
  children: ReactNode;
  messages: MessageMap;
  /**
   * The subtree's locale, instead of the page's: an English-only section
   * (Products) passes "en" with its own English catalogs.
   */
  locale?: string;
};

export function ScopedIntlProvider({
  children,
  messages,
  locale: localeOverride,
}: ScopedIntlProviderProps) {
  const parentLocale = useLocale();
  const locale = localeOverride ?? parentLocale;
  const parentMessages = useMessages() as MessageMap;
  const mergedMessages = useMemo(
    () => ({ ...parentMessages, ...messages }),
    [parentMessages, messages]
  );

  return (
    <NextIntlClientProvider locale={locale} messages={mergedMessages}>
      {children}
    </NextIntlClientProvider>
  );
}
