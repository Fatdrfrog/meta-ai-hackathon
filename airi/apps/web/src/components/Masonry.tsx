"use client";

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { gsap } from "gsap";

const DEFAULT_QUERIES = [
  "(min-width:1500px)",
  "(min-width:1120px)",
  "(min-width:760px)",
  "(min-width:520px)",
] as const;

const DEFAULT_COLUMN_VALUES = [5, 4, 3, 2] as const;

function canUseDom() {
  return (
    typeof window !== "undefined" && typeof window.matchMedia === "function"
  );
}

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

function useMedia(
  queries: readonly string[],
  values: readonly number[],
  defaultValue: number
): number {
  const get = useCallback(() => {
    if (!canUseDom()) return defaultValue;
    const index = queries.findIndex(query => window.matchMedia(query).matches);
    return values[index] ?? defaultValue;
  }, [defaultValue, queries, values]);

  const [value, setValue] = useState<number>(get);

  useEffect(() => {
    if (!canUseDom()) return;
    const handler = () => setValue(get());
    const mediaQueries = queries.map(query => window.matchMedia(query));
    mediaQueries.forEach(query => query.addEventListener("change", handler));
    handler();
    return () =>
      mediaQueries.forEach(query =>
        query.removeEventListener("change", handler)
      );
  }, [get, queries]);

  return value;
}

function useMeasure<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useIsomorphicLayoutEffect(() => {
    if (!ref.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return [ref, size] as const;
}

type GridItem<TItem> = {
  item: TItem;
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type MasonryProps<TItem> = {
  items: TItem[];
  getKey: (item: TItem) => string;
  getHeight: (item: TItem, columnWidth: number) => number;
  renderItem: (item: TItem) => React.ReactNode;
  gap?: number;
  minColumnWidth?: number;
  queries?: readonly string[];
  columnValues?: readonly number[];
  defaultColumns?: number;
  ease?: string;
  duration?: number;
  stagger?: number;
  animateFrom?: "bottom" | "top" | "left" | "right" | "center" | "random";
  scaleOnHover?: boolean;
  hoverScale?: number;
  blurToFocus?: boolean;
  className?: string;
  itemClassName?: string;
  onItemClick?: (item: TItem) => void;
};

function MasonryMeasuredItem({
  itemKey,
  children,
  onHeight,
}: {
  itemKey: string;
  children: React.ReactNode;
  onHeight: (key: string, height: number) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useIsomorphicLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const updateHeight = () => {
      onHeight(itemKey, Math.ceil(element.getBoundingClientRect().height));
    };

    updateHeight();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, [itemKey, onHeight]);

  return (
    <div ref={ref} className="w-full">
      {children}
    </div>
  );
}

function clampColumnsByWidth(
  requestedColumns: number,
  width: number,
  minColumnWidth: number,
  gap: number
) {
  if (!width) return requestedColumns;
  const maxColumns = Math.max(
    1,
    Math.floor((width + gap) / Math.max(1, minColumnWidth + gap))
  );
  return Math.max(1, Math.min(requestedColumns, maxColumns));
}

function prefersReducedMotion() {
  if (!canUseDom()) return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function escapeMasonryKey(key: string) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(key);
  }
  return key.replace(/["\\]/g, "\\$&");
}

function Masonry<TItem>({
  items,
  getKey,
  getHeight,
  renderItem,
  gap = 16,
  minColumnWidth = 220,
  queries = DEFAULT_QUERIES,
  columnValues = DEFAULT_COLUMN_VALUES,
  defaultColumns = 1,
  ease = "power3.out",
  duration = 0.45,
  stagger = 0.035,
  animateFrom = "bottom",
  scaleOnHover = false,
  hoverScale = 0.98,
  blurToFocus = false,
  className,
  itemClassName,
  onItemClick,
}: MasonryProps<TItem>) {
  const requestedColumns = useMedia(queries, columnValues, defaultColumns);
  const [containerRef, { width }] = useMeasure<HTMLDivElement>();
  const [measuredHeights, setMeasuredHeights] = useState<
    Record<string, number>
  >({});
  const hasMounted = useRef(false);
  const reduceMotion = prefersReducedMotion();

  const handleMeasuredHeight = useCallback((key: string, height: number) => {
    setMeasuredHeights(previous => {
      if (Math.abs((previous[key] ?? 0) - height) < 1) return previous;
      return { ...previous, [key]: height };
    });
  }, []);

  const liveMeasuredHeights = useMemo(() => {
    const liveKeys = new Set(items.map(item => getKey(item)));
    return Object.fromEntries(
      Object.entries(measuredHeights).filter(([key]) => liveKeys.has(key))
    );
  }, [getKey, items, measuredHeights]);

  const grid = useMemo<GridItem<TItem>[]>(() => {
    if (!width) return [];
    const columns = clampColumnsByWidth(
      requestedColumns,
      width,
      minColumnWidth,
      gap
    );
    const columnHeights = new Array(columns).fill(0) as number[];
    const totalGaps = (columns - 1) * gap;
    const columnWidth = (width - totalGaps) / columns;

    return items.map(item => {
      const key = getKey(item);
      const column = columnHeights.indexOf(Math.min(...columnHeights));
      const x = column * (columnWidth + gap);
      const y = columnHeights[column] ?? 0;
      const h = Math.max(
        1,
        liveMeasuredHeights[key] ?? getHeight(item, columnWidth)
      );
      columnHeights[column] = y + h + gap;
      return {
        item,
        key,
        x,
        y,
        w: columnWidth,
        h,
      };
    });
  }, [
    gap,
    getHeight,
    getKey,
    items,
    liveMeasuredHeights,
    minColumnWidth,
    requestedColumns,
    width,
  ]);

  const containerHeight = useMemo(() => {
    if (grid.length === 0) return 0;
    return Math.max(...grid.map(item => item.y + item.h));
  }, [grid]);

  const getInitialPosition = useCallback(
    (item: GridItem<TItem>) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { x: item.x, y: item.y };

      let direction = animateFrom;
      if (direction === "random") {
        const directions = ["top", "bottom", "left", "right"] as const;
        direction = directions[Math.floor(Math.random() * directions.length)];
      }

      switch (direction) {
        case "top":
          return { x: item.x, y: -item.h - gap };
        case "bottom":
          return { x: item.x, y: window.innerHeight + gap };
        case "left":
          return { x: -item.w - gap, y: item.y };
        case "right":
          return { x: window.innerWidth + gap, y: item.y };
        case "center":
          return {
            x: rect.width / 2 - item.w / 2,
            y: rect.height / 2 - item.h / 2,
          };
        default:
          return { x: item.x, y: item.y + 80 };
      }
    },
    [animateFrom, containerRef, gap]
  );

  useIsomorphicLayoutEffect(() => {
    if (!width || grid.length === 0) return;

    if (reduceMotion) {
      grid.forEach(item => {
        gsap.set(`[data-masonry-key="${escapeMasonryKey(item.key)}"]`, {
          opacity: 1,
          x: item.x,
          y: item.y,
          width: item.w,
          height: item.h,
          clearProps: "filter",
        });
      });
      hasMounted.current = true;
      return;
    }

    grid.forEach((item, index) => {
      const selector = `[data-masonry-key="${escapeMasonryKey(item.key)}"]`;
      const next = {
        x: item.x,
        y: item.y,
        width: item.w,
        height: item.h,
      };

      if (!hasMounted.current) {
        const start = getInitialPosition(item);
        gsap.fromTo(
          selector,
          {
            opacity: 0,
            x: start.x,
            y: start.y,
            width: item.w,
            height: item.h,
            ...(blurToFocus ? { filter: "blur(8px)" } : {}),
          },
          {
            opacity: 1,
            ...next,
            ...(blurToFocus ? { filter: "blur(0px)" } : {}),
            duration: 0.65,
            ease,
            delay: index * stagger,
          }
        );
      } else {
        gsap.to(selector, {
          ...next,
          opacity: 1,
          duration,
          ease,
          overwrite: "auto",
        });
      }
    });

    hasMounted.current = true;
  }, [
    blurToFocus,
    duration,
    ease,
    getInitialPosition,
    grid,
    reduceMotion,
    stagger,
    width,
  ]);

  const handleMouseEnter = useCallback(
    (key: string) => {
      if (!scaleOnHover || reduceMotion) return;
      gsap.to(`[data-masonry-key="${escapeMasonryKey(key)}"]`, {
        scale: hoverScale,
        duration: 0.2,
        ease: "power2.out",
      });
    },
    [hoverScale, reduceMotion, scaleOnHover]
  );

  const handleMouseLeave = useCallback(
    (key: string) => {
      if (!scaleOnHover || reduceMotion) return;
      gsap.to(`[data-masonry-key="${escapeMasonryKey(key)}"]`, {
        scale: 1,
        duration: 0.2,
        ease: "power2.out",
      });
    },
    [reduceMotion, scaleOnHover]
  );

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ position: "relative", width: "100%", height: containerHeight }}
    >
      {grid.map(gridItem => (
        <div
          key={gridItem.key}
          data-masonry-key={gridItem.key}
          className={itemClassName}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: gridItem.w,
            height: gridItem.h,
            opacity: reduceMotion ? 1 : 0,
            willChange: "transform,width,height,opacity",
          }}
          onClick={() => onItemClick?.(gridItem.item)}
          onMouseEnter={() => handleMouseEnter(gridItem.key)}
          onMouseLeave={() => handleMouseLeave(gridItem.key)}
        >
          <MasonryMeasuredItem
            itemKey={gridItem.key}
            onHeight={handleMeasuredHeight}
          >
            {renderItem(gridItem.item)}
          </MasonryMeasuredItem>
        </div>
      ))}
    </div>
  );
}

export default Masonry;
