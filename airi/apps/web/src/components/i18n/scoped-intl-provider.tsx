"use client";

import { NextIntlClientProvider, useLocale, useMessages } from "next-intl";
import { useMemo, type ReactNode } from "react";

type MessageMap = Record<string, unknown>;

type ScopedIntlProviderProps = {
  children: ReactNode;
  messages: MessageMap;
};

export function ScopedIntlProvider({
  children,
  messages,
}: ScopedIntlProviderProps) {
  const locale = useLocale();
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
