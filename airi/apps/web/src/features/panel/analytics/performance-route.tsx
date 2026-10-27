"use client";

import { AgentLeaderboard } from "@/components/dashboard/agent-leaderboard";
import { PerformanceInsights } from "@/components/dashboard/performance-insights";
import { EmptyState, ErrorState } from "@/components/ui/async-states";
import { AnalyticsLayout } from "@/components/analytics/analytics-layout";
import { PageHeader } from "@/components/ui/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { AgentPerformanceResponse } from "@/types/performance";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";

const AgentPerformanceChart = dynamic(
  () =>
    import("@/components/dashboard/agent-performance-chart").then(
      module => module.AgentPerformanceChart
    ),
  {
    ssr: false,
    loading: () => <Skeleton className="h-80 w-full" />,
  }
);

const DATE_RANGE_OPTIONS = [
  { value: "7", labelKey: "last7Days" },
  { value: "30", labelKey: "last30Days" },
  { value: "90", labelKey: "last90Days" },
] as const;

const performanceFetcher = async (
  url: string
): Promise<AgentPerformanceResponse> => {
  const res = await fetch(url);
  if (!res.ok) {
    const result = await res.json().catch(() => null);
    throw new Error(getApiErrorMessage(result) ?? res.statusText);
  }
  return res.json();
};

function getApiErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string" && error.trim()) return error;

  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }

  return null;
}

function DateRangeSelector({
  days,
  onDaysChange,
}: {
  days: string;
  onDaysChange: (value: string) => void;
}) {
  const t = useTranslations("PerformancePage.dateRanges");

  return (
    <Select iconFree value={days} onValueChange={onDaysChange}>
      <SelectTrigger className="h-9 w-full min-w-[10rem] sm:w-auto">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {DATE_RANGE_OPTIONS.map(option => (
          <SelectItem key={option.value} value={option.value}>
            {t(option.labelKey)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function PerformancePageHeader({
  days,
  onDaysChange,
}: {
  days: string;
  onDaysChange: (value: string) => void;
}) {
  const t = useTranslations("PerformancePage");

  return (
    <PageHeader
      title={t("title")}
      description={t("description")}
      secondaryAction={
        <DateRangeSelector days={days} onDaysChange={onDaysChange} />
      }
    />
  );
}

export default function PerformancePage() {
  const t = useTranslations("PerformancePage");
  const params = useParams();
  const workspaceId = params.workspaceId as string;
  const [days, setDays] = useState("30");

  const {
    data,
    error: swrError,
    isLoading,
    mutate,
  } = useSWR<AgentPerformanceResponse>(
    workspaceId
      ? `/api/agent-performance?workspaceId=${encodeURIComponent(workspaceId)}&days=${days}`
      : null,
    performanceFetcher,
    { revalidateOnFocus: false }
  );

  if (isLoading) {
    return (
      <AnalyticsLayout workspaceId={workspaceId}>
        <div className="space-y-6">
          <PerformancePageHeader days={days} onDaysChange={setDays} />
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-80 w-full" />
          <Skeleton className="h-80 w-full" />
        </div>
      </AnalyticsLayout>
    );
  }

  if (swrError) {
    return (
      <AnalyticsLayout workspaceId={workspaceId}>
        <div className="flex flex-col gap-6">
          <PerformancePageHeader days={days} onDaysChange={setDays} />
          <ErrorState
            message={t("errors.loadFailed")}
            onRetry={() => void mutate()}
            retryLabel={t("errors.retry")}
          />
        </div>
      </AnalyticsLayout>
    );
  }

  if (!data || data.agents.length === 0) {
    return (
      <AnalyticsLayout workspaceId={workspaceId}>
        <div className="flex flex-col gap-6">
          <PerformancePageHeader days={days} onDaysChange={setDays} />
          <EmptyState
            title={t("chart.title")}
            description={t("chart.collectMoreData")}
          />
        </div>
      </AnalyticsLayout>
    );
  }

  return (
    <AnalyticsLayout workspaceId={workspaceId}>
      <div className="flex flex-col gap-6">
        <PerformancePageHeader days={days} onDaysChange={setDays} />
        <PerformanceInsights
          summary={data.summary}
          dimensions={data.dimensions}
          coachingPriorities={data.coaching_priorities}
        />
        <AgentPerformanceChart
          data={data.agents}
          teamAverage={data.summary.avg_qa_score}
        />
        <AgentLeaderboard data={data.agents} />
      </div>
    </AnalyticsLayout>
  );
}
