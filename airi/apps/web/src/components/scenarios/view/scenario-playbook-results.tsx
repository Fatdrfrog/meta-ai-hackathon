"use client";

import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { ScenarioConversionReport } from "@icecore/shared/types/conversion-events";
import { ChevronDown, ChartNoAxesCombined } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";

export function ScenarioPlaybookResults({
  workspaceId,
  scenarioId,
}: {
  workspaceId: string;
  scenarioId: string;
}) {
  const t = useTranslations("Scenarios.revenuePlaybookResults");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const ownerKey = `${workspaceId}:${scenarioId}`;
  const [result, setResult] = useState<{
    ownerKey: string;
    report?: ScenarioConversionReport;
    error?: boolean;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setResult(null);
    const query = new URLSearchParams({
      workspaceId,
      report: "scenario",
      scenarioId,
      days: "30",
    });
    void (async () => {
      try {
        const response = await fetch(`/api/conversions?${query}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Report unavailable");
        const report = (await response.json()) as ScenarioConversionReport;
        if (
          report.scenarioId !== scenarioId ||
          !report.totals ||
          !Array.isArray(report.currencies)
        ) {
          throw new Error("Invalid report");
        }
        if (!controller.signal.aborted) setResult({ ownerKey, report });
      } catch {
        if (!controller.signal.aborted) setResult({ ownerKey, error: true });
      }
    })();
    return () => controller.abort();
  }, [workspaceId, scenarioId, ownerKey, open, attempt]);

  const current = result?.ownerKey === ownerKey ? result : null;
  const report = current?.report;
  const number = new Intl.NumberFormat(locale === "kz" ? "kk" : locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const empty =
    report && Object.values(report.totals).every(count => count === 0);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="min-w-0 shrink-0 border-b bg-background"
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className="h-auto w-full justify-start gap-2 rounded-none px-4 py-2 text-left"
        >
          <ChartNoAxesCombined className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 whitespace-normal">
            {t("title")}{" "}
            <span className="font-normal text-muted-foreground">
              · {t("period")}
            </span>
          </span>
          <ChevronDown
            className={`size-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="max-h-[40vh] overflow-y-auto px-4 pb-3">
        <p className="mb-3 text-xs text-muted-foreground">{t("scope")}</p>
        {!current ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t("loading")}
          </p>
        ) : null}
        {current?.error ? (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-sm text-destructive">
              {t("error")}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAttempt(value => value + 1)}
            >
              {t("retry")}
            </Button>
          </div>
        ) : null}
        {report ? (
          <div className="space-y-3">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(["sales", "bookings", "signups", "refunds"] as const).map(
                key => (
                  <div key={key}>
                    <dt className="text-xs text-muted-foreground">{t(key)}</dt>
                    <dd className="text-lg font-semibold tabular-nums">
                      {report.totals[key]}
                    </dd>
                  </div>
                )
              )}
            </dl>
            {empty ? (
              <p className="text-sm text-muted-foreground">{t("empty")}</p>
            ) : null}
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {report.currencies.map(row => (
                <section
                  key={row.currency}
                  aria-label={row.currency || t("unknownCurrency")}
                  className="min-w-0 rounded-lg border p-3"
                >
                  <h3 className="mb-2 text-sm font-semibold">
                    {row.currency || t("unknownCurrency")}
                  </h3>
                  <dl className="space-y-1 text-sm">
                    {(
                      [
                        ["gross", row.grossRevenue],
                        ["refunded", row.refundedRevenue],
                        ["net", row.netRevenue],
                      ] as const
                    ).map(([label, value]) => (
                      <div
                        key={label}
                        className="flex flex-wrap justify-between gap-x-3 gap-y-1"
                      >
                        <dt className="text-muted-foreground">{t(label)}</dt>
                        <dd className="break-all tabular-nums">
                          {number.format(value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
            {report.truncated ? (
              <p className="text-xs text-muted-foreground">{t("truncated")}</p>
            ) : null}
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}
