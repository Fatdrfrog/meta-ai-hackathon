"use client";

import type { ScenarioNodePaletteItem } from "@/components/scenarios/graph/node-palette";
import { useCallback, useEffect, useRef, type ComponentProps } from "react";
import { scenarioEditorChunks } from "../../scenario-editor-chunks";
import {
  lazyScenarioChunkComponent,
  useOpenedOnce,
} from "../../scenario-lazy-chunk";
import { ScenarioLazyChunkBoundary } from "../../scenario-lazy-chunk-boundary";
import {
  coldScenarioPaletteItemChunks,
  preloadScenarioCanvasActionChunks,
  waitForScenarioEditorChunks,
} from "../scenario-canvas-editor-chunks";
import type { ScenarioNodePaletteMenu } from "./scenario-node-palette-menu";

const ScenarioNodePaletteMenuChunk = lazyScenarioChunkComponent(
  scenarioEditorChunks.nodePaletteMenu,
  module => module.ScenarioNodePaletteMenu
);

/**
 * Adds a step once the editors its card shows have downloaded (at most
 * SCENARIO_EDITOR_CHUNK_MAX_WAIT_MS), so React Flow first measures the real
 * card: the auto-layout that follows an added step keeps that first size.
 */
function useAddWhenEditorsLoad(
  add: (item: ScenarioNodePaletteItem) => void
): (item: ScenarioNodePaletteItem) => void {
  const mountedRef = useRef(false);
  const waitingRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return useCallback(
    (item: ScenarioNodePaletteItem) => {
      const coldChunks = coldScenarioPaletteItemChunks(item.kind);
      if (coldChunks.length === 0) {
        add(item);
        return;
      }
      if (waitingRef.current) return;
      waitingRef.current = true;
      void waitForScenarioEditorChunks(coldChunks).then(() => {
        waitingRef.current = false;
        if (mountedRef.current) add(item);
      });
    },
    [add]
  );
}

/**
 * The add-step menu, downloaded on idle or on its first open. It stays
 * mounted after that open so closing it still returns focus. Opening it
 * starts the action editors a new step can show.
 */
export function LazyScenarioNodePaletteMenu(
  props: ComponentProps<typeof ScenarioNodePaletteMenu>
) {
  const open = Boolean(props.contextMenu);
  const opened = useOpenedOnce(open);
  useEffect(() => {
    if (open) preloadScenarioCanvasActionChunks();
  }, [open]);
  const onAddNodeFromPaletteItem = useAddWhenEditorsLoad(
    props.onAddNodeFromPaletteItem
  );
  if (!opened) return null;
  return (
    <ScenarioLazyChunkBoundary
      chunk={scenarioEditorChunks.nodePaletteMenu}
      fallback={null}
    >
      <ScenarioNodePaletteMenuChunk
        {...props}
        onAddNodeFromPaletteItem={onAddNodeFromPaletteItem}
      />
    </ScenarioLazyChunkBoundary>
  );
}
