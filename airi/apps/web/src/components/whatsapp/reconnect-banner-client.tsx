"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { loadPostHogClient } from "@/lib/posthog/client";
import type { WhatsAppReconnectStatus } from "@/lib/whatsapp/reconnect-status";
import { cn } from "@/lib/utils";
import { AlertTriangle, ArrowRight, X } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import useSWR from "swr";

interface WhatsAppReconnectBannerClientProps {
  workspaceId: string;
  companyId?: string;
  status: WhatsAppReconnectStatus;
}

const DISMISS_STORAGE_PREFIX = "wa-reconnect-banner-dismissed:";
const RECONNECT_STATUS_POLL_MS = 60_000;

function isSilentReconnectState(state: WhatsAppReconnectStatus["state"]) {
  return (
    state === "healthy" ||
    state === "maintaining" ||
    state === "unknown" ||
    state === "not_connected"
  );
}

async function fetchReconnectStatus(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Failed to refresh WhatsApp status");
  return (await response.json()) as WhatsAppReconnectStatus;
}

function makeDismissKey(workspaceId: string, days: number | null): string {
  // Key by rounded-days-bucket so the banner reappears as the window
  // tightens (e.g. dismiss at 14d still re-shows at 7d and at 1d).
  const bucket =
    days === null
      ? "unknown"
      : days <= 0
        ? "expired"
        : days <= 1
          ? "1d"
          : days <= 3
            ? "3d"
            : days <= 7
              ? "7d"
              : "14d";
  return `${DISMISS_STORAGE_PREFIX}${workspaceId}:${bucket}`;
}

function makeBannerKey(
  workspaceId: string,
  status: WhatsAppReconnectStatus
): string {
  if (status.state === "removed" && status.partnerRemoval) {
    return `wa-partner-removed:${workspaceId}:${status.partnerRemoval.sourceId}:${status.partnerRemoval.removedAt}`;
  }
  return `${makeDismissKey(workspaceId, status.daysUntilExpiry)}:${status.state}`;
}

export function WhatsAppReconnectBannerClient({
  workspaceId,
  companyId,
  status: initialStatus,
}: WhatsAppReconnectBannerClientProps) {
  const { data: liveStatus } = useSWR<WhatsAppReconnectStatus>(
    `/api/whatsapp/reconnect-status?workspaceId=${encodeURIComponent(workspaceId)}`,
    fetchReconnectStatus,
    {
      fallbackData: initialStatus,
      refreshInterval: RECONNECT_STATUS_POLL_MS,
      revalidateOnFocus: true,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
    }
  );
  const status = liveStatus ?? initialStatus;
  const dismissKey = makeBannerKey(workspaceId, status);

  return (
    <WhatsAppReconnectBannerBody
      key={dismissKey}
      workspaceId={workspaceId}
      companyId={companyId}
      status={status}
      dismissKey={dismissKey}
    />
  );
}

function WhatsAppReconnectBannerBody({
  workspaceId,
  companyId,
  status,
  dismissKey,
}: WhatsAppReconnectBannerClientProps & { dismissKey: string }) {
  const t = useTranslations("WhatsAppReconnectBanner");
  const [dismissed, setDismissed] = useState(() =>
    status.state === "removed"
      ? status.partnerRemoval?.alertDismissed === true
      : true
  );
  const [dismissError, setDismissError] = useState(false);
  const [isDismissPending, startDismissTransition] = useTransition();
  const capturedAlertKeyRef = useRef<string | null>(null);
  const dismissKeyRef = useRef(dismissKey);

  // Hydrate dismissal from sessionStorage on the client to avoid SSR
  // mismatch (server always renders, client may hide).
  useEffect(() => {
    if (status.state === "removed") {
      setDismissed(status.partnerRemoval?.alertDismissed === true);
      return;
    }
    try {
      const value = sessionStorage.getItem(dismissKeyRef.current);
      setDismissed(value === "1");
    } catch {
      setDismissed(false);
    }
  }, [status.state, status.partnerRemoval?.alertDismissed]);

  // Emit PostHog event once per page-render when the banner is actually
  // shown to the user. Keyed by state + bucket so we dedupe within a
  // session but still capture transitions.
  useEffect(() => {
    if (dismissed) return;
    if (isSilentReconnectState(status.state)) return;
    if (capturedAlertKeyRef.current === dismissKey) return;
    capturedAlertKeyRef.current = dismissKey;

    void loadPostHogClient().then(posthog => {
      if (!posthog) return;
      posthog.capture("wa_reconnect_required", {
        workspace_id: workspaceId,
        waba_id: status.wabaId,
        days_until_expiry: status.daysUntilExpiry ?? -1,
        state: status.state,
        reconnect_method: status.reconnectMethod,
        company_id: companyId,
        $groups: companyId ? { company: companyId } : undefined,
      });
    });
  }, [dismissed, companyId, workspaceId, status, dismissKey]);

  if (dismissed) return null;
  if (isSilentReconnectState(status.state)) return null;

  const isRemoved = status.state === "removed";
  const isExpired = status.state === "expired";
  const isUrgent = isRemoved || isExpired;
  const title = isRemoved
    ? t("removedTitle")
    : isExpired
      ? t("expiredTitle")
      : t("warningTitle");

  const body = isRemoved
    ? status.displayPhoneNumber
      ? t("removedBodyWithPhone", { phone: status.displayPhoneNumber })
      : t("removedBody")
    : status.displayPhoneNumber
      ? t("bodyWithPhone", { phone: status.displayPhoneNumber })
      : t("body");

  const handleDismiss = () => {
    if (isRemoved) {
      const removal = status.partnerRemoval;
      if (!removal) return;
      setDismissError(false);
      startDismissTransition(async () => {
        try {
          const response = await fetch("/api/whatsapp/reconnect-status", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              workspaceId,
              sourceId: removal.sourceId,
              removedAt: removal.removedAt,
            }),
          });
          if (!response.ok) throw new Error("Dismissal failed");
          setDismissed(true);
        } catch {
          setDismissError(true);
        }
      });
      return;
    }
    try {
      sessionStorage.setItem(dismissKey, "1");
    } catch {
      // sessionStorage may be unavailable (private mode); fall back to
      // in-memory only.
    }
    setDismissed(true);
  };

  return (
    <div className="border-b bg-background px-4 py-2 lg:px-3">
      <Alert
        variant={isUrgent ? "destructive" : "default"}
        className={cn(
          "flex items-start gap-3 border-0 bg-transparent p-0",
          !isUrgent && "text-amber-700 dark:text-amber-400"
        )}
      >
        <AlertTriangle className="shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <div className="min-w-0">
            <AlertTitle>{title}</AlertTitle>
            <AlertDescription className="break-words">{body}</AlertDescription>
            {dismissError ? (
              <p className="mt-1 text-xs font-medium" role="status">
                {t("dismissError")}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              asChild
              size="sm"
              variant={isUrgent ? "default" : "outline"}
            >
              <Link
                href={`/panel/w/${workspaceId}/settings/integrations?type=whatsapp&reconnect=1`}
              >
                {t("cta")}
                <ArrowRight className="size-3.5" />
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={handleDismiss}
              disabled={isDismissPending}
              aria-label={isRemoved ? t("dismissWorkspace") : t("dismiss")}
              title={isRemoved ? t("dismissWorkspace") : t("dismiss")}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        </div>
      </Alert>
    </div>
  );
}
