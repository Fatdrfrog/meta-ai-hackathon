"use client";

import { Button } from "@/components/ui/button";
import {
  closestCenter,
  defaultDropAnimationSideEffects,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTranslations } from "next-intl";
import {
  type ButtonHTMLAttributes,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from "react";
import { ScenarioHierarchyDragOverlay } from "./drag-overlay";
import { ScenarioHierarchyRow } from "./row";
import {
  useScenarioStatusToggle,
  type SaveScenarioStatus,
} from "./use-scenario-status-toggle";
import type { ScenarioRoutingSettingsPatch } from "../../types";
import {
  type ScenarioHierarchyDropPayload,
  type ScenarioHierarchyIssueSummaryByScenarioId,
  type ScenarioHierarchySubscenarioIndicatorByScenarioId,
  type ScenarioListLayoutItem,
} from "./utils";

type ScenarioHierarchyListProps = {
  items: ScenarioListLayoutItem[];
  allItems?: ScenarioListLayoutItem[];
  viewMode?: "journeys" | "flat";
  density?: "comfortable" | "compact";
  scenariosCount: number;
  activeScenarioId: string | null;
  pendingScenarioId?: string | null;
  activeLabel: string;
  draftLabel: string;
  isInteractionDisabled?: boolean;
  onSelectScenario: (scenarioId: string) => void;
  /** Pointer or focus reached a scenario it may open next. */
  onPrefetchScenario?: (scenarioId: string) => void;
  /** Pointer or focus left that scenario again. */
  onCancelScenarioPrefetch?: (scenarioId: string) => void;
  onScenarioNameCommit: (scenarioId: string, value: string) => Promise<boolean>;
  onScenarioSettingsSave?: SaveScenarioStatus;
  onScenarioRoutingSettingsChange?: (
    scenarioId: string,
    patch: ScenarioRoutingSettingsPatch
  ) => Promise<boolean> | boolean;
  disableReorder?: boolean;
  forceExpandAll?: boolean;
  onReorder: (payload: ScenarioHierarchyDropPayload) => void;
  onDeleteScenario?: (scenarioId: string) => void;
  onNormalizeScenarioLayout?: () => void;
  normalizeScenarioLayoutDisabled?: boolean;
  subscenarioIndicatorByScenarioId?: ScenarioHierarchySubscenarioIndicatorByScenarioId;
  issueSummaryByScenarioId?: ScenarioHierarchyIssueSummaryByScenarioId;
};

type ScenarioHierarchyDragState = {
  scenarioId: string | null;
  widthPx: number | null;
};

const DRAG_ACTIVATION_DISTANCE_PX = 12;
const FLAT_SCENARIO_GAP_PX = 12;
const HIERARCHY_WINDOW_SIZE = 200;
const EMPTY_DRAG_STATE: ScenarioHierarchyDragState = {
  scenarioId: null,
  widthPx: null,
};
const EMPTY_SUBSCENARIO_INDICATOR_BY_SCENARIO_ID: ScenarioHierarchySubscenarioIndicatorByScenarioId =
  {};
const EMPTY_ISSUE_SUMMARY_BY_SCENARIO_ID: ScenarioHierarchyIssueSummaryByScenarioId =
  {};

const dragOverlayDropAnimation = {
  duration: 210,
  easing: "cubic-bezier(0.2, 0.7, 0.3, 1)",
  sideEffects: defaultDropAnimationSideEffects({
    styles: {
      active: {
        opacity: "0.45",
      },
    },
  }),
};

function SortableScenarioListItem({
  scenarioId,
  children,
  disabled = false,
}: {
  scenarioId: string;
  children: (params: {
    handleProps: ButtonHTMLAttributes<HTMLButtonElement>;
    isDragging: boolean;
  }) => ReactNode;
  disabled?: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: scenarioId,
    disabled,
  });

  const handleProps = {
    ...attributes,
    ...(listeners ?? {}),
  } as ButtonHTMLAttributes<HTMLButtonElement>;

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: transform ? CSS.Transform.toString(transform) : undefined,
        transition,
      }}
    >
      {children({ handleProps, isDragging })}
    </div>
  );
}

export function ScenarioHierarchyList({
  items,
  allItems,
  viewMode = "journeys",
  density = "comfortable",
  scenariosCount,
  activeScenarioId,
  pendingScenarioId,
  activeLabel,
  draftLabel,
  isInteractionDisabled = false,
  onSelectScenario,
  onPrefetchScenario,
  onCancelScenarioPrefetch,
  onScenarioNameCommit,
  onScenarioSettingsSave,
  onScenarioRoutingSettingsChange,
  disableReorder = false,
  forceExpandAll = false,
  onReorder,
  onDeleteScenario,
  onNormalizeScenarioLayout,
  normalizeScenarioLayoutDisabled = false,
  subscenarioIndicatorByScenarioId = EMPTY_SUBSCENARIO_INDICATOR_BY_SCENARIO_ID,
  issueSummaryByScenarioId = EMPTY_ISSUE_SUMMARY_BY_SCENARIO_ID,
}: ScenarioHierarchyListProps) {
  const t = useTranslations("Scenarios");
  const isCompact = density === "compact";
  const orderedItems = allItems ?? items;
  const [dragState, setDragState] =
    useState<ScenarioHierarchyDragState>(EMPTY_DRAG_STATE);
  const { handleStatusToggle, savingSettingsScenarioId } =
    useScenarioStatusToggle(orderedItems, onScenarioSettingsSave);
  const [collapsedRootIds, setCollapsedRootIds] = useState<string[]>([]);
  const [visibleItemsCount, setVisibleItemsCount] = useState(
    HIERARCHY_WINDOW_SIZE
  );
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: DRAG_ACTIVATION_DISTANCE_PX,
      },
    })
  );

  const listItems = useMemo(() => {
    if (viewMode === "flat") {
      return items.map((layoutItem, index) => ({
        ...layoutItem,
        item: {
          ...layoutItem.item,
          depth: 0,
          rootScenarioId: layoutItem.item.scenario._id,
          directParentScenarioId: null,
        },
        marginTopPx: index === 0 ? 0 : FLAT_SCENARIO_GAP_PX,
      }));
    }

    if (forceExpandAll || collapsedRootIds.length === 0) {
      return items;
    }

    const collapsedSet = new Set(collapsedRootIds);
    return items.filter(layoutItem => {
      if (layoutItem.item.depth === 0) return true;
      return !collapsedSet.has(layoutItem.item.rootScenarioId);
    });
  }, [collapsedRootIds, forceExpandAll, items, viewMode]);

  const childCountByRootId = useMemo(() => {
    const next: Record<string, number> = {};
    for (const layoutItem of orderedItems) {
      if (layoutItem.item.depth === 0) continue;
      next[layoutItem.item.rootScenarioId] =
        (next[layoutItem.item.rootScenarioId] || 0) + 1;
    }
    return next;
  }, [orderedItems]);

  const isWindowedList = listItems.length > HIERARCHY_WINDOW_SIZE;
  const renderedItems = useMemo(() => {
    if (!isWindowedList) return listItems;
    return listItems.slice(0, visibleItemsCount);
  }, [isWindowedList, listItems, visibleItemsCount]);

  const scenarioIds = useMemo(
    () => renderedItems.map(layoutItem => layoutItem.item.scenario._id),
    [renderedItems]
  );
  const scenarioById = useMemo(
    () =>
      new Map(
        orderedItems.map(layoutItem => [
          layoutItem.item.scenario._id,
          layoutItem.item.scenario,
        ])
      ),
    [orderedItems]
  );
  const draggingScenario = useMemo(() => {
    if (!dragState.scenarioId) return null;
    return scenarioById.get(dragState.scenarioId) ?? null;
  }, [dragState.scenarioId, scenarioById]);

  const resolveActiveCenterY = useCallback(
    (event: DragMoveEvent | DragEndEvent): number => {
      const translatedRect = event.active.rect.current.translated;
      if (translatedRect) {
        return translatedRect.top + translatedRect.height / 2;
      }

      const initialRect = event.active.rect.current.initial;
      if (initialRect) {
        return initialRect.top + event.delta.y + initialRect.height / 2;
      }

      return event.over?.rect.top ?? 0;
    },
    []
  );

  const resolveDropPreview = useCallback(
    (
      event: DragMoveEvent | DragEndEvent
    ): ScenarioHierarchyDropPayload | null => {
      if (!event.over) return null;

      const draggedScenarioId = String(event.active.id);
      const overScenarioId = String(event.over.id);
      if (!draggedScenarioId || !overScenarioId) return null;

      const overRect = event.over.rect;
      const activeCenterY = resolveActiveCenterY(event);
      const overCenterY = overRect.top + overRect.height / 2;
      const placement = activeCenterY >= overCenterY ? "after" : "before";
      return {
        draggedScenarioId,
        overScenarioId,
        placement,
      };
    },
    [resolveActiveCenterY]
  );

  const resetDragState = useCallback(() => {
    setDragState(EMPTY_DRAG_STATE);
  }, []);

  const handleDragEnd = (event: DragEndEvent) => {
    if (isInteractionDisabled) {
      resetDragState();
      return;
    }

    const dropPreview = resolveDropPreview(event);

    resetDragState();
    if (!dropPreview) return;
    if (dropPreview.draggedScenarioId === dropPreview.overScenarioId) {
      return;
    }

    onReorder(dropPreview);
  };

  const handleLoadMore = useCallback(() => {
    setVisibleItemsCount(current =>
      Math.min(listItems.length, current + HIERARCHY_WINDOW_SIZE)
    );
  }, [listItems.length]);

  const toggleRootCollapse = useCallback((rootScenarioId: string) => {
    setCollapsedRootIds(current =>
      current.includes(rootScenarioId)
        ? current.filter(id => id !== rootScenarioId)
        : [...current, rootScenarioId]
    );
  }, []);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={event => {
        if (isInteractionDisabled) return;
        setDragState({
          scenarioId: String(event.active.id),
          widthPx: event.active.rect.current.initial?.width ?? null,
        });
      }}
      onDragCancel={resetDragState}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={scenarioIds}
        strategy={verticalListSortingStrategy}
      >
        <div className={isCompact ? "pt-1" : "pt-2"}>
          {renderedItems.map((layoutItem, index) => {
            const { item, marginTopPx } = layoutItem;
            const scenario = item.scenario;
            const nextLayoutItem = renderedItems[index + 1];
            const nextScenarioIsDirectChild =
              nextLayoutItem?.item.directParentScenarioId === scenario._id;
            const isActive = scenario._id === activeScenarioId;
            const depthPadding =
              Math.min(item.depth, 6) * (isCompact ? 10 : 28);
            const isSavingSettings = savingSettingsScenarioId === scenario._id;
            const isDragDisabled =
              isInteractionDisabled || disableReorder || scenariosCount <= 1;
            const canToggleChildren =
              viewMode === "journeys" &&
              !forceExpandAll &&
              item.depth === 0 &&
              (childCountByRootId[scenario._id] || 0) > 0;

            return (
              <SortableScenarioListItem
                key={scenario._id}
                scenarioId={scenario._id}
                disabled={isDragDisabled}
              >
                {({ handleProps, isDragging }) => (
                  <ScenarioHierarchyRow
                    scenario={scenario}
                    marginTopPx={marginTopPx}
                    depthPadding={depthPadding}
                    isActive={isActive}
                    isSelectionPending={pendingScenarioId === scenario._id}
                    isDragging={
                      isDragging || dragState.scenarioId === scenario._id
                    }
                    handleProps={
                      handleProps as ButtonHTMLAttributes<HTMLButtonElement>
                    }
                    isInteractionDisabled={isInteractionDisabled}
                    isDragDisabled={isDragDisabled}
                    activeLabel={activeLabel}
                    draftLabel={draftLabel}
                    density={density}
                    canToggleStatus={Boolean(onScenarioSettingsSave)}
                    isSavingSettings={isSavingSettings}
                    subscenarioIndicator={
                      subscenarioIndicatorByScenarioId[scenario._id]
                    }
                    issueSummary={issueSummaryByScenarioId[scenario._id]}
                    canToggleChildren={canToggleChildren}
                    isCollapsed={collapsedRootIds.includes(scenario._id)}
                    onToggleChildren={
                      canToggleChildren
                        ? () => toggleRootCollapse(scenario._id)
                        : undefined
                    }
                    nextScenarioIsDirectChild={nextScenarioIsDirectChild}
                    showNormalizeLayoutButton={
                      Boolean(onNormalizeScenarioLayout) &&
                      scenario._id === activeScenarioId
                    }
                    normalizeScenarioLayoutDisabled={
                      normalizeScenarioLayoutDisabled
                    }
                    onSelectScenario={onSelectScenario}
                    onPrefetchScenario={onPrefetchScenario}
                    onCancelScenarioPrefetch={onCancelScenarioPrefetch}
                    onScenarioNameCommit={onScenarioNameCommit}
                    onStatusToggle={handleStatusToggle}
                    onScenarioRoutingSettingsChange={
                      onScenarioRoutingSettingsChange
                    }
                    onDeleteScenario={
                      onDeleteScenario && scenariosCount > 1
                        ? onDeleteScenario
                        : undefined
                    }
                    onNormalizeScenarioLayout={onNormalizeScenarioLayout}
                  />
                )}
              </SortableScenarioListItem>
            );
          })}
          {isWindowedList && renderedItems.length < listItems.length ? (
            <div className="mt-3 flex justify-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleLoadMore}
                disabled={isInteractionDisabled}
              >
                {t("loadMoreScenarios", {
                  loaded: renderedItems.length,
                  total: listItems.length,
                })}
              </Button>
            </div>
          ) : null}
        </div>
      </SortableContext>

      <DragOverlay dropAnimation={dragOverlayDropAnimation}>
        <ScenarioHierarchyDragOverlay
          scenario={draggingScenario}
          widthPx={dragState.widthPx}
          activeLabel={activeLabel}
          draftLabel={draftLabel}
        />
      </DragOverlay>
    </DndContext>
  );
}
