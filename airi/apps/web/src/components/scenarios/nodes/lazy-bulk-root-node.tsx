"use client";

import { CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "next-intl";
import { memo } from "react";
import { scenarioEditorChunks } from "../scenario-editor-chunks";
import { lazyScenarioChunkComponent } from "../scenario-lazy-chunk";
import { ScenarioLazyChunkBoundary } from "../scenario-lazy-chunk-boundary";
import type { ScenarioBulkEditorNodeProps } from "../view/node-enrichment/types";
import { BulkRootNodeFrame } from "./bulk-root-node-frame";
import { areNodePropsEqual } from "./node-memo-utils";

const BulkRootNodeChunk = lazyScenarioChunkComponent(
  scenarioEditorChunks.bulkRootNode,
  module => module.BulkRootNode
);

/** The bulk block's frame and handles, with its editor still loading. */
function BulkRootNodeLoading({ data, selected }: ScenarioBulkEditorNodeProps) {
  const t = useTranslations("Scenarios");
  return (
    <BulkRootNodeFrame selected={selected} nodeData={data}>
      <CardHeader className="space-y-2 px-3 pb-2">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-4 w-48" />
      </CardHeader>
      <CardContent role="status" className="space-y-3 px-3 pb-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-9 w-full" />
        <span className="sr-only">{t("loadingItems")}</span>
      </CardContent>
    </BulkRootNodeFrame>
  );
}

/**
 * The bulk campaign block, downloaded only when a scenario has one. Register
 * this wrapper, never the editor itself, so the campaign editor and its CSV
 * parser stay out of the page's first load.
 */
export const LazyBulkRootNode = memo(function LazyBulkRootNode(
  props: ScenarioBulkEditorNodeProps
) {
  return (
    <ScenarioLazyChunkBoundary
      chunk={scenarioEditorChunks.bulkRootNode}
      fallback={<BulkRootNodeLoading {...props} />}
    >
      <BulkRootNodeChunk {...props} />
    </ScenarioLazyChunkBoundary>
  );
}, areNodePropsEqual);
