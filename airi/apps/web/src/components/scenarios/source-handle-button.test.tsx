/**
 * @jest-environment jsdom
 */

import type {
  CSSProperties,
  KeyboardEventHandler,
  MouseEventHandler,
  PointerEventHandler,
  ReactNode,
} from "react";

type MockHandleProps = {
  children?: ReactNode;
  className?: string;
  id?: string;
  onClick?: MouseEventHandler<HTMLDivElement>;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  onMouseDownCapture?: MouseEventHandler<HTMLDivElement>;
  onPointerDownCapture?: PointerEventHandler<HTMLDivElement>;
  isConnectable?: boolean;
  role?: string;
  style?: CSSProperties;
  tabIndex?: number;
  title?: string;
  "aria-label"?: string;
  "data-route-status"?: string;
  "data-route-required"?: string;
};

jest.mock("@xyflow/react", () => ({
  Handle: ({
    children,
    className,
    id,
    onClick,
    onKeyDown,
    onMouseDownCapture,
    onPointerDownCapture,
    isConnectable,
    role,
    style,
    tabIndex,
    title,
    "aria-label": ariaLabel,
    "data-route-status": dataRouteStatus,
    "data-route-required": dataRouteRequired,
  }: MockHandleProps) => (
    <div
      aria-label={ariaLabel}
      className={className}
      data-handle-id={id}
      data-is-connectable={String(isConnectable)}
      data-route-status={dataRouteStatus}
      data-route-required={dataRouteRequired}
      data-testid="handle"
      onClick={onClick}
      onKeyDown={onKeyDown}
      onMouseDownCapture={onMouseDownCapture}
      onPointerDownCapture={onPointerDownCapture}
      role={role}
      style={style}
      tabIndex={tabIndex}
      title={title}
    >
      {children}
    </div>
  ),
  Position: { Right: "right", Left: "left", Top: "top", Bottom: "bottom" },
  useStore: (
    selector: (state: { transform: [number, number, number] }) => unknown
  ) => selector({ transform: [0, 0, 0.25] }),
}));

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Position } from "@xyflow/react";
import {
  SCENARIO_ROUTE_HANDLE_EDGE_CLASS,
  SCENARIO_ROUTE_HANDLE_LOCAL_CLASS,
  SCENARIO_ROUTE_HANDLE_PADDED_EDGE_CLASS,
} from "./scenario-route";
import {
  ScenarioSourceHandleButton,
  SCENARIO_SOURCE_HANDLE_ON_BOX_EDGE_CLASS,
  SCENARIO_SOURCE_HANDLE_ON_PADDED_NODE_EDGE_CLASS,
} from "./source-handle-button";
import { ScenarioSourceHandlePresentationProvider } from "./source-handle-presentation-context";
import type { ScenarioSourceHandlePresentation } from "./source-handle-types";

const PRESENTATION: ScenarioSourceHandlePresentation = {
  chooseLabel: "Choose next step",
  unlinkedStatus: "Not connected",
  linkedPrefix: "Next:",
  connectedStatus: "Connected",
  requiredStatus: "Needs a next step",
};

function getCreateControl(name: string) {
  const control = screen.getByRole("button", { name });
  const target = control.querySelector("[data-hit-target]");
  if (!(target instanceof HTMLElement)) {
    throw new Error("missing hit target");
  }
  return { control, target };
}

function createPointerDownEvent(clientX: number, clientY: number) {
  return Object.assign(new Event("pointerdown", { bubbles: true }), {
    clientX,
    clientY,
  });
}

describe("ScenarioSourceHandleButton", () => {
  const originalElementFromPoint = document.elementFromPoint;

  afterEach(() => {
    document.elementFromPoint = originalElementFromPoint;
  });

  it("keeps an outward native 44px interaction target at low canvas zoom", () => {
    render(
      <ScenarioSourceHandleButton
        id="right-source"
        title="Add next block"
        aria-label="Add next block"
        interactionTargetPlacement="outward"
        onCreateNode={jest.fn()}
      />
    );

    const { control, target } = getCreateControl("Add next block");

    expect(control.tagName).toBe("DIV");
    expect(control.querySelector("button")).toBeNull();
    expect(target.style.height).toBe("44px");
    expect(target.style.width).toBe("44px");
    expect(target.style.transform).toBe("scale(4)");
    expect(target.style.left).toBe("0px");
    expect(target.style.top).toBe("calc(50% - 22px)");
    expect(screen.getByTestId("handle").className).toContain("!z-20");
  });

  it.each([
    [Position.Right, "left", "left center"],
    [Position.Left, "right", "right center"],
    [Position.Top, "bottom", "center bottom"],
    [Position.Bottom, "top", "center top"],
  ] as const)(
    "expands the %s target outward without growing across its inward edge",
    (position, inwardEdge, transformOrigin) => {
      render(
        <ScenarioSourceHandleButton
          id="source"
          position={position}
          interactionTargetPlacement="outward"
          aria-label="Add next block"
          onCreateNode={jest.fn()}
        />
      );

      const { target } = getCreateControl("Add next block");
      expect(target.style[inwardEdge]).toBe("0px");
      expect(target.style.transformOrigin).toBe(transformOrigin);
      expect(target.style.width).toBe("44px");
      expect(target.style.height).toBe("44px");
      expect(target.style.transform).toBe("scale(4)");
    }
  );

  it.each([
    { name: "default", inline: false, className: "" },
    { name: "compact inline", inline: true, className: "" },
    { name: "expanded inline", inline: true, className: "!h-8 !w-8" },
    {
      name: "relative recipient",
      inline: false,
      className: "!relative !right-0 !top-0 !translate-y-0",
    },
  ])(
    "keeps the $name branch target within its visible handle at low zoom",
    ({ inline, className }) => {
      render(
        <ScenarioSourceHandleButton
          id="source"
          inline={inline}
          className={className}
          aria-label="Add next block"
          onCreateNode={jest.fn()}
        />
      );

      const { target } = getCreateControl("Add next block");
      expect(target.style.inset).toBe("0");
      expect(target.style.width).toBe("100%");
      expect(target.style.height).toBe("100%");
      expect(target.style.transform).toBe("");
      expect(target.style.transformOrigin).toBe("");
      const handle = screen.getByTestId("handle");
      expect(handle.style.position).toBe(inline ? "relative" : "");
      expect(handle.style.transform).toBe(
        inline ? "none" : "translate(50%, -50%)"
      );
      if (className) expect(handle.className).toContain(className);
    }
  );

  it.each(["Enter", " "])(
    "opens the palette with %s using the visible handle coordinates",
    key => {
      const onCreateNode = jest.fn();
      render(
        <ScenarioSourceHandleButton
          id="source"
          interactionTargetPlacement="outward"
          aria-label="Add next block"
          onCreateNode={onCreateNode}
        />
      );
      const handle = screen.getByTestId("handle");
      jest.spyOn(handle, "getBoundingClientRect").mockReturnValue({
        x: 120,
        y: 80,
        left: 120,
        top: 80,
        right: 126,
        bottom: 86,
        width: 6,
        height: 6,
        toJSON: () => ({}),
      });
      const { control } = getCreateControl("Add next block");
      control.focus();
      fireEvent.keyDown(control, { key });

      expect(onCreateNode).toHaveBeenCalledTimes(1);
      expect(onCreateNode).toHaveBeenCalledWith({ clientX: 123, clientY: 83 });
      expect(document.activeElement).toBe(control);
    }
  );

  it("keeps a connected handle anchored without exposing create behavior", () => {
    const onCreateNode = jest.fn();

    render(
      <ScenarioSourceHandleButton
        id="right-source"
        connected
        connectedLabel="Connected to next block"
        title="Add next block"
        aria-label="Add next block"
        onCreateNode={onCreateNode}
      />
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByLabelText("Connected to next block")).toBeTruthy();
    expect(screen.getByTestId("handle").dataset.isConnectable).toBe("false");

    fireEvent.click(screen.getByTestId("handle"));
    expect(onCreateNode).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "uses an edge dot for a connected=%s service path without a picker pill",
    connected => {
      const onCreateNode = jest.fn();
      const { container } = render(
        <ScenarioSourceHandleButton
          id="choice-a"
          connected={connected}
          variant="route"
          routeLabel={connected ? "Delivery details" : "Choose next"}
          aria-label="Yes"
          interactionTargetPlacement="outward"
          onCreateNode={onCreateNode}
        />
      );
      const { control } = getCreateControl(
        connected ? "Yes. Connected to Delivery details" : "Yes. Not connected"
      );
      const handle = screen.getByTestId("handle");
      const plus = container.querySelector(".lucide-plus");
      if (connected) {
        expect(plus).toBeNull();
      } else {
        // A dark Plus on the amber dot keeps contrast above 3:1.
        expect(plus).toHaveAttribute("aria-hidden", "true");
        expect(plus?.getAttribute("class")).toContain("text-amber-950");
        expect(plus?.getAttribute("class")).toContain("size-full");
      }
      expect(container.querySelector(".lucide-check")).toBeNull();
      expect(container.querySelector(".lucide-arrow-right")).toBeNull();
      expect(screen.queryByText("Choose next")).toBeNull();
      expect(screen.queryByText("Delivery details")).toBeNull();
      expect(handle.className).toContain(
        "scenario-source-handle-button--route"
      );
      expect(handle.className).toContain(
        connected
          ? "scenario-source-handle-button--linked"
          : "scenario-source-handle-button--unlinked"
      );
      expect(handle.className).toContain(
        connected ? "!bg-primary" : "!bg-amber-400"
      );
      expect(handle.className).not.toContain("!border-dashed");
      expect(handle.getAttribute("data-route-status")).toBe(
        connected ? "linked" : "unlinked"
      );
      expect(handle.style.width).toBe("14px");
      expect(handle.style.height).toBe("14px");
      expect(handle.querySelector("button")).toBeNull();
      fireEvent.click(control, { clientX: 320, clientY: 240 });
      expect(onCreateNode).toHaveBeenCalledWith({ clientX: 320, clientY: 240 });
      expect(handle.dataset.isConnectable).toBe(String(!connected));
    }
  );

  it("keeps a default route control separate from its existing canvas anchor", () => {
    render(
      <ScenarioSourceHandleButton
        id="right-source"
        variant="route"
        externalAnchor
        routeLabel="Choose next step"
        aria-label="Reply"
        onCreateNode={jest.fn()}
      />
    );
    expect(screen.queryByTestId("handle")).toBeNull();
    // The name contains the visible text (WCAG 2.5.3 Label in Name).
    const control = screen.getByRole("button", {
      name: "Reply. Choose next step",
    });
    // The row prints the route name; the control names the next step.
    expect(control).toHaveTextContent("Choose next step");
    expect(control).toHaveAttribute("title", "Reply. Choose next step");
    expect(screen.queryByText("Reply")).toBeNull();
  });

  it.each([
    {
      name: "unlinked",
      props: {},
      text: "Choose next step",
      expected: "Reply. Choose next step",
    },
    {
      name: "unlinked and required",
      props: { required: true },
      text: "Choose next step",
      expected: "Reply. Needs a next step. Choose next step",
    },
    {
      name: "linked with a destination",
      props: { connected: true, routeLabel: "Send price list" },
      text: "Send price list",
      expected: "Reply. Next: Send price list",
    },
    {
      name: "linked without a destination",
      props: { connected: true },
      text: "Connected",
      expected: "Reply. Connected",
    },
  ])(
    "puts the visible text in the name of a $name default route control",
    ({ props, text, expected }) => {
      render(
        <ScenarioSourceHandlePresentationProvider value={PRESENTATION}>
          <ScenarioSourceHandleButton
            id="right-source"
            variant="route"
            externalAnchor
            aria-label="Reply"
            onCreateNode={jest.fn()}
            {...props}
          />
        </ScenarioSourceHandlePresentationProvider>
      );
      const control = screen.getByRole("button", { name: expected });
      expect(control).toHaveTextContent(text);
      expect(control.getAttribute("aria-label")).toContain(
        control.textContent ?? ""
      );
    }
  );

  it("never offers the choose label on a linked default route control", () => {
    render(
      <ScenarioSourceHandlePresentationProvider
        value={{ ...PRESENTATION, connectedStatus: undefined }}
      >
        <ScenarioSourceHandleButton
          id="right-source"
          variant="route"
          externalAnchor
          connected
          aria-label="Reply"
          onCreateNode={jest.fn()}
        />
      </ScenarioSourceHandlePresentationProvider>
    );
    const control = screen.getByRole("button", { name: "Reply. Next:" });
    expect(control).toHaveTextContent("Reply");
    expect(control).not.toHaveTextContent("Choose next step");
  });

  it("keeps the status when the name already holds the visible text", () => {
    render(
      <ScenarioSourceHandlePresentationProvider value={PRESENTATION}>
        <ScenarioSourceHandleButton
          id="continue"
          variant="route"
          externalAnchor
          aria-label="Choose next step"
          onCreateNode={jest.fn()}
        />
      </ScenarioSourceHandlePresentationProvider>
    );
    expect(
      screen.getByRole("button", { name: "Choose next step. Not connected" })
    ).toHaveTextContent("Choose next step");
  });

  it("names the linked next step on a default route control", () => {
    render(
      <ScenarioSourceHandlePresentationProvider value={PRESENTATION}>
        <ScenarioSourceHandleButton
          id="right-source"
          variant="route"
          externalAnchor
          connected
          routeLabel="Delivery details {{name}}"
          aria-label="Reply"
          onCreateNode={jest.fn()}
        />
      </ScenarioSourceHandlePresentationProvider>
    );
    const control = screen.getByRole("button", {
      name: "Reply. Next: Delivery details …",
    });
    expect(control).toHaveTextContent("Delivery details");
    expect(screen.queryByText("Reply")).toBeNull();
  });

  it.each([
    {
      name: "linked with a destination",
      props: { connected: true, routeLabel: "Send price list" },
      expected: "Taps “Yes”. Next: Send price list",
    },
    {
      name: "linked without a destination",
      props: { connected: true },
      expected: "Taps “Yes”. Connected",
    },
    {
      name: "unlinked and required",
      props: { required: true },
      expected: "Taps “Yes”. Needs a next step",
    },
    {
      name: "unlinked and optional",
      props: {},
      expected: "Taps “Yes”. Not connected",
    },
  ])("names a route dot $name", ({ props, expected }) => {
    render(
      <ScenarioSourceHandlePresentationProvider value={PRESENTATION}>
        <ScenarioSourceHandleButton
          id="choice-yes"
          variant="route"
          aria-label="Taps “Yes”"
          {...props}
        />
      </ScenarioSourceHandlePresentationProvider>
    );
    expect(screen.getByTestId("handle")).toHaveAttribute(
      "aria-label",
      expected
    );
  });

  it("falls back to the linked prefix without a connected status", () => {
    render(
      <ScenarioSourceHandlePresentationProvider
        value={{ ...PRESENTATION, connectedStatus: undefined }}
      >
        <ScenarioSourceHandleButton
          id="choice-yes"
          variant="route"
          connected
          aria-label="Yes"
        />
      </ScenarioSourceHandlePresentationProvider>
    );
    expect(screen.getByTestId("handle")).toHaveAttribute(
      "aria-label",
      "Yes. Next:"
    );
  });

  it("paints an unlinked required route rose with a white Plus", () => {
    const { container } = render(
      <ScenarioSourceHandleButton
        id="telegram-order"
        variant="route"
        required
        aria-label="Taps “Order”"
        onCreateNode={jest.fn()}
      />
    );
    const handle = screen.getByTestId("handle");
    expect(handle).toHaveAttribute("data-route-status", "unlinked");
    expect(handle).toHaveAttribute("data-route-required", "true");
    expect(handle.className).toContain("!bg-rose-500");
    expect(handle.className).not.toContain("!bg-amber-400");
    expect(
      container.querySelector(".lucide-plus")?.getAttribute("class")
    ).toContain("text-white");
  });

  it("keeps a linked required route in the linked style", () => {
    const { container } = render(
      <ScenarioSourceHandleButton
        id="telegram-order"
        variant="route"
        required
        connected
        aria-label="Taps “Order”"
      />
    );
    const handle = screen.getByTestId("handle");
    expect(handle).toHaveAttribute("data-route-status", "linked");
    expect(handle).toHaveAttribute("data-route-required", "true");
    expect(handle.className).toContain("!bg-primary");
    expect(container.querySelector(".lucide-plus")).toBeNull();
  });

  it("marks optional routes and leaves default handles unmarked", () => {
    const { unmount } = render(
      <ScenarioSourceHandleButton id="choice-a" variant="route" />
    );
    expect(screen.getByTestId("handle")).toHaveAttribute(
      "data-route-required",
      "false"
    );
    unmount();
    render(<ScenarioSourceHandleButton id="right-source" />);
    expect(screen.getByTestId("handle")).not.toHaveAttribute(
      "data-route-required"
    );
  });

  it("keeps click-to-create but blocks drag connections when not connectable", () => {
    const onCreateNode = jest.fn();
    render(
      <ScenarioSourceHandleButton
        id="any-reply"
        variant="route"
        connectable={false}
        aria-label="Any reply"
        interactionTargetPlacement="outward"
        onCreateNode={onCreateNode}
      />
    );
    const { control } = getCreateControl("Any reply. Not connected");
    expect(control.dataset.isConnectable).toBe("false");
    fireEvent.click(control, { clientX: 10, clientY: 20 });
    expect(onCreateNode).toHaveBeenCalledWith({ clientX: 10, clientY: 20 });
  });

  it("opens node creation from a plain click", () => {
    const onCreateNode = jest.fn();

    render(
      <ScenarioSourceHandleButton
        id="right-source"
        title="create a node"
        aria-label="create a node"
        onCreateNode={onCreateNode}
      />
    );

    const { control } = getCreateControl("create a node");

    fireEvent(control, createPointerDownEvent(320, 240));
    fireEvent.click(control, {
      clientX: 320,
      clientY: 240,
    });

    expect(onCreateNode).toHaveBeenCalledWith({
      clientX: 320,
      clientY: 240,
    });
  });

  it("notifies before React Flow starts a handle interaction", () => {
    const onInteractionStart = jest.fn();

    render(
      <ScenarioSourceHandleButton
        id="right-source"
        title="create a node"
        aria-label="create a node"
        onInteractionStart={onInteractionStart}
      />
    );

    fireEvent(screen.getByTestId("handle"), createPointerDownEvent(320, 240));

    expect(onInteractionStart).toHaveBeenCalledTimes(1);
  });

  it("does not open node creation after the pointer moved like a drag", () => {
    const onCreateNode = jest.fn();

    render(
      <ScenarioSourceHandleButton
        id="right-source"
        title="create a node"
        aria-label="create a node"
        onCreateNode={onCreateNode}
      />
    );

    const handle = screen.getByTestId("handle");

    fireEvent(handle, createPointerDownEvent(320, 240));
    fireEvent.click(handle, {
      clientX: 340,
      clientY: 240,
    });

    expect(onCreateNode).not.toHaveBeenCalled();
  });

  it("opens node creation when a drag releases on the canvas", async () => {
    const onCreateNode = jest.fn();
    const canvasPane = document.createElement("div");
    canvasPane.className = "react-flow__pane";
    document.elementFromPoint = jest.fn(() => canvasPane);

    render(
      <ScenarioSourceHandleButton
        id="right-source"
        title="create a node"
        aria-label="create a node"
        onCreateNode={onCreateNode}
      />
    );

    const handle = screen.getByTestId("handle");

    fireEvent(handle, createPointerDownEvent(320, 240));
    window.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        clientX: 380,
        clientY: 260,
      })
    );
    fireEvent.click(handle, {
      clientX: 380,
      clientY: 260,
    });

    await waitFor(() => expect(onCreateNode).toHaveBeenCalledTimes(1));
    expect(onCreateNode).toHaveBeenCalledWith({
      clientX: 380,
      clientY: 260,
    });
  });

  it("waits for mouseup when pointerup happens before React Flow clears the connection line", async () => {
    const onCreateNode = jest.fn();
    const canvasPane = document.createElement("div");
    canvasPane.className = "react-flow__pane";
    document.elementFromPoint = jest.fn(() => canvasPane);

    render(
      <ScenarioSourceHandleButton
        id="right-source"
        title="create a node"
        aria-label="create a node"
        onCreateNode={onCreateNode}
      />
    );

    const handle = screen.getByTestId("handle");

    fireEvent(handle, createPointerDownEvent(320, 240));
    window.dispatchEvent(
      Object.assign(new Event("pointerup", { bubbles: true }), {
        clientX: 380,
        clientY: 260,
      })
    );
    expect(onCreateNode).not.toHaveBeenCalled();
    expect(document.elementFromPoint).not.toHaveBeenCalled();

    window.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        clientX: 380,
        clientY: 260,
      })
    );

    await waitFor(() => expect(onCreateNode).toHaveBeenCalledTimes(1));
    expect(onCreateNode).toHaveBeenCalledWith({
      clientX: 380,
      clientY: 260,
    });
  });

  it("does not use the drag-release fallback when released over a node", () => {
    const onCreateNode = jest.fn();
    const node = document.createElement("div");
    node.className = "react-flow__node";
    document.elementFromPoint = jest.fn(() => node);

    render(
      <ScenarioSourceHandleButton
        id="right-source"
        title="create a node"
        aria-label="create a node"
        onCreateNode={onCreateNode}
      />
    );

    const handle = screen.getByTestId("handle");

    fireEvent(handle, createPointerDownEvent(320, 240));
    window.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        clientX: 380,
        clientY: 260,
      })
    );

    expect(onCreateNode).not.toHaveBeenCalled();
  });

  it("cancels deferred node creation when the drag has connected successfully", async () => {
    const onCreateNode = jest.fn();
    const canvasPane = document.createElement("div");
    canvasPane.className = "react-flow__pane";
    document.elementFromPoint = jest.fn(() => canvasPane);
    const { rerender } = render(
      <ScenarioSourceHandleButton
        id="right-source"
        onCreateNode={onCreateNode}
      />
    );
    fireEvent(screen.getByTestId("handle"), createPointerDownEvent(320, 240));
    window.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, clientX: 380, clientY: 260 })
    );
    // Connecting can resize the target card before the deferred hit test runs.
    rerender(
      <ScenarioSourceHandleButton
        id="right-source"
        connected
        onCreateNode={onCreateNode}
      />
    );
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect(onCreateNode).not.toHaveBeenCalled();
  });

  it("uses xyflow side transforms instead of Tailwind translate utilities", () => {
    expect(SCENARIO_SOURCE_HANDLE_ON_BOX_EDGE_CLASS).toContain("!right-0");
    expect(SCENARIO_SOURCE_HANDLE_ON_BOX_EDGE_CLASS).toContain(
      "!translate-none"
    );
    expect(SCENARIO_SOURCE_HANDLE_ON_BOX_EDGE_CLASS).not.toContain(
      "translate-x-1/2"
    );
    expect(SCENARIO_SOURCE_HANDLE_ON_BOX_EDGE_CLASS).not.toContain(
      "-translate-y-1/2"
    );
    expect(SCENARIO_SOURCE_HANDLE_ON_PADDED_NODE_EDGE_CLASS).toContain(
      "!-right-3"
    );
    expect(SCENARIO_SOURCE_HANDLE_ON_PADDED_NODE_EDGE_CLASS).toContain(
      "!translate-none"
    );
    expect(SCENARIO_ROUTE_HANDLE_EDGE_CLASS).toContain("!right-0");
    expect(SCENARIO_ROUTE_HANDLE_EDGE_CLASS).not.toContain("!-right-2");
    expect(SCENARIO_ROUTE_HANDLE_PADDED_EDGE_CLASS).toContain("!-right-3");
    expect(SCENARIO_ROUTE_HANDLE_PADDED_EDGE_CLASS).not.toContain(
      "!-right-[1.125rem]"
    );
    expect(SCENARIO_ROUTE_HANDLE_LOCAL_CLASS).toBe(
      SCENARIO_ROUTE_HANDLE_EDGE_CLASS
    );
  });

  it.each([
    [Position.Right, "translate(50%, -50%)"],
    [Position.Left, "translate(-50%, -50%)"],
    [Position.Top, "translate(-50%, -50%)"],
    [Position.Bottom, "translate(-50%, 50%)"],
  ] as const)(
    "applies the official xyflow %s handle transform via inline style",
    (position, transform) => {
      render(
        <ScenarioSourceHandleButton
          id="edge-source"
          position={position}
          aria-label="Add next block"
          onCreateNode={jest.fn()}
        />
      );
      expect(screen.getByTestId("handle").style.transform).toBe(transform);
    }
  );

  it("does not fight xyflow with a Tailwind translate when a custom top is set", () => {
    render(
      <ScenarioSourceHandleButton
        id="success-source"
        style={{ top: "42%" }}
        aria-label="Success"
        onCreateNode={jest.fn()}
      />
    );
    const handle = screen.getByTestId("handle");
    expect(handle.style.top).toBe("42%");
    expect(handle.style.transform).toBe("translate(50%, -50%)");
  });
});
