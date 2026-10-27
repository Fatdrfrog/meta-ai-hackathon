"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  DASHBOARD_CARD_IDS,
  snapBoardCardSize,
  type AnalyticsBoardCard,
  type BoardGridMetrics,
  type DashboardCardId,
} from "./dashboard-board-model";

type GridProps<CardId extends string> = {
  cards: AnalyticsBoardCard<CardId>[];
  editing: boolean;
  onCardsChange: (cards: AnalyticsBoardCard<CardId>[]) => void;
  renderCard: (id: CardId) => ReactNode;
  getCardLabel?: (id: CardId) => string;
  gridLabel?: string;
};

export function DashboardBoardGrid<CardId extends string = DashboardCardId>({
  cards,
  editing,
  onCardsChange,
  renderCard,
  getCardLabel,
  gridLabel,
}: GridProps<CardId>) {
  const t = useTranslations("DashboardClientPage.board");
  const gridRef = useRef<HTMLDivElement>(null);
  const cardLabel = (id: string | number) => {
    const card = cards.find(item => item.id === id);
    if (card && getCardLabel) return getCardLabel(card.id);
    const dashboardId = DASHBOARD_CARD_IDS.find(item => item === String(id));
    return dashboardId ? t(`cards.${dashboardId}`) : String(id);
  };
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function move(from: number, to: number) {
    if (editing && from !== to && to >= 0 && to < cards.length)
      onCardsChange(arrayMove(cards, from, to));
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = cards.findIndex(card => card.id === active.id);
    const to = cards.findIndex(card => card.id === over.id);
    if (from >= 0 && to >= 0) move(from, to);
  }

  function removeCard(index: number) {
    const nextCard = cards[index + 1] ?? cards[index - 1];
    onCardsChange(cards.filter((_, cardIndex) => cardIndex !== index));
    requestAnimationFrame(() => {
      const nextSettings =
        nextCard &&
        gridRef.current?.querySelector<HTMLButtonElement>(
          `[data-card-id="${nextCard.id}"] [data-card-settings]`
        );
      (nextSettings || gridRef.current)?.focus();
    });
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      accessibility={{
        screenReaderInstructions: { draggable: t("dragInstructions") },
        announcements: {
          onDragStart: ({ active }) =>
            t("dragStarted", { card: cardLabel(active.id) }),
          onDragOver: ({ active, over }) =>
            over && over.id !== active.id
              ? t("dragPosition", {
                  card: cardLabel(active.id),
                  position: cards.findIndex(card => card.id === over.id) + 1,
                })
              : undefined,
          onDragEnd: ({ active, over }) =>
            t(over ? "dragDropped" : "dragCancelled", {
              card: cardLabel(active.id),
              position: over
                ? cards.findIndex(card => card.id === over.id) + 1
                : 0,
            }),
          onDragCancel: ({ active }) =>
            t("dragCancelled", { card: cardLabel(active.id) }),
        },
      }}
    >
      <SortableContext
        items={cards.map(card => card.id)}
        strategy={rectSortingStrategy}
      >
        <div
          ref={gridRef}
          tabIndex={-1}
          aria-label={gridLabel ?? t("grid")}
          className="grid min-w-0 grid-cols-1 items-stretch gap-3 sm:grid-cols-2 sm:auto-rows-[minmax(145px,auto)] xl:grid-cols-4"
        >
          {cards.map((card, index) => (
            <BoardCard
              key={card.id}
              card={card}
              label={cardLabel(card.id)}
              editing={editing}
              index={index}
              count={cards.length}
              onSizeChange={size =>
                onCardsChange(
                  cards.map(item =>
                    item.id === card.id ? { ...item, ...size } : item
                  )
                )
              }
              onMove={offset => move(index, index + offset)}
              onRemove={() => removeCard(index)}
            >
              {renderCard(card.id)}
            </BoardCard>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

type CardSize = Pick<AnalyticsBoardCard<string>, "width" | "height">;

/** Read the rendered grid tracks once per drag; null below two columns. */
function measureBoardGrid(
  card: HTMLElement,
  height: number
): BoardGridMetrics | null {
  const grid = card.parentElement;
  if (!grid) return null;
  const style = window.getComputedStyle(grid);
  const tracks = style.gridTemplateColumns.split(" ").filter(Boolean);
  const columnWidth = Number.parseFloat(tracks[0] ?? "");
  const columnGap = Number.parseFloat(style.columnGap) || 0;
  const rowGap = Number.parseFloat(style.rowGap) || 0;
  const rowHeight =
    (card.getBoundingClientRect().height - (height - 1) * rowGap) / height;
  if (tracks.length < 2 || !(columnWidth > 0) || !(rowHeight > 0)) return null;
  return {
    columns: tracks.length,
    columnWidth,
    columnGap,
    rowHeight,
    rowGap,
  };
}

function BoardCard({
  card,
  label,
  editing,
  index,
  count,
  onSizeChange,
  onMove,
  onRemove,
  children,
}: {
  card: AnalyticsBoardCard<string>;
  label: string;
  editing: boolean;
  index: number;
  count: number;
  onSizeChange: (size: Partial<CardSize>) => void;
  onMove: (offset: number) => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  const t = useTranslations("DashboardClientPage.board");
  const widthId = useId();
  const heightId = useId();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: card.id, disabled: !editing });
  const cardElement = useRef<HTMLDivElement | null>(null);
  const resize = useRef<{
    pointerId: number;
    x: number;
    y: number;
    metrics: BoardGridMetrics;
  } | null>(null);
  // Live preview while the resize handle is dragged; committed on release only.
  const [preview, setPreview] = useState<CardSize | null>(null);
  const size = preview ?? card;
  const desktopWidth = [
    "",
    "xl:col-span-1",
    "xl:col-span-2",
    "xl:col-span-3",
    "xl:col-span-4",
  ][size.width];
  const rowSpan = ["", "sm:row-span-1", "sm:row-span-2", "sm:row-span-3"][
    size.height
  ];

  useEffect(() => {
    if (!preview) return;
    function cancelOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      resize.current = null;
      setPreview(null);
    }
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [preview]);

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!editing || event.button !== 0 || !cardElement.current) return;
    const metrics = measureBoardGrid(cardElement.current, card.height);
    if (!metrics) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    resize.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      metrics,
    };
    setPreview({ width: card.width, height: card.height });
  }

  function snapTo(event: ReactPointerEvent<HTMLDivElement>) {
    const active = resize.current;
    if (!active || active.pointerId !== event.pointerId) return null;
    return snapBoardCardSize(
      card,
      { x: event.clientX - active.x, y: event.clientY - active.y },
      active.metrics
    );
  }

  function moveResize(event: ReactPointerEvent<HTMLDivElement>) {
    const next = snapTo(event);
    if (!next) return;
    setPreview(current =>
      current?.width === next.width && current.height === next.height
        ? current
        : next
    );
  }

  function endResize(
    event: ReactPointerEvent<HTMLDivElement>,
    commit: boolean
  ) {
    const next = snapTo(event);
    if (!next) return;
    resize.current = null;
    setPreview(null);
    if (commit && (next.width !== card.width || next.height !== card.height))
      onSizeChange(next);
  }

  return (
    <div
      ref={node => {
        setNodeRef(node);
        cardElement.current = node;
      }}
      data-card-id={card.id}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={cn(
        "relative col-span-1 flex min-w-0 flex-col rounded-xl motion-reduce:!transition-none",
        size.width > 1 ? "sm:col-span-2" : "sm:col-span-1",
        desktopWidth,
        rowSpan,
        editing && "ring-1 ring-primary/25",
        preview && "z-10 ring-2 ring-primary",
        isDragging && "z-10 opacity-70 shadow-lg"
      )}
    >
      {editing && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-1 rounded-t-xl border-b bg-background px-2 py-1.5">
          <Button
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            aria-label={`${t("move")}: ${label}`}
            variant="ghost"
            size="sm"
            className="h-8 cursor-grab touch-none px-2 text-xs active:cursor-grabbing"
          >
            {t("move")}
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                data-card-settings
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-xs"
                aria-label={`${t("cardSettings")}: ${label}`}
              >
                {t("cardSettings")}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              aria-label={`${t("cardSettings")}: ${label}`}
              className="w-64 max-w-[calc(100vw-2rem)] space-y-4"
            >
              <p className="break-words text-sm font-medium">{label}</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor={widthId}>{t("width")}</Label>
                  <select
                    id={widthId}
                    value={card.width}
                    onChange={event =>
                      onSizeChange({
                        width: Number(
                          event.target.value
                        ) as AnalyticsBoardCard<string>["width"],
                      })
                    }
                    className="border-input bg-background focus-visible:ring-ring h-9 w-full appearance-none rounded-md border px-2 text-sm outline-none focus-visible:ring-2"
                  >
                    {[1, 2, 3, 4].map(width => (
                      <option key={width} value={width}>
                        {t(`widthChoices.${width}`)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor={heightId}>{t("height")}</Label>
                  <select
                    id={heightId}
                    value={card.height}
                    onChange={event =>
                      onSizeChange({
                        height: Number(
                          event.target.value
                        ) as AnalyticsBoardCard<string>["height"],
                      })
                    }
                    className="border-input bg-background focus-visible:ring-ring h-9 w-full appearance-none rounded-md border px-2 text-sm outline-none focus-visible:ring-2"
                  >
                    {[1, 2, 3].map(height => (
                      <option key={height} value={height}>
                        {t(`heightChoices.${height}`)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{t("sizeHint")}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={index === 0}
                  onClick={() => onMove(-1)}
                >
                  {t("earlier")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={index === count - 1}
                  onClick={() => onMove(1)}
                >
                  {t("later")}
                </Button>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={onRemove}
              >
                {t("remove")}
              </Button>
            </PopoverContent>
          </Popover>
        </div>
      )}
      <div className="min-w-0 flex-1 rounded-xl [&>[data-slot=card]]:min-w-0 sm:[&>[data-slot=card]]:h-full">
        {children}
      </div>
      {editing && (
        // Pointer shortcut only; Card settings keeps the keyboard size controls.
        <div
          data-resize-handle
          aria-hidden="true"
          title={t("resizeHint")}
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={event => endResize(event, true)}
          onPointerCancel={event => endResize(event, false)}
          className="absolute bottom-0 right-0 z-10 hidden size-6 cursor-se-resize touch-none items-end justify-end p-1.5 sm:flex"
        >
          <span className="size-2.5 rounded-br-sm border-b-2 border-r-2 border-muted-foreground/70" />
        </div>
      )}
      {preview && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-2 right-8 z-10 rounded-md bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground"
        >
          {t("resizePreview", {
            width: preview.width,
            height: preview.height,
          })}
        </span>
      )}
    </div>
  );
}
