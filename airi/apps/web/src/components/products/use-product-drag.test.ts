/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { MouseSensor, TouchSensor, useSensor } from "@dnd-kit/core";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import {
  droppedTemplate,
  productDragAnnouncements,
  PRODUCT_DRAG_DISTANCE_PX,
  PRODUCT_DRAG_TOUCH_DELAY_MS,
  PRODUCT_DRAG_TOUCH_TOLERANCE_PX,
  useProductDrag,
} from "./use-product-drag";

jest.mock("@dnd-kit/core", () => {
  const actual = jest.requireActual("@dnd-kit/core");
  return { ...actual, useSensor: jest.fn(actual.useSensor) };
});

const over = (templateId: unknown) =>
  ({
    id: `tile:${String(templateId)}`,
    data: { current: { templateId } },
  }) as never;

function setup() {
  const onCarry = jest.fn();
  const onDrop = jest.fn();
  const hook = renderHook(() =>
    useProductDrag({ carried: () => 2, onCarry, onDrop })
  );
  return { ...hook, onCarry, onDrop };
}

test("a tap stays a tap: the mouse moves 6 px and a finger holds 250 ms before a drag", () => {
  setup();
  expect(useSensor).toHaveBeenCalledWith(MouseSensor, {
    activationConstraint: { distance: PRODUCT_DRAG_DISTANCE_PX },
  });
  expect(useSensor).toHaveBeenCalledWith(TouchSensor, {
    activationConstraint: {
      delay: PRODUCT_DRAG_TOUCH_DELAY_MS,
      tolerance: PRODUCT_DRAG_TOUCH_TOLERANCE_PX,
    },
  });
  expect(PRODUCT_DRAG_DISTANCE_PX).toBe(6);
  expect(PRODUCT_DRAG_TOUCH_DELAY_MS).toBe(250);
  expect(PRODUCT_DRAG_TOUCH_TOLERANCE_PX).toBe(8);
});

test("a drag picks the product it starts on, and a drop on a tile makes it", () => {
  const { result, onCarry, onDrop } = setup();
  act(() =>
    result.current.events.onDragStart({
      active: { id: "p1" },
    } as never)
  );
  expect(onCarry).toHaveBeenCalledWith("p1");
  expect(result.current.carrying).toBe("p1");

  act(() =>
    result.current.events.onDragEnd({
      active: { id: "p1" },
      over: over("reel_filmed_sold"),
    } as never)
  );
  expect(result.current.carrying).toBeNull();
  expect(onDrop).toHaveBeenCalledTimes(1);
  expect(onDrop.mock.calls[0]![0]).toMatchObject({ id: "reel_filmed_sold" });
  // The click that ends the drag on its product isn't a tap.
  expect(result.current.justDropped()).toBe(true);
});

test("a drop on nothing, or a cancelled drag, makes nothing", () => {
  const { result, onDrop } = setup();
  act(() =>
    result.current.events.onDragStart({ active: { id: "p1" } } as never)
  );
  act(() =>
    result.current.events.onDragEnd({
      active: { id: "p1" },
      over: null,
    } as never)
  );
  act(() =>
    result.current.events.onDragStart({ active: { id: "p2" } } as never)
  );
  act(() => result.current.events.onDragCancel());
  expect(onDrop).not.toHaveBeenCalled();
  expect(result.current.carrying).toBeNull();
});

test("reads the tile a drop landed on, and nothing else", () => {
  expect(droppedTemplate({ over: over("post_studio") })?.id).toBe(
    "post_studio"
  );
  expect(droppedTemplate({ over: over("not_a_tile") })).toBeNull();
  expect(droppedTemplate({ over: null })).toBeNull();
});

test("tells a screen reader what is carried and where it is over", () => {
  const announce = productDragAnnouncements(() => 3);
  expect(announce.onDragStart({ active: { id: "p1" } } as never)).toBe(
    PRODUCTS_COPY.rows.carrying(3)
  );
  expect(
    announce.onDragOver({
      active: { id: "p1" },
      over: over("chat_kit"),
    } as never)
  ).toBe("WhatsApp chat Carousel + form");
  expect(
    announce.onDragOver({ active: { id: "p1" }, over: null } as never)
  ).toBeUndefined();
});
