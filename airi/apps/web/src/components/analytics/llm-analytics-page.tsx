"use client";

import { StatsCard } from "@/components/analytics/charts/StatsCard";
import { EmptyState, ErrorState } from "@/components/ui/async-states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import type { AiriReplyOperatorAnalytics } from "@/lib/airi/reply/runtime/llm-analytics";
import {
  readNonEmptyStringField,
  normalizeLooseString as compactText,
} from "@icecore/shared/lib/value-utils";
import dynamic from "next/dynamic";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import {
  createLlmAnalyticsFormatters,
  optionalNumberField,
  presentLlmEnum,
  presentLlmOperation,
  type LlmAnalyticsFormatters,
  type LlmAnalyticsTranslator,
  type LlmEnumKind,
} from "./llm-analytics-presentation";

export type LlmAnalyticsResponse = {
  days: number;
  analytics: AiriReplyOperatorAnalytics;
  warehouse?: {
    overview?: Record<string, unknown> | null;
    modelBreakdown?: Array<Record<string, unknown>>;
    ragFailures?: Array<Record<string, unknown>>;
    scoreTrends?: Array<Record<string, unknown>>;
    generationQuality?: Record<string, unknown> | null;
    systemPerformance?: Record<string, unknown> | null;
    operationalEfficiency?: Record<string, unknown> | null;
    spend?: {
      workspace: {
        overview?: Record<string, unknown> | null;
        daily?: Array<Record<string, unknown>>;
        byOperation?: Array<Record<string, unknown>>;
      };
      company?: {
        overview?: Record<string, unknown> | null;
        workspaceCount?: number;
      } | null;
      pricingVersion?: string;
    };
    airiChats?: {
      overview?: Record<string, unknown> | null;
      daily?: Array<Record<string, unknown>>;
      issues?: Array<Record<string, unknown>>;
      qualityScore?: {
        answer_count: number;
        grounded_rate: number | null;
        no_context_rate: number | null;
        latency_target_pass_rate: number | null;
        error_rate: number | null;
        citation_coverage: number | null;
        cost_per_answer: number | null;
        sample_size_warning: boolean | number;
      } | null;
    };
    source?: "bigquery" | "disabled";
    generatedAt?: string;
    errors?: string[];
  } | null;
};

type ReviewItem = {
  id: string;
  conversationId?: string | null;
  issueType: string;
  severity: string;
  title: string;
  summary?: string | null;
  inputExcerpt?: string | null;
  outputExcerpt?: string | null;
  suggestedFix?: {
    type?: string;
    title?: string;
  } | null;
};

type ReviewItemsResponse = {
  items: ReviewItem[];
};

type ReviewItemUpdateResponse = {
  regressionCaseId?: string | null;
};

const DATE_RANGE_OPTIONS = ["7", "30", "90"];

const LlmSpendDailyChart = dynamic(
  () =>
    import("./llm-analytics-charts").then(module => module.LlmSpendDailyChart),
  {
    ssr: false,
    loading: () => <Skeleton className="h-[280px] w-full" />,
  }
);

const AiriChatDailyHealthChart = dynamic(
  () =>
    import("./llm-analytics-charts").then(
      module => module.AiriChatDailyHealthChart
    ),
  {
    ssr: false,
    loading: () => <Skeleton className="h-[280px] w-full" />,
  }
);

const LlmDailyTrendChart = dynamic(
  () =>
    import("./llm-analytics-charts").then(module => module.LlmDailyTrendChart),
  {
    ssr: false,
    loading: () => <Skeleton className="h-[340px] w-full" />,
  }
);

const FallbackActionsChart = dynamic(
  () =>
    import("./llm-analytics-charts").then(
      module => module.FallbackActionsChart
    ),
  {
    ssr: false,
    loading: () => <Skeleton className="h-[340px] w-full" />,
  }
);

async function readResponseErrorDetail(
  response: Response
): Promise<string | null> {
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!payload || typeof payload !== "object") return null;

  const error = (payload as { error?: unknown }).error;
  return typeof error === "string" && error.trim() ? error : null;
}

function errorDetail(error: unknown): string | null {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return message.trim() ? message : null;
}

const fetcher = async (url: string): Promise<LlmAnalyticsResponse> => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error((await readResponseErrorDetail(res)) ?? "");
  }
  return res.json();
};

const reviewItemsFetcher = async (
  url: string
): Promise<ReviewItemsResponse> => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error((await readResponseErrorDetail(res)) ?? "");
  }
  return res.json();
};

function numberField(
  row: Record<string, unknown> | null | undefined,
  key: string
): number {
  const value = row?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function hasNumberField(
  row: Record<string, unknown> | null | undefined,
  key: string
): boolean {
  return optionalNumberField(row, key) !== null;
}

function formatOptionalPercent(
  row: Record<string, unknown> | null | undefined,
  key: string,
  formatters: LlmAnalyticsFormatters,
  t: LlmAnalyticsTranslator
): string {
  const value = optionalNumberField(row, key);
  return value === null ? t("common.notAvailable") : formatters.percent(value);
}

function formatOptionalMs(
  row: Record<string, unknown> | null | undefined,
  key: string,
  formatters: LlmAnalyticsFormatters,
  t: LlmAnalyticsTranslator
): string {
  const value = optionalNumberField(row, key);
  return value === null
    ? t("common.notAvailable")
    : formatters.milliseconds(value);
}

function formatOptionalRate(
  row: Record<string, unknown> | null | undefined,
  key: string,
  formatters: LlmAnalyticsFormatters,
  t: LlmAnalyticsTranslator
): string {
  const value = optionalNumberField(row, key);
  return value === null
    ? t("common.notAvailable")
    : formatters.perSecond(value);
}

function formatOptionalScore(
  row: Record<string, unknown> | null | undefined,
  key: string,
  formatters: LlmAnalyticsFormatters,
  t: LlmAnalyticsTranslator
): string {
  const value = optionalNumberField(row, key);
  return value === null ? t("common.notAvailable") : formatters.score(value);
}

function getReviewSignal(
  item: ReviewItem,
  t: LlmAnalyticsTranslator
): {
  label: string;
  value: string;
} | null {
  const text = compactText(item.summary);
  if (!text) return null;

  return {
    label: t("common.technicalDetail"),
    value: text,
  };
}

function DateRangeSelector({
  days,
  onDaysChange,
}: {
  days: string;
  onDaysChange: (value: string) => void;
}) {
  const t = useTranslations("LlmAnalytics");

  return (
    <Select iconFree value={days} onValueChange={onDaysChange}>
      <SelectTrigger className="h-9 w-full min-w-[10rem] sm:w-auto">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {DATE_RANGE_OPTIONS.map(option => (
          <SelectItem key={option} value={option}>
            {t(`dateRanges.${option}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function BreakdownTable({
  title,
  rows,
  emptyLabel,
  enumKind,
}: {
  title: string;
  rows: Array<{ name: string; count: number }>;
  emptyLabel: string;
  enumKind: LlmEnumKind;
}) {
  const t = useTranslations("LlmAnalytics");
  const locale = useLocale();
  const translate = t as unknown as LlmAnalyticsTranslator;
  const formatters = createLlmAnalyticsFormatters(locale, translate);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyLabel}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("labels.name")}</TableHead>
                <TableHead className="text-right">
                  {t("labels.count")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(row => (
                <TableRow key={row.name}>
                  <TableCell className="max-w-[18rem] whitespace-normal">
                    <Badge variant="outline">
                      {presentLlmEnum(enumKind, row.name, translate)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {formatters.number(row.count)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function LlmAnalyticsPage({
  workspaceId,
  initialDays = 30,
}: {
  workspaceId: string;
  initialDays?: number;
}) {
  const t = useTranslations("LlmAnalytics");
  const locale = useLocale();
  const translate = t as unknown as LlmAnalyticsTranslator;
  const formatters = useMemo(
    () => createLlmAnalyticsFormatters(locale, translate),
    [locale, translate]
  );
  const [days, setDays] = useState(String(initialDays));

  const {
    data,
    error: swrError,
    isLoading,
  } = useSWR<LlmAnalyticsResponse>(
    workspaceId
      ? `/api/analytics/llm?workspaceId=${encodeURIComponent(workspaceId)}&days=${days}`
      : null,
    fetcher,
    { revalidateOnFocus: false }
  );
  const {
    data: reviewData,
    error: reviewError,
    isLoading: isReviewLoading,
    mutate: mutateReviewItems,
  } = useSWR<ReviewItemsResponse>(
    workspaceId
      ? `/api/ai-quality/review-items?workspaceId=${encodeURIComponent(
          workspaceId
        )}&status=open&limit=8`
      : null,
    reviewItemsFetcher,
    { revalidateOnFocus: false }
  );
  const [updatingReviewItemId, setUpdatingReviewItemId] = useState<
    string | null
  >(null);

  const loadErrorDetail = errorDetail(swrError);
  const reviewErrorDetail = errorDetail(reviewError);
  const analytics = data?.analytics;
  const warehouseOverview = data?.warehouse?.overview;
  const warehouseTraceCount = numberField(warehouseOverview, "trace_count");
  const warehouseRagTurnCount = numberField(
    warehouseOverview,
    "rag_turn_count"
  );
  const hasWarehouseData = warehouseTraceCount > 0 || warehouseRagTurnCount > 0;
  const generationQuality = data?.warehouse?.generationQuality;
  const systemPerformance = data?.warehouse?.systemPerformance;
  const operationalEfficiency = data?.warehouse?.operationalEfficiency;
  const hasGenerationQualityData = Boolean(
    hasNumberField(generationQuality, "rag_turn_count") ||
      hasNumberField(generationQuality, "generation_quality_score") ||
      hasNumberField(generationQuality, "eval_sampled_count")
  );
  const hasSystemPerformanceData = Boolean(
    hasNumberField(systemPerformance, "trace_count") ||
      hasNumberField(systemPerformance, "rag_turn_count")
  );
  const hasOperationalEfficiencyData = Boolean(
    hasNumberField(operationalEfficiency, "trace_count") ||
      hasNumberField(operationalEfficiency, "total_tokens")
  );
  const hasModelScoreData = Boolean(
    hasGenerationQualityData ||
      hasSystemPerformanceData ||
      hasOperationalEfficiencyData
  );
  const spendOverview = data?.warehouse?.spend?.workspace?.overview;
  const spendTraceCount = numberField(spendOverview, "trace_count");
  const spendTotalUsd = numberField(spendOverview, "total_cost_usd");
  const hasSpendData = spendTraceCount > 0 || spendTotalUsd > 0;
  const spendDaily = data?.warehouse?.spend?.workspace?.daily || [];
  const spendByOperation = data?.warehouse?.spend?.workspace?.byOperation || [];
  const modelBreakdown = data?.warehouse?.modelBreakdown || [];
  const companySpendOverview = data?.warehouse?.spend?.company?.overview;
  const companySpendUsd = numberField(companySpendOverview, "total_cost_usd");
  const airiChatOverview = data?.warehouse?.airiChats?.overview;
  const airiChatTraceCount = numberField(airiChatOverview, "trace_count");
  const airiChatTurnCount = numberField(airiChatOverview, "rag_turn_count");
  const airiChatNoContextCount = numberField(
    airiChatOverview,
    "no_context_turn_count"
  );
  const hasAiriChatData = airiChatTraceCount > 0 || airiChatTurnCount > 0;
  const airiChatDaily = data?.warehouse?.airiChats?.daily || [];
  const airiChatIssues = data?.warehouse?.airiChats?.issues || [];
  const hasModelAndChatData = Boolean(hasModelScoreData || hasAiriChatData);
  const reviewItems = reviewData?.items || [];
  const hasReviewItems = Boolean(reviewItems.length);
  const reviewItemCount = reviewItems.length;
  const warehouseGeneratedAt = formatters.dateTime(
    data?.warehouse?.generatedAt
  );
  const warehouseErrors = data?.warehouse?.errors || [];
  const hasAnyData = Boolean(
    (analytics && analytics.sampleInfo.eventCount > 0) ||
      hasWarehouseData ||
      hasModelAndChatData ||
      hasSpendData ||
      hasReviewItems ||
      isReviewLoading
  );

  async function updateReviewItem(
    item: ReviewItem,
    action: "resolve" | "ignore"
  ) {
    const readJudgeScore = (label: string): number | undefined => {
      const raw = window.prompt(
        t("judge.scorePrompt", { dimension: label }),
        ""
      );
      if (raw === null || raw.trim() === "") return undefined;
      const score = Number(raw);
      if (!Number.isFinite(score)) return undefined;
      return Math.max(0, Math.min(1, score));
    };
    const judgeExplanation =
      action === "resolve"
        ? window.prompt(
            t("judge.explanationPrompt"),
            item.suggestedFix?.title || item.summary || item.title
          ) || undefined
        : undefined;
    const relevanceScore =
      action === "resolve"
        ? readJudgeScore(t("judge.dimensions.relevance"))
        : undefined;
    const trustworthinessScore =
      action === "resolve"
        ? readJudgeScore(t("judge.dimensions.trustworthiness"))
        : undefined;
    const concisenessScore =
      action === "resolve"
        ? readJudgeScore(t("judge.dimensions.conciseness"))
        : undefined;
    const completenessScore =
      action === "resolve"
        ? readJudgeScore(t("judge.dimensions.completeness"))
        : undefined;
    const safetyScore =
      action === "resolve"
        ? readJudgeScore(t("judge.dimensions.safety"))
        : undefined;
    const overallScore =
      action === "resolve"
        ? readJudgeScore(t("judge.dimensions.overall"))
        : undefined;
    setUpdatingReviewItemId(item.id);
    let updateDiagnostic: string | null = null;
    try {
      const response = await fetch(`/api/ai-quality/review-items/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          workspaceId,
          action,
          createRegressionCase:
            action === "resolve" && Boolean(item.inputExcerpt?.trim()),
          expectedBehavior:
            action === "resolve"
              ? item.suggestedFix?.title || item.summary || item.title
              : undefined,
          datasetDecision:
            action === "resolve" && item.inputExcerpt?.trim()
              ? "add_to_golden"
              : "candidate",
          datasetSplit: "validation",
          judgeExplanation,
          relevanceScore,
          trustworthinessScore,
          concisenessScore,
          completenessScore,
          safetyScore,
          overallScore,
        }),
      });

      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as unknown;
        if (result && typeof result === "object") {
          const rawError = (result as { error?: unknown }).error;
          if (typeof rawError === "string" && rawError.trim()) {
            updateDiagnostic = rawError;
          }
        }
        throw new Error("review_item_update_failed");
      }

      const result = (await response
        .json()
        .catch(() => ({}))) as ReviewItemUpdateResponse;
      await mutateReviewItems();
      toast.success(
        action === "resolve"
          ? result.regressionCaseId
            ? t("toasts.resolvedWithRegression")
            : t("toasts.resolved")
          : t("toasts.ignored")
      );
    } catch (error) {
      console.error("[AI Quality] Failed to update review item", error);
      if (updateDiagnostic) {
        toast.error(t("toasts.updateFailed"), {
          description: `${t("common.technicalDetail")}: ${updateDiagnostic}`,
        });
      } else {
        toast.error(t("toasts.updateFailed"));
      }
    } finally {
      setUpdatingReviewItemId(null);
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-end">
          <DateRangeSelector days={days} onDaysChange={setDays} />
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-32 w-full" />
          ))}
        </div>
        <div className="grid gap-6 xl:grid-cols-2">
          <Skeleton className="h-96 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    );
  }

  if (swrError) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-end">
          <DateRangeSelector days={days} onDaysChange={setDays} />
        </div>
        <ErrorState message={t("errors.loadFailed")} />
        {loadErrorDetail ? (
          <p className="break-words text-xs text-muted-foreground">
            <span className="font-medium">{t("common.technicalDetail")}</span>:{" "}
            {loadErrorDetail}
          </p>
        ) : null}
      </div>
    );
  }

  if (!analytics || !hasAnyData) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-end">
          <DateRangeSelector days={days} onDaysChange={setDays} />
        </div>
        <EmptyState
          title={t("empty.title")}
          description={t("empty.description")}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge variant="secondary">{t("common.aiQuality")}</Badge>
          <Badge variant={hasWarehouseData ? "default" : "outline"}>
            {hasWarehouseData
              ? t("common.warehouseActive")
              : t("common.waitingForEvents")}
          </Badge>
          <Badge variant="outline">{t("common.manualApproval")}</Badge>
        </div>
        <DateRangeSelector days={days} onDaysChange={setDays} />
      </div>

      {analytics.sampleInfo.limited ? (
        <Alert>
          <AlertDescription>{t("limitedSample")}</AlertDescription>
        </Alert>
      ) : null}

      {warehouseErrors.length > 0 ? (
        <Alert>
          <AlertDescription>
            <p>{t("common.warehousePartialUnavailable")}</p>
            <ul className="mt-2 space-y-1 text-xs">
              {warehouseErrors.map(message => (
                <li key={message}>
                  <span className="font-medium">
                    {t("common.technicalDetail")}
                  </span>
                  : <span className="break-words">{message}</span>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {hasSpendData ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h3 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
                {t("warehouse.spend.title")}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t("warehouse.spend.description")}
              </p>
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <StatsCard
              title={t("warehouse.spend.cards.totalSpend.title")}
              value={formatters.currency(spendTotalUsd)}
              subtitle={t("warehouse.spend.cards.totalSpend.subtitle")}
            />
            <StatsCard
              title={t("warehouse.spend.cards.avgCost.title")}
              value={formatters.currency(
                numberField(spendOverview, "avg_cost_per_call")
              )}
              subtitle={t("warehouse.spend.cards.avgCost.subtitle")}
            />
            <StatsCard
              title={t("warehouse.spend.cards.totalTokens.title")}
              value={formatters.compactNumber(
                numberField(spendOverview, "total_tokens")
              )}
              subtitle={t("warehouse.spend.cards.totalTokens.subtitle")}
            />
            {companySpendUsd > 0 ? (
              <StatsCard
                title={t("warehouse.spend.cards.companyTotal.title")}
                value={formatters.currency(companySpendUsd)}
                subtitle={t("warehouse.spend.cards.companyTotal.subtitle", {
                  count: data?.warehouse?.spend?.company?.workspaceCount || 0,
                })}
              />
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("warehouse.spend.footnote")}
          </p>
          <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle className="text-base">
                  {t("warehouse.spend.charts.daily")}
                </CardTitle>
                <CardDescription>
                  {t("warehouse.spend.charts.dailyDescription")}
                </CardDescription>
              </CardHeader>
              <CardContent className="min-w-0">
                {spendDaily.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t("warehouse.spend.empty.daily")}
                  </p>
                ) : (
                  <LlmSpendDailyChart data={spendDaily} />
                )}
              </CardContent>
            </Card>
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle className="text-base">
                  {t("warehouse.spend.tables.byOperation")}
                </CardTitle>
                <CardDescription>
                  {t("warehouse.spend.tables.byOperationDescription")}
                </CardDescription>
              </CardHeader>
              <CardContent className="min-w-0">
                {spendByOperation.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t("warehouse.spend.empty.byOperation")}
                  </p>
                ) : (
                  <Table className="table-fixed">
                    <colgroup>
                      <col />
                      <col className="w-32" />
                    </colgroup>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="whitespace-normal">
                          {t("labels.name")}
                        </TableHead>
                        <TableHead className="whitespace-normal text-right">
                          {t("warehouse.spend.labels.cost")}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {spendByOperation.map(row => {
                        const operation =
                          readNonEmptyStringField(row, "operation") ??
                          "unknown";
                        const operationCopy = presentLlmOperation(
                          operation,
                          translate
                        );
                        const cost = numberField(row, "total_cost_usd");
                        const calls = numberField(row, "calls");
                        const tokens = numberField(row, "total_tokens");

                        return (
                          <TableRow key={operation}>
                            <TableCell className="min-w-0 whitespace-normal align-top">
                              <div className="flex min-w-0 flex-col gap-1">
                                <span className="break-words font-medium leading-snug [overflow-wrap:anywhere]">
                                  {operationCopy.label}
                                </span>
                                <span className="text-xs leading-relaxed text-muted-foreground">
                                  {operationCopy.detail}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  {t("units.calls", { count: calls })} ·{" "}
                                  {t("units.tokens", { count: tokens })}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell className="whitespace-normal text-right align-top">
                              <div className="flex flex-col items-end gap-1">
                                <span className="font-medium">
                                  {formatters.currency(cost)}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  {formatters.spendShare(cost, spendTotalUsd)}
                                </span>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
          {modelBreakdown.length > 0 ? (
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle className="text-base">
                  {t("warehouse.spend.tables.byModel")}
                </CardTitle>
                <CardDescription>
                  {t("warehouse.spend.tables.byModelDescription")}
                </CardDescription>
              </CardHeader>
              <CardContent className="min-w-0">
                <Table className="table-fixed">
                  <colgroup>
                    <col className="w-1/2" />
                    <col className="w-1/4" />
                    <col className="w-1/4" />
                  </colgroup>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="whitespace-normal">
                        {t("warehouse.spend.labels.modelAndWorkflow")}
                      </TableHead>
                      <TableHead className="whitespace-normal text-right">
                        {t("warehouse.spend.labels.volume")}
                      </TableHead>
                      <TableHead className="whitespace-normal text-right">
                        {t("warehouse.spend.labels.cost")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {modelBreakdown.map(row => {
                      const provider =
                        readNonEmptyStringField(row, "provider") ??
                        t("common.unknown");
                      const model =
                        readNonEmptyStringField(row, "model") ??
                        t("common.unknown");
                      const operation =
                        readNonEmptyStringField(row, "operation") ?? "unknown";
                      const operationCopy = presentLlmOperation(
                        operation,
                        translate
                      );
                      const calls = numberField(row, "calls");
                      const tokens = numberField(row, "total_tokens");
                      const cost = numberField(row, "total_cost_usd");
                      const key = `${provider}:${model}:${operation}`;

                      return (
                        <TableRow key={key}>
                          <TableCell className="min-w-0 whitespace-normal align-top">
                            <div className="flex min-w-0 flex-col gap-2">
                              <div className="flex min-w-0 flex-col gap-1">
                                <span className="break-words font-medium leading-snug [overflow-wrap:anywhere]">
                                  {model}
                                </span>
                                <span className="text-xs leading-relaxed text-muted-foreground">
                                  {operationCopy.detail}
                                </span>
                              </div>
                              <div className="flex min-w-0 flex-wrap gap-1.5">
                                <Badge
                                  variant="secondary"
                                  className="max-w-full truncate"
                                >
                                  {provider}
                                </Badge>
                                <Badge
                                  variant="outline"
                                  className="max-w-full truncate"
                                >
                                  {operationCopy.label}
                                </Badge>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="whitespace-normal text-right align-top">
                            <div className="flex flex-col items-end gap-1">
                              <span className="font-medium">
                                {t("units.calls", { count: calls })}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {t("units.tokens", { count: tokens })}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="whitespace-normal text-right align-top">
                            <div className="flex flex-col items-end gap-1">
                              <span className="font-medium">
                                {formatters.currency(cost)}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {formatters.spendShare(cost, spendTotalUsd)}
                              </span>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : null}
        </div>
      ) : null}

      {hasWarehouseData ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h3 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
                {t("warehouse.title")}
              </h3>
              <p className="text-sm text-muted-foreground">
                {warehouseGeneratedAt
                  ? t("warehouse.descriptionWithRefresh", {
                      time: warehouseGeneratedAt,
                    })
                  : t("warehouse.description")}
              </p>
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <StatsCard
              title={t("warehouse.cards.llmCalls.title")}
              value={formatters.compactNumber(warehouseTraceCount)}
              subtitle={t("warehouse.cards.llmCalls.subtitle")}
            />
            <StatsCard
              title={t("warehouse.cards.errorRate.title")}
              value={formatters.percent(
                warehouseTraceCount > 0
                  ? (numberField(warehouseOverview, "error_count") /
                      warehouseTraceCount) *
                      100
                  : 0
              )}
              subtitle={t("warehouse.cards.errorRate.subtitle")}
              color="text-destructive"
            />
            <StatsCard
              title={t("warehouse.cards.p95Latency.title")}
              value={formatters.milliseconds(
                numberField(warehouseOverview, "p95_latency_ms")
              )}
              subtitle={t("warehouse.cards.p95Latency.subtitle")}
            />
            <StatsCard
              title={t("warehouse.cards.totalTokens.title")}
              value={formatters.compactNumber(
                numberField(warehouseOverview, "total_tokens")
              )}
              subtitle={t("warehouse.cards.totalTokens.subtitle")}
            />
            <StatsCard
              title={t("warehouse.cards.ragIssues.title")}
              value={formatters.compactNumber(
                numberField(warehouseOverview, "rag_issue_count")
              )}
              subtitle={t("warehouse.cards.ragIssues.subtitle")}
              color="text-destructive"
            />
          </div>
        </div>
      ) : null}

      {hasModelAndChatData ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h3 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
                {t("quality.title")}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t("quality.description")}
              </p>
            </div>
          </div>

          {hasAiriChatData ? (
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-muted-foreground">
                {t("quality.airiChatReporting")}
              </h4>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <StatsCard
                  title={t("quality.cards.airiAnswers.title")}
                  value={t("units.turns", { count: airiChatTurnCount })}
                  subtitle={t("quality.cards.airiAnswers.subtitle")}
                />
                <StatsCard
                  title={t("quality.cards.noContextTurns.title")}
                  value={t("units.turns", { count: airiChatNoContextCount })}
                  subtitle={t("quality.cards.noContextTurns.subtitle")}
                  color="text-destructive"
                />
                <StatsCard
                  title={t("quality.cards.airiChatSpend.title")}
                  value={formatters.currency(
                    numberField(airiChatOverview, "total_cost_usd")
                  )}
                  subtitle={t("quality.cards.airiChatSpend.subtitle")}
                />
              </div>
            </div>
          ) : null}

          {hasGenerationQualityData ? (
            <div className="space-y-3">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
                <StatsCard
                  title={t("quality.cards.generationQuality.title")}
                  value={formatOptionalScore(
                    generationQuality,
                    "generation_quality_score",
                    formatters,
                    translate
                  )}
                  subtitle={t("quality.cards.generationQuality.subtitle")}
                />
                <StatsCard
                  title={t("quality.cards.groundedness.title")}
                  value={formatOptionalPercent(
                    generationQuality,
                    "groundedness_pct",
                    formatters,
                    translate
                  )}
                  subtitle={t("quality.cards.groundedness.subtitle")}
                  color="text-chart-3"
                />
                <StatsCard
                  title={t("quality.cards.answerRelevance.title")}
                  value={formatOptionalPercent(
                    generationQuality,
                    "answer_relevance_pct",
                    formatters,
                    translate
                  )}
                  subtitle={t("quality.cards.answerRelevance.subtitle")}
                />
                <StatsCard
                  title={t("quality.cards.guardrailPass.title")}
                  value={formatOptionalPercent(
                    generationQuality,
                    "guardrail_pass_pct",
                    formatters,
                    translate
                  )}
                  subtitle={t("quality.cards.guardrailPass.subtitle")}
                  color="text-chart-2"
                />
                <StatsCard
                  title={t("quality.cards.evalPass.title")}
                  value={formatOptionalPercent(
                    generationQuality,
                    "eval_pass_pct",
                    formatters,
                    translate
                  )}
                  subtitle={t("units.sampledEvaluations", {
                    count: numberField(generationQuality, "eval_sampled_count"),
                  })}
                  color="text-chart-2"
                />
              </div>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <StatsCard
                  title={t("quality.cards.answerCompleteness.title")}
                  value={formatOptionalPercent(
                    generationQuality,
                    "answer_completeness_pct",
                    formatters,
                    translate
                  )}
                  subtitle={t("quality.cards.answerCompleteness.subtitle")}
                />
                <StatsCard
                  title={t("quality.cards.citationCoverage.title")}
                  value={formatOptionalPercent(
                    generationQuality,
                    "citation_coverage_pct",
                    formatters,
                    translate
                  )}
                  subtitle={t("quality.cards.citationCoverage.subtitle")}
                />
                <StatsCard
                  title={t("quality.cards.toxicityScore.title")}
                  value={formatOptionalPercent(
                    generationQuality,
                    "toxicity_score_pct",
                    formatters,
                    translate
                  )}
                  subtitle={t("quality.cards.toxicityScore.subtitle")}
                />
                <StatsCard
                  title={t("quality.cards.toxicOutputs.title")}
                  value={formatters.compactNumber(
                    numberField(generationQuality, "toxicity_violation_count")
                  )}
                  subtitle={t("quality.cards.toxicOutputs.subtitle")}
                />
              </div>
            </div>
          ) : null}

          {hasSystemPerformanceData ? (
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-muted-foreground">
                {t("systemPerformance.title")}
              </h4>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
                <StatsCard
                  title={t("systemPerformance.cards.p95Latency.title")}
                  value={formatOptionalMs(
                    systemPerformance,
                    "p95_latency_ms",
                    formatters,
                    translate
                  )}
                  subtitle={t("systemPerformance.cards.p95Latency.subtitle")}
                />
                <StatsCard
                  title={t("systemPerformance.cards.p99Latency.title")}
                  value={formatOptionalMs(
                    systemPerformance,
                    "p99_latency_ms",
                    formatters,
                    translate
                  )}
                  subtitle={t("systemPerformance.cards.p99Latency.subtitle")}
                />
                <StatsCard
                  title={t("systemPerformance.cards.tokensPerSecond.title")}
                  value={formatOptionalRate(
                    systemPerformance,
                    "tokens_per_second",
                    formatters,
                    translate
                  )}
                  subtitle={t(
                    "systemPerformance.cards.tokensPerSecond.subtitle"
                  )}
                />
                <StatsCard
                  title={t(
                    "systemPerformance.cards.outputTokensPerSecond.title"
                  )}
                  value={formatOptionalRate(
                    systemPerformance,
                    "output_tokens_per_second",
                    formatters,
                    translate
                  )}
                  subtitle={t(
                    "systemPerformance.cards.outputTokensPerSecond.subtitle"
                  )}
                />
                <StatsCard
                  title={t("systemPerformance.cards.timeToFirstToken.title")}
                  value={formatOptionalMs(
                    systemPerformance,
                    "p95_time_to_first_token_ms",
                    formatters,
                    translate
                  )}
                  subtitle={t(
                    "systemPerformance.cards.timeToFirstToken.subtitle"
                  )}
                />
              </div>
              {typeof systemPerformance?.time_to_first_token_note ===
              "string" ? (
                <Alert>
                  <AlertDescription>
                    <span className="font-medium">
                      {t("common.technicalDetail")}
                    </span>
                    :{" "}
                    <span className="break-words">
                      {String(systemPerformance.time_to_first_token_note)}
                    </span>
                  </AlertDescription>
                </Alert>
              ) : null}
            </div>
          ) : null}

          {hasOperationalEfficiencyData ? (
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-muted-foreground">
                {t("costEfficiency.title")}
              </h4>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
                <StatsCard
                  title={t("costEfficiency.cards.errorRate.title")}
                  value={formatOptionalPercent(
                    operationalEfficiency,
                    "error_rate_pct",
                    formatters,
                    translate
                  )}
                  subtitle={t("costEfficiency.cards.errorRate.subtitle")}
                  color="text-destructive"
                />
                <StatsCard
                  title={t("costEfficiency.cards.promptTokenShare.title")}
                  value={formatOptionalPercent(
                    operationalEfficiency,
                    "prompt_token_share_pct",
                    formatters,
                    translate
                  )}
                  subtitle={t("costEfficiency.cards.promptTokenShare.subtitle")}
                />
                <StatsCard
                  title={t("costEfficiency.cards.completionTokenShare.title")}
                  value={formatOptionalPercent(
                    operationalEfficiency,
                    "completion_token_share_pct",
                    formatters,
                    translate
                  )}
                  subtitle={t(
                    "costEfficiency.cards.completionTokenShare.subtitle"
                  )}
                />
                <StatsCard
                  title={t("costEfficiency.cards.costPerThousandTokens.title")}
                  value={formatters.currency(
                    numberField(operationalEfficiency, "cost_per_1k_tokens_usd")
                  )}
                  subtitle={t(
                    "costEfficiency.cards.costPerThousandTokens.subtitle"
                  )}
                />
                <StatsCard
                  title={t("costEfficiency.cards.semanticCacheHit.title")}
                  value={formatOptionalPercent(
                    operationalEfficiency,
                    "semantic_cache_hit_rate_pct",
                    formatters,
                    translate
                  )}
                  subtitle={t("units.observedCalls", {
                    count: numberField(
                      operationalEfficiency,
                      "semantic_cache_observed_count"
                    ),
                  })}
                />
              </div>
            </div>
          ) : null}

          {hasAiriChatData ? (
            <div className="grid gap-6 xl:grid-cols-[2fr,1fr]">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    {t("health.daily.title")}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {airiChatDaily.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t("health.daily.empty")}
                    </p>
                  ) : (
                    <AiriChatDailyHealthChart data={airiChatDaily} />
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    {t("health.warnings.title")}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {airiChatIssues.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t("health.warnings.empty")}
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>
                            {t("health.warnings.columns.issue")}
                          </TableHead>
                          <TableHead className="text-right">
                            {t("health.warnings.columns.turns")}
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {airiChatIssues.map(row => {
                          const key = [
                            row.result_type,
                            row.fallback_action,
                            row.fallback_reason,
                            row.retrieval_path,
                          ]
                            .map(value => String(value || "none"))
                            .join(":");
                          return (
                            <TableRow key={key}>
                              <TableCell className="max-w-[12rem] whitespace-normal">
                                <div className="space-y-1">
                                  <Badge variant="outline">
                                    {presentLlmEnum(
                                      "resultType",
                                      String(row.result_type || "no_context"),
                                      translate
                                    )}
                                  </Badge>
                                  <p className="text-xs text-muted-foreground">
                                    {presentLlmEnum(
                                      "retrievalPath",
                                      String(row.retrieval_path || "none"),
                                      translate
                                    )}
                                  </p>
                                </div>
                              </TableCell>
                              <TableCell className="text-right font-medium">
                                {t("units.turns", {
                                  count: numberField(row, "turns"),
                                })}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </div>
          ) : null}
        </div>
      ) : null}

      <Card className="min-w-0">
        <CardHeader className="flex flex-col gap-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">
                {t("reviewQueue.title")}
              </CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("reviewQueue.description")}
              </p>
            </div>
            <Badge variant={reviewItemCount > 0 ? "default" : "outline"}>
              {t("units.openFindings", { count: reviewItemCount })}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="min-w-0">
          {isReviewLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, index) => (
                <Skeleton key={index} className="h-12 w-full" />
              ))}
            </div>
          ) : reviewError ? (
            <div className="space-y-1 text-sm text-muted-foreground">
              <p>{t("reviewQueue.loadFailed")}</p>
              {reviewErrorDetail ? (
                <p className="break-words text-xs">
                  <span className="font-medium">
                    {t("common.technicalDetail")}
                  </span>
                  : {reviewErrorDetail}
                </p>
              ) : null}
            </div>
          ) : !reviewItems.length ? (
            <p className="text-sm text-muted-foreground">
              {t("reviewQueue.empty")}
            </p>
          ) : (
            <Table className="table-fixed">
              <colgroup>
                <col className="w-[34%]" />
                <col />
                <col className="w-36" />
              </colgroup>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-normal">
                    {t("reviewQueue.columns.finding")}
                  </TableHead>
                  <TableHead className="whitespace-normal">
                    {t("reviewQueue.columns.evidence")}
                  </TableHead>
                  <TableHead className="whitespace-normal text-right">
                    {t("reviewQueue.columns.decision")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reviewItems.map(item => {
                  const signal = getReviewSignal(item, translate);
                  const outputExcerpt = compactText(item.outputExcerpt);
                  const suggestedFix = compactText(item.suggestedFix?.title);
                  const severity = presentLlmEnum(
                    "severity",
                    item.severity,
                    translate
                  );

                  return (
                    <TableRow key={item.id}>
                      <TableCell className="min-w-0 whitespace-normal align-top">
                        <div className="flex min-w-0 flex-col gap-2">
                          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                            <Badge variant="outline" className="max-w-full">
                              <span className="truncate">
                                {presentLlmEnum(
                                  "issueType",
                                  item.issueType,
                                  translate
                                )}
                              </span>
                            </Badge>
                            <Badge
                              variant={
                                item.severity.toLowerCase() === "high"
                                  ? "default"
                                  : "secondary"
                              }
                              className="max-w-full"
                            >
                              <span className="truncate">{severity}</span>
                            </Badge>
                          </div>
                          <div className="break-words font-medium leading-snug [overflow-wrap:anywhere]">
                            {item.title}
                          </div>
                          {signal ? (
                            <div className="flex min-w-0 flex-wrap gap-1.5">
                              <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
                                <span className="truncate">
                                  {signal.label}: {signal.value}
                                </span>
                              </span>
                            </div>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="min-w-0 whitespace-normal align-top">
                        <div className="flex min-w-0 flex-col gap-2.5">
                          <div className="min-w-0">
                            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                              {t("reviewQueue.labels.replyExcerpt")}
                            </div>
                            {outputExcerpt ? (
                              <div className="line-clamp-2 break-words text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                                {outputExcerpt}
                              </div>
                            ) : (
                              <div className="text-sm text-muted-foreground">
                                {t("reviewQueue.labels.noReplyExcerpt")}
                              </div>
                            )}
                          </div>
                          {suggestedFix ? (
                            <div className="min-w-0">
                              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                {t("reviewQueue.labels.recommendedNextStep")}
                              </div>
                              <div className="line-clamp-1 break-words text-sm text-foreground [overflow-wrap:anywhere]">
                                {suggestedFix}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-normal align-top">
                        <div className="flex flex-col items-stretch gap-2 sm:items-end">
                          <Button
                            size="sm"
                            variant="secondary"
                            title={
                              item.inputExcerpt
                                ? t("prompts.resolveWithRegression")
                                : t("prompts.resolveWithoutRegression")
                            }
                            disabled={updatingReviewItemId === item.id}
                            onClick={() => updateReviewItem(item, "resolve")}
                          >
                            {t("reviewQueue.actions.resolve")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={updatingReviewItemId === item.id}
                            onClick={() => updateReviewItem(item, "ignore")}
                          >
                            {t("reviewQueue.actions.ignore")}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <StatsCard
          title={t("cards.safeReplies.title")}
          value={analytics.totals.safeConversationalReplies}
          subtitle={t("cards.safeReplies.subtitle")}
        />
        <StatsCard
          title={t("cards.ragTurns.title")}
          value={analytics.totals.ragTurns}
          subtitle={t("cards.ragTurns.subtitle")}
        />
        <StatsCard
          title={t("cards.groundedRecovery.title")}
          value={analytics.totals.groundedRecoveryUsage}
          subtitle={t("cards.groundedRecovery.subtitle")}
        />
        <StatsCard
          title={t("cards.genericClarification.title")}
          value={analytics.totals.genericClarificationUsage}
          subtitle={t("cards.genericClarification.subtitle")}
        />
        <StatsCard
          title={t("cards.lowConfidence.title")}
          value={analytics.totals.lowConfidenceUnderstandingResults}
          subtitle={t("cards.lowConfidence.subtitle")}
          color="text-destructive"
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatsCard
          title={t("cards.groundedRecoveryRate.title")}
          value={formatters.percent(analytics.rates.groundedRecoveryRate)}
          subtitle={t("cards.groundedRecoveryRate.subtitle")}
        />
        <StatsCard
          title={t("cards.genericClarificationRate.title")}
          value={formatters.percent(analytics.rates.genericClarificationRate)}
          subtitle={t("cards.genericClarificationRate.subtitle")}
        />
        <StatsCard
          title={t("cards.lowConfidenceRate.title")}
          value={formatters.percent(analytics.rates.lowConfidenceRate)}
          subtitle={t("cards.lowConfidenceRate.subtitle")}
        />
        <StatsCard
          title={t("cards.safeReplyShare.title")}
          value={formatters.percent(analytics.rates.safeReplyShare)}
          subtitle={t("cards.safeReplyShare.subtitle")}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[2fr,1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("charts.dailyTrend")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <LlmDailyTrendChart data={analytics.trends} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("charts.fallbackActions")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {analytics.breakdowns.fallbackActions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("empty.noFallbackActions")}
              </p>
            ) : (
              <FallbackActionsChart
                data={analytics.breakdowns.fallbackActions}
              />
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <BreakdownTable
          title={t("tables.fallbackReasons")}
          rows={analytics.breakdowns.fallbackReasons}
          emptyLabel={t("empty.noFallbackReasons")}
          enumKind="fallbackReason"
        />
        <BreakdownTable
          title={t("tables.channels")}
          rows={analytics.breakdowns.channels}
          emptyLabel={t("empty.noChannels")}
          enumKind="channel"
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <BreakdownTable
          title={t("tables.resultTypes")}
          rows={analytics.breakdowns.resultTypes}
          emptyLabel={t("empty.noResultTypes")}
          enumKind="resultType"
        />
        <BreakdownTable
          title={t("tables.safeReplyKinds")}
          rows={analytics.breakdowns.safeReplyKinds}
          emptyLabel={t("empty.noSafeReplyKinds")}
          enumKind="turnKind"
        />
        <BreakdownTable
          title={t("tables.lowConfidenceKinds")}
          rows={analytics.breakdowns.lowConfidenceKinds}
          emptyLabel={t("empty.noLowConfidenceKinds")}
          enumKind="turnKind"
        />
      </div>
    </div>
  );
}
