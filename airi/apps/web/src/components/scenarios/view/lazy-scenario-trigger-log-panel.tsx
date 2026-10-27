"use client";

import { useTranslations } from "next-intl";
import type { ComponentProps } from "react";
import { scenarioEditorChunks } from "../scenario-editor-chunks";
import { lazyScenarioChunkComponent } from "../scenario-lazy-chunk";
import { ScenarioLazyChunkBoundary } from "../scenario-lazy-chunk-boundary";
import type { ScenarioTriggerLogPanel } from "./scenario-trigger-log-panel";

const ScenarioTriggerLogPanelChunk = lazyScenarioChunkComponent(
  scenarioEditorChunks.triggerLogPanel,
  module => module.ScenarioTriggerLogPanel
);

type ScenarioTriggerLogPanelProps = ComponentProps<
  typeof ScenarioTriggerLogPanel
>;

function ScenarioTriggerLogPanelLoading({
  layout = "side",
}: Pick<ScenarioTriggerLogPanelProps, "layout">) {
  const t = useTranslations("Scenarios");
  return (
    <aside
      role="status"
      className={
        layout === "bottom"
          ? "h-full border-t bg-background p-4 text-sm text-muted-foreground"
          : "h-full w-[360px] min-w-[340px] border-l bg-background p-4 text-sm text-muted-foreground"
      }
    >
      {t("triggerLogLoading")}
    </aside>
  );
}

/** Trigger logs, downloaded when the panel is first shown. */
export function LazyScenarioTriggerLogPanel(
  props: ScenarioTriggerLogPanelProps
) {
  return (
    <ScenarioLazyChunkBoundary
      chunk={scenarioEditorChunks.triggerLogPanel}
      fallback={<ScenarioTriggerLogPanelLoading layout={props.layout} />}
    >
      <ScenarioTriggerLogPanelChunk {...props} />
    </ScenarioLazyChunkBoundary>
  );
}
