/** @jest-environment jsdom */
import { act, render } from "@testing-library/react";
import type { ComponentProps, ReactNode, Ref } from "react";
import { ScenariosSidebarPanel } from "./scenarios-sidebar-panel";

const mockResize = jest.fn();
const mockPanel = jest.fn();
const mockObservers = new Map<Element, () => void>();
// The list's size in the panel group, in percent, and how the group resizes
// it on its own: a drag, arrow keys or the settings dock taking room.
const mockLayout = {
  size: null as number | null,
  groupResize: null as ((size: number) => void) | null,
};

// react-resizable-panels ships ESM only. This stand-in keeps its sizing
// contract: sizes are percentages clamped to minSize/maxSize, and onResize
// reports every change synchronously, whether from a drag, resize() or the
// clamp that follows new constraints. Resizing the group reports nothing.
jest.mock("@/components/ui/resizable", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  function ResizablePanel({
    ref,
    ...props
  }: {
    ref: Ref<unknown>;
    defaultSize: number;
    minSize: number;
    maxSize: number;
    onResize: (size: number) => void;
    children: ReactNode;
  }) {
    mockPanel(props);
    const setSize = (size: number) => {
      const next = Math.min(props.maxSize, Math.max(props.minSize, size));
      if (next === mockLayout.size) return;
      mockLayout.size = next;
      props.onResize(next);
    };
    // Registration and new constraints settle before the host's effects run.
    React.useLayoutEffect(() => {
      mockLayout.groupResize = setSize;
      setSize(mockLayout.size ?? props.defaultSize);
    });
    React.useImperativeHandle(ref, () => ({
      resize: (size: number) => {
        mockResize(size);
        setSize(size);
      },
    }));
    return <div>{props.children}</div>;
  }
  return { ResizablePanel };
});
jest.mock("@/lib/observe-element-resize", () => ({
  observeElementResize: (element: Element, callback: () => void) => {
    mockObservers.set(element, callback);
    return () => mockObservers.delete(element);
  },
}));
jest.mock("./scenarios-sidebar", () => ({
  ScenariosSidebar: ({ layoutMode }: { layoutMode: string }) => (
    <aside data-layout-mode={layoutMode} />
  ),
}));

function setup(width: number) {
  // The group points the list's handle at it and marks the handle active
  // while it is dragged or has keyboard focus.
  const { container, unmount } = render(
    <div data-panel-group>
      <ScenariosSidebarPanel
        {...({} as ComponentProps<typeof ScenariosSidebarPanel>)}
      />
      <div data-resize-handle aria-controls="scenario-sidebar" />
    </div>
  );
  const group = container.firstElementChild!;
  const handle = group.lastElementChild!;
  const sidebar = container.querySelector("aside")!;
  let groupWidth = width;
  const listWidth = () => (mockLayout.size! * groupWidth) / 100;
  const resizeGroup = (nextWidth: number) => {
    groupWidth = nextWidth;
    jest
      .spyOn(group, "getBoundingClientRect")
      .mockReturnValue({ width: nextWidth } as DOMRect);
    act(() => mockObservers.get(group)!());
  };
  // The settings dock takes room from the list with no list handle active.
  const dockResizesList = (listPx: number) =>
    act(() => mockLayout.groupResize!((listPx / groupWidth) * 100));
  const focusListHandle = () =>
    handle.setAttribute("data-resize-handle-active", "keyboard");
  const dragList = (listPx: number, active = "pointer") => {
    handle.setAttribute("data-resize-handle-active", active);
    dockResizesList(listPx);
    handle.removeAttribute("data-resize-handle-active");
  };
  // The layout the list renders once its new width is measured.
  const layoutMode = () => {
    const measured = sidebar.parentElement!;
    jest
      .spyOn(measured, "getBoundingClientRect")
      .mockReturnValue({ width: listWidth() } as DOMRect);
    act(() => mockObservers.get(measured)!());
    return sidebar.dataset.layoutMode;
  };
  resizeGroup(width);
  return {
    resizeGroup,
    dragList,
    focusListHandle,
    dockResizesList,
    listWidth,
    layoutMode,
    unmount,
  };
}

describe("ScenariosSidebarPanel sizing", () => {
  beforeEach(() => {
    mockResize.mockClear();
    mockPanel.mockClear();
    mockObservers.clear();
    mockLayout.size = null;
    mockLayout.groupResize = null;
  });

  it.each([320, 390, 768, 1365, 2560])(
    "uses a readable initial width on a %spx canvas",
    width => {
      setup(width);
      expect(mockResize).toHaveBeenLastCalledWith(
        ((width < 768 ? 64 : 320) / width) * 100
      );
      const constraints = mockPanel.mock.calls.at(-1)![0];
      expect((constraints.minSize * width) / 100).toBeCloseTo(64);
      expect((constraints.maxSize * width) / 100).toBeCloseTo(
        Math.min(420, width * 0.42)
      );
    }
  );

  it("keeps the list's width in pixels when the canvas narrows", () => {
    const { resizeGroup, listWidth, layoutMode } = setup(1280);
    resizeGroup(832);
    // Keeping only the percentage left 208px here, the icon rail.
    expect(mockResize).toHaveBeenLastCalledWith((320 / 832) * 100);
    expect(listWidth()).toBeCloseTo(320);
    expect(layoutMode()).toBe("compact");
  });

  it.each(["pointer", "keyboard"])(
    "keeps a width the user sets with the list's handle (%s) across later canvas resizes",
    active => {
      const { resizeGroup, dragList, listWidth, layoutMode } = setup(1280);
      mockResize.mockClear();
      dragList(400, active);
      expect(mockResize).not.toHaveBeenCalled();
      for (const width of [1600, 1100, 1280]) {
        resizeGroup(width);
        expect(listWidth()).toBeCloseTo(400);
      }
      expect(layoutMode()).toBe("comfortable");
    }
  );

  it("keeps the chosen width across resizes while its handle keeps focus", () => {
    // Arrow keys leave the handle focused, so still active, as the window
    // resizes. Our resize() and the cap's clamps still set no width.
    const { resizeGroup, dragList, focusListHandle, listWidth } = setup(1280);
    dragList(400, "keyboard");
    focusListHandle();
    resizeGroup(2560);
    expect(listWidth()).toBeCloseTo(400);
    resizeGroup(900);
    expect(listWidth()).toBeCloseTo(378);
    resizeGroup(1280);
    expect(listWidth()).toBeCloseTo(400);
  });

  it("keeps the width when a wider canvas clamps the old percentage", () => {
    const { resizeGroup, listWidth } = setup(1280);
    resizeGroup(2560);
    expect(listWidth()).toBeCloseTo(320);
    resizeGroup(1280);
    expect(listWidth()).toBeCloseTo(320);
  });

  it("still caps the list at 42% of the canvas and 420px", () => {
    const { resizeGroup, dragList, listWidth } = setup(1280);
    dragList(600);
    expect(listWidth()).toBeCloseTo(420);
    resizeGroup(900);
    expect(mockResize).toHaveBeenLastCalledWith((420 / 900) * 100);
    expect(mockPanel.mock.calls.at(-1)![0].maxSize).toBe(42);
    expect(listWidth()).toBeCloseTo(378);
    // Neither cap lowers the width the list returns to.
    resizeGroup(2560);
    expect(listWidth()).toBeCloseTo(420);
    resizeGroup(1280);
    expect(listWidth()).toBeCloseTo(420);
  });

  it("folds into the rail below 768px and restores the last chosen width", () => {
    const { resizeGroup, dragList, listWidth, layoutMode } = setup(1365);
    dragList(380);
    resizeGroup(390);
    expect(mockResize).toHaveBeenLastCalledWith((64 / 390) * 100);
    expect(layoutMode()).toBe("rail");
    // Manual resizing in the narrow layout stays with the panel library and
    // is not remembered as the list's width.
    dragList(200);
    mockResize.mockClear();
    resizeGroup(320);
    expect(mockResize).not.toHaveBeenCalled();
    resizeGroup(1365);
    expect(mockResize).toHaveBeenLastCalledWith((380 / 1365) * 100);
    expect(listWidth()).toBeCloseTo(380);
  });

  it("returns to the chosen width after the settings dock squeezes the list", () => {
    // Past the canvas minimum, reopening the dock (expand()) or dragging its
    // handle takes room from the list. That is not a width the user chose.
    const { resizeGroup, dragList, dockResizesList, listWidth } = setup(1300);
    dragList(380);
    resizeGroup(1100);
    expect(listWidth()).toBeCloseTo(380);
    dockResizesList(300);
    expect(listWidth()).toBeCloseTo(300);
    resizeGroup(1300);
    expect(mockResize).toHaveBeenLastCalledWith((380 / 1300) * 100);
    expect(listWidth()).toBeCloseTo(380);
  });

  it("keeps a stable identity first in the panel group that can hold node settings", () => {
    setup(1365);
    expect(mockPanel.mock.calls.at(-1)![0]).toMatchObject({
      id: "scenario-sidebar",
      order: 1,
    });
  });

  it("releases both measurement observers on unmount", () => {
    const { unmount } = setup(1365);
    expect(mockObservers.size).toBe(2);
    unmount();
    expect(mockObservers.size).toBe(0);
  });
});
