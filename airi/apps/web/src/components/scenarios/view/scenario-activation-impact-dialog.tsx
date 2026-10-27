"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ScenarioActivationImpact } from "./scenario-activation-impact";
import {
  getScenarioIssueSoftTone,
  ScenarioIssueIcon,
} from "./scenario-issue-visuals";

type ScenarioActivationImpactDialogProps = {
  open: boolean;
  impact: ScenarioActivationImpact | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  /** Closes the dialog and selects the block on the canvas. */
  onShowBlock?: (nodeId: string) => void;
};

export function ScenarioActivationImpactDialog({
  open,
  impact,
  onOpenChange,
  onConfirm,
  onShowBlock,
}: ScenarioActivationImpactDialogProps) {
  const t = useTranslations("Scenarios");
  // A listed error is one the server would refuse; don't offer the button.
  const hasBlockingIssue = Boolean(
    impact?.issues.some(issue => issue.severity === "error")
  );

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("activationImpactTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("activationImpactDescription", {
              name: impact?.scenarioName || "",
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {impact ? (
          <ScrollArea className="max-h-[60vh]">
            <div className="space-y-4 pr-2">
              <div className="rounded-lg border bg-muted/20 p-3">
                <div className="text-xs font-medium uppercase text-muted-foreground">
                  {t("activationImpactSummaryTitle")}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {impact.summaryChips.length > 0 ? (
                    impact.summaryChips.map(chip => (
                      <Badge
                        key={`${impact.scenarioId}-${chip}`}
                        variant="secondary"
                        className="text-[10px]"
                      >
                        {chip}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      {t("activationImpactSummaryEmpty")}
                    </span>
                  )}
                </div>
              </div>

              <div className="rounded-lg border bg-background p-3">
                <div className="text-xs font-medium uppercase text-muted-foreground">
                  {t("activationImpactJourneyTitle")}
                </div>
                <div className="mt-2 text-sm">{impact.journeyDescription}</div>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium uppercase text-muted-foreground">
                  {t("activationImpactRisksTitle")}
                </div>
                {impact.pendingChecks ? (
                  <div
                    role="status"
                    className="flex items-center gap-2 rounded-lg border p-3 text-sm text-muted-foreground"
                  >
                    <Loader2
                      aria-hidden
                      className="h-4 w-4 shrink-0 animate-spin"
                    />
                    {t("activationImpactTemplateFlowChecking")}
                  </div>
                ) : null}
                {impact.issues.length > 0 ? (
                  impact.issues.map(issue => (
                    <div
                      key={issue.id}
                      className={cn(
                        "flex items-start gap-2 rounded-lg border p-3",
                        getScenarioIssueSoftTone(issue.severity)
                      )}
                    >
                      <ScenarioIssueIcon
                        severity={issue.severity}
                        className="mt-0.5 h-4 w-4 shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium">{issue.title}</div>
                        <div className="text-xs text-muted-foreground">
                          {issue.description}
                        </div>
                        {issue.block ? (
                          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                            <span className="font-medium">
                              {issue.block.label}
                            </span>
                            {onShowBlock ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={() => onShowBlock(issue.block!.nodeId)}
                              >
                                {t("activationImpactShowBlock")}
                              </Button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ))
                ) : impact.pendingChecks ? null : (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-3 text-sm text-emerald-800">
                    {t("activationImpactNoRisks")}
                  </div>
                )}
              </div>
            </div>
          </ScrollArea>
        ) : null}

        {hasBlockingIssue ? (
          <p className="text-sm text-muted-foreground" role="status">
            {t("activationImpactFixFirst")}
          </p>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={hasBlockingIssue}>
            {t("activationImpactActivate")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
