"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_SCENARIO_ENTRY_POLICY,
  type ScenarioFlowEdge,
  type ScenarioFlowNode,
  type ScenarioStatus,
  type ScenarioSummary,
} from "../types";
import type { ScenarioDraftPreviewInput } from "./preview/evaluation";
import { parseScenarioPriorityInput } from "./scenario-template-utils";

function removePreviewSearchParam() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("preview")) return;

  params.delete("preview");
  const query = params.toString();
  const nextUrl = query
    ? `${window.location.pathname}?${query}`
    : window.location.pathname;

  window.history.replaceState(window.history.state ?? null, "", nextUrl);
}

type UseScenarioPreviewDrawerParams = {
  activeScenarioId: string | null;
  activeScenario: ScenarioSummary | null | undefined;
  activeScenarioName: string;
  activeScenarioStatus: ScenarioStatus;
  entryPriorityInput: string;
  loadingFlow: boolean;
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
  requestedScenarioId: string | null;
  openPreviewOnMount: boolean;
};

export function useScenarioPreviewDrawer({
  activeScenarioId,
  activeScenario,
  activeScenarioName,
  activeScenarioStatus,
  entryPriorityInput,
  loadingFlow,
  nodes,
  edges,
  requestedScenarioId,
  openPreviewOnMount,
}: UseScenarioPreviewDrawerParams) {
  const [showPreviewDrawer, setShowPreviewDrawer] = useState(false);
  const [autoPreviewScenarioId, setAutoPreviewScenarioId] = useState<
    string | null
  >(() => (openPreviewOnMount ? requestedScenarioId : null));
  const cleanedRequestedPreviewRef = useRef<string | null>(null);

  const shouldOpenAutoPreview =
    autoPreviewScenarioId !== null &&
    activeScenarioId === autoPreviewScenarioId;
  const isPreviewDrawerOpen = showPreviewDrawer || shouldOpenAutoPreview;

  useEffect(() => {
    if (!shouldOpenAutoPreview || !autoPreviewScenarioId) return;
    if (cleanedRequestedPreviewRef.current === autoPreviewScenarioId) return;

    cleanedRequestedPreviewRef.current = autoPreviewScenarioId;
    removePreviewSearchParam();
  }, [autoPreviewScenarioId, shouldOpenAutoPreview]);

  const openPreviewDrawer = useCallback(() => {
    setShowPreviewDrawer(true);
  }, []);

  const handlePreviewDrawerOpenChange = useCallback((open: boolean) => {
    setShowPreviewDrawer(open);
    if (!open) {
      setAutoPreviewScenarioId(null);
    }
  }, []);

  const draftScenarioForPreview =
    useMemo<ScenarioDraftPreviewInput | null>(() => {
      if (!isPreviewDrawerOpen) return null;
      if (!activeScenarioId || !activeScenario || loadingFlow) return null;
      return {
        scenarioId: activeScenarioId,
        name: activeScenarioName || activeScenario.name,
        status: activeScenarioStatus,
        priority: parseScenarioPriorityInput(entryPriorityInput),
        matchingRole: activeScenario.matchingRole ?? "default",
        entryPolicy:
          activeScenario.entryPolicy ?? DEFAULT_SCENARIO_ENTRY_POLICY,
        nodes,
        edges,
      };
    }, [
      activeScenario,
      activeScenarioId,
      activeScenarioName,
      activeScenarioStatus,
      edges,
      entryPriorityInput,
      isPreviewDrawerOpen,
      loadingFlow,
      nodes,
    ]);

  return {
    isPreviewDrawerOpen,
    draftScenarioForPreview,
    openPreviewDrawer,
    handlePreviewDrawerOpenChange,
  };
}
