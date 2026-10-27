"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ScenarioEditorChunkName } from "../scenario-editor-chunks";
import type { ScenarioNodeData } from "../types";
import {
  coldScenarioCanvasChunks,
  waitForScenarioEditorChunks,
} from "./scenario-canvas-editor-chunks";

const NO_CHUNKS: readonly ScenarioEditorChunkName[] = [];

/**
 * Keeps the canvas's loading state until the editors its cards show have
 * downloaded, the first time each scenario shows. React Flow then measures
 * every card at its real size (for the first fit to view and the measured
 * auto-layout) and every editor's handles exist when the edges draw. Later
 * edits never hide the canvas again. The wait is capped, so a slow or failed
 * download shows the cards' placeholders instead.
 */
export function ScenarioCanvasEditorsGate({
  loading,
  scenarioKey,
  nodes,
  fallback,
  children,
}: {
  loading: boolean;
  scenarioKey: string;
  nodes: readonly { data: ScenarioNodeData }[];
  fallback: ReactNode;
  children: ReactNode;
}) {
  const [shownKey, setShownKey] = useState<string | null>(null);
  const shown = shownKey === scenarioKey;
  const coldChunks = useMemo(
    () => (loading || shown ? NO_CHUNKS : coldScenarioCanvasChunks(nodes)),
    [loading, nodes, shown]
  );
  const ready = !loading && coldChunks.length === 0;
  if (ready && !shown) setShownKey(scenarioKey);

  useEffect(() => {
    if (coldChunks.length === 0) return;
    let cancelled = false;
    void waitForScenarioEditorChunks(coldChunks).then(() => {
      if (!cancelled) setShownKey(scenarioKey);
    });
    return () => {
      cancelled = true;
    };
  }, [coldChunks, scenarioKey]);

  if (loading) return fallback;
  return shown || ready ? children : fallback;
}
