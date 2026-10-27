"use client";

import type {
  DashboardSourceCoverage,
  ServiceTruthReport,
} from "@/lib/analytics/service-truth";
import { useLocale, useTranslations } from "next-intl";
import { createDashboardFormatters } from "./dashboard-formatters";
import {
  formatDashboardDuration,
  type DashboardTranslator,
} from "./dashboard-localization";

export function ServiceCoverageNotice({
  coverage,
}: {
  coverage?: DashboardSourceCoverage;
}) {
  const t = useTranslations("DashboardPage.serviceTruth"),
    locale = useLocale();
  if (coverage?.status !== "partial") return null;
  return (
    <p
      role="status"
      className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-sm leading-relaxed text-foreground"
    >
      {t("partialCoverage", {
        limit: createDashboardFormatters(locale).integer(coverage.rowLimit),
      })}
    </p>
  );
}

export function ServiceTruthSummary({
  report,
}: {
  report?: ServiceTruthReport;
}) {
  const t = useTranslations("DashboardPage.serviceTruth"),
    durationT = useTranslations("SectionCards"),
    locale = useLocale();
  if (!report) return null;
  const format = createDashboardFormatters(locale),
    response = report.firstHumanResponse,
    resolution = report.resolution;
  const duration = (seconds: number | null) =>
    formatDashboardDuration(
      seconds,
      locale,
      durationT as unknown as DashboardTranslator
    );
  const rows = [
    ["eligible", format.integer(response.eligibleConversations)],
    ["answered", format.integer(response.answeredConversations)],
    ["unanswered", format.integer(response.unansweredConversations)],
    [
      "coverage",
      response.coverageRate === null
        ? "—"
        : `${format.number(response.coverageRate)}%`,
    ],
    ["oldestUnanswered", duration(response.oldestUnansweredSeconds)],
    ["medianResolution", duration(resolution.medianSeconds)],
    ["unknownClosures", format.integer(resolution.unknownClosedConversations)],
    ["timeouts", format.integer(resolution.timeoutClosedConversations)],
  ];
  return (
    <section
      className="min-w-0 space-y-4 border-b border-border/60 py-5"
      aria-label={t("title")}
    >
      <div className="space-y-1">
        <h3 className="text-base font-semibold tracking-tight">{t("title")}</h3>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          {t("description")}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-x-5 gap-y-6 lg:grid-cols-4">
        {rows.map(([key, value]) => (
          <div key={key} className="min-w-0 space-y-1">
            <dt className="text-xs leading-relaxed text-muted-foreground">
              {t(key)}
            </dt>
            <dd className="break-words text-xl font-semibold tabular-nums tracking-tight">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
        {response.eligibleConversations === null &&
        !report.sourceCoverage?.firstResponseRowsTruncated ? (
          <p>{t("managerFilterNotice")}</p>
        ) : null}
        <p>
          {t("knownResolutions", {
            count: resolution.measuredResolvedConversations,
          })}{" "}
          {t("resolutionNotice")}
        </p>
        <p>{t("cohortNotice")}</p>
      </div>
    </section>
  );
}
