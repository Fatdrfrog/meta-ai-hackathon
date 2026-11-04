"use client";

import {
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
  type ScreenReaderInstructions,
} from "@dnd-kit/core";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import {
  productTemplate,
  type ProductTemplate,
} from "@/lib/products/templates";
import { useCallback, useMemo, useRef, useState } from "react";

// Carrying the picks from the shelf to a tile (studio v3). A press that
// moves 6 px with the mouse, or a 250 ms long-press on a phone, lifts every
// pick as one stack; dropping it on a tile makes that tile, as a tap on the
// tile does. A tap stays a tap: the scenario canvas taught that a click can
// be swallowed by a drag, hence the distance. Mouse and touch have their own
// sensors (as the leads board has), so a finger's sideways swipe still
// scrolls a shelf row instead of starting a drag. The keyboard's path is the
// taps themselves: Space picks, Enter or Space on a tile makes it.

/** How far the mouse moves before a press becomes a drag. */
export const PRODUCT_DRAG_DISTANCE_PX = 6;
/** How long a finger holds before it lifts the picks, and how far it may wander. */
export const PRODUCT_DRAG_TOUCH_DELAY_MS = 250;
export const PRODUCT_DRAG_TOUCH_TOLERANCE_PX = 8;
/** How long after a drag ends a click on its product is the drag's own. */
const AFTER_DROP_MS = 400;

const ROWS = PRODUCTS_COPY.rows;

/** The tile a drop landed on, or null for anywhere else. */
export function droppedTemplate(
  event: Pick<DragEndEvent, "over">
): ProductTemplate | null {
  const data = event.over?.data.current as { templateId?: unknown } | undefined;
  return productTemplate(data?.templateId);
}

/** What a screen reader hears while the picks are carried. */
export function productDragAnnouncements(carried: () => number): Announcements {
  const tileName = (over: { data: { current?: unknown } } | null) => {
    const template = productTemplate(
      (over?.data.current as { templateId?: unknown } | undefined)?.templateId
    );
    return template
      ? `${PRODUCTS_COPY.gallery.groups[template.group]} ${template.label}`
      : null;
  };
  return {
    onDragStart: () => ROWS.carrying(carried()),
    onDragOver: ({ over }) => {
      const name = tileName(over);
      return name ?? undefined;
    },
    onDragEnd: ({ over }) => {
      const name = tileName(over);
      return name ?? undefined;
    },
    onDragCancel: () => undefined,
  };
}

export const PRODUCT_DRAG_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable: ROWS.dragHelp,
};

/**
 * The shelf's drag: its sensors, the product being carried, and the events
 * for DndContext. `onCarry` picks a product a drag started on (dragging an
 * unpicked product picks it first); `onDrop` makes the tile it landed on.
 */
export function useProductDrag({
  carried,
  onCarry,
  onDrop,
}: {
  /** How many picks the stack holds, for the announcement. */
  carried: () => number;
  onCarry: (productId: string) => void;
  onDrop: (template: ProductTemplate) => void;
}) {
  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: PRODUCT_DRAG_DISTANCE_PX },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: PRODUCT_DRAG_TOUCH_DELAY_MS,
        tolerance: PRODUCT_DRAG_TOUCH_TOLERANCE_PX,
      },
    })
  );
  const [carrying, setCarrying] = useState<string | null>(null);
  const endedAt = useRef(0);

  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      const id = String(event.active.id);
      onCarry(id);
      setCarrying(id);
    },
    [onCarry]
  );
  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      setCarrying(null);
      endedAt.current = Date.now();
      const template = droppedTemplate(event);
      if (template) onDrop(template);
    },
    [onDrop]
  );
  const onDragCancel = useCallback(() => {
    setCarrying(null);
    endedAt.current = Date.now();
  }, []);
  /** Whether a click now is the end of a drag, not a tap. */
  const justDropped = useCallback(
    () => Date.now() - endedAt.current < AFTER_DROP_MS,
    []
  );

  const accessibility = useMemo(
    () => ({
      announcements: productDragAnnouncements(carried),
      screenReaderInstructions: PRODUCT_DRAG_INSTRUCTIONS,
    }),
    [carried]
  );

  return {
    sensors,
    /** The product the drag started on, while the picks are carried. */
    carrying,
    events: { onDragStart, onDragEnd, onDragCancel },
    accessibility,
    justDropped,
  };
}
