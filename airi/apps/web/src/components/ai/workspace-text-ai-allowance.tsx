"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Skeleton } from "@/components/ui/skeleton";
import type { WorkspaceTextAiAllowanceStatus } from "@/hooks/use-company-limits";
import { cn } from "@/lib/utils";

export function WorkspaceTextAiAllowance({
  workspaceId,
  allowance,
  loading = false,
  compact = false,
}: {
  workspaceId: string;
  allowance?: WorkspaceTextAiAllowanceStatus;
  loading?: boolean;
  compact?: boolean;
}) {
  const t = useTranslations("AppSidebar.limits.textAi");
  if (loading) {
    return <Skeleton className="h-20 w-full" aria-label={t("loading")} />;
  }
  const current =
    allowance?.status === "available" &&
    allowance.workspaceId === workspaceId &&
    allowance.plan === "pro" &&
    allowance.includedActions === 500 &&
    allowance.remainingActions !== null &&
    typeof allowance.spendLimitReached === "boolean" &&
    allowance.resetAt === null
      ? allowance
      : null;
  const remaining = current?.remainingActions;
  const limit = current?.includedActions;
  if (
    !current ||
    typeof remaining !== "number" ||
    typeof limit !== "number" ||
    remaining < 0 ||
    remaining > limit
  ) {
    return (
      <div
        className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
        role="status"
      >
        {t("unavailable")}
      </div>
    );
  }
  const exhausted = remaining === 0;
  const platformUnavailable = exhausted || current.spendLimitReached;
  const requiresSource = platformUnavailable && !current.hasCustomerSource;
  return (
    <div
      className={cn(
        "min-w-0 space-y-1.5 rounded-md border px-3 py-2.5 text-xs leading-4",
        requiresSource
          ? "border-amber-300/70 bg-amber-50 text-amber-950 dark:border-amber-500/40 dark:bg-amber-950/35 dark:text-amber-100"
          : "bg-muted/30",
        !compact && "text-sm leading-5"
      )}
    >
      <p className="font-medium">
        {t("remaining", {
          remaining,
          limit,
        })}
      </p>
      <p className="text-muted-foreground">{t("shared")}</p>
      <p className="text-muted-foreground">
        {t("lifetime")}
      </p>
      {current.hasCustomerSource ? (
        <p>{t(platformUnavailable ? "customerActive" : "customerReady")}</p>
      ) : requiresSource ? (
        <>
          <p>{t(exhausted ? "exhausted" : "spendLimit")}</p>
          <Link
            href={`/panel/w/${encodeURIComponent(workspaceId)}/settings/integrations?integration=google_ai`}
            className="inline-flex max-w-full rounded-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("connect")}
          </Link>
        </>
      ) : null}
    </div>
  );
}
