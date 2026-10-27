"use client";
import type { ConversionFeedbackReport } from "@/lib/conversions/conversion-feedback-report";
import { StatsCard } from "@/components/analytics/charts/StatsCard";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useLocale, useTranslations } from "next-intl";
import {
  createDashboardFormatters,
  normalizeDashboardIntlLocale,
} from "./dashboard-formatters";

const readableReasons = new Set([
  "missing_attributable_click",
  "transaction_id_missing",
  "feedback_not_enabled",
  "whatsapp_source_unavailable",
  "whatsapp_account_changed",
  "delivery_destination_changed",
  "event_too_old",
  "pre_dispatch_failure",
  "dispatch_started",
  "original_purchase_not_sent",
  "invalid_value",
  "invalid_currency",
  "invalid_event_time",
  "event_in_future",
  "missing_snapshot",
  "missing_whatsapp_source",
  "unsupported_outcome",
  "invalid_ctwa_clid",
  "invalid_dataset_id",
  "invalid_waba_id",
  "purchase_not_eligible",
  "purchase_destination_changed",
  "invalid_snapshot",
  "invalid_source_id",
  "invalid_event_name",
  "invalid_test_event_code",
  "invalid_event_id",
  "invalid_access_token",
  "transport_error",
  "unconfirmed_http_error",
  "missing_acceptance",
  "provider_response_timeout",
  "provider_response_too_large",
]);

export function ConversionFeedbackReportSection({
  report,
  error,
}: {
  report?: ConversionFeedbackReport | null;
  error?: "unavailable" | null;
}) {
  const t = useTranslations("DashboardPage.advertisement.feedback");
  const locale = useLocale();
  const formatters = createDashboardFormatters(locale);
  if (!report && !error) return null;
  const pending =
    (report?.statuses.pending ?? 0) + (report?.statuses.queued ?? 0);
  const oldestPending = report?.oldestPendingAt
    ? new Intl.DateTimeFormat(normalizeDashboardIntlLocale(locale), {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(report.oldestPendingAt))
    : null;
  const statusLabels = {
    not_eligible: "ineligible",
    pending: "pending",
    queued: "pending",
    sent: "accepted",
    rejected: "rejected",
    delivery_unknown: "unknown",
  } as const;
  return (
    <section
      className="min-w-0 space-y-3 rounded-lg border p-3"
      aria-label={t("title")}
    >
      <div>
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {t("scope")}
        </p>
      </div>
      {error ? (
        <p className="text-sm text-destructive">{t("unavailable")}</p>
      ) : null}
      {report ? (
        <>
          {report.recorded === 0 ? (
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatsCard
                title={t("recorded")}
                value={formatters.integer(report.recorded)}
              />
              <StatsCard
                title={t("eligible")}
                value={formatters.integer(report.eligible)}
              />
              <StatsCard
                title={t("accepted")}
                value={formatters.integer(report.statuses.sent)}
              />
              <StatsCard
                title={t("pending")}
                value={formatters.integer(pending)}
              />
              <StatsCard
                title={t("rejected")}
                value={formatters.integer(report.statuses.rejected)}
              />
              <StatsCard
                title={t("unknown")}
                value={formatters.integer(report.statuses.delivery_unknown)}
              />
              <StatsCard
                title={t("ineligible")}
                value={formatters.integer(report.statuses.not_eligible)}
              />
            </div>
          )}
          {oldestPending ? (
            <p className="text-xs text-muted-foreground">
              {t("oldestPending", { date: oldestPending })}
            </p>
          ) : null}
          {report.statuses.delivery_unknown > 0 ? (
            <p className="text-sm leading-relaxed text-foreground">
              {t("unknownHelp")}
            </p>
          ) : null}
          {report.reasons.length ? (
            <details className="min-w-0 rounded-md bg-muted/25 p-3">
              <summary className="cursor-pointer text-sm font-medium focus-visible:outline focus-visible:outline-ring">
                {t("reasonsTitle")}
              </summary>
              <Table className="mt-3">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("status")}</TableHead>
                    <TableHead>{t("reason")}</TableHead>
                    <TableHead className="text-right">{t("count")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.reasons.map((item, index) => (
                    <TableRow
                      key={`${item.status}:${item.reason || ""}:${index}`}
                    >
                      <TableCell className="whitespace-normal">
                        {t(statusLabels[item.status])}
                      </TableCell>
                      <TableCell className="min-w-40 whitespace-normal">
                        {item.reason &&
                        /^meta_(?:graph_)?\d{1,10}(?:_\d{1,10})?$/.test(
                          item.reason
                        )
                          ? t("reasons.meta", {
                              code: item.reason.replace(
                                /^meta_(?:graph_)?/,
                                ""
                              ),
                            })
                          : t(
                              `reasons.${item.reason && readableReasons.has(item.reason) ? item.reason : "other"}`
                            )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatters.integer(item.count)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </details>
          ) : null}
          {report.truncated ? (
            <p className="text-xs text-muted-foreground">{t("truncated")}</p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
