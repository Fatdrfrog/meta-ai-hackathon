"use client";

import {
  AiriChatWorkspace,
  type AiriDesktopColumnsProps,
} from "@/components/ai/airi-chat-workspace";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { ComponentProps } from "react";

/**
 * The /airi page's resizable columns. Only this page module imports
 * react-resizable-panels: the drawer shares AiriChatWorkspace without it,
 * and the page renders the columns with its own code, so its layout never
 * waits on (or fails with) a separate download.
 */
export function AiriResizableDesktopColumns({
  threadList,
  thread,
  sidePanel,
  sidePanelSize,
  onSidePanelSizeChange,
}: AiriDesktopColumnsProps) {
  const sidePanelVisible = sidePanel !== null;
  return (
    <ResizablePanelGroup
      direction="horizontal"
      className="min-w-0 flex-1"
      onLayout={sizes => {
        if (!sidePanelVisible) return;
        const size = sizes[2];
        if (typeof size === "number" && size >= 24 && size <= 48) {
          onSidePanelSizeChange(Math.round(size));
        }
      }}
    >
      <ResizablePanel
        defaultSize={sidePanelVisible ? 20 : 24}
        minSize={18}
        maxSize={sidePanelVisible ? 30 : 38}
        className="min-w-[220px] max-w-[440px]"
      >
        {threadList}
      </ResizablePanel>
      <ResizableHandle
        withHandle
        className="bg-transparent after:w-2 hover:bg-muted/70"
      />
      <ResizablePanel
        defaultSize={sidePanelVisible ? 48 : 76}
        minSize={sidePanelVisible ? 32 : 48}
        className="min-w-0"
      >
        {thread}
      </ResizablePanel>
      {sidePanelVisible ? (
        <>
          <ResizableHandle
            withHandle
            className="bg-transparent after:w-2 hover:bg-muted/70"
          />
          <ResizablePanel
            defaultSize={sidePanelSize}
            minSize={24}
            maxSize={48}
            className="min-w-[360px] max-w-[760px]"
          >
            {sidePanel}
          </ResizablePanel>
        </>
      ) : null}
    </ResizablePanelGroup>
  );
}

/** The full-page Airi workspace, laid out in resizable columns. */
export function AiriPageWorkspace(
  props: Omit<
    ComponentProps<typeof AiriChatWorkspace>,
    "compact" | "desktopColumns"
  >
) {
  return (
    <AiriChatWorkspace
      {...props}
      desktopColumns={AiriResizableDesktopColumns}
    />
  );
}
