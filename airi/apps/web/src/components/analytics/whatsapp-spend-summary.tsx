"use client";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { normalizeDashboardIntlLocale } from "@/components/dashboard/dashboard-formatters";
import {
  boundWhatsAppSpendPeriod,
  type WhatsAppSpendDays,
} from "@/lib/analytics/whatsapp-analytics-contract";
import type {
  WhatsAppSpendAccount,
  WhatsAppSpendReport,
} from "@/lib/analytics/whatsapp-spend";
import { cn } from "@/lib/utils";
import { AlertCircle } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useId } from "react";
import useSWR from "swr";

const fetcher = async (url: string): Promise<WhatsAppSpendReport> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error("whatsapp_spend_unavailable");
  const payload = (await response.json()) as WhatsAppSpendReport;
  if (!payload || !Array.isArray(payload.accounts) || !payload.window)
    throw new Error("whatsapp_spend_unavailable");
  return payload;
};

type WhatsAppSpendPeriod =
  | { days: WhatsAppSpendDays }
  | { from: string; to: string };

/**
 * A report period becomes whole UTC dates the route accepts (its last 90
 * days); null when it ends before the period Meta spend can be shown for.
 */
export function buildWhatsAppSpendUrl(
  workspaceId: string,
  period: WhatsAppSpendPeriod,
  now = new Date()
): string | null {
  const route = `/api/workspaces/${encodeURIComponent(workspaceId)}/analytics/whatsapp-spend`;
  if ("days" in period)
    return `${route}?${new URLSearchParams({ days: String(period.days) })}`;
  const dates = boundWhatsAppSpendPeriod(period, now);
  return dates ? `${route}?${new URLSearchParams(dates)}` : null;
}

/**
 * Account-level WhatsApp spend Meta reports for a period. It covers every
 * message of the WhatsApp Business Account, so it is never shown per campaign.
 */
export function WhatsAppSpendSummary({
  workspaceId,
  period,
  className,
}: {
  workspaceId: string;
  period: WhatsAppSpendPeriod;
  className?: string;
}) {
  const t = useTranslations("WhatsAppSpendSummary");
  const locale = normalizeDashboardIntlLocale(useLocale());
  const headingId = useId();
  const url = workspaceId ? buildWhatsAppSpendUrl(workspaceId, period) : null;
  const { data, error, isLoading, isValidating, mutate } = useSWR(
    url,
    fetcher,
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
      dedupingInterval: 60_000,
    }
  );
  const money = (value: number, currency: string) => {
    try {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
      }).format(value);
    } catch {
      return `${value.toFixed(2)} ${currency}`;
    }
  };
  const day = (value: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeZone: "UTC",
    }).format(new Date(value));
  const integrationsHref = `/panel/w/${encodeURIComponent(workspaceId)}/settings/integrations?type=whatsapp`;
  const retry = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7"
      disabled={isValidating}
      onClick={() => void mutate()}
    >
      {isValidating ? t("retrying") : t("retry")}
    </Button>
  );
  const accountState = (account: WhatsAppSpendAccount) =>
    account.state === "reported" && account.currency && account.spend !== null
      ? money(account.spend, account.currency)
      : t(`accountState.${account.state}`);

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={isLoading || isValidating}
      className={cn("min-w-0 rounded-lg border bg-background p-3", className)}
    >
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 id={headingId} className="text-sm font-semibold">
          {t("title")}
        </h3>
        {data && data.state !== "no_source" ? (
          <span className="text-xs text-muted-foreground">
            {t("window", {
              start: day(data.window.start),
              end: day(data.window.end),
            })}
          </span>
        ) : null}
      </div>

      {workspaceId && !url ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {t("outOfRange")}
        </p>
      ) : isLoading && !data ? (
        <div className="mt-3 space-y-2" role="status">
          <span className="sr-only">{t("loading")}</span>
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      ) : error && !data ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span role="status">{t("error")}</span>
          {retry}
        </div>
      ) : data?.state === "no_source" ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {t("noSource")}{" "}
          <Link
            href={integrationsHref}
            className="font-medium text-foreground underline underline-offset-4"
          >
            {t("connect")}
          </Link>
        </p>
      ) : data ? (
        <>
          {data.totals.length ? (
            <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
              {data.totals.map(total => (
                <div key={total.currency} className="min-w-0">
                  <dt className="text-xs text-muted-foreground">
                    {t("approximate", { currency: total.currency })}
                  </dt>
                  <dd className="break-words text-2xl font-semibold tabular-nums">
                    {money(total.spend, total.currency)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : data.state === "available" ? (
            <p className="mt-2 text-sm text-muted-foreground">{t("noSpend")}</p>
          ) : null}

          {data.state === "reconnect" ? (
            <p
              role="status"
              className="mt-2 flex items-start gap-1.5 text-sm text-amber-800 dark:text-amber-200"
            >
              <AlertCircle
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              <span>
                {t("reconnect")}{" "}
                <Link
                  href={`${integrationsHref}&reconnect=1`}
                  className="font-medium underline underline-offset-4"
                >
                  {t("reconnectAction")}
                </Link>
              </span>
            </p>
          ) : data.state === "unavailable" ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span role="status">{t("unavailable")}</span>
              {retry}
            </div>
          ) : data.state === "partial" ? (
            <p role="status" className="mt-2 text-xs text-muted-foreground">
              {t("partial")}
            </p>
          ) : null}

          {data.accounts.length > 1 ||
          data.accounts.some(account => account.state !== "reported") ? (
            <ul className="mt-3 divide-y rounded-md border text-sm">
              {data.accounts.map(account => (
                <li
                  key={account.accountKey}
                  className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-2"
                >
                  <span className="min-w-0 truncate" title={account.sourceName}>
                    {account.sourceName}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 text-right",
                      account.state === "reported"
                        ? "font-medium tabular-nums"
                        : account.state === "reconnect"
                          ? "text-amber-800 dark:text-amber-200"
                          : "text-muted-foreground"
                    )}
                  >
                    {accountState(account)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {t("scope")}
          </p>
          {data.accountsTruncated ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("truncated")}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
