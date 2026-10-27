"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import type { ComponentProps } from "react";
import { scenarioEditorChunks } from "../../scenario-editor-chunks";
import { lazyScenarioChunkComponent } from "../../scenario-lazy-chunk";
import { ScenarioLazyChunkBoundary } from "../../scenario-lazy-chunk-boundary";
import type { TriggerNodeSettings } from "./trigger-node-settings";

const TriggerNodeSettingsChunk = lazyScenarioChunkComponent(
  scenarioEditorChunks.triggerNodeSettings,
  module => module.TriggerNodeSettings
);

/** Keeps the settings body's place (and its scroll area) while it loads. */
function TriggerNodeSettingsLoading({ className }: { className?: string }) {
  const t = useTranslations("Scenarios");
  return (
    <div role="status" className={cn("flex w-full flex-col gap-5", className)}>
      <div className="space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-9 w-full" />
      </div>
      <Skeleton className="h-32 w-full" />
      <span className="sr-only">{t("loadingItems")}</span>
    </div>
  );
}

/**
 * Trigger settings, downloaded when a trigger is first opened. Import them
 * only through this wrapper so they stay out of the page's first load.
 */
export function LazyTriggerNodeSettings(
  props: ComponentProps<typeof TriggerNodeSettings>
) {
  return (
    <ScenarioLazyChunkBoundary
      chunk={scenarioEditorChunks.triggerNodeSettings}
      fallback={<TriggerNodeSettingsLoading className={props.className} />}
    >
      <TriggerNodeSettingsChunk {...props} />
    </ScenarioLazyChunkBoundary>
  );
}
