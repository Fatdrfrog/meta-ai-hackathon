"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";

const CAROUSEL_CAN_SCROLL_LEFT = 1;
const CAROUSEL_CAN_SCROLL_RIGHT = 2;

function readCarouselScrollSnapshot(node: HTMLDivElement | null): number {
  if (!node) return 0;
  const maxScrollLeft = Math.max(0, node.scrollWidth - node.clientWidth);
  return (
    (node.scrollLeft > 2 ? CAROUSEL_CAN_SCROLL_LEFT : 0) |
    (node.scrollLeft < maxScrollLeft - 2 ? CAROUSEL_CAN_SCROLL_RIGHT : 0)
  );
}

function readEmptyCarouselScrollSnapshot(): number {
  return 0;
}

/** Horizontal card strip with always-visible scroll affordance (Mac Safari hides overlay bars). */
export function CarouselCardsScroller({
  children,
  onViewportChange,
  className,
  previousLabel = "Scroll carousel left",
  nextLabel = "Scroll carousel right",
  interactive = true,
  viewportClassName,
  navigationClassName,
  persistentNavigation = false,
}: {
  children: ReactNode;
  onViewportChange?: () => void;
  className?: string;
  previousLabel?: string;
  nextLabel?: string;
  interactive?: boolean;
  viewportClassName?: string;
  navigationClassName?: string;
  persistentNavigation?: boolean;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const onViewportChangeRef = useRef(onViewportChange);
  useEffect(() => {
    onViewportChangeRef.current = onViewportChange;
  }, [onViewportChange]);

  const getScrollSnapshot = useCallback(
    () => readCarouselScrollSnapshot(scrollerRef.current),
    []
  );
  const subscribeToScrollSnapshot = useCallback((onStoreChange: () => void) => {
    const node = scrollerRef.current;
    if (!node) return () => undefined;

    const notifyViewport = () => {
      onStoreChange();
      onViewportChangeRef.current?.();
    };
    node.addEventListener("scroll", notifyViewport, { passive: true });
    window.addEventListener("resize", notifyViewport);
    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(notifyViewport)
        : null;
    const mutationObserver =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(notifyViewport)
        : null;
    resizeObserver?.observe(node);
    mutationObserver?.observe(node, { childList: true });
    onStoreChange();

    return () => {
      node.removeEventListener("scroll", notifyViewport);
      window.removeEventListener("resize", notifyViewport);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, []);

  const scrollSnapshot = useSyncExternalStore(
    subscribeToScrollSnapshot,
    getScrollSnapshot,
    readEmptyCarouselScrollSnapshot
  );
  const canScrollLeft = (scrollSnapshot & CAROUSEL_CAN_SCROLL_LEFT) !== 0;
  const canScrollRight = (scrollSnapshot & CAROUSEL_CAN_SCROLL_RIGHT) !== 0;

  const scrollByCards = (direction: -1 | 1) => {
    const node = scrollerRef.current;
    if (!node) return;
    const firstCard = node.firstElementChild as HTMLElement | null;
    const cardWidth = firstCard?.offsetWidth ?? 0;
    const gap = 8;
    node.scrollBy({
      left: direction * ((cardWidth > 0 ? cardWidth : 200) + gap),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  };

  return (
    <div className={cn("relative overflow-hidden", className)}>
      {interactive &&
      (canScrollLeft || (persistentNavigation && canScrollRight)) ? (
        <Button
          type="button"
          variant="secondary"
          size="icon"
          className={cn(
            "nodrag absolute left-1 top-1/2 z-[1] h-7 w-7 -translate-y-1/2 rounded-full border border-black/10 bg-white/95 shadow-sm dark:border-white/10 dark:bg-[#1f2c33]/95",
            navigationClassName
          )}
          aria-label={previousLabel}
          disabled={!canScrollLeft}
          onPointerDown={event => event.stopPropagation()}
          onClick={() => scrollByCards(-1)}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </Button>
      ) : null}
      {interactive &&
      (canScrollRight || (persistentNavigation && canScrollLeft)) ? (
        <Button
          type="button"
          variant="secondary"
          size="icon"
          className={cn(
            "nodrag absolute right-1 top-1/2 z-[1] h-7 w-7 -translate-y-1/2 rounded-full border border-black/10 bg-white/95 shadow-sm dark:border-white/10 dark:bg-[#1f2c33]/95",
            navigationClassName
          )}
          aria-label={nextLabel}
          disabled={!canScrollRight}
          onPointerDown={event => event.stopPropagation()}
          onClick={() => scrollByCards(1)}
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Button>
      ) : null}
      <div
        ref={scrollerRef}
        data-testid="carousel-cards-viewport"
        tabIndex={interactive ? undefined : -1}
        className={cn(
          "nodrag flex gap-2 overflow-x-auto overflow-y-hidden overscroll-x-contain",
          "[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden",
          viewportClassName
        )}
      >
        {children}
      </div>
    </div>
  );
}
