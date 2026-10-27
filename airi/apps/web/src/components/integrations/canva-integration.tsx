"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Source } from "@/types/supabase";
import { CheckCircle2, ExternalLink, Palette } from "lucide-react";
import { useTranslations } from "next-intl";
import { readNonEmptyString } from "@icecore/shared/lib/value-utils";

interface CanvaIntegrationProps {
  source?: Source;
  workspaceId: string;
  connectionActionsDisabled?: boolean;
}

export function CanvaIntegration({
  source,
  workspaceId,
  connectionActionsDisabled = false,
}: CanvaIntegrationProps) {
  const t = useTranslations("CanvaIntegration");
  const connected = Boolean(source);
  const credentials = readCredentials(source);
  const scope = readNonEmptyString(credentials?.scope);
  const connectedAt = readNonEmptyString(credentials?.connected_at);
  const connectUrl = `/api/sources/canva/connect?workspaceId=${encodeURIComponent(workspaceId)}`;

  return (
    <section className="space-y-4 rounded-2xl border bg-background p-4 sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted/50">
            {connected ? (
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            ) : (
              <Palette className="h-5 w-5 text-muted-foreground" />
            )}
          </div>
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold text-foreground">
                {connected ? t("connectedTitle") : t("disconnectedTitle")}
              </h3>
              {connected && (
                <Badge className="bg-emerald-50 text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300">
                  <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                  {t("connectedBadge")}
                </Badge>
              )}
            </div>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {connected
                ? t("connectedDescription")
                : t("disconnectedDescription")}
            </p>
          </div>
        </div>

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

      {connected && (scope || connectedAt) ? (
        <dl className="grid gap-3 rounded-xl bg-muted/30 p-3 text-sm sm:grid-cols-2">
          {scope ? (
            <div className="space-y-1">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("scopeLabel")}
              </dt>
              <dd className="break-words text-foreground">{scope}</dd>
            </div>
          ) : null}
          {connectedAt ? (
            <div className="space-y-1">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("connectedAtLabel")}
              </dt>
              <dd className="text-foreground">
                {new Date(connectedAt).toLocaleString()}
              </dd>
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
