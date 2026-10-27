/** @jest-environment jsdom */

import { act, render } from "@testing-library/react";
import {
  isFlowRectVisible,
  ScenarioNodeSettingsReveal,
} from "./scenario-node-settings-reveal";

type MockInternalNode = {
  measured: { width?: number; height?: number };
  internals: { positionAbsolute: { x: number; y: number } };
};

const mockSetCenter = jest.fn();
const mockInternalNodes = new Map<string, MockInternalNode>();
let mockViewport = { x: 0, y: 0, zoom: 1 };
let mockCanvasSize = { width: 800, height: 600 };
// React Flow returns stable instance methods.
const mockReactFlow = {
  getInternalNode: (id: string) => mockInternalNodes.get(id),
  getViewport: () => mockViewport,
  setCenter: (...args: unknown[]) => mockSetCenter(...args),
};

jest.mock("@xyflow/react", () => ({
  useReactFlow: () => mockReactFlow,
  useStore: (selector: (state: { width: number; height: number }) => number) =>
    selector(mockCanvasSize),
}));

function placeNode(
  id: string,
  x: number,
  measured: MockInternalNode["measured"] = { width: 200, height: 100 }
) {
  mockInternalNodes.set(id, {
    measured,
    internals: { positionAbsolute: { x, y: 100 } },
  });
}

describe("isFlowRectVisible", () => {
  const canvas = { width: 800, height: 600 };
  const rect = { x: 100, y: 100, width: 200, height: 100 };

  it("accepts a card fully inside the canvas, including its edges", () => {
    expect(isFlowRectVisible(rect, { x: 0, y: 0, zoom: 1 }, canvas)).toBe(true);
    expect(
      isFlowRectVisible(
        { x: 0, y: 0, width: 800, height: 600 },
        { x: 0, y: 0, zoom: 1 },
        canvas
      )
    ).toBe(true);
  });

  it("rejects a card clipped by any side after pan and zoom", () => {
    expect(
      isFlowRectVisible({ ...rect, x: 700 }, { x: 0, y: 0, zoom: 1 }, canvas)
    ).toBe(false);
    expect(isFlowRectVisible(rect, { x: -500, y: 0, zoom: 0.5 }, canvas)).toBe(
      false
    );
    expect(isFlowRectVisible(rect, { x: 0, y: -120, zoom: 1 }, canvas)).toBe(
      false
    );
    expect(
      isFlowRectVisible({ ...rect, y: 550 }, { x: 0, y: 0, zoom: 1 }, canvas)
    ).toBe(false);
  });
});

describe("ScenarioNodeSettingsReveal", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockSetCenter.mockClear();
    mockInternalNodes.clear();
    mockViewport = { x: 0, y: 0, zoom: 0.8 };
    mockCanvasSize = { width: 800, height: 600 };
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("centres a card that no longer fits at the current zoom", () => {
    placeNode("trigger", 900);
    render(<ScenarioNodeSettingsReveal nodeId="trigger" />);
    expect(mockSetCenter).toHaveBeenCalledTimes(1);
    expect(mockSetCenter).toHaveBeenCalledWith(1000, 150, {
      zoom: 0.8,
      duration: 200,
    });
  });

  it("leaves a visible card where the user put it", () => {
    placeNode("trigger", 100);
    render(<ScenarioNodeSettingsReveal nodeId="trigger" />);
    expect(mockSetCenter).not.toHaveBeenCalled();
  });

  it("follows the canvas narrowing only while the settings are opening", () => {
    placeNode("trigger", 500);
    const view = render(<ScenarioNodeSettingsReveal nodeId="trigger" />);
    expect(mockSetCenter).not.toHaveBeenCalled();

    // The dock opens and the canvas narrows shortly after selection.
    mockCanvasSize = { width: 520, height: 600 };
    view.rerender(<ScenarioNodeSettingsReveal nodeId="trigger" />);
    expect(mockSetCenter).toHaveBeenCalledTimes(1);

    // Later resizing and panning are left to the user.
    mockCanvasSize = { width: 800, height: 600 };
    view.rerender(<ScenarioNodeSettingsReveal nodeId="trigger" />);
    mockCanvasSize = { width: 420, height: 600 };
    view.rerender(<ScenarioNodeSettingsReveal nodeId="trigger" />);
    expect(mockSetCenter).toHaveBeenCalledTimes(1);
  });

  it("stops revealing once the opening window has passed", () => {
    placeNode("trigger", 500);
    const view = render(<ScenarioNodeSettingsReveal nodeId="trigger" />);
    act(() => jest.advanceTimersByTime(600));
    mockCanvasSize = { width: 420, height: 600 };
    view.rerender(<ScenarioNodeSettingsReveal nodeId="trigger" />);
    expect(mockSetCenter).not.toHaveBeenCalled();
  });

  it("waits for the card to be measured and restarts for another node", () => {
    placeNode("trigger", 900, {});
    const view = render(<ScenarioNodeSettingsReveal nodeId="trigger" />);
    expect(mockSetCenter).not.toHaveBeenCalled();

    placeNode("link", 900);
    view.rerender(<ScenarioNodeSettingsReveal nodeId="link" />);
    expect(mockSetCenter).toHaveBeenCalledTimes(1);
    expect(mockSetCenter).toHaveBeenLastCalledWith(1000, 150, {
      zoom: 0.8,
      duration: 200,
    });
  });
});
