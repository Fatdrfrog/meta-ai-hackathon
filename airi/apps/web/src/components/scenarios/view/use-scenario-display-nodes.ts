"use client";

import { useMemo, useState } from "react";
import type { ScenarioFlowNode } from "../types";
import {
  createScenarioNodeEnrichmentCache,
  enrichScenarioEditorNodesWithCache,
} from "./node-enrichment/enrichment-cache";
import type { ScenarioEditorFlowNode } from "./node-enrichment/types";
import { useScenarioNodeEnrichment } from "./scenario-node-enrichment-context";

/**
 * The canvas's editor nodes. A node keeps its previous editor node until its
 * persisted data, placement or the context values it reads change, so a
 * size measurement or an edit elsewhere re-renders only the nodes it
 * affects.
 */
export function useScenarioDisplayNodes(
  nodes: ScenarioFlowNode[]
): ScenarioEditorFlowNode[] {
  const ctx = useScenarioNodeEnrichment();
  const [cache] = useState(createScenarioNodeEnrichmentCache);

  return useMemo(
    () => enrichScenarioEditorNodesWithCache(nodes, ctx, cache),
    [cache, ctx, nodes]
  );
}
