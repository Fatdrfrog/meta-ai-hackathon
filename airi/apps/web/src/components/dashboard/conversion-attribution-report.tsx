"use client";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  ConversionAttributionReport,
  ConversionAttributionRow,
} from "@icecore/shared/types/conversion-events";
import type { AdvertisementAnalytics } from "@/types/dashboard";
import { useLocale, useTranslations } from "next-intl";
import {
  createDashboardFormatters,
  normalizeDashboardIntlLocale,
} from "./dashboard-formatters";

export function ConversionAttributionReportSection({
  report,
  error,
}: {
  report?: ConversionAttributionReport | null;
  error?: AdvertisementAnalytics["conversionAttributionError"];
}) {
  const locale = useLocale();
  const t = useTranslations("DashboardPage.advertisement.sales");
  const formatters = createDashboardFormatters(locale);
  // Recorded money retains cents; the existing overview currency formatter rounds larger values.
  const money = new Intl.NumberFormat(normalizeDashboardIntlLocale(locale), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (!report && !error) return null;

  const groups = new Map<string, ConversionAttributionRow[]>();
  for (const row of report?.rows ?? []) {
    const rows = groups.get(row.currency) ?? [];
    rows.push(row);
    groups.set(row.currency, rows);
  }
  const deliveries = report?.recentDeliveries ?? [];
  const hasUnknown = deliveries.some(
    item => item.status === "delivery_unknown"
  );

  return (
    <section className="min-w-0 space-y-4" aria-label={t("title")}>
      <div className="space-y-1">
        <h3 className="text-base font-semibold">{t("title")}</h3>
        <p className="text-sm text-muted-foreground">{t("scope")}</p>
        <p className="text-xs text-muted-foreground">{t("customerScope")}</p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(error === "date_range_too_large" ? "dateRangeError" : "error")}
        </p>
      ) : (
        <>
          {groups.size === 0 ? (
            <p className="rounded-lg bg-muted/25 p-4 text-sm text-muted-foreground">
              {t("empty")}
            </p>
          ) : null}
          {Array.from(groups, ([currency, rows]) => (
            <section
              key={currency}
              aria-label={t("currencyGroup", {
                currency: currency || t("unknownCurrency"),
              })}
              className="min-w-0 space-y-2"
            >
              <h4 className="text-sm font-medium">
                {currency || t("unknownCurrency")}
              </h4>
              <div className="min-w-0 overflow-hidden rounded-lg border">
                <Table
                  tabIndex={0}
                  aria-label={t("currencyGroup", {
                    currency: currency || t("unknownCurrency"),
                  })}
                  className="min-w-[900px]"
                >
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("adColumn")}</TableHead>
                      <TableHead className="max-w-32 whitespace-normal text-right">
                        {t("payingCustomers")}
                      </TableHead>
                      <TableHead className="max-w-28 whitespace-normal text-right">
                        {t("paidConversations")}
                      </TableHead>
                      <TableHead className="text-right">{t("sales")}</TableHead>
                      <TableHead className="text-right">
                        {t("refunds")}
                      </TableHead>
                      <TableHead className="text-right">{t("gross")}</TableHead>
                      <TableHead className="text-right">
                        {t("refunded")}
                      </TableHead>
                      <TableHead className="text-right">{t("net")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map(row => (
                      <TableRow
                        key={`${row.adId ?? ""}:${row.campaignId ?? ""}`}
                      >
                        <TableCell className="max-w-60 whitespace-normal">
                          <p className="break-words font-medium">
                            {row.adId
                              ? row.campaignName ||
                                row.campaignId ||
                                t("ad", { id: row.adId })
                              : t("unattributed")}
                          </p>
                          <p className="mt-1 break-all text-xs text-muted-foreground">
                            {row.adId
                              ? t("ad", { id: row.adId })
                              : row.campaignName || row.campaignId}
                          </p>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatters.integer(row.payingCustomers)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatters.integer(row.paidConversations)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatters.integer(row.sales)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatters.integer(row.refunds)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {money.format(row.grossRevenue)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {money.format(row.refundedRevenue)}
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {money.format(row.netRevenue)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          ))}
          {report?.truncated ? (
            <p className="text-xs text-muted-foreground">{t("truncated")}</p>
          ) : null}
          {deliveries.length > 0 ? (
            <details className="min-w-0 rounded-lg border p-3">
              <summary className="cursor-pointer rounded-sm text-sm font-medium focus-visible:outline focus-visible:outline-ring">
                {t("recent", { count: deliveries.length })}
              </summary>
              <p className="mt-3 text-xs text-muted-foreground">
                {t("deliveryScope")}
              </p>
              {hasUnknown ? (
                <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
                  {t("unknownHelp")}
                </p>
              ) : null}
              <ul className="mt-3 divide-y">
                {deliveries.map(item => (
                  <li
                    key={item.id}
                    className="flex min-w-0 flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between"
                  >
                    <div className="min-w-0 space-y-1">
                      <p className="text-sm">
                        {t(
                          item.conversionType === "refund" ? "refund" : "sale"
                        )}{" "}
                        · {item.value === null ? "—" : money.format(item.value)}{" "}
                        {item.currency || t("unknownCurrency")} ·{" "}
                        {formatters.shortDate(item.occurredAt)}
                      </p>
                      <p className="break-all text-xs text-muted-foreground">
                        {item.id}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge
                        variant={
                          item.status === "rejected"
                            ? "destructive"
                            : "secondary"
                        }
                      >
                        {t(
                          item.status === "rejected" &&
                            item.reason === "pre_dispatch_failure"
                            ? "preparationFailed"
                            : `statuses.${item.status}`
                        )}
                      </Badge>
                      {item.testMode ? (
                        <Badge variant="outline">{t("testCode")}</Badge>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}
