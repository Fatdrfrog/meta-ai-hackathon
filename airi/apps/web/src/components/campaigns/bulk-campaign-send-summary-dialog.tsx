"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { BulkCampaignOverflowQueuePlan } from "@/lib/campaign/bulk-campaign-overflow-queue";
import type { BulkCampaignSkipReason } from "@icecore/scenario-contracts";
import { useLayoutEffect, useRef } from "react";
import { BulkCampaignSkipList } from "./bulk-campaign-outcome-summary";

type Translate = (
  key: string,
  values?: Record<string, string | number | Date>
) => string;

/** What a send will do, shown once more before it goes out. */
export type BulkCampaignSendSummary = {
  /** Template name, or the translated kind of message. */
  message: string;
  /** The WhatsApp number or email sender, when one is chosen. */
  sender?: string | null;
  recipientCount: number;
  skippedByReason?: Partial<Record<BulkCampaignSkipReason, number>>;
  /** Present when the send runs over the daily limit. */
  overflowPlan?: BulkCampaignOverflowQueuePlan | null;
};

/** Reads sendSummary.* and outcome.* from the caller's namespace. */
export function BulkCampaignSendSummaryDialog(props: {
  summary: BulkCampaignSendSummary | null;
  t: Translate;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  /**
   * Where focus goes on close. Send is disabled while the form validates,
   * so the element focused at open time is often <body>.
   */
  returnFocusTo?: () => HTMLElement | null;
}) {
  const { summary, t } = props;
  const overflowPlan = summary?.overflowPlan?.exceedsDailyLimit
    ? summary.overflowPlan
    : null;
  const hasSkipped = Object.values(summary?.skippedByReason ?? {}).some(
    count => (count ?? 0) > 0
  );
  // Send opens this without a dialog trigger, so Radix would drop focus to
  // <body> on close. Remember the opener and return focus to it.
  const open = summary !== null;
  const openerRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    openerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  }, [open]);
  return (
    <AlertDialog open={open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent
        onCloseAutoFocus={event => {
          const target = props.returnFocusTo?.() ?? openerRef.current;
          if (!target?.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{t("sendSummary.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("sendSummary.description")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {summary ? (
          <div className="grid min-w-0 gap-3 text-sm">
            <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
              <dt className="text-muted-foreground">
                {t("sendSummary.message")}
              </dt>
              <dd className="min-w-0 break-words font-medium">
                {summary.message}
              </dd>
              {summary.sender ? (
                <>
                  <dt className="text-muted-foreground">
                    {t("sendSummary.sender")}
                  </dt>
                  <dd className="min-w-0 break-words font-medium">
                    {summary.sender}
                  </dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">
                {t("sendSummary.recipients")}
              </dt>
              <dd
                data-testid="bulk-campaign-send-summary-recipients"
                className="min-w-0 font-medium tabular-nums"
              >
                {t("sendSummary.recipientCount", {
                  count: summary.recipientCount,
                })}
              </dd>
            </dl>
            {hasSkipped ? (
              <div
                data-testid="bulk-campaign-send-summary-skipped"
                className="grid gap-1.5 rounded-md bg-muted/40 px-3 py-2"
              >
                <p className="text-muted-foreground">
                  {t("sendSummary.skipped")}
                </p>
                <BulkCampaignSkipList
                  skippedByReason={summary.skippedByReason ?? {}}
                  t={t}
                />
              </div>
            ) : null}
            {overflowPlan ? (
              <p className="rounded-md bg-muted/40 px-3 py-2">
                {t("sendSummary.overflow", {
                  dailyLimit: overflowPlan.dailyLimit,
                  firstWaveCount: overflowPlan.firstWaveCount,
                  queuedCount: overflowPlan.queuedCount,
                  lastWaveAt: overflowPlan.lastWaveAt
                    ? new Date(overflowPlan.lastWaveAt).toLocaleString()
                    : "",
                })}
              </p>
            ) : null}
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("sendSummary.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={event => {
              event.preventDefault();
              props.onConfirm();
            }}
          >
            {t("sendSummary.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
