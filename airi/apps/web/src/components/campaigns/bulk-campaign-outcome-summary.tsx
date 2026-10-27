"use client";

import type {
  BulkCampaignCommandResult,
  BulkCampaignSkipReason,
} from "@icecore/scenario-contracts";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

const SKIP_REASON_LABEL_KEYS = {
  marketing_opt_out: "outcome.marketingOptOut",
  recipient_limit: "outcome.recipientLimit",
  prior_failure: "outcome.priorFailure",
  ineligible: "outcome.ineligible",
  service_window: "outcome.serviceWindow",
  unsubscribed: "outcome.unsubscribed",
  recent_contact: "outcome.recentContact",
} as const satisfies Record<BulkCampaignSkipReason, string>;

const SKIP_REASON_ORDER = [
  "marketing_opt_out",
  "recent_contact",
  "recipient_limit",
  "prior_failure",
  "ineligible",
  "service_window",
  "unsubscribed",
] as const satisfies readonly BulkCampaignSkipReason[];

type Translate = (
  key: string,
  values?: Record<string, string | number | Date>
) => string;

export type BulkCampaignOutcomeSummaryProps = {
  result: BulkCampaignCommandResult;
  t?: Translate;
  className?: string;
};

export function BulkCampaignOutcomeSummary({
  result,
  t: tProp,
  className,
}: BulkCampaignOutcomeSummaryProps) {
  const defaultT = useTranslations("MultiChannelCampaignBuilder");
  const t = tProp || defaultT;
  const outcome = result.ok ? result.outcome : result.partialOutcome;
  if (!outcome) return null;
  return (
    <BulkCampaignSkipList
      data-testid="bulk-campaign-outcome-summary"
      skippedByReason={outcome.skippedByReason}
      missingConsent={outcome.warnings.missingMarketingConsent}
      title={t("outcome.skippedTitle")}
      t={t}
      className={className}
    />
  );
}

/**
 * Recipients left out of a send, by reason, from a send result or an
 * eligibility preview. Renders nothing when nobody is left out. A caller with
 * its own heading leaves out `title`.
 */
export function BulkCampaignSkipList({
  skippedByReason,
  missingConsent = 0,
  title,
  t,
  className,
  "data-testid": testId,
}: {
  skippedByReason: Partial<Record<BulkCampaignSkipReason, number>>;
  missingConsent?: number;
  title?: string;
  t: Translate;
  className?: string;
  "data-testid"?: string;
}) {
  const skippedReasons = SKIP_REASON_ORDER.filter(
    reason => (skippedByReason[reason] || 0) > 0
  );
  if (skippedReasons.length === 0 && missingConsent === 0) return null;

  // Skip reasons count recipients left out of the send; missing consent is a
  // warning only, so it sits apart instead of reading as another skip.
  return (
    <div data-testid={testId} className={cn("space-y-1 text-sm", className)}>
      {title && skippedReasons.length > 0 ? (
        <div className="text-muted-foreground">{title}</div>
      ) : null}
      <ul className="space-y-1">
        {skippedReasons.map(reason => (
          <li
            key={reason}
            className="flex min-w-0 items-baseline justify-between gap-3"
          >
            <span className="min-w-0 break-words">
              {t(SKIP_REASON_LABEL_KEYS[reason])}
            </span>
            <span className="shrink-0 font-medium tabular-nums">
              {skippedByReason[reason] || 0}
            </span>
          </li>
        ))}
        {missingConsent > 0 ? (
          <li
            className={cn(
              "flex min-w-0 items-baseline justify-between gap-3",
              skippedReasons.length > 0 && "border-t pt-1"
            )}
          >
            <span className="min-w-0 break-words">
              {t("outcome.missingMarketingConsent")}
            </span>
            <span className="shrink-0 font-medium">{missingConsent}</span>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
