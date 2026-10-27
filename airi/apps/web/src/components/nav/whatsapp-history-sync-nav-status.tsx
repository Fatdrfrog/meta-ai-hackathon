"use client";

import { cn } from "@/lib/utils";
import type { WhatsAppHistorySyncState } from "@icecore/whatsapp/historySyncState";
import {
  buildWhatsAppHistorySyncSummary,
  isWhatsAppHistorySyncActive,
} from "@/lib/whatsapp/history-sync/status";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

type HistorySyncStatusResponse = {
  data?: {
    history_sync?: WhatsAppHistorySyncState | null;
  };
};

export function WhatsAppHistorySyncNavStatus({
  workspaceId,
  className,
}: {
  workspaceId: string;
  className?: string;
}) {
  const t = useTranslations("WhatsAppHistorySync");
  const [historySync, setHistorySync] =
    useState<WhatsAppHistorySyncState | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timeoutId: number | null = null;

    const loadStatus = async () => {
      try {
        const response = await fetch(
          `/api/whatsapp/smb-app-data?workspaceId=${encodeURIComponent(workspaceId)}`,
          {
            cache: "no-store",
            signal: controller.signal,
          }
        );
        if (!response.ok) {
          if (!controller.signal.aborted) setHistorySync(null);
          return;
        }

        const payload = (await response.json()) as HistorySyncStatusResponse;
        const nextHistorySync = payload.data?.history_sync || null;
        if (controller.signal.aborted) return;
        setHistorySync(nextHistorySync);

        if (isWhatsAppHistorySyncActive(nextHistorySync)) {
          timeoutId = window.setTimeout(loadStatus, 5000);
        }
      } catch {
        if (!controller.signal.aborted) setHistorySync(null);
      }
    };

    loadStatus();

    return () => {
      controller.abort();
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [workspaceId]);

  if (!isWhatsAppHistorySyncActive(historySync)) return null;

  const summary = buildWhatsAppHistorySyncSummary(historySync);
  const progress =
    typeof summary.providerProgress === "number"
      ? `${summary.providerProgress}%`
      : null;

  return (
    <Link
      href={`/panel/w/${workspaceId}/settings/integrations?integration=whatsapp`}
      className={cn(
        "hidden h-8 max-w-[18rem] shrink min-w-0 items-center gap-2 rounded-md border border-border bg-muted/40 px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:flex",
        className
      )}
      aria-label={t("navLabel", { status: t(summary.titleKey) })}
    >
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-foreground" />
      <span className="truncate">{t(summary.titleKey)}</span>
      {progress ? (
        <span className="shrink-0 tabular-nums">{progress}</span>
      ) : null}
    </Link>
  );
}
