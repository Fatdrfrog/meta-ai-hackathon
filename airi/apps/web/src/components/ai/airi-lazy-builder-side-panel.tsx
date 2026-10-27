"use client";

import { AiriBuilderIntlProvider } from "@/components/ai/airi-builder-intl-provider";
import type { AiriBuilderSidePanelProps } from "@/components/ai/airi-builder-side-panel";
import { airiChatChunks } from "@/components/ai/airi-chat-chunks";
import { lazyScenarioChunkComponent } from "@/components/scenarios/scenario-lazy-chunk";
import { ScenarioLazyChunkBoundary } from "@/components/scenarios/scenario-lazy-chunk-boundary";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { PanelRightClose } from "lucide-react";

const LazyAiriBuilderSidePanel = lazyScenarioChunkComponent(
  airiChatChunks.builderSidePanel,
  module => module.AiriBuilderSidePanel
);

/** Starts the builder download before it is shown. */
export function preloadAiriBuilderSidePanel() {
  airiChatChunks.builderSidePanel.preload();
}

function AiriBuilderPanelLoadingShell({
  className,
  showCloseButton,
  onClose,
}: {
  className?: string;
  showCloseButton: boolean;
  onClose: () => void;
}) {
  return (
    <aside
      className={cn(
        "relative flex h-full min-h-0 flex-col overflow-hidden bg-background dark:bg-black",
        className
      )}
      aria-label="WhatsApp builder"
    >
      <div
        className={cn(
          "flex h-11 shrink-0 items-center gap-2 border-b py-0 pl-3",
          showCloseButton ? "pr-3" : "pr-14"
        )}
      >
        <p className="min-w-0 flex-1 truncate text-sm font-semibold">
          WhatsApp Builder
        </p>
        {showCloseButton ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 rounded-full"
            aria-label="Toggle side panel"
            onClick={onClose}
          >
            <PanelRightClose data-icon="icon" />
          </Button>
        ) : null}
      </div>
      <div
        role="status"
        aria-label="Loading builder"
        data-testid="airi-builder-loading-shell"
        className="flex flex-col gap-3 p-4"
      >
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-4/5" />
      </div>
    </aside>
  );
}

/**
 * The WhatsApp builder, downloaded (with the Flow builder and its
 * translations) only when a builder artifact is shown, so the Airi drawer
 * opens without it.
 */
export function AiriLazyBuilderSidePanel(props: AiriBuilderSidePanelProps) {
  if (props.hasActiveThread === false) return null;
  const fallback = (
    <AiriBuilderPanelLoadingShell
      className={props.className}
      showCloseButton={props.showCloseButton ?? true}
      onClose={props.onClose}
    />
  );
  return (
    <AiriBuilderIntlProvider fallback={fallback}>
      <ScenarioLazyChunkBoundary
        chunk={airiChatChunks.builderSidePanel}
        fallback={fallback}
      >
        <LazyAiriBuilderSidePanel {...props} />
      </ScenarioLazyChunkBoundary>
    </AiriBuilderIntlProvider>
  );
}
