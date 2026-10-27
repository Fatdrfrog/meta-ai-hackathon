/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react";
import type { ScenarioGraphEditor } from "./graph/controller-utils";
import type { ScenarioFlowNode } from "../types";
import { useHelperLines } from "./helper-lines";

function createNode(
  id: string,
  position: { x: number; y: number },
  measured = { width: 100, height: 100 }
): ScenarioFlowNode {
  return {
    id,
    position,
    measured,
    data: { kind: "action", actionType: "reply" },
  } as ScenarioFlowNode;
}

function createAnimationFrameController() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();

  const request = jest.fn((callback: FrameRequestCallback) => {
    const id = nextId;
    nextId += 1;
    callbacks.set(id, callback);
    return id;
  });
  const cancel = jest.fn((id: number) => {
    callbacks.delete(id);
  });
  const flush = () => {
    const pending = Array.from(callbacks.entries());
    callbacks.clear();
    pending.forEach(([, callback]) => callback(0));
  };

  return { request, cancel, flush };
}

function createGraphReader(
  nodes: ScenarioFlowNode[]
): Pick<ScenarioGraphEditor, "read"> {
  return { read: () => ({ nodes, edges: [] }) };
}

describe("useHelperLines", () => {
  let animationFrame: ReturnType<typeof createAnimationFrameController>;
  beforeEach(() => {
    animationFrame = createAnimationFrameController();
    jest
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation(animationFrame.request);
    jest
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(animationFrame.cancel);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([true, false])(
    "passes one snap to the document owner at drag stop (frame flushed: %s)",
    flushFrame => {
      const draggedNode = createNode("dragged", { x: 96, y: 0 });
      const targetNode = createNode("target", { x: 100, y: 200 });
      const graphEditor = createGraphReader([draggedNode, targetNode]);
      const finishNodeDrag = jest.fn();
      const { result } = renderHook(() =>
        useHelperLines({ graphEditor, finishNodeDrag })
      );
      act(() => {
        result.current.onNodeDrag({} as MouseEvent, draggedNode, [
          draggedNode,
        ]);
        if (flushFrame) animationFrame.flush();
      });
      if (flushFrame)
        expect(result.current.helperLines).toEqual({
          horizontal: null,
          vertical: 100,
        });
      expect(finishNodeDrag).not.toHaveBeenCalled();
      act(() => result.current.handleNodeDragStop());
      expect(finishNodeDrag).toHaveBeenCalledTimes(1);
      expect(finishNodeDrag).toHaveBeenCalledWith({
        nodeId: "dragged",
        x: 100,
        y: null,
      });
      expect(result.current.helperLines).toEqual({
        horizontal: null,
        vertical: null,
      });
    }
  );

  it("does not rerender when repeated drag frames keep the same visible lines", () => {
    const draggedNode = createNode("dragged", { x: 96, y: 0 });
    const graphEditor = createGraphReader([
      draggedNode,
      createNode("target", { x: 100, y: 200 }),
    ]);
    const finishNodeDrag = jest.fn();
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useHelperLines({ graphEditor, finishNodeDrag });
    });
    act(() => {
      result.current.onNodeDrag({} as MouseEvent, draggedNode, [
        draggedNode,
      ]);
      animationFrame.flush();
    });
    const afterFirstFrame = renderCount;
    act(() => {
      result.current.onNodeDrag({} as MouseEvent, draggedNode, [
        draggedNode,
      ]);
      animationFrame.flush();
    });
    expect(renderCount).toBe(afterFirstFrame);
    expect(finishNodeDrag).not.toHaveBeenCalled();
  });

  it.each(["multiple nodes", "disabled"])(
    "finishes without snapping when alignment is unavailable: %s",
    reason => {
      const draggedNode = createNode("dragged", { x: 96, y: 0 });
      const targetNode = createNode("target", { x: 100, y: 200 });
      const graphEditor = createGraphReader([draggedNode, targetNode]);
      const finishNodeDrag = jest.fn();
      const { result } = renderHook(() =>
        useHelperLines({
          graphEditor,
          finishNodeDrag,
          enabled: reason !== "disabled",
        })
      );
      act(() => {
        result.current.onNodeDrag(
          {} as MouseEvent,
          draggedNode,
          reason === "multiple nodes"
            ? [draggedNode, targetNode]
            : [draggedNode]
        );
        animationFrame.flush();
        result.current.handleNodeDragStop();
      });
      expect(animationFrame.request).not.toHaveBeenCalled();
      expect(result.current.helperLines).toEqual({
        horizontal: null,
        vertical: null,
      });
      expect(finishNodeDrag).toHaveBeenCalledTimes(1);
      expect(finishNodeDrag).toHaveBeenCalledWith(null);
    }
  );

  it("cancels pending work and rejects stale drag callbacks after changing editor visits", () => {
    const draggedNode = createNode("dragged", { x: 96, y: 0 });
    const firstEditor = createGraphReader([
      draggedNode,
      createNode("target", { x: 100, y: 200 }),
    ]);
    const nextEditor = createGraphReader([
      createNode("dragged", { x: 500, y: 500 }),
    ]);
    const finishNodeDrag = jest.fn();
    const { result, rerender } = renderHook(
      ({ graphEditor }) => useHelperLines({ graphEditor, finishNodeDrag }),
      { initialProps: { graphEditor: firstEditor } }
    );
    const oldCallbacks = result.current;
    act(() => {
      oldCallbacks.onNodeDrag({} as MouseEvent, draggedNode, [
        draggedNode,
      ]);
    });
    const queuedFrame = animationFrame.request.mock.calls[0]?.[0];
    rerender({ graphEditor: nextEditor });
    expect(animationFrame.cancel).toHaveBeenCalledWith(1);
    act(() => {
      queuedFrame?.(0);
      oldCallbacks.onNodeDrag({} as MouseEvent, draggedNode, [
        draggedNode,
      ]);
      oldCallbacks.handleNodeDragStop();
    });
    expect(result.current.helperLines).toEqual({
      horizontal: null,
      vertical: null,
    });
    expect(animationFrame.request).toHaveBeenCalledTimes(1);
    expect(finishNodeDrag).not.toHaveBeenCalled();
  });

  it("cancels queued drag work when the editor unmounts", () => {
    const draggedNode = createNode("dragged", { x: 96, y: 0 });
    const graphEditor = createGraphReader([
      draggedNode,
      createNode("target", { x: 100, y: 200 }),
    ]);
    const finishNodeDrag = jest.fn();
    const { result, unmount } = renderHook(() =>
      useHelperLines({ graphEditor, finishNodeDrag })
    );
    act(() => {
      result.current.onNodeDrag({} as MouseEvent, draggedNode, [
        draggedNode,
      ]);
    });
    unmount();
    expect(animationFrame.cancel).toHaveBeenCalledWith(1);
  });
});
