"use client";

import { ScopedIntlProvider } from "@/components/i18n/scoped-intl-provider";
import { Button } from "@/components/ui/button";
import {
  AIRI_BUILDER_MESSAGE_NAMESPACES,
  getLoadedAiriBuilderClientMessages,
  loadAiriBuilderClientMessages,
  resolveAiriBuilderMessagesLocale,
} from "@/i18n/airi-builder-client-messages";
import { cn } from "@/lib/utils";
import { AlertCircle, RefreshCw } from "lucide-react";
import { useLocale, useMessages, useTranslations } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";

type MessageMap = Record<string, unknown>;

type AiriBuilderMessagesState =
  | { key: string; status: "loaded"; messages: MessageMap }
  | { key: string; status: "failed" };

/**
 * Gives the WhatsApp builders their Scenarios and templates translations.
 * The /airi page already provides them; the drawer does not, so there the
 * catalogs download with the builder (once per locale) and the builder waits
 * on `fallback` instead of rendering raw message keys. A failed download
 * shows `renderFailure` (the builder's message by default) with a retry.
 */
export function AiriBuilderIntlProvider({
  children,
  fallback,
  renderFailure,
}: {
  children: ReactNode;
  fallback: ReactNode;
  /** What a failed download shows, for callers that are not the builder. */
  renderFailure?: (retry: () => void) => ReactNode;
}) {
  const locale = resolveAiriBuilderMessagesLocale(useLocale());
  const parentMessages = useMessages() as MessageMap | null | undefined;
  const hasCatalogs = AIRI_BUILDER_MESSAGE_NAMESPACES.every(
    namespace => parentMessages?.[namespace] !== undefined
  );
  const [attempt, setAttempt] = useState(0);
  const requestKey = `${locale}\u0000${attempt}`;
  const [state, setState] = useState<AiriBuilderMessagesState | null>(null);
  const cachedMessages = hasCatalogs
    ? null
    : getLoadedAiriBuilderClientMessages(locale);

  useEffect(() => {
    if (hasCatalogs || cachedMessages) return;
    let cancelled = false;
    loadAiriBuilderClientMessages(locale).then(
      messages => {
        if (!cancelled) {
          setState({ key: requestKey, status: "loaded", messages });
        }
      },
      () => {
        if (!cancelled) setState({ key: requestKey, status: "failed" });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [cachedMessages, hasCatalogs, locale, requestKey]);

  if (hasCatalogs) return <>{children}</>;

  const messages =
    cachedMessages ??
    (state?.key === requestKey && state.status === "loaded"
      ? state.messages
      : null);
  if (messages) {
    return (
      <ScopedIntlProvider messages={messages}>{children}</ScopedIntlProvider>
    );
  }

  if (state?.key === requestKey && state.status === "failed") {
    const retry = () => setAttempt(value => value + 1);
    if (renderFailure) return <>{renderFailure(retry)}</>;
    return (
      <div
        role="alert"
        className="flex h-full min-h-40 flex-col items-center justify-center gap-3 px-4 text-center text-sm text-muted-foreground"
      >
        <AlertCircle className="size-5 text-destructive" />
        <p>The builder could not load. Check your connection and try again.</p>
        <Button type="button" size="sm" variant="outline" onClick={retry}>
          <RefreshCw data-icon="inline-start" />
          Retry
        </Button>
      </div>
    );
  }

  return <>{fallback}</>;
}

/**
 * A failed catalog download where a message shows a template preview, not
 * the builder: compact and neutral, since a chat can hold several previews.
 */
export function AiriPreviewLoadFailure({
  className,
  onRetry,
}: {
  className?: string;
  onRetry: () => void;
}) {
  const t = useTranslations("AiriChat");
  return (
    <div
      data-testid="airi-preview-load-failure"
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-[1.5rem] bg-muted/50 px-4 py-6 text-center text-xs text-muted-foreground",
        className
      )}
    >
      <p className="[overflow-wrap:anywhere]">{t("previewLoadFailed")}</p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 px-2 text-xs"
        onClick={onRetry}
      >
        <RefreshCw data-icon="inline-start" />
        {t("retry")}
      </Button>
    </div>
  );
}
