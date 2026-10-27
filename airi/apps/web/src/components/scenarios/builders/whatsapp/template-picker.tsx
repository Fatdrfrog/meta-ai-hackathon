"use client";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  CalendarCheck,
  ClipboardList,
  Loader2,
  Plus,
  UserPlus,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Image from "next/image";
import { useEffect, useMemo, useRef } from "react";
import type { ScenarioWhatsAppFlowOption } from "../../types";
import {
  getExistingFlowOptionKey,
  getFlowStatusBadgeKey,
} from "./existing-flow-options";
import { FLOW_TEMPLATES, type FlowTemplateId } from "./templates";

const ICON_MAP = {
  UserPlus,
  ClipboardList,
  CalendarCheck,
} as const;

export type ExistingFlow = ScenarioWhatsAppFlowOption;

type TemplatePickerProps = {
  onSelect: (templateId: FlowTemplateId) => void;
  existingFlows?: ExistingFlow[];
  existingFlowsLoading?: boolean;
  existingFlowsRefreshing?: boolean;
  selectingExistingFlowKey?: string | null;
  existingFlowSelectionError?: string | null;
  onSelectExistingFlow?: (flow: ExistingFlow) => void | Promise<void>;
  onOpenExistingFlows?: () => void;
  sourceLabelById?: ReadonlyMap<string, string>;
  constrainedFlowId?: string | null;
};

export function TemplatePicker({
  onSelect,
  existingFlows,
  existingFlowsLoading = false,
  existingFlowsRefreshing = false,
  selectingExistingFlowKey = null,
  existingFlowSelectionError = null,
  onSelectExistingFlow,
  onOpenExistingFlows,
  sourceLabelById,
  constrainedFlowId,
}: TemplatePickerProps) {
  const t = useTranslations("Scenarios");
  const normalizedConstrainedFlowId = constrainedFlowId?.trim() || null;
  const flows = useMemo(() => {
    const availableFlows = existingFlows ?? [];
    if (!normalizedConstrainedFlowId) return availableFlows;
    return availableFlows.filter(
      flow => flow.id.trim() === normalizedConstrainedFlowId
    );
  }, [existingFlows, normalizedConstrainedFlowId]);
  const duplicateFlowIds = useMemo(() => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const flow of flows) {
      const flowId = flow.id.trim();
      if (seen.has(flowId)) duplicates.add(flowId);
      seen.add(flowId);
    }
    return duplicates;
  }, [flows]);
  const isSelectingExistingFlow = selectingExistingFlowKey !== null;
  const isTemplateOwnedFlow = normalizedConstrainedFlowId !== null;
  const hasRequestedExistingFlowsRef = useRef(false);

  useEffect(() => {
    if (hasRequestedExistingFlowsRef.current) return;
    hasRequestedExistingFlowsRef.current = true;
    onOpenExistingFlows?.();
  }, [onOpenExistingFlows]);

  return (
    <div className="flex flex-col gap-3 p-3">
      {isTemplateOwnedFlow ? (
        <div className="rounded-md border bg-muted/30 px-2.5 py-2">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("flowTemplateOwnedDescription")}
          </p>
        </div>
      ) : null}

      {(existingFlowsLoading || existingFlowsRefreshing) &&
      flows.length === 0 ? (
        <div
          className="flex flex-wrap gap-1.5"
          data-testid="flow-picker-loading"
        >
          <Skeleton className="h-7 w-24 rounded-full" />
          <Skeleton className="h-7 w-20 rounded-full" />
          <span className="sr-only">{t("flowPickerExistingLoading")}</span>
        </div>
      ) : null}

      {flows.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-muted-foreground">
            {t("flowPickerExisting")}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {flows.map(flow => {
              const flowKey = getExistingFlowOptionKey(flow);
              const sourceId = flow.sourceId?.trim();
              const statusKey = getFlowStatusBadgeKey(flow.status);
              const sourceLabel = sourceId
                ? sourceLabelById?.get(sourceId)?.trim() ||
                  (duplicateFlowIds.has(flow.id.trim()) ? sourceId : null)
                : null;
              return (
                <button
                  key={flowKey}
                  type="button"
                  className={cn(
                    "inline-flex min-h-7 items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                    "hover:border-green-500/60 hover:bg-green-500/10 hover:text-green-700",
                    isSelectingExistingFlow && "cursor-not-allowed opacity-60",
                    "dark:hover:text-green-400"
                  )}
                  onClick={() => void onSelectExistingFlow?.(flow)}
                  disabled={isSelectingExistingFlow || !onSelectExistingFlow}
                  title={flow.id}
                >
                  {selectingExistingFlowKey === flowKey ? (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  ) : (
                    <Image
                      src="/whatsapp.svg"
                      alt=""
                      width={12}
                      height={12}
                      className="h-3 w-3 object-contain"
                    />
                  )}
                  <span>{flow.name?.trim() || t("untitledForm")}</span>
                  {sourceLabel ? (
                    <span className="font-normal text-muted-foreground">
                      {sourceLabel}
                    </span>
                  ) : null}
                  {statusKey ? (
                    <Badge
                      variant="secondary"
                      className="ml-0.5 h-3.5 px-1 text-[9px] font-normal"
                    >
                      {t(statusKey)}
                    </Badge>
                  ) : null}
                </button>
              );
            })}
          </div>
          {existingFlowSelectionError ? (
            <p className="text-[11px] text-destructive">
              {existingFlowSelectionError}
            </p>
          ) : null}
        </div>
      )}

      {isTemplateOwnedFlow &&
      flows.length === 0 &&
      !existingFlowsLoading &&
      !existingFlowsRefreshing ? (
        <p className="text-[11px] text-muted-foreground">
          {t("flowTemplateOwnedUnavailable")}
        </p>
      ) : null}

      {!isTemplateOwnedFlow ? (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-muted-foreground">
            {flows.length > 0
              ? t("flowPickerCreateNew")
              : t("flowPickerDescription")}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {FLOW_TEMPLATES.map(template => {
              const Icon = ICON_MAP[template.icon];
              return (
                <button
                  key={template.id}
                  type="button"
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                    "hover:border-green-500/60 hover:bg-green-500/10 hover:text-green-700",
                    isSelectingExistingFlow && "cursor-not-allowed opacity-60",
                    "dark:hover:text-green-400"
                  )}
                  onClick={() => onSelect(template.id)}
                  disabled={isSelectingExistingFlow}
                >
                  <Plus className="h-3 w-3 opacity-50" aria-hidden />
                  <Icon className="h-3 w-3 text-green-600" aria-hidden />
                  {t(template.titleKey)}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
