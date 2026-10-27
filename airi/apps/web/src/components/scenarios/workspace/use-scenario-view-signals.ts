"use client";

import { useEffect } from "react";
import type { ScenarioStatus } from "../types";
import type { ScenarioCanvasInteractionMode } from "../view/scenario-canvas-interaction-mode";

export type ScenarioAutomationHeaderActions = {
  hasScenario: boolean;
  canCreate: boolean;
  isCreatingScenario: boolean;
  canDelete: boolean;
  saveStatus: "saved" | "saving" | "unsaved";
  canvasInteractionMode: ScenarioCanvasInteractionMode;
  isTriggerLogVisible: boolean;
  /** The open scenario's status; null when none is open. */
  activeScenarioStatus?: ScenarioStatus | null;
  isActivatingScenario?: boolean;
  onCreateScenario: () => void;
  onOpenNodePalette?: () => void;
  onOpenAiGenerate?: () => void;
  onCanvasInteractionModeChange: (mode: ScenarioCanvasInteractionMode) => void;
  onToggleTriggerLog: () => void;
  onDeleteScenario: () => void;
  onActivateScenario?: () => void;
};

type UseScenarioLoadingSignalParams = {
  isLoading: boolean;
  onLoadingChange?: (isLoading: boolean) => void;
};

export function useScenarioLoadingSignal({
  isLoading,
  onLoadingChange,
}: UseScenarioLoadingSignalParams) {
  useEffect(() => {
    onLoadingChange?.(isLoading);
  }, [isLoading, onLoadingChange]);
}

type UseScenarioAutomationHeaderActionsParams =
  ScenarioAutomationHeaderActions & {
    onAutomationActionsChange?: (
      actions: ScenarioAutomationHeaderActions | null
    ) => void;
  };

export function useScenarioAutomationHeaderActions({
  onAutomationActionsChange,
  hasScenario,
  canCreate,
  isCreatingScenario,
  canDelete,
  saveStatus,
  canvasInteractionMode,
  isTriggerLogVisible,
  activeScenarioStatus,
  isActivatingScenario,
  onCreateScenario,
  onOpenNodePalette,
  onOpenAiGenerate,
  onCanvasInteractionModeChange,
  onToggleTriggerLog,
  onDeleteScenario,
  onActivateScenario,
}: UseScenarioAutomationHeaderActionsParams) {
  useEffect(() => {
    if (!onAutomationActionsChange) return;
    onAutomationActionsChange({
      hasScenario,
      canCreate,
      isCreatingScenario,
      canDelete,
      saveStatus,
      canvasInteractionMode,
      isTriggerLogVisible,
      activeScenarioStatus,
      isActivatingScenario,
      onCreateScenario,
      onOpenNodePalette,
      onOpenAiGenerate,
      onCanvasInteractionModeChange,
      onToggleTriggerLog,
      onDeleteScenario,
      onActivateScenario,
    });
  }, [
    activeScenarioStatus,
    canDelete,
    canCreate,
    canvasInteractionMode,
    hasScenario,
    isActivatingScenario,
    isCreatingScenario,
    isTriggerLogVisible,
    onActivateScenario,
    onCreateScenario,
    onOpenNodePalette,
    onOpenAiGenerate,
    onCanvasInteractionModeChange,
    onAutomationActionsChange,
    onDeleteScenario,
    onToggleTriggerLog,
    saveStatus,
  ]);

  useEffect(() => {
    return () => {
      onAutomationActionsChange?.(null);
    };
  }, [onAutomationActionsChange]);
}
