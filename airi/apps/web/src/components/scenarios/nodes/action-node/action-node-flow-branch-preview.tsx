"use client";

import { cn } from "@/lib/utils";
import {
  buildFlowBranchOptionKey,
  buildFlowBranchSourceHandleId,
} from "@icecore/scenario-contracts";
import { ListChecks } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { FlowBranchOptionHandleRenderParams } from "../../builders/whatsapp/field-editor";
import type { FlowBranchOption } from "@/lib/scenarios/whatsapp-flow-branches";

export function FlowBranchPreview({
  connectedBranchIds,
  options,
  renderFlowBranchHandle,
}: {
  connectedBranchIds?: readonly string[];
  options: FlowBranchOption[];
  /** Canvas only. */
  renderFlowBranchHandle?: (
    params: FlowBranchOptionHandleRenderParams
  ) => ReactNode;
}) {
  const t = useTranslations("Scenarios");
  const connected = new Set(connectedBranchIds ?? []);

  return (
    <div
      className="mt-2 space-y-1 rounded-md border border-emerald-100/70 bg-emerald-50/15 p-1 transition-colors hover:bg-emerald-50/40 dark:border-emerald-900/45 dark:bg-emerald-950/10 dark:hover:bg-emerald-950/20"
      data-testid="flow-branch-preview"
    >
      <p className="flex items-center gap-1.5 px-1.5 pt-0.5 text-[10px] font-medium text-muted-foreground">
        <ListChecks className="size-3 shrink-0" aria-hidden />
        {t("flowBranchPreviewTitle")}
      </p>
      {options.map(option => {
        const branchId = buildFlowBranchOptionKey(
          option.fieldId,
          option.optionId
        );
        const optionTitle = option.optionTitle.trim() || t("untitledOption");

        return (
          <div
            key={branchId}
            className={cn(
              "relative flex min-w-0 items-center gap-1.5 overflow-visible rounded-md border border-transparent px-1.5 py-1 transition-colors hover:border-emerald-100/80 hover:bg-background/80 dark:hover:border-emerald-900/50 dark:hover:bg-background/10",
              connected.has(branchId)
                ? "border-emerald-200/70 bg-emerald-50/60 dark:border-emerald-800/50 dark:bg-emerald-950/30"
                : "bg-transparent"
            )}
          >
            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-400/80" />
            <span
              className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground"
              title={optionTitle}
            >
              {optionTitle}
            </span>
            {renderFlowBranchHandle?.({
              fieldId: option.fieldId,
              optionId: option.optionId,
              optionTitle,
              branchId,
              handleId: buildFlowBranchSourceHandleId(
                option.fieldId,
                option.optionId
              ),
            })}
          </div>
        );
      })}
    </div>
  );
}
