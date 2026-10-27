"use client";

import { ResizablePanel } from "@/components/ui/resizable";
import { observeElementResize } from "@/lib/observe-element-resize";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import type { ImperativePanelHandle } from "react-resizable-panels";
import {
  ScenariosSidebar,
  type ScenariosSidebarLayoutMode,
} from "./scenarios-sidebar";

const SCENARIO_SIDEBAR_PANEL_ID = "scenario-sidebar";
const DEFAULT_SCENARIO_SIDEBAR_SIZE = 28;
const MAX_SCENARIO_SIDEBAR_SIZE = 42;
const MIN_SCENARIO_SIDEBAR_WIDTH_PX = 64;
const DEFAULT_SCENARIO_SIDEBAR_WIDTH_PX = 320;
const MAX_SCENARIO_SIDEBAR_WIDTH_PX = 420;
const NARROW_SCENARIO_LAYOUT_WIDTH_PX = 768;
const RAIL_SCENARIO_SIDEBAR_WIDTH_PX = 208;
const COMPACT_SCENARIO_SIDEBAR_WIDTH_PX = 360;
const RAIL_SCENARIO_SIDEBAR_PANEL_SIZE = 15;
const COMPACT_SCENARIO_SIDEBAR_PANEL_SIZE = 24;

type ScenariosSidebarPanelProps = Omit<
  ComponentProps<typeof ScenariosSidebar>,
  "layoutMode"
>;

function resolveSidebarLayoutMode(params: {
  panelSize: number;
  panelWidth: number | null;
}): ScenariosSidebarLayoutMode {
  const { panelSize, panelWidth } = params;

  if (panelWidth !== null) {
    if (panelWidth <= RAIL_SCENARIO_SIDEBAR_WIDTH_PX) return "rail";
    if (panelWidth <= COMPACT_SCENARIO_SIDEBAR_WIDTH_PX) return "compact";
    return "comfortable";
  }

  if (panelSize <= RAIL_SCENARIO_SIDEBAR_PANEL_SIZE) return "rail";
  if (panelSize <= COMPACT_SCENARIO_SIDEBAR_PANEL_SIZE) return "compact";
  return "comfortable";
}

/**
 * Whether the list's own resize handle is being dragged or has keyboard focus.
 * react-resizable-panels points that handle at the list with aria-controls.
 */
function isSidebarHandleActive(node: Element | null) {
  const handle = node
    ?.closest("[data-panel-group]")
    ?.querySelector(
      `[data-resize-handle][aria-controls="${SCENARIO_SIDEBAR_PANEL_ID}"]`
    );
  return handle?.hasAttribute("data-resize-handle-active") ?? false;
}

export const ScenariosSidebarPanel = memo(function ScenariosSidebarPanel(
  sidebarProps: ScenariosSidebarPanelProps
) {
  const panelRef = useRef<HTMLDivElement>(null);
  const resizablePanelRef = useRef<ImperativePanelHandle>(null);
  // The panel group keeps percentages; the list keeps its chosen width in
  // pixels, next to the group width it was last sized for.
  const preferredWidthRef = useRef(DEFAULT_SCENARIO_SIDEBAR_WIDTH_PX);
  const sizedGroupWidthRef = useRef<number | null>(null);
  const [panelSize, setPanelSize] = useState(DEFAULT_SCENARIO_SIDEBAR_SIZE);
  const [panelWidth, setPanelWidth] = useState<number | null>(null);
  const [groupWidth, setGroupWidth] = useState<number | null>(null);

  useEffect(() => {
    const node = panelRef.current;
    if (!node) return;

    const stopPanelObserver = observeElementResize(node, () => {
      const width = node.getBoundingClientRect().width;
      setPanelWidth(current =>
        Math.abs((current ?? 0) - width) < 1 ? current : width
      );
    });
    const group = node.closest("[data-panel-group]");
    const stopGroupObserver = group
      ? observeElementResize(group, () => {
          const width = group.getBoundingClientRect().width;
          if (width > 0) setGroupWidth(width);
        })
      : undefined;
    return () => {
      stopPanelObserver();
      stopGroupObserver?.();
    };
  }, []);

  useEffect(() => {
    if (groupWidth === null) return;
    const isNarrow = groupWidth < NARROW_SCENARIO_LAYOUT_WIDTH_PX;
    const sizedGroupWidth = sizedGroupWidthRef.current;
    const wasNarrow =
      sizedGroupWidth !== null &&
      sizedGroupWidth < NARROW_SCENARIO_LAYOUT_WIDTH_PX;
    // Re-apply the list's width in pixels whenever the group resizes. A narrow
    // canvas folds it into the rail once; manual resizing there remains owned
    // by the panel library.
    if (!isNarrow || !wasNarrow) {
      const width = isNarrow
        ? MIN_SCENARIO_SIDEBAR_WIDTH_PX
        : Math.min(
            Math.max(preferredWidthRef.current, MIN_SCENARIO_SIDEBAR_WIDTH_PX),
            MAX_SCENARIO_SIDEBAR_WIDTH_PX
          );
      resizablePanelRef.current?.resize((width / groupWidth) * 100);
    }
    sizedGroupWidthRef.current = groupWidth;
  }, [groupWidth]);

  const handleResize = useCallback(
    (size: number) => {
      setPanelSize(size);
      // Only the list's own handle, dragged or moved with arrow keys, sets the
      // width to keep; the settings dock taking room does not. Our own
      // resize() and the clamps of new min/max sizes report before this group
      // width is sized; the narrow layout keeps no width.
      if (
        groupWidth === null ||
        groupWidth !== sizedGroupWidthRef.current ||
        groupWidth < NARROW_SCENARIO_LAYOUT_WIDTH_PX ||
        !isSidebarHandleActive(panelRef.current)
      ) {
        return;
      }
      preferredWidthRef.current = (size * groupWidth) / 100;
    },
    [groupWidth]
  );

  const layoutMode = resolveSidebarLayoutMode({ panelSize, panelWidth });

  return (
    <ResizablePanel
      ref={resizablePanelRef}
      // Stable identity in the group, which can also hold node settings.
      id={SCENARIO_SIDEBAR_PANEL_ID}
      order={1}
      defaultSize={DEFAULT_SCENARIO_SIDEBAR_SIZE}
      minSize={
        groupWidth ? (MIN_SCENARIO_SIDEBAR_WIDTH_PX / groupWidth) * 100 : 12
      }
      maxSize={
        groupWidth
          ? Math.min(
              MAX_SCENARIO_SIDEBAR_SIZE,
              (MAX_SCENARIO_SIDEBAR_WIDTH_PX / groupWidth) * 100
            )
          : MAX_SCENARIO_SIDEBAR_SIZE
      }
      onResize={handleResize}
      className="min-h-0 overflow-hidden border-r"
    >
      <div ref={panelRef} className="h-full min-h-0 w-full">
        <ScenariosSidebar {...sidebarProps} layoutMode={layoutMode} />
      </div>
    </ResizablePanel>
  );
});
