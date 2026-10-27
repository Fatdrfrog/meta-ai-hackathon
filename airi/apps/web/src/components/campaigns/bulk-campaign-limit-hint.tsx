"use client";

import { PlanUpgradeDialog } from "@/components/billing/plan-upgrade-dialog";
import { Button } from "@/components/ui/button";
import type { CompanyLimitStatus } from "@/hooks/use-company-limits";
import { cn } from "@/lib/utils";
import { AlertCircle } from "lucide-react";
import { useState } from "react";

type Translate = (
  key: string,
  values?: Record<string, string | number | Date>
) => string;

type BulkCampaignLimit =
  | (Pick<
      CompanyLimitStatus,
      | "subscriptionType"
      | "bulkRecipientLimit"
      | "bulkRecipientCount"
      | "bulkRecipientsRemaining"
    > &
      Partial<Pick<CompanyLimitStatus, "trialExpired">>)
  | null
  | undefined;

type BulkCampaignLimitHintProps = {
  limit: BulkCampaignLimit;
  t: Translate;
  compact?: boolean;
  className?: string;
  /** Shows an upgrade button once the allowance is used up. */
  workspaceId?: string | null;
  /** Lets Send point at the hint as the reason it is disabled. */
  id?: string;
  /** Recipients in the audience, to say when only the first ones will send. */
  recipientCount?: number;
};

export function getBulkCampaignLimitText(
  limit: BulkCampaignLimitHintProps["limit"],
  t: Translate,
  recipientCount = 0
): string | null {
  if (!limit) return null;

  if (
    limit.subscriptionType !== "free" ||
    limit.bulkRecipientLimit === null ||
    limit.bulkRecipientsRemaining === null
  ) {
    return null;
  }

  const remaining = limit.bulkRecipientsRemaining;
  const values = {
    remaining,
    limit: limit.bulkRecipientLimit,
    used: limit.bulkRecipientCount ?? 0,
    count: recipientCount,
  };

  if (remaining <= 0) return t("bulkLimit.freeExhausted", values);
  return recipientCount > remaining
    ? t("bulkLimit.freeTrimmed", values)
    : t("bulkLimit.freeRemaining", values);
}

/** Opens the plan dialog; copy is `bulkLimit.upgrade` in the caller's `t`. */
export function BulkCampaignUpgradeButton({
  workspaceId,
  limit,
  t,
  compact = false,
  className,
  label,
}: {
  workspaceId: string;
  limit:
    | {
        subscriptionType?: "free" | "pro" | "enterprise";
        trialExpired?: boolean;
      }
    | null
    | undefined;
  t: Translate;
  compact?: boolean;
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className={cn(
          "shrink-0",
          compact ? "h-7 px-2 text-[11px]" : "h-8",
          className
        )}
        onClick={() => setOpen(true)}
      >
        {label ?? t("bulkLimit.upgrade")}
      </Button>
      <PlanUpgradeDialog
        workspaceId={workspaceId}
        subscriptionType={limit?.subscriptionType}
        open={open}
        onOpenChange={setOpen}
        reason={limit?.trialExpired ? "trial_expired" : undefined}
      />
    </>
  );
}

export function BulkCampaignLimitHint({
  limit,
  t,
  compact = false,
  className,
  workspaceId,
  id,
  recipientCount = 0,
}: BulkCampaignLimitHintProps) {
  const text = getBulkCampaignLimitText(limit, t, recipientCount);

  if (!text) return null;
  const remaining = limit?.bulkRecipientsRemaining ?? 0;
  const exhausted = remaining <= 0;
  // Free plans send only the first recipients that fit; say so as loudly as
  // a used-up allowance, without blocking Send.
  const trimmed = !exhausted && recipientCount > remaining;
  const prominent = exhausted || trimmed;

  return (
    <div
      id={id}
      role={exhausted ? "alert" : trimmed ? "status" : undefined}
      className={cn(
        "flex min-w-0 items-start gap-2",
        prominent
          ? "flex-wrap rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100"
          : "text-muted-foreground",
        compact ? "text-[11px] leading-snug" : "text-xs leading-5",
        className
      )}
    >
      {prominent ? (
        <AlertCircle
          className={cn("mt-0.5 shrink-0", compact ? "h-3.5 w-3.5" : "h-4 w-4")}
          aria-hidden="true"
        />
      ) : null}
      <span className="min-w-0 flex-1">{text}</span>
      {prominent && workspaceId ? (
        <BulkCampaignUpgradeButton
          workspaceId={workspaceId}
          limit={limit}
          t={t}
          compact={compact}
        />
      ) : null}
    </div>
  );
}
