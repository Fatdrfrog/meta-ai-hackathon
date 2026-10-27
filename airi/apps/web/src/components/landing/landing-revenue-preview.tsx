"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  LANDING_CONVERSATION_SAMPLES,
  LANDING_REVENUE_SAMPLES,
} from "./landing-workflow-sample";
import { createLandingNumberFormatters } from "./landing-number-formatters";
import { LandingAnalyticsDetails } from "./landing-analytics-details";
import s from "./landing-workflow-studio.module.css";

export function LandingRevenuePreview({
  interactive,
  variant = "card",
  compact = false,
}: {
  interactive: boolean;
  variant?: "card" | "report";
  compact?: boolean;
}) {
  const t = useTranslations("LandingDemo.featureCards.previews.analytics");
  const common = useTranslations("LandingDemo.featureCards.previews.common");
  const format = createLandingNumberFormatters(useLocale());
  const tooltipId = useId();
  const [period, setPeriod] =
    useState<keyof typeof LANDING_REVENUE_SAMPLES>("month");
  const activePeriod = variant === "report" ? "month" : period;
  const sample = LANDING_REVENUE_SAMPLES[activePeriod];
  const netRevenue = sample.grossRevenue - sample.refundedRevenue;
  const conversations = LANDING_CONVERSATION_SAMPLES[activePeriod];
  const chartData = conversations.current.map((point, index) => ({
    day: index + 1,
    current: point.total,
    previous: conversations.previous[index].total,
  }));
  const chartSummary = t("trend.summary", {
    current: format.integer(
      conversations.current.reduce((sum, day) => sum + day.total, 0)
    ),
    previous: format.integer(
      conversations.previous.reduce((sum, day) => sum + day.total, 0)
    ),
  });
  const accessibleChart = interactive || variant === "report";
  return (
    <div
      className={s.revenueScene}
      data-analytics-period={activePeriod}
      data-analytics-layout={variant}
      data-compact={compact}
    >
      <div className={s.revenueHeading}>
        {!compact && <span>{common("shop")}</span>}
        <span>{t("sample")}</span>
      </div>
      {interactive && variant === "card" ? (
        <div
          className={s.revenuePeriods}
          role="group"
          aria-label={t("periodLabel")}
        >
          {(["month", "week"] as const).map(value => (
            <button
              type="button"
              key={value}
              aria-pressed={period === value}
              onClick={() => setPeriod(value)}
            >
              {t(`periods.${value}`)}
            </button>
          ))}
        </div>
      ) : (
        <p className={s.revenuePeriod}>{t(`periods.${activePeriod}`)}</p>
      )}
      <section data-analytics-detail="revenue" aria-label={t("source")}>
        {!compact && <p className={s.revenuePeriod}>{t("source")}</p>}
        <dl
          className={s.revenueTotal}
          aria-live={interactive ? "polite" : undefined}
        >
          <dt>{t("netRevenue")}</dt>
          <dd>
            {format.integer(netRevenue)} <span>₸</span>
          </dd>
        </dl>
        <dl className={s.revenueMetrics}>
          <div>
            <dt>{t("sales")}</dt>
            <dd>{format.integer(sample.sales)}</dd>
          </div>
          <div>
            <dt>{t("refunds")}</dt>
            <dd>
              {format.integer(sample.refundedRevenue)} <span>₸</span>
            </dd>
          </div>
        </dl>
        {!compact && <p className={s.revenueNote}>{t("note")}</p>}
      </section>
      <figure className={s.revenueTrend} data-conversation-trend={activePeriod}>
        <figcaption>
          <span>{t("trend.title")}</span>
          {!compact && <span>{t("trend.unit")}</span>}
        </figcaption>
        {!compact && <p className={s.revenuePeriod}>{t("trend.source")}</p>}
        <ChartContainer
          className={s.revenueChart}
          config={{
            current: {
              label: t("trend.current"),
              color: "var(--trend-current)",
            },
            previous: {
              label: t("trend.previous"),
              color: "var(--trend-previous)",
            },
          }}
          role="group"
          aria-label={t("trend.title")}
        >
          <AreaChart
            data={chartData}
            margin={{ top: 12, right: 12, bottom: 0, left: -12 }}
            accessibilityLayer={accessibleChart}
            role={accessibleChart ? "application" : "img"}
            aria-label={chartSummary}
            aria-describedby={accessibleChart ? tooltipId : undefined}
          >
            <CartesianGrid
              vertical={false}
              stroke="var(--trend-grid)"
              strokeDasharray="3 5"
            />
            <XAxis
              dataKey="day"
              tickLine={false}
              axisLine={false}
              tickMargin={9}
              ticks={activePeriod === "month" ? [1, 10, 20, 30] : [1, 2, 4, 7]}
              tickFormatter={value => String(value)}
            />
            <YAxis
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              width={49}
              tickCount={4}
              tickFormatter={value => format.integer(Number(value))}
            />
            <ChartTooltip
              cursor={{
                stroke: "var(--trend-previous)",
                strokeDasharray: "3 4",
              }}
              content={
                <ChartTooltipContent
                  id={tooltipId}
                  className={s.revenueTooltip}
                  labelFormatter={(_label, payload) =>
                    t("trend.day", {
                      day: String(payload[0]?.payload.day ?? ""),
                    })
                  }
                  formatter={(value, name) => (
                    <span className={s.revenueTooltipRow}>
                      <span>
                        {t(
                          name === "current"
                            ? "trend.current"
                            : "trend.previous"
                        )}
                      </span>
                      <strong>{format.integer(Number(value))}</strong>
                    </span>
                  )}
                />
              }
            />
            <Area
              dataKey="previous"
              type="linear"
              fill="none"
              stroke="var(--color-previous)"
              strokeWidth={1.5}
              strokeDasharray="5 5"
              isAnimationActive={false}
            />
            <Area
              dataKey="current"
              type="linear"
              fill="var(--color-current)"
              fillOpacity={0.1}
              stroke="var(--color-current)"
              strokeWidth={2.5}
              isAnimationActive={false}
            />
          </AreaChart>
        </ChartContainer>
        <div className={s.revenueLegend}>
          <span>
            <i aria-hidden />
            {t("trend.current")}
          </span>
          <span>
            <i aria-hidden />
            {t("trend.previous")}
          </span>
          {!compact && <span>{t("trend.axis")}</span>}
        </div>
      </figure>
      {variant === "report" && <LandingAnalyticsDetails />}
    </div>
  );
}
