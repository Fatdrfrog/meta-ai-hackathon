"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Source } from "@/types/supabase";
import {
  CalendarDays,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Unplug,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useSWRConfig } from "swr";
import { readNonEmptyString } from "@icecore/shared/lib/value-utils";

interface GoogleCalendarIntegrationProps {
  source?: Source;
  workspaceId: string;
  onSourceChanged?: () => Promise<unknown>;
  connectionActionsDisabled?: boolean;
}

export function GoogleCalendarIntegration({
  source,
  workspaceId,
  onSourceChanged,
  connectionActionsDisabled = false,
}: GoogleCalendarIntegrationProps) {
  const t = useTranslations("GoogleCalendarIntegration");
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const connected = Boolean(source);
  const credentials = readCredentials(source);
  const scope = readNonEmptyString(credentials?.scope);
  const calendarId = readNonEmptyString(credentials?.calendar_id);
  const accountEmail = readNonEmptyString(credentials?.account_email);
  const connectedAt = readNonEmptyString(credentials?.connected_at);
  const [disconnecting, setDisconnecting] = useState(false);
  const connectUrl = `/api/sources/google-calendar/connect?workspaceId=${encodeURIComponent(workspaceId)}`;

  const connectedAtLabel = useMemo(() => {
    if (!connectedAt) return null;
    return new Date(connectedAt).toLocaleString();
  }, [connectedAt]);

  const handleDisconnect = async () => {
    if (!connected || disconnecting) return;
    setDisconnecting(true);
    try {
      const response = await fetch(
        `/api/sources/google-calendar/disconnect?workspaceId=${encodeURIComponent(workspaceId)}`,
        { method: "DELETE" }
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(payload?.error || t("toast.disconnectFailed"));
      }

      toast.success(t("toast.disconnected"));
      await mutate(`/api/workspaces/${workspaceId}/integrations`);
      await onSourceChanged?.();
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("toast.disconnectFailed")
      );
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <section className="space-y-4 rounded-2xl border bg-background p-4 sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted/50">
            {connected ? (
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            ) : (
              <CalendarDays className="h-5 w-5 text-muted-foreground" />
            )}
          </div>
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold text-foreground">
                {connected ? t("connectedTitle") : t("disconnectedTitle")}
              </h3>
              {connected ? (
                <Badge className="bg-emerald-50 text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300">
                  <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                  {t("connectedBadge")}
                </Badge>
              ) : null}
            </div>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {connected
                ? t("connectedDescription")
                : t("disconnectedDescription")}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {connected ? (
            <Button
              type="button"
              variant="outline"
              onClick={handleDisconnect}
              disabled={disconnecting || connectionActionsDisabled}
            >
              {disconnecting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Unplug className="mr-2 h-4 w-4" />
              )}
              {t("disconnect")}
            </Button>
          ) : null}
          <Button
            disabled={connectionActionsDisabled}
            asChild={!connectionActionsDisabled}
          >
            {connectionActionsDisabled ? (
              <span>
                {connected ? t("reconnect") : t("connect")}
                <ExternalLink className="ml-2 h-4 w-4" />
              </span>
            ) : (
              <a href={connectUrl}>
                {connected ? t("reconnect") : t("connect")}
                <ExternalLink className="ml-2 h-4 w-4" />
              </a>
            )}
          </Button>
        </div>
      </div>

      {connected ? (
        <dl className="grid gap-3 rounded-xl bg-muted/30 p-3 text-sm sm:grid-cols-2">
          {accountEmail ? (
            <div className="space-y-1">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("accountLabel")}
              </dt>
              <dd className="break-words text-foreground">{accountEmail}</dd>
            </div>
          ) : null}
          {calendarId ? (
            <div className="space-y-1">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("calendarLabel")}
              </dt>
              <dd className="break-words text-foreground">{calendarId}</dd>
            </div>
          ) : null}
          {scope ? (
            <div className="space-y-1">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("scopeLabel")}
              </dt>
              <dd className="break-words text-foreground">{scope}</dd>
            </div>
          ) : null}
          {connectedAtLabel ? (
            <div className="space-y-1">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("connectedAtLabel")}
              </dt>
              <dd className="text-foreground">{connectedAtLabel}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </section>
  );
}

function readCredentials(source?: Source): Record<string, unknown> | null {
  if (!source?.credentials || typeof source.credentials !== "object") {
    return null;
  }

  return source.credentials as Record<string, unknown>;
}
