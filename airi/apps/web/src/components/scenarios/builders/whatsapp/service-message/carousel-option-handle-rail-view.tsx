"use client";

import { SCENARIO_HANDLE_ANCHOR_CLASS } from "@/components/scenarios/source-handle-button";
import { useLatestRef } from "@/components/scenarios/view/use-latest-ref";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  clusterHiddenConnectedHandles,
  EMPTY_CAROUSEL_OPTION_HANDLE_RAIL_SNAPSHOT,
  readCarouselOptionHandleRail,
  sameCarouselOptionHandleRailSnapshots,
  type CarouselOptionHandleRailSnapshot,
  type CarouselRailCluster,
} from "./carousel-option-handle-rail";

const EMPTY_CONNECTED_OPTION_IDS: ReadonlySet<string> = new Set();

/** Phone chrome uses `px-2`. Shift hidden-connection dots onto the node inner edge. */
const CAROUSEL_OPTION_HANDLE_RAIL_CLASS =
  "pointer-events-none absolute inset-y-0 -right-2 z-30 w-0 overflow-visible";

/**
 * Tracks which carousel cards are in view, so only their buttons show route
 * dots, and gathers the connected routes of the cards scrolled away. Put
 * `wrapRef` on the element around the carousel scroller.
 */
export function useCarouselOptionHandleRail({
  enabled,
  layoutKey,
  connectedOptionIds,
  onViewportChange,
}: {
  /** False when the carousel shows no route dots. */
  enabled: boolean;
  /** Changes whenever the cards or their buttons change. */
  layoutKey: unknown;
  connectedOptionIds?: ReadonlySet<string>;
  onViewportChange?: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [handleRail, setHandleRail] =
    useState<CarouselOptionHandleRailSnapshot>(
      EMPTY_CAROUSEL_OPTION_HANDLE_RAIL_SNAPSHOT
    );
  const onViewportChangeRef = useLatestRef(onViewportChange);

  const syncHandleRail = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap || !enabled) return;
    setHandleRail(current => {
      const next = readCarouselOptionHandleRail(wrap);
      return sameCarouselOptionHandleRailSnapshots(current, next)
        ? current
        : next;
    });
  }, [enabled]);

  const handleViewportChange = useCallback(() => {
    syncHandleRail();
    onViewportChange?.();
  }, [onViewportChange, syncHandleRail]);

  useLayoutEffect(() => {
    syncHandleRail();
  }, [layoutKey, syncHandleRail]);

  const resolvedConnectedOptionIds =
    connectedOptionIds ?? EMPTY_CONNECTED_OPTION_IDS;
  const hiddenConnectionClusters = useMemo(
    () =>
      clusterHiddenConnectedHandles(
        handleRail.options,
        resolvedConnectedOptionIds
      ),
    [handleRail.options, resolvedConnectedOptionIds]
  );

  useLayoutEffect(() => {
    if (!enabled) return;
    onViewportChangeRef.current?.();
  }, [handleRail, enabled, onViewportChangeRef]);

  return {
    wrapRef,
    activeCardIds: handleRail.activeCardIds,
    hiddenConnectionClusters,
    handleViewportChange,
  };
}

/**
 * Connected route dots of the cards scrolled out of view, on the node's
 * inner edge and grouped by button position, with a count when several
 * cards share one.
 */
export function CarouselOptionHandleRail({
  clusters,
  renderHandle,
}: {
  clusters: readonly CarouselRailCluster[];
  /** The route dot of one button, or `null` when it has none. */
  renderHandle: (optionId: string) => ReactNode;
}) {
  const t = useTranslations("Scenarios");
  if (clusters.length === 0) return null;

  return (
    <div
      data-testid="carousel-option-handle-rail"
      className={CAROUSEL_OPTION_HANDLE_RAIL_CLASS}
    >
      {clusters.map(cluster => (
        <div
          key={`hidden-cta-${cluster.optionIndex}`}
          data-testid="carousel-hidden-connection-cluster"
          data-option-index={String(cluster.optionIndex)}
          data-count={String(cluster.optionIds.length)}
          className="absolute right-0 h-0 w-0"
          style={{ top: cluster.top }}
        >
          {cluster.optionIds.map(optionId => {
            const handle = renderHandle(optionId);
            if (!handle) return null;
            return (
              <div
                key={optionId}
                data-testid={`carousel-option-handle-slot-${optionId}`}
                className={cn(
                  "absolute right-0 h-0 w-0",
                  SCENARIO_HANDLE_ANCHOR_CLASS
                )}
              >
                {handle}
              </div>
            );
          })}
          {cluster.optionIds.length > 1 ? (
            <span
              data-testid="carousel-hidden-connection-badge"
              role="img"
              aria-label={t("whatsappServiceCarouselHiddenConnectionCount", {
                count: cluster.optionIds.length,
              })}
              className="pointer-events-none absolute right-3.5 top-0 z-40 flex h-3.5 min-w-3.5 -translate-y-1/2 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-none text-primary-foreground shadow-sm"
            >
              {cluster.optionIds.length}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
