"use client";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Check,
  CircleCheck,
  Hand,
  Loader2,
  MousePointer2,
  Play,
  Plus,
  ScrollText,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { ScenarioTemplateDraftStatus } from "../view/editor-drafts";
import type { ScenarioCanvasInteractionMode } from "../view/scenario-canvas-interaction-mode";
import type { ScenarioAutomationHeaderActions } from "./use-scenario-view-signals";

type ScenarioToolbarIconButtonProps = {
  active?: boolean;
  disabled?: boolean;
  isToggle?: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
};

function ScenarioToolbarIconButton({
  active = false,
  disabled = false,
  isToggle = false,
  label,
  onClick,
  children,
}: ScenarioToolbarIconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            type="button"
            variant={active ? "secondary" : "ghost"}
            size="icon-sm"
            className="h-10 w-10 rounded-md sm:h-8 sm:w-8"
            aria-label={label}
            aria-pressed={isToggle ? active : undefined}
            disabled={disabled}
            onClick={onClick}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        sideOffset={6}
        className="px-2 py-1 text-[11px]"
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The scenario's on/off state where people look for it. Activation opens the
 * same review as the list switch; turning off stays in the list.
 */
function ScenarioActivationControl({
  actions,
}: {
  actions: ScenarioAutomationHeaderActions;
}) {
  const t = useTranslations("Scenarios");
  if (actions.activeScenarioStatus === "active") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex h-10 items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 text-xs font-medium text-emerald-800 sm:h-8 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
            tabIndex={0}
          >
            <CircleCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {t("active")}
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          sideOffset={6}
          className="px-2 py-1 text-[11px]"
        >
          {t("toolbarScenarioActiveHint")}
        </TooltipContent>
      </Tooltip>
    );
  }
  if (!actions.onActivateScenario) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            type="button"
            size="sm"
            className="h-10 gap-1.5 px-3 sm:h-8"
            disabled={actions.isActivatingScenario}
            onClick={actions.onActivateScenario}
          >
            {actions.isActivatingScenario ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Play className="h-4 w-4" aria-hidden />
            )}
            {t("toolbarActivateScenario")}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        sideOffset={6}
        className="px-2 py-1 text-[11px]"
      >
        {t("toolbarActivateScenarioHint")}
      </TooltipContent>
    </Tooltip>
  );
}

function ScenarioCanvasModeToggle({
  mode,
  onModeChange,
}: {
  mode: ScenarioCanvasInteractionMode;
  onModeChange: (mode: ScenarioCanvasInteractionMode) => void;
}) {
  const t = useTranslations("Scenarios");

  return (
    <div
      className="flex shrink-0 items-center gap-0.5 rounded-lg border bg-muted/30 p-0.5"
      role="group"
      aria-label={t("canvasModeGroup")}
    >
      <ScenarioToolbarIconButton
        active={mode === "select"}
        isToggle
        label={t("canvasModeSelect")}
        onClick={() => {
          if (mode !== "select") onModeChange("select");
        }}
      >
        <MousePointer2 className="h-4 w-4" />
      </ScenarioToolbarIconButton>
      <ScenarioToolbarIconButton
        active={mode === "pan"}
        isToggle
        label={t("canvasModePan")}
        onClick={() => {
          if (mode !== "pan") onModeChange("pan");
        }}
      >
        <Hand className="h-4 w-4" />
      </ScenarioToolbarIconButton>
    </div>
  );
}

export function ScenariosToolbar({
  actions,
}: {
  actions: ScenarioAutomationHeaderActions | null;
}) {
  const t = useTranslations("Scenarios");
  // The loading view owns its skeleton toolbar; the empty view needs no toolbar.
  if (!actions?.hasScenario) return null;

  const saveLabel =
    actions.saveStatus === "saving"
      ? t("saving")
      : actions.saveStatus === "saved"
        ? t("scenarioSaved")
        : t("unsavedChanges");

  return (
    <TooltipProvider>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-background px-3 py-2 sm:px-4">
        <div className="flex shrink-0 items-center gap-1.5">
          {actions.onOpenNodePalette ? (
            <ScenarioToolbarIconButton
              label={t("newNode")}
              onClick={actions.onOpenNodePalette}
            >
              <Plus className="h-4 w-4" />
            </ScenarioToolbarIconButton>
          ) : null}
          <ScenarioCanvasModeToggle
            mode={actions.canvasInteractionMode}
            onModeChange={actions.onCanvasInteractionModeChange}
          />
        </div>
        <div className="order-last flex min-w-0 basis-full flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs text-muted-foreground sm:order-none sm:ml-auto sm:basis-auto">
          <span
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="inline-flex min-w-0 items-center gap-1.5"
          >
            {actions.saveStatus === "saving" ? (
              <Loader2
                className="h-3.5 w-3.5 shrink-0 animate-spin"
                aria-hidden
              />
            ) : null}
            {actions.saveStatus === "saved" ? (
              <Check
                className="h-3.5 w-3.5 shrink-0 text-emerald-600"
                aria-hidden
              />
            ) : null}
            <span
              className={
                actions.saveStatus === "unsaved"
                  ? "text-amber-600 dark:text-amber-400"
                  : undefined
              }
            >
              {saveLabel}
            </span>
          </span>
          {actions.saveStatus === "saved" ? (
            <ScenarioTemplateDraftStatus />
          ) : null}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1 border-l pl-2 sm:ml-0">
          <ScenarioActivationControl actions={actions} />
          <ScenarioToolbarIconButton
            active={actions.isTriggerLogVisible}
            isToggle
            label={
              actions.isTriggerLogVisible
                ? t("hideTriggerLog")
                : t("showTriggerLog")
            }
            onClick={actions.onToggleTriggerLog}
          >
            <ScrollText className="h-4 w-4" />
          </ScenarioToolbarIconButton>
          <ScenarioToolbarIconButton
            label={t("delete")}
            onClick={actions.onDeleteScenario}
            disabled={!actions.canDelete}
          >
            <Trash2 className="h-4 w-4" />
          </ScenarioToolbarIconButton>
        </div>
      </div>
    </TooltipProvider>
  );
}
