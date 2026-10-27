"use client";

import { useBulkAnalyticsFormatters } from "@/components/analytics/bulk-analytics-formatters";
import type { BulkAnalyticsResponse } from "@/components/analytics/bulk-analytics";
import { StatsCard } from "@/components/analytics/charts/StatsCard";
import type { LlmAnalyticsResponse } from "@/components/analytics/llm-analytics-page";
import {
  createLlmAnalyticsFormatters,
  optionalNumberField,
  type LlmAnalyticsTranslator,
} from "@/components/analytics/llm-analytics-presentation";
import { ErrorState, LoadingState } from "@/components/ui/async-states";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo } from "react";
import useSWR from "swr";

const domainSWRConfig = {
  dedupingInterval: 60_000,
  revalidateOnFocus: false,
  shouldRetryOnError: false,
};

async function domainFetcher<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Analytics summary unavailable");
  return response.json();
}

export function DashboardDomainCard({
  kind,
  workspaceId,
}: {
  kind: "ai_usage" | "campaigns";
  workspaceId: string;
}) {
  const t = useTranslations("DashboardClientPage.board.domain");
  const aiT = useTranslations("LlmAnalytics");
  const campaignT = useTranslations("BulkAnalytics");
  const locale = useLocale();
  const campaignFormatters = useBulkAnalyticsFormatters();
  const aiFormatters = useMemo(
    () => createLlmAnalyticsFormatters(locale, aiT as LlmAnalyticsTranslator),
    [locale, aiT]
  );
  const timezone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    []
  );
  const encodedWorkspaceId = encodeURIComponent(workspaceId);
  const query = new URLSearchParams({
    days: "30",
    replyWindowHours: "168",
    timezone,
    conversationScope: "campaign_sends",
    view: "overview",
    compare: "off",
  });
  const requestUrl = !workspaceId
    ? null
    : kind === "ai_usage"
      ? `/api/analytics/llm?workspaceId=${encodedWorkspaceId}&days=30`
      : `/api/workspaces/${encodedWorkspaceId}/analytics/bulk?${query}`;
  const { data, error, isLoading, mutate } = useSWR<
    LlmAnalyticsResponse | BulkAnalyticsResponse
  >(requestUrl, domainFetcher, domainSWRConfig);

  const ai =
    kind === "ai_usage"
      ? (data as LlmAnalyticsResponse | undefined)
      : undefined;
  const campaigns =
    kind === "campaigns"
      ? (data as BulkAnalyticsResponse | undefined)
      : undefined;
  const calls = optionalNumberField(ai?.warehouse?.overview, "trace_count");
  const spend = optionalNumberField(
    ai?.warehouse?.spend?.workspace?.overview,
    "total_cost_usd"
  );
  const errors = optionalNumberField(ai?.warehouse?.overview, "error_count");
  const summary =
    campaigns?.overview?.status === "disabled" ? undefined : campaigns?.summary;
  const accepted = optionalNumberField(summary, "totalAccepted");
  const delivered = optionalNumberField(summary, "delivered");
  const replied = optionalNumberField(summary, "replied");
  const unavailable =
    kind === "ai_usage"
      ? calls === null && spend === null && errors === null
      : summary === undefined || accepted === null;
  const empty =
    kind === "ai_usage"
      ? calls === 0 && spend === 0 && errors === 0
      : accepted === 0;
  const metrics =
    kind === "ai_usage"
      ? [
          {
            title: aiT("warehouse.cards.llmCalls.title"),
            value:
              calls === null ? t("notAvailable") : aiFormatters.number(calls),
          },
          {
            title: aiT("warehouse.spend.cards.totalSpend.title"),
            value:
              spend === null ? t("notAvailable") : aiFormatters.currency(spend),
          },
          {
            title: t("aiErrors"),
            value:
              errors === null ? t("notAvailable") : aiFormatters.number(errors),
          },
        ]
      : [
          {
            title: campaignT("summary.acceptedSends"),
            value:
              accepted === null
                ? t("notAvailable")
                : campaignFormatters.formatInteger(accepted),
          },
          {
            title: campaignT("funnel.delivered"),
            value:
              delivered === null
                ? t("notAvailable")
                : campaignFormatters.formatInteger(delivered),
          },
          {
            title: campaignT("summary.replied"),
            value:
              replied === null
                ? t("notAvailable")
                : campaignFormatters.formatInteger(replied),
          },
        ];

  return (
    <div className="@container flex h-full min-w-0 flex-col gap-3">
      <div className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>{t("window")}</span>
        <span aria-hidden="true">·</span>
        <span>{t(kind === "ai_usage" ? "aiScope" : "campaignScope")}</span>
      </div>
      {error ? (
        <ErrorState
          message={t("loadFailed")}
          retryLabel={t("retry")}
          onRetry={() => void mutate()}
        />
      ) : null}
      {isLoading && !data ? (
        <div role="status" aria-live="polite">
          <span className="sr-only">{t("loading")}</span>
          <LoadingState lines={3} />
        </div>
      ) : data || !error ? (
        unavailable ? (
          <p className="text-sm text-muted-foreground">{t("unavailable")}</p>
        ) : empty ? (
          <p className="text-sm text-muted-foreground">
            {t(kind === "ai_usage" ? "emptyAi" : "emptyCampaigns")}
          </p>
        ) : (
          <div className="grid min-w-0 gap-2 @min-[24rem]:grid-cols-3 [&_[data-slot=card-content]>div]:break-all">
            {metrics.map(metric => (
              <StatsCard
                key={metric.title}
                title={metric.title}
                value={metric.value}
                color="text-foreground"
              />
            ))}
          </div>
        )
      ) : null}
      {kind === "campaigns" ? (
        <p className="text-xs text-muted-foreground">
          {t("campaignReplyWindow")}
        </p>
      ) : null}
      <Link
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "mt-auto w-fit max-w-full justify-start gap-1.5 whitespace-normal text-left"
        )}
        href={`/panel/w/${encodedWorkspaceId}/analytics/${kind === "ai_usage" ? "llm" : "bulk"}`}
        prefetch={false}
      >
        {t("openReport")}
      </Link>
    </div>
  );
}
