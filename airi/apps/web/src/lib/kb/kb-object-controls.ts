import { cn } from "@/lib/utils";

export type KBControlRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type KBControlSize = {
  width: number;
  height: number;
};

export type KBAnchoredControlPlacement =
  | "top-start"
  | "top-end"
  | "bottom-start"
  | "bottom-end";

export type KBObjectResizeHandle =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

const VIEWPORT_PADDING = 8;
export const KB_OBJECT_SELECTION_COLOR = "#8b5cf6";

function hasUsableRect(rect: KBControlRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

export function clampKBViewportPosition({
  value,
  size = 0,
  viewportSize,
  padding = VIEWPORT_PADDING,
}: {
  value: number;
  size?: number;
  viewportSize?: number;
  padding?: number;
}): number {
  if (!viewportSize || viewportSize <= 0) {
    return Math.max(padding, value);
  }

  return clamp(value, padding, viewportSize - size - padding);
}

export function getKBViewportSize(): KBControlSize {
  if (typeof window === "undefined") {
    return { width: 1024, height: 768 };
  }

  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

export function buildKBAnchoredControlPosition({
  anchorRect,
  panelSize,
  viewport = getKBViewportSize(),
  placement = "bottom-start",
  offset = 8,
  padding = VIEWPORT_PADDING,
}: {
  anchorRect: KBControlRect;
  panelSize: KBControlSize;
  viewport?: KBControlSize;
  placement?: KBAnchoredControlPlacement;
  offset?: number;
  padding?: number;
}): { left: number; top: number } | null {
  if (!hasUsableRect(anchorRect)) return null;

  const alignEnd = placement.endsWith("end");
  const preferTop = placement.startsWith("top");
  const startLeft = alignEnd
    ? anchorRect.right - panelSize.width
    : anchorRect.left;
  const topPosition = anchorRect.top - panelSize.height - offset;
  const bottomPosition = anchorRect.bottom + offset;
  let top = preferTop ? topPosition : bottomPosition;

  if (preferTop && top < padding) {
    top = bottomPosition;
  } else if (!preferTop && top + panelSize.height > viewport.height - padding) {
    top = topPosition;
  }

  return {
    left: Math.round(
      clampKBViewportPosition({
        value: startLeft,
        size: panelSize.width,
        viewportSize: viewport.width,
        padding,
      })
    ),
    top: Math.round(
      clampKBViewportPosition({
        value: top,
        size: panelSize.height,
        viewportSize: viewport.height,
        padding,
      })
    ),
  };
}

export function getKBObjectSelectionClassNames() {
  return {
    frame:
      "kb-editor-object-selection-frame pointer-events-none absolute inset-0 z-10 hidden rounded-md border-2 border-[#8b5cf6]",
    visible: "block",
    visibleFlex: "flex",
    quickAction:
      "kb-editor-object-quick-action pointer-events-auto absolute right-0 top-0 z-20 hidden size-9 translate-x-3 -translate-y-3 items-center justify-center rounded-md bg-zinc-700 text-white shadow-lg transition hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5cf6] focus-visible:ring-offset-2",
    resizeHandle:
      "kb-editor-object-resize-handle pointer-events-auto absolute z-20 hidden size-4 rounded-full border-2 border-[#8b5cf6] bg-background shadow-sm ring-2 ring-background transition-transform hover:scale-110",
  } as const;
}

export function getKBObjectResizeHandleClassName(
  handle: KBObjectResizeHandle,
  className?: string
): string {
  const positions: Record<KBObjectResizeHandle, string> = {
    "top-left": "-left-2 -top-2 cursor-nwse-resize",
    "top-right": "-right-2 -top-2 cursor-nesw-resize",
    "bottom-left": "-bottom-2 -left-2 cursor-nesw-resize",
    "bottom-right": "-bottom-2 -right-2 cursor-nwse-resize",
  };

  return cn(
    getKBObjectSelectionClassNames().resizeHandle,
    positions[handle],
    className
  );
}
