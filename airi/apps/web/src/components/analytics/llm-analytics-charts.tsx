"use client";

import {
  createLlmAnalyticsFormatters,
  optionalNumberField,
  presentLlmEnum,
  type LlmAnalyticsFormatters,
  type LlmAnalyticsTranslator,
} from "@/components/analytics/llm-analytics-presentation";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { AiriReplyOperatorAnalytics } from "@/lib/airi/reply/runtime/llm-analytics";
import { useLocale, useTranslations } from "next-intl";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";

type WarehouseRow = Record<string, unknown>;

const SPEND_CHART_CONFIG = {
  total_cost_usd: {
    label: "Spend",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig;

const HEALTH_CHART_CONFIG = {
  rag_turn_count: {
    label: "Answers",
    color: "var(--chart-2)",
  },
  grounded_turn_count: {
    label: "Grounded",
    color: "var(--chart-1)",
  },
  no_context_turn_count: {
    label: "No context",
    color: "var(--chart-4)",
  },
} satisfies ChartConfig;

const TREND_CHART_CONFIG = {
  ragTurns: {
    label: "RAG turns",
    color: "var(--chart-1)",
  },
  groundedRecoveryUsage: {
    label: "Grounded recovery",
    color: "var(--chart-3)",
  },
  genericClarificationUsage: {
    label: "Clarification",
    color: "var(--chart-4)",
  },
  safeConversationalReplies: {
    label: "Safe replies",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig;

const FALLBACK_CHART_CONFIG = {
  count: {
    label: "Events",
    color: "var(--chart-3)",
  },
} satisfies ChartConfig;

function createCountTooltipFormatter(
  config: ChartConfig,
  formatters: LlmAnalyticsFormatters
) {
  return function formatCountTooltip(value: unknown, name: unknown) {
    const series = config[String(name)];
    const count = optionalNumberField({ value }, "value");

    return (
      <div className="flex w-full items-center gap-2">
        <div
          className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
          style={{ backgroundColor: series?.color }}
        />
        <div className="flex flex-1 items-center justify-between gap-4">
          <span className="text-muted-foreground">
            {series?.label ?? String(name)}
          </span>
          {count !== null && (
            <span className="text-foreground font-mono font-medium tabular-nums">
              {formatters.number(count)}
            </span>
          )}
        </div>
      </div>
    );
  };
}

export function LlmSpendDailyChart({ data }: { data: WarehouseRow[] }) {
  const t = useTranslations("LlmAnalytics");
  const locale = useLocale();
  const formatters = createLlmAnalyticsFormatters(
    locale,
    t as unknown as LlmAnalyticsTranslator
  );

  const config = {
    ...SPEND_CHART_CONFIG,
    total_cost_usd: {
      ...SPEND_CHART_CONFIG.total_cost_usd,
      label: t("warehouse.spend.legend.dailySpend"),
    },
  } satisfies ChartConfig;

  return (
    <ChartContainer
      config={config}
      className="aspect-auto h-[280px] min-w-0 w-full"
    >
      <LineChart data={data} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={value =>
            formatters.shortDate(String(value)) ?? String(value)
          }
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={56}
          tickFormatter={value => formatters.currency(Number(value))}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={value =>
                formatters.shortDate(String(value)) ?? String(value)
              }
              formatter={value => (
                <span className="font-mono font-medium tabular-nums">
                  {formatters.currency(Number(value))}
                </span>
              )}
            />
          }
        />
        <Line
          type="monotone"
          dataKey="total_cost_usd"
          stroke="var(--color-total_cost_usd)"
          strokeWidth={2}
          dot={{ r: 2 }}
        />
      </LineChart>
    </ChartContainer>
  );
}

export function AiriChatDailyHealthChart({ data }: { data: WarehouseRow[] }) {
  const t = useTranslations("LlmAnalytics");
  const locale = useLocale();
  const formatters = createLlmAnalyticsFormatters(
    locale,
    t as unknown as LlmAnalyticsTranslator
  );

  const config = {
    rag_turn_count: {
      ...HEALTH_CHART_CONFIG.rag_turn_count,
      label: t("health.daily.series.answers"),
    },
    grounded_turn_count: {
      ...HEALTH_CHART_CONFIG.grounded_turn_count,
      label: t("health.daily.series.grounded"),
    },
    no_context_turn_count: {
      ...HEALTH_CHART_CONFIG.no_context_turn_count,
      label: t("health.daily.series.noContext"),
    },
  } satisfies ChartConfig;

  return (
    <ChartContainer
      config={config}
      className="aspect-auto h-[280px] min-w-0 w-full"
    >
      <LineChart data={data} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={value =>
            formatters.shortDate(String(value)) ?? String(value)
          }
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={40}
          tickFormatter={value => formatters.number(Number(value))}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={value =>
                formatters.shortDate(String(value)) ?? String(value)
              }
              formatter={createCountTooltipFormatter(config, formatters)}
            />
          }
        />
        <ChartLegend
          content={<ChartLegendContent className="flex-wrap gap-x-4 gap-y-2" />}
        />
        <Line
          type="monotone"
          dataKey="rag_turn_count"
          stroke="var(--color-rag_turn_count)"
          strokeWidth={2}
          dot={{ r: 2 }}
        />
        <Line
          type="monotone"
          dataKey="grounded_turn_count"
          stroke="var(--color-grounded_turn_count)"
          strokeWidth={2}
          dot={{ r: 2 }}
        />
        <Line
          type="monotone"
          dataKey="no_context_turn_count"
          stroke="var(--color-no_context_turn_count)"
          strokeWidth={2}
          dot={{ r: 2 }}
        />
      </LineChart>
    </ChartContainer>
  );
}

export function LlmDailyTrendChart({
  data,
}: {
  data: AiriReplyOperatorAnalytics["trends"];
}) {
  const t = useTranslations("LlmAnalytics");
  const locale = useLocale();
  const formatters = createLlmAnalyticsFormatters(
    locale,
    t as unknown as LlmAnalyticsTranslator
  );

  const config = {
    ragTurns: {
      ...TREND_CHART_CONFIG.ragTurns,
      label: t("legend.ragTurns"),
    },
    groundedRecoveryUsage: {
      ...TREND_CHART_CONFIG.groundedRecoveryUsage,
      label: t("legend.groundedRecovery"),
    },
    genericClarificationUsage: {
      ...TREND_CHART_CONFIG.genericClarificationUsage,
      label: t("legend.genericClarification"),
    },
    safeConversationalReplies: {
      ...TREND_CHART_CONFIG.safeConversationalReplies,
      label: t("legend.safeReplies"),
    },
  } satisfies ChartConfig;

  return (
    <ChartContainer
      config={config}
      className="aspect-auto h-[340px] min-w-0 w-full"
    >
      <LineChart data={data} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={value =>
            formatters.shortDate(String(value)) ?? String(value)
          }
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={40}
          tickFormatter={value => formatters.number(Number(value))}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={value =>
                formatters.shortDate(String(value)) ?? String(value)
              }
              formatter={createCountTooltipFormatter(config, formatters)}
            />
          }
        />
        <ChartLegend
          content={<ChartLegendContent className="flex-wrap gap-x-4 gap-y-2" />}
        />
        <Line
          type="monotone"
          dataKey="ragTurns"
          stroke="var(--color-ragTurns)"
          strokeWidth={2}
          dot={{ r: 2 }}
        />
        <Line
          type="monotone"
          dataKey="groundedRecoveryUsage"
          stroke="var(--color-groundedRecoveryUsage)"
          strokeWidth={2}
          dot={{ r: 2 }}
        />
        <Line
          type="monotone"
          dataKey="genericClarificationUsage"
          stroke="var(--color-genericClarificationUsage)"
          strokeWidth={2}
          dot={{ r: 2 }}
        />
        <Line
          type="monotone"
          dataKey="safeConversationalReplies"
          stroke="var(--color-safeConversationalReplies)"
          strokeWidth={2}
          dot={{ r: 2 }}
        />
      </LineChart>
    </ChartContainer>
  );
}

export function FallbackActionsChart({
  data,
}: {
  data: AiriReplyOperatorAnalytics["breakdowns"]["fallbackActions"];
}) {
  const t = useTranslations("LlmAnalytics");
  const locale = useLocale();
  const translate = t as unknown as LlmAnalyticsTranslator;
  const formatters = createLlmAnalyticsFormatters(locale, translate);

  const config = {
    ...FALLBACK_CHART_CONFIG,
    count: {
      ...FALLBACK_CHART_CONFIG.count,
      label: t("labels.events"),
    },
  } satisfies ChartConfig;

  return (
    <ChartContainer
      config={config}
      className="aspect-auto h-[340px] min-w-0 w-full"
    >
      <BarChart data={data} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="name"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickFormatter={value =>
            presentLlmEnum("fallbackAction", String(value), translate)
          }
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={40}
          tickFormatter={value => formatters.number(Number(value))}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={value =>
                presentLlmEnum("fallbackAction", String(value), translate)
              }
              formatter={createCountTooltipFormatter(config, formatters)}
            />
          }
        />
        <Bar dataKey="count" fill="var(--color-count)" radius={6} />
      </BarChart>
    </ChartContainer>
  );
}
