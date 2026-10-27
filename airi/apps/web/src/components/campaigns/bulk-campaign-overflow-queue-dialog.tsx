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

type Translate = (
  key: string,
  values?: Record<string, string | number | Date>
) => string;

/** Reads overflowQueue.* from the caller's namespace. */
export function BulkCampaignOverflowQueueDialog(props: {
  plan: BulkCampaignOverflowQueuePlan | null;
  t: Translate;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { plan, t } = props;
  return (
    <AlertDialog open={plan !== null} onOpenChange={props.onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("overflowQueue.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {plan
              ? t("overflowQueue.description", {
                  recipientCount: plan.recipientCount,
                  dailyLimit: plan.dailyLimit,
                  firstWaveCount: plan.firstWaveCount,
                  queuedCount: plan.queuedCount,
                  lastWaveAt: plan.lastWaveAt
                    ? new Date(plan.lastWaveAt).toLocaleString()
                    : "",
                })
              : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("overflowQueue.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={event => {
              event.preventDefault();
              props.onConfirm();
            }}
          >
            {t("overflowQueue.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
