/** @jest-environment jsdom */

import { render } from "@testing-library/react";
import { useRef } from "react";
import { useScenarioCanvasWheelGuard } from "./use-scenario-canvas-wheel-guard";

function Canvas({ onWheel }: { onWheel: (event: WheelEvent) => void }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  useScenarioCanvasWheelGuard(wrapperRef);
  return (
    <div
      ref={wrapperRef}
      data-testid="wrapper"
      onWheelCapture={event => onWheel(event.nativeEvent)}
    >
      <div data-testid="pane">
        <div
          className="nowheel"
          data-testid="list"
          style={{ overflowY: "auto" }}
        >
          <div data-testid="item">Route</div>
        </div>
      </div>
    </div>
  );
}

function makeScrollable(element: HTMLElement) {
  Object.defineProperty(element, "scrollHeight", { value: 400 });
  Object.defineProperty(element, "clientHeight", { value: 100 });
}

function wheel(target: HTMLElement, init: WheelEventInit) {
  const event = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

describe("useScenarioCanvasWheelGuard", () => {
  it("never lets a pinch over a scrollable card area zoom the page", () => {
    const { getByTestId } = render(<Canvas onWheel={jest.fn()} />);
    const list = getByTestId("list");
    makeScrollable(list);

    // A trackpad pinch arrives as a wheel with ctrlKey.
    const event = wheel(getByTestId("item"), { deltaY: 30, ctrlKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(list.scrollTop).toBe(0);
  });

  it("never lets a pinch over a card area that can't scroll zoom the page", () => {
    const { getByTestId } = render(<Canvas onWheel={jest.fn()} />);

    const event = wheel(getByTestId("item"), { deltaY: -30, ctrlKey: true });

    expect(event.defaultPrevented).toBe(true);
  });

  it("still scrolls a card area with a plain wheel", () => {
    const { getByTestId } = render(<Canvas onWheel={jest.fn()} />);
    const list = getByTestId("list");
    makeScrollable(list);

    const event = wheel(getByTestId("item"), { deltaY: 30 });

    expect(event.defaultPrevented).toBe(true);
    expect(list.scrollTop).toBe(30);
  });

  it("leaves a pinch on the open canvas to React Flow", () => {
    const onWheel = jest.fn();
    const { getByTestId } = render(<Canvas onWheel={onWheel} />);

    const event = wheel(getByTestId("pane"), { deltaY: 30, ctrlKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(onWheel).toHaveBeenCalledTimes(1);
  });
});
