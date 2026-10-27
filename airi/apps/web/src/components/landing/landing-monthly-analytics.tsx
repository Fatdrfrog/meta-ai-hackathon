"use client";

import { useId, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { buildDashboardCountComparison } from "@/lib/dashboard-comparison";
import { createLandingNumberFormatters } from "./landing-number-formatters";
import { LANDING_MONTHLY_ATTRIBUTION } from "./landing-workflow-sample";
import s from "./landing-workflow-studio.module.css";

const METRICS = ["spend", "conversations", "sales", "netRevenue"] as const;
type Metric = (typeof METRICS)[number];

/** Public report concept composed from the existing source/ledger metrics. */
export function LandingMonthlyAnalytics() {
  const t = useTranslations("LandingDemo.revenueReport.monthly");
  const format = createLandingNumberFormatters(useLocale());
  const id = useId();
  const [currentMonth, setCurrentMonth] = useState("jun");
  const [previousMonth, setPreviousMonth] = useState("may");
  const current = LANDING_MONTHLY_ATTRIBUTION.find(
    row => row.month === currentMonth
  )!;
  const previous = LANDING_MONTHLY_ATTRIBUTION.find(
    row => row.month === previousMonth
  )!;
  const currentLabel = `${t(`months.${currentMonth}`)} 2026`;
  const previousLabel = `${t(`months.${previousMonth}`)} 2026`;
  const value = (metric: Metric, amount: number) =>
    metric === "spend"
      ? format.currency(amount, "USD")
      : metric === "netRevenue"
        ? `${format.integer(amount)} ₸`
        : format.integer(amount);

  return (
    <section
      className={s.monthlyReport}
      aria-labelledby={`${id}-title`}
      data-monthly-analytics
    >
      <header className={s.monthlyHeader}>
        <div>
          <p className={s.monthlyKicker}>{t("scope")}</p>
          <h3 id={`${id}-title`}>{t("title")}</h3>
          <p className={s.monthlyConcept}>{t("concept")}</p>
        </div>
        <div className={s.monthlyFilters}>
          <label htmlFor={`${id}-current`}>
            <span>{t("current")}</span>
            <NativeSelect
              id={`${id}-current`}
              value={currentMonth}
              onChange={event => setCurrentMonth(event.target.value)}
            >
              {LANDING_MONTHLY_ATTRIBUTION.map(row => (
                <NativeSelectOption key={row.month} value={row.month}>
                  {t(`months.${row.month}`)} 2026
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <label htmlFor={`${id}-previous`}>
            <span>{t("previous")}</span>
            <NativeSelect
              id={`${id}-previous`}
              value={previousMonth}
              onChange={event => setPreviousMonth(event.target.value)}
            >
              {LANDING_MONTHLY_ATTRIBUTION.map(row => (
                <NativeSelectOption key={row.month} value={row.month}>
                  {t(`months.${row.month}`)} 2026
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        </div>
      </header>
      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {t("selection", { current: currentLabel, previous: previousLabel })}
      </p>
      <div className={s.monthlyContent}>
        <figure className={s.monthlyTrend}>
          <figcaption>
            <span>{t("chart")}</span>
            <span>{t("unit")}</span>
          </figcaption>
          <ChartContainer
            className={s.monthlyChart}
            config={{
              netRevenue: {
                label: t("metrics.netRevenue"),
                color: "var(--monthly-current)",
              },
            }}
          >
            <BarChart
              data={LANDING_MONTHLY_ATTRIBUTION}
              margin={{ top: 14, right: 4, bottom: 0, left: -14 }}
              accessibilityLayer
              role="application"
              aria-label={t("chartLabel")}
              aria-describedby={`${id}-tooltip`}
            >
              <CartesianGrid
                vertical={false}
                stroke="var(--monthly-grid)"
                strokeDasharray="3 5"
              />
              <XAxis
                dataKey="month"
                tickLine={false}
                axisLine={false}
                interval={0}
                tickMargin={10}
                tickFormatter={month => t(`shortMonths.${month}`)}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={50}
                tickCount={4}
                tickFormatter={amount => format.integer(Number(amount) / 1000)}
              />
              <ChartTooltip
                cursor={{ fill: "var(--monthly-cursor)", opacity: 0.5 }}
                content={
                  <ChartTooltipContent
                    id={`${id}-tooltip`}
                    className={s.monthlyTooltipBox}
                    labelFormatter={(_label, payload) =>
                      `${t(`months.${payload[0]?.payload.month ?? "jan"}`)} 2026`
                    }
                    formatter={amount => (
                      <span className={s.monthlyTooltip}>
                        <span>{t("metrics.netRevenue")}</span>
                        <strong>{value("netRevenue", Number(amount))}</strong>
                      </span>
                    )}
                  />
                }
              />
              <Bar
                dataKey="netRevenue"
                radius={[4, 4, 0, 0]}
                maxBarSize={44}
                isAnimationActive={false}
              >
                {LANDING_MONTHLY_ATTRIBUTION.map(row => (
                  <Cell
                    key={row.month}
                    fill={
                      row.month === currentMonth
                        ? "var(--monthly-current)"
                        : row.month === previousMonth
                          ? "var(--monthly-previous)"
                          : "var(--monthly-other)"
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
          <div className={s.monthlyLegend}>
            <span>
              <i aria-hidden />
              {currentLabel}
            </span>
            {previousMonth !== currentMonth && (
              <span>
                <i aria-hidden />
                {previousLabel}
              </span>
            )}
          </div>
        </figure>
        <table className={s.monthlyTable}>
          <caption className="sr-only">
            {t("selection", { current: currentLabel, previous: previousLabel })}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("metric")}</th>
              <th scope="col">{currentLabel}</th>
              <th scope="col">{previousLabel}</th>
              <th scope="col">{t("change")}</th>
            </tr>
          </thead>
          <tbody>
            {METRICS.map(metric => {
              const comparison = buildDashboardCountComparison(
                current[metric],
                previous[metric]
              );
              return (
                <tr key={metric} data-monthly-metric={metric}>
                  <th scope="row">{t(`metrics.${metric}`)}</th>
                  <td>{value(metric, current[metric])}</td>
                  <td>{value(metric, previous[metric])}</td>
                  <td>
                    {comparison.percentChange === null
                      ? "—"
                      : format.signedPercent(comparison.percentChange, 1)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className={s.monthlyNote}>{t("note")}</p>
    </section>
  );
}
