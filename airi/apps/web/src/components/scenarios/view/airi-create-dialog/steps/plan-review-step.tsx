"use client";

import { Badge } from "@/components/ui/badge";
import {
  Message,
  MessageAvatar,
  MessageContent,
} from "@/components/ui/message";
import { useTranslations } from "next-intl";
import { formatSourceMentionLabel } from "../shared";
import type { AiriCreateDialogStepProps } from "../use-scenario-generator-wizard";

type PlanReviewStepWizardKey =
  | "generatorSummary"
  | "readyBlueprint"
  | "assetRefs";

export function AiriCreateDialogPlanReviewStep({
  wizard,
}: AiriCreateDialogStepProps<PlanReviewStepWizardKey>) {
  const t = useTranslations("Scenarios.airiCreate");
  const { generatorSummary, readyBlueprint, assetRefs } = wizard;

  return (
    <>
      {generatorSummary ? (
        <Message from="assistant">
          <MessageAvatar name="AI" />
          <MessageContent className="max-w-[92%]">
            <div className="font-semibold">{t("plan.drafted")}</div>
            <div className="mt-1 text-muted-foreground">{generatorSummary}</div>
          </MessageContent>
        </Message>
      ) : null}

      {readyBlueprint ? (
        <Message from="assistant">
          <MessageAvatar name="AI" />
          <MessageContent className="w-full max-w-[96%]">
            <div className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold">
                    {t("plan.reviewTitle")}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t("plan.reviewHint")}
                  </div>
                </div>
                <Badge variant="secondary">
                  {readyBlueprint.sendMode === "immediate"
                    ? t("plan.immediate")
                    : t("plan.trigger")}
                </Badge>
              </div>
              <dl className="divide-y border-y text-xs">
                <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3 py-2">
                  <dt className="text-muted-foreground">
                    {t("plan.campaign")}
                  </dt>
                  <dd className="min-w-0 font-medium text-foreground">
                    {readyBlueprint.campaignName}
                  </dd>
                </div>
                <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3 py-2">
                  <dt className="text-muted-foreground">
                    {t("plan.channels")}
                  </dt>
                  <dd className="min-w-0 text-foreground">
                    {readyBlueprint.channels
                      .map(formatSourceMentionLabel)
                      .join(", ")}
                  </dd>
                </div>
                <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3 py-2">
                  <dt className="text-muted-foreground">
                    {t("plan.audience")}
                  </dt>
                  <dd className="min-w-0 text-foreground">
                    {readyBlueprint.recipientSourceSummary}
                  </dd>
                </div>
                <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3 py-2">
                  <dt className="text-muted-foreground">{t("plan.drafts")}</dt>
                  <dd className="min-w-0 text-foreground">
                    {t("plan.draftsValue", {
                      groups: readyBlueprint.cohorts.length || 1,
                      assets: assetRefs.length,
                    })}
                  </dd>
                </div>
              </dl>
            </div>
          </MessageContent>
        </Message>
      ) : null}
    </>
  );
}
