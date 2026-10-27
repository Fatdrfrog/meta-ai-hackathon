"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PanelRightClose } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

type AiriResizableSidebarProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  storageKey: string;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  showHeader?: boolean;
  headerSlot?: ReactNode;
  contentClassName?: string;
  bodyClassName?: string;
  closeLabel?: string;
  showCloseButton?: boolean;
};

function clampWidth(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getViewportMaxWidth(maxWidth: number): number {
  if (typeof window === "undefined") return maxWidth;
  return Math.min(maxWidth, Math.max(320, window.innerWidth - 24));
}

export function AiriResizableSidebar({
  open,
  onOpenChange,
  title,
  description,
  children,
  storageKey,
  defaultWidth = 440,
  minWidth = 360,
  maxWidth = 720,
  showHeader = true,
  headerSlot,
  contentClassName,
  bodyClassName,
  closeLabel = "Close Airi sidebar",
  showCloseButton = true,
}: AiriResizableSidebarProps) {
  const [width, setWidth] = useState(() => {
    if (typeof window === "undefined") return defaultWidth;
    const stored = Number(window.localStorage.getItem(storageKey));
    return Number.isFinite(stored) && stored > 0
      ? clampWidth(stored, minWidth, maxWidth)
      : clampWidth(defaultWidth, minWidth, maxWidth);
  });
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const cancelResizeSession = useCallback(() => {
    resizeCleanupRef.current?.();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      storageKey,
      String(clampWidth(width, minWidth, maxWidth))
    );
  }, [maxWidth, minWidth, storageKey, width]);

  useEffect(() => {
    if (!open) cancelResizeSession();
  }, [cancelResizeSession, open]);

  useEffect(() => () => cancelResizeSession(), [cancelResizeSession]);

  const handleResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "touch") return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;
      const resizeMaxWidth = getViewportMaxWidth(maxWidth);

      cancelResizeSession();
      const handlePointerMove = (moveEvent: PointerEvent) => {
        const delta = startX - moveEvent.clientX;
        setWidth(clampWidth(startWidth + delta, minWidth, resizeMaxWidth));
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("pointercancel", cleanup);
        window.removeEventListener("blur", cleanup);
        if (resizeCleanupRef.current === cleanup) {
          resizeCleanupRef.current = null;
        }
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", cleanup);
      window.addEventListener("pointercancel", cleanup);
      window.addEventListener("blur", cleanup);
      resizeCleanupRef.current = cleanup;
    },
    [cancelResizeSession, maxWidth, minWidth, width]
  );

  const handleResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const resizeMaxWidth = getViewportMaxWidth(maxWidth);
      let delta = 0;
      if (event.key === "ArrowLeft") delta = 16;
      if (event.key === "ArrowRight") delta = -16;
      if (delta === 0 && event.key !== "Home" && event.key !== "End") return;

      event.preventDefault();
      setWidth(current => {
        if (event.key === "Home") return minWidth;
        if (event.key === "End") return resizeMaxWidth;
        return clampWidth(current + delta, minWidth, resizeMaxWidth);
      });
    },
    [maxWidth, minWidth]
  );

  const contentStyle = {
    "--airi-sidebar-width": `${width}px`,
  } as CSSProperties;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          style={contentStyle}
          // Keyboard users can leave this nonmodal panel without losing their draft.
          onFocusOutside={event => event.preventDefault()}
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex max-h-dvh w-screen min-w-0 max-w-full flex-col border-l bg-background shadow-[0_28px_120px_-52px_rgba(15,23,42,0.78)] outline-none sm:w-[var(--airi-sidebar-width)] sm:max-w-[calc(100vw-12px)]",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right data-[state=closed]:duration-150 data-[state=open]:duration-200",
            "motion-reduce:animate-none motion-reduce:transition-none",
            contentClassName
          )}
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize Airi sidebar"
            tabIndex={0}
            className="absolute inset-y-0 left-0 hidden w-2 -translate-x-1 cursor-col-resize items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex"
            onPointerDown={handleResizePointerDown}
            onKeyDown={handleResizeKeyDown}
          >
            <div className="h-12 w-1 rounded-full bg-border transition" />
          </div>
          <DialogPrimitive.Title className="sr-only">
            {title}
          </DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description className="sr-only">
              {description}
            </DialogPrimitive.Description>
          ) : null}
          {showHeader ? (
            <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{title}</div>
                {description ? (
                  <div className="truncate text-xs text-muted-foreground">
                    {description}
                  </div>
                ) : null}
              </div>
              {headerSlot}
              {showCloseButton ? (
                <DialogPrimitive.Close asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 rounded-full"
                    aria-label={closeLabel}
                  >
                    <PanelRightClose className="size-4" />
                  </Button>
                </DialogPrimitive.Close>
              ) : null}
            </div>
          ) : showCloseButton ? (
            <DialogPrimitive.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-3 top-3 z-10 size-8 rounded-full bg-background/80"
                aria-label={closeLabel}
              >
                <PanelRightClose className="size-4" />
              </Button>
            </DialogPrimitive.Close>
          ) : null}
          <div className={cn("min-h-0 flex-1 overflow-hidden", bodyClassName)}>
            {children}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
