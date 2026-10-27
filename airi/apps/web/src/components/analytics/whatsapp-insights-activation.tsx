"use client";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";

type ActivationError =
  | "reconnect"
  | "unsupported"
  | "busy"
  | "forbidden"
  | "failed";

const fetchCanManage = async (url: string): Promise<boolean> => {
  const response = await fetch(url);
  if (!response.ok) return false;
  const payload = (await response.json().catch(() => null)) as {
    canManage?: unknown;
  } | null;
  return payload?.canManage === true;
};

function activationError(status: number, outcome: unknown): ActivationError {
  if (status === 403) return "forbidden";
  if (outcome === "permission_required" || outcome === "not_connected")
    return "reconnect";
  if (outcome === "unsupported") return "unsupported";
  if (outcome === "rate_limited" || outcome === "busy") return "busy";
  return "failed";
}

/**
 * Owner/admin action for a WABA whose template analytics are off. Meta keeps
 * insights on permanently once enabled, so it is always confirmed first.
 */
export function WhatsAppInsightsActivation({
  workspaceId,
  sourceId,
  accountName,
  onEnabled,
}: {
  workspaceId: string;
  sourceId: string;
  accountName: string;
  onEnabled?: () => unknown;
}) {
  const t = useTranslations("AnalyticsOutcomes");
  const endpoint = `/api/workspaces/${encodeURIComponent(workspaceId)}/whatsapp/insights`;
  const { data: canManage, isLoading } = useSWR(endpoint, fetchCanManage, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ActivationError | null>(null);
  const [enabled, setEnabled] = useState(false);

  const enable = async () => {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId }),
      });
      const payload = (await response.json().catch(() => null)) as {
        outcome?: unknown;
      } | null;
      if (
        !response.ok ||
        (payload?.outcome !== "enabled" &&
          payload?.outcome !== "already_enabled")
      ) {
        setError(activationError(response.status, payload?.outcome));
        return;
      }
      setEnabled(true);
      setOpen(false);
      await onEnabled?.();
    } catch {
      setError("failed");
    } finally {
      setPending(false);
    }
  };

  if (enabled)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {t("insights.enabled")}
      </p>
    );
  if (isLoading) return null;
  if (!canManage)
    return (
      <p className="text-xs text-muted-foreground">{t("insights.adminOnly")}</p>
    );
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {t("insights.enable")}
      </Button>
      {error && !open ? (
        <p role="alert" className="text-xs text-destructive">
          {t(`insights.errors.${error}`)}
        </p>
      ) : null}
      <AlertDialog
        open={open}
        onOpenChange={next => {
          if (!pending) setOpen(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("insights.confirmTitle", { account: accountName })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("insights.confirmDescription")}
            </AlertDialogDescription>
            <p className="text-sm font-medium">{t("insights.permanent")}</p>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {t(`insights.errors.${error}`)}{" "}
                {error === "reconnect" ? (
                  <Link
                    href={`/panel/w/${encodeURIComponent(workspaceId)}/settings/integrations?type=whatsapp&reconnect=1`}
                    className="font-medium underline underline-offset-4"
                  >
                    {t("insights.reconnect")}
                  </Link>
                ) : null}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>
              {t("insights.cancel")}
            </AlertDialogCancel>
            <Button
              type="button"
              disabled={pending}
              onClick={() => void enable()}
            >
              {pending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {pending ? t("insights.enabling") : t("insights.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
