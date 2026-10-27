"use client";

import { Input } from "@/components/ui/input";
import { ScenarioStatusSwitch } from "./scenario-status-switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useSyncedDraftValue } from "@/components/scenarios/nodes/draft-state";
import { MAX_SCENARIO_NAME_LENGTH } from "@icecore/scenario-contracts";
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  GripVertical,
  LayoutGrid,
  Loader2,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, useRef, useState, type ButtonHTMLAttributes } from "react";
import type {
  ScenarioRoutingSettingsPatch,
  ScenarioSummary,
} from "../../types";
import { ScenarioSettingsPopover } from "../scenario-settings-popover";
import type { ScenarioHierarchyIssueSummary } from "./utils";

type ScenarioHierarchyRowProps = {
  scenario: ScenarioSummary;
  density?: "comfortable" | "compact";
  marginTopPx: number;
  depthPadding: number;
  isActive: boolean;
  isSelectionPending?: boolean;
  isDragging: boolean;
  handleProps: ButtonHTMLAttributes<HTMLButtonElement>;
  isInteractionDisabled: boolean;
  isDragDisabled: boolean;
  activeLabel: string;
  draftLabel: string;
  canToggleStatus: boolean;
  isSavingSettings: boolean;
  subscenarioIndicator?: string;
  issueSummary?: ScenarioHierarchyIssueSummary;
  canToggleChildren?: boolean;
  isCollapsed?: boolean;
  onToggleChildren?: () => void;
  nextScenarioIsDirectChild: boolean;
  showNormalizeLayoutButton: boolean;
  normalizeScenarioLayoutDisabled: boolean;
  onSelectScenario: (scenarioId: string) => void;
  /** Pointer or focus reached the scenario: it may open next. */
  onPrefetchScenario?: (scenarioId: string) => void;
  /** Pointer or focus left the scenario again. */
  onCancelScenarioPrefetch?: (scenarioId: string) => void;
  onScenarioNameCommit: (scenarioId: string, value: string) => Promise<boolean>;
  onStatusToggle: (scenarioId: string, checked: boolean) => void;
  onScenarioRoutingSettingsChange?: (
    scenarioId: string,
    patch: ScenarioRoutingSettingsPatch
  ) => Promise<boolean> | boolean;
  onDeleteScenario?: (scenarioId: string) => void;
  onNormalizeScenarioLayout?: () => void;
};

const ScenarioChainConnector = memo(function ScenarioChainConnector({
  isCompact,
  label,
}: {
  isCompact: boolean;
  label: string;
}) {
  return (
    <div
      className={cn(
        "pointer-events-none flex items-center gap-1.5",
        isCompact ? "mt-1 px-1" : "mt-1.5 px-2"
      )}
      aria-hidden
    >
      <div className="h-px flex-1 bg-border/70" />
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/30 font-medium text-muted-foreground",
          isCompact ? "px-1 py-0.5" : "px-2 py-0.5 text-[10px]"
        )}
      >
        {isCompact ? null : label}
        <ArrowRight className="h-2.5 w-2.5" />
      </span>
      <div className="h-px flex-1 bg-border/70" />
    </div>
  );
});

const ScenarioHierarchyDragHandle = memo(function ScenarioHierarchyDragHandle({
  handleProps,
  isCompact,
  isDisabled,
  ariaLabel,
}: {
  handleProps: ButtonHTMLAttributes<HTMLButtonElement>;
  isCompact: boolean;
  isDisabled: boolean;
  ariaLabel: string;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center border-r bg-muted/30 py-0.5",
        isCompact ? "px-0" : "px-0.5"
      )}
    >
      <button
        type="button"
        {...handleProps}
        onClick={event => {
          event.stopPropagation();
        }}
        className={cn(
          "rounded-md p-0.5 text-muted-foreground",
          isDisabled ? "cursor-not-allowed opacity-50" : "cursor-grab"
        )}
        aria-label={ariaLabel}
        disabled={isDisabled}
      >
        <GripVertical className={isCompact ? "h-3 w-3" : "h-3.5 w-3.5"} />
      </button>
    </div>
  );
});

const ScenarioHierarchyStatus = memo(function ScenarioHierarchyStatus({
  isCompact,
  status,
  activeLabel,
  draftLabel,
}: {
  isCompact: boolean;
  status: ScenarioSummary["status"];
  activeLabel: string;
  draftLabel: string;
}) {
  const isActive = status === "active";

  return (
    <span
      title={isActive ? activeLabel : draftLabel}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1 rounded-full text-[9px] font-medium",
        isCompact ? "h-4 w-4 px-0" : "px-1.5 py-0.5",
        isActive
          ? "bg-emerald-50 text-emerald-700"
          : "bg-muted/60 text-muted-foreground"
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          isActive ? "bg-emerald-500" : "bg-muted-foreground/60"
        )}
      />
      {isCompact ? null : isActive ? activeLabel : draftLabel}
    </span>
  );
});

const ScenarioHierarchyRowActions = memo(function ScenarioHierarchyRowActions({
  scenario,
  activeLabel,
  draftLabel,
  canToggleStatus,
  isCompact,
  isInteractionDisabled,
  isSavingSettings,
  onStatusToggle,
  onScenarioRoutingSettingsChange,
  onDeleteScenario,
  showNormalizeLayoutButton,
  normalizeScenarioLayoutDisabled,
  onNormalizeScenarioLayout,
}: {
  scenario: ScenarioSummary;
  activeLabel: string;
  draftLabel: string;
  canToggleStatus: boolean;
  isCompact: boolean;
  isInteractionDisabled: boolean;
  isSavingSettings: boolean;
  onStatusToggle: (scenarioId: string, checked: boolean) => void;
  onScenarioRoutingSettingsChange?: (
    scenarioId: string,
    patch: ScenarioRoutingSettingsPatch
  ) => Promise<boolean> | boolean;
  onDeleteScenario?: (scenarioId: string) => void;
  showNormalizeLayoutButton: boolean;
  normalizeScenarioLayoutDisabled: boolean;
  onNormalizeScenarioLayout?: () => void;
}) {
  const t = useTranslations("Scenarios");

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1",
        isCompact ? "px-0.5 py-1" : "px-1.5 py-1.5"
      )}
    >
      <div
        className={cn(
          "inline-flex items-center gap-0.5 rounded-md",
          isCompact
            ? "bg-transparent p-0"
            : "border bg-background/80 p-0.5 shadow-sm"
        )}
      >
        {showNormalizeLayoutButton && onNormalizeScenarioLayout ? (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={event => {
                    event.stopPropagation();
                    onNormalizeScenarioLayout();
                  }}
                  disabled={
                    isInteractionDisabled || normalizeScenarioLayoutDisabled
                  }
                  className={cn(
                    "rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50",
                    isCompact ? "p-0.5" : "p-1"
                  )}
                  aria-label={t("normalizeLayoutTooltip")}
                >
                  <LayoutGrid className="h-3 w-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-[240px] text-xs">
                {t("normalizeLayoutTooltip")}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
        {scenario.mode !== "bulk_campaign" &&
        onScenarioRoutingSettingsChange ? (
          <ScenarioSettingsPopover
            scenario={scenario}
            disabled={isInteractionDisabled || isSavingSettings}
            triggerClassName={isCompact ? "h-6 w-6 p-0.5" : "h-7 w-7 p-1"}
            onSettingsChange={onScenarioRoutingSettingsChange}
          />
        ) : null}
        <div className={cn("flex items-center", isCompact ? "px-0" : "px-1")}>
          <ScenarioStatusSwitch
            scenarioId={scenario._id}
            status={scenario.status}
            activeLabel={activeLabel}
            draftLabel={draftLabel}
            onStatusToggle={onStatusToggle}
            disabled={
              !canToggleStatus || isInteractionDisabled || isSavingSettings
            }
            compact={isCompact}
          />
        </div>
        {isSavingSettings ? (
          <span
            className={cn(
              "flex items-center text-muted-foreground",
              isCompact ? "h-6 px-0.5" : "h-7 px-1"
            )}
          >
            <Loader2 className="h-3 w-3 animate-spin" />
          </span>
        ) : null}
        {onDeleteScenario ? (
          <button
            type="button"
            onClick={event => {
              event.stopPropagation();
              onDeleteScenario(scenario._id);
            }}
            disabled={isInteractionDisabled}
            className={cn(
              "rounded-md text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-50",
              isCompact ? "p-0.5" : "p-1"
            )}
            aria-label={t("delete")}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        ) : null}
      </div>
    </div>
  );
});

const ScenarioHierarchyIssueBadge = memo(function ScenarioHierarchyIssueBadge({
  summary,
}: {
  summary: ScenarioHierarchyIssueSummary;
}) {
  const t = useTranslations("Scenarios");

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={
              "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[9px] font-semibold"
            }
            aria-label={t("issueBadgeAria")}
          >
            <AlertTriangle className="mr-0.5 h-2.5 w-2.5" />
            {summary.count}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-[240px] text-xs">
          {summary.tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});

export const ScenarioHierarchyRow = memo(function ScenarioHierarchyRow({
  scenario,
  density = "comfortable",
  marginTopPx,
  depthPadding,
  isActive,
  isSelectionPending = false,
  isDragging,
  handleProps,
  isInteractionDisabled,
  isDragDisabled,
  activeLabel,
  draftLabel,
  canToggleStatus,
  isSavingSettings,
  subscenarioIndicator,
  issueSummary,
  canToggleChildren = false,
  isCollapsed = false,
  onToggleChildren,
  nextScenarioIsDirectChild,
  showNormalizeLayoutButton,
  normalizeScenarioLayoutDisabled,
  onSelectScenario,
  onPrefetchScenario,
  onCancelScenarioPrefetch,
  onScenarioNameCommit,
  onStatusToggle,
  onScenarioRoutingSettingsChange,
  onDeleteScenario,
  onNormalizeScenarioLayout,
}: ScenarioHierarchyRowProps) {
  const t = useTranslations("Scenarios");
  const prefetchScenario = () => {
    if (!isInteractionDisabled) onPrefetchScenario?.(scenario._id);
  };
  const cancelScenarioPrefetch = () => onCancelScenarioPrefetch?.(scenario._id);
  const [showNameTitle, setShowNameTitle] = useState(false);
  const [draftName, setDraftName] = useSyncedDraftValue(scenario.name);
  const [pendingNameSaves, setPendingNameSaves] = useState(0);
  const inFlightNamesRef = useRef(new Set<string>());
  const skipNextBlurCommitRef = useRef(false);
  const isCompact = density === "compact";

  const commitDraftName = async () => {
    if (
      draftName === scenario.name ||
      inFlightNamesRef.current.has(draftName)
    ) {
      return;
    }
    const requestedName = draftName;
    inFlightNamesRef.current.add(requestedName);
    setPendingNameSaves(current => current + 1);
    try {
      await onScenarioNameCommit(scenario._id, requestedName);
    } finally {
      inFlightNamesRef.current.delete(requestedName);
      setPendingNameSaves(current => Math.max(0, current - 1));
    }
  };

  return (
    <div
      className="relative"
      style={{
        marginTop: `${marginTopPx}px`,
        paddingLeft: `${depthPadding}px`,
      }}
    >
      <div
        className={cn(
          "relative z-10 flex overflow-hidden border bg-background/80 shadow-sm transition-[box-shadow,border-color,ring] duration-150",
          isCompact ? "rounded-lg" : "rounded-xl",
          isActive
            ? "border-primary/60 ring-1 ring-primary/20"
            : "hover:border-primary/40",
          isDragging ? "opacity-75 shadow-md" : ""
        )}
      >
        <ScenarioHierarchyDragHandle
          handleProps={handleProps}
          isCompact={isCompact}
          isDisabled={isDragDisabled}
          ariaLabel={t("dragScenario", {
            name: scenario.name,
          })}
        />

        <div
          role="button"
          tabIndex={isInteractionDisabled ? -1 : 0}
          aria-pressed={isActive}
          aria-busy={isSelectionPending}
          onPointerEnter={prefetchScenario}
          onFocus={prefetchScenario}
          onPointerLeave={cancelScenarioPrefetch}
          onBlur={cancelScenarioPrefetch}
          onClick={() => {
            if (isInteractionDisabled) return;
            onSelectScenario(scenario._id);
          }}
          onKeyDown={event => {
            if (event.target !== event.currentTarget) return;
            if (isInteractionDisabled) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onSelectScenario(scenario._id);
          }}
          className={cn(
            "min-w-0 flex-1 overflow-hidden text-left",
            isCompact ? "px-1.5 py-1" : "px-2 py-1.5"
          )}
        >
          <div
            className={cn(
              "flex min-w-0 items-center",
              isCompact ? "gap-1" : "gap-1.5"
            )}
          >
            <div
              className={cn(
                "flex shrink-0 items-center justify-center",
                isCompact ? "h-4 w-4" : "h-5 w-5"
              )}
            >
              {isSelectionPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : canToggleChildren && onToggleChildren ? (
                <button
                  type="button"
                  onClick={event => {
                    event.stopPropagation();
                    onToggleChildren();
                  }}
                  className="rounded-md p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  title={t("journeyChildrenToggle")}
                  aria-label={t("journeyChildrenToggle")}
                >
                  {isCollapsed ? (
                    <ChevronRight
                      className={isCompact ? "h-3 w-3" : "h-3.5 w-3.5"}
                    />
                  ) : (
                    <ChevronDown
                      className={isCompact ? "h-3 w-3" : "h-3.5 w-3.5"}
                    />
                  )}
                </button>
              ) : null}
            </div>
            <Input
              value={draftName}
              maxLength={MAX_SCENARIO_NAME_LENGTH}
              disabled={isInteractionDisabled}
              aria-busy={pendingNameSaves > 0}
              title={showNameTitle ? draftName : undefined}
              onClick={event => {
                event.stopPropagation();
                if (isInteractionDisabled) return;
                onSelectScenario(scenario._id);
              }}
              onFocus={event => {
                event.stopPropagation();
                setShowNameTitle(false);
                if (isInteractionDisabled) return;
                onSelectScenario(scenario._id);
              }}
              onMouseEnter={event => {
                const input = event.currentTarget;
                setShowNameTitle(input.scrollWidth > input.clientWidth + 1);
              }}
              onMouseLeave={() => {
                setShowNameTitle(false);
              }}
              onChange={event => {
                setDraftName(event.target.value);
              }}
              onBlur={() => {
                if (skipNextBlurCommitRef.current) {
                  skipNextBlurCommitRef.current = false;
                  return;
                }
                void commitDraftName();
              }}
              onKeyDown={event => {
                event.stopPropagation();
                if (event.key === "Escape") {
                  event.preventDefault();
                  skipNextBlurCommitRef.current = true;
                  setDraftName(scenario.name);
                  event.currentTarget.blur();
                  return;
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
              placeholder={t("scenarioNamePlaceholder")}
              className={cn(
                "min-w-0 border-transparent bg-transparent px-0 font-medium shadow-none focus-visible:border-none focus-visible:ring-0",
                isCompact ? "h-6 text-xs" : "h-6 text-[13px]"
              )}
            />
            {pendingNameSaves > 0 ? (
              <Loader2
                className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"
                aria-label={t("saving")}
              />
            ) : null}
            <div className="flex shrink-0 items-center gap-1">
              {issueSummary ? (
                <ScenarioHierarchyIssueBadge summary={issueSummary} />
              ) : null}
              <ScenarioHierarchyStatus
                isCompact={isCompact}
                status={scenario.status}
                activeLabel={activeLabel}
                draftLabel={draftLabel}
              />
            </div>
          </div>
          {subscenarioIndicator ? (
            <p
              className={cn(
                "mt-0.5 truncate text-[10px] text-muted-foreground",
                isCompact ? "pl-5" : "pl-6"
              )}
            >
              {subscenarioIndicator}
            </p>
          ) : null}
        </div>

        <ScenarioHierarchyRowActions
          scenario={scenario}
          activeLabel={activeLabel}
          draftLabel={draftLabel}
          canToggleStatus={canToggleStatus}
          isCompact={isCompact}
          isInteractionDisabled={isInteractionDisabled}
          isSavingSettings={isSavingSettings}
          onStatusToggle={onStatusToggle}
          onScenarioRoutingSettingsChange={onScenarioRoutingSettingsChange}
          onDeleteScenario={onDeleteScenario}
          showNormalizeLayoutButton={showNormalizeLayoutButton}
          normalizeScenarioLayoutDisabled={normalizeScenarioLayoutDisabled}
          onNormalizeScenarioLayout={onNormalizeScenarioLayout}
        />
      </div>

      {nextScenarioIsDirectChild ? (
        <ScenarioChainConnector
          isCompact={isCompact}
          label={t("linkedScenarioConnectorLabel")}
        />
      ) : null}
    </div>
  );
});
