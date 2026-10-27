"use client";

import { airiChatChunks } from "@/components/ai/airi-chat-chunks";
import { AiriResizableSidebar } from "@/components/ai/airi-resizable-sidebar";
import { lazyScenarioChunkComponent } from "@/components/scenarios/scenario-lazy-chunk";
import { ScenarioLazyChunkBoundary } from "@/components/scenarios/scenario-lazy-chunk-boundary";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PanelRightClose, Sparkles } from "lucide-react";

export type AiriChatModalProps = {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const LazyAiriChatWorkspace = lazyScenarioChunkComponent(
  airiChatChunks.workspace,
  module => module.AiriChatWorkspace
);

/** Starts the chat download early, e.g. on hover or when the browser idles. */
export function preloadAiriChatModal() {
  airiChatChunks.workspace.preload();
}

/**
 * Shown at once while the chat downloads, and kept while a failed download
 * is retried, so the drawer always opens and can always be closed.
 */
function AiriChatWorkspaceLoadingShell({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background dark:bg-black/95">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <span className="grid size-8 place-items-center rounded-lg bg-emerald-100 text-emerald-950 dark:bg-emerald-400/20 dark:text-emerald-100">
          <Sparkles className="size-4" />
        </span>
        <p className="min-w-0 flex-1 truncate text-sm font-semibold">Airi</p>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8 rounded-full"
          aria-label="Close Airi sidebar"
          onClick={onClose}
        >
          <PanelRightClose className="size-4" />
        </Button>
      </header>
      <div
        role="status"
        aria-label="Loading Airi"
        data-testid="airi-chat-loading-shell"
        className="mx-auto flex w-full max-w-[400px] flex-1 flex-col items-center gap-4 px-3 pt-6"
      >
        <Skeleton className="size-9 rounded-xl" />
        <Skeleton className="h-6 w-3/5" />
        <Skeleton className="h-4 w-4/5" />
        <div className="grid w-full grid-cols-2 gap-2 pt-2">
          <Skeleton className="h-16 rounded-xl" />
          <Skeleton className="h-16 rounded-xl" />
          <Skeleton className="h-16 rounded-xl" />
          <Skeleton className="h-16 rounded-xl" />
        </div>
      </div>
      <div className="shrink-0 px-3 py-3">
        <Skeleton className="h-12 w-full rounded-2xl" />
      </div>
    </div>
  );
}

export function AiriChatModal({
  workspaceId,
  open,
  onOpenChange,
}: AiriChatModalProps) {
  const close = () => onOpenChange(false);
  return (
    <AiriResizableSidebar
      open={open}
      onOpenChange={onOpenChange}
      title="Ask Airi"
      description="Chat with Airi about this workspace."
      storageKey="airi-chat-sidebar-width"
      defaultWidth={520}
      minWidth={420}
      maxWidth={760}
      showHeader={false}
      showCloseButton={false}
      contentClassName="sm:rounded-l-xl"
    >
      <ScenarioLazyChunkBoundary
        chunk={airiChatChunks.workspace}
        fallback={<AiriChatWorkspaceLoadingShell onClose={close} />}
      >
        <LazyAiriChatWorkspace
          workspaceId={workspaceId}
          compact
          initialSource="global"
          onClose={close}
        />
      </ScenarioLazyChunkBoundary>
    </AiriResizableSidebar>
  );
}
