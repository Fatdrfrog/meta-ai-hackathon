/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import type { CSSProperties, ReactNode } from "react";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) =>
    key === "addBlock" ? "Добавить следующий блок" : key,
}));

jest.mock("@xyflow/react", () => ({
  Handle: ({
    children,
    id,
    type,
    className,
    title,
    style,
    "aria-label": ariaLabel,
    "aria-hidden": ariaHidden,
    role,
    tabIndex,
  }: {
    children?: ReactNode;
    id?: string;
    type?: string;
    className?: string;
    title?: string;
    style?: CSSProperties;
    "aria-label"?: string;
    "aria-hidden"?: boolean;
    role?: string;
    tabIndex?: number;
  }) => (
    <div
      aria-label={ariaLabel}
      aria-hidden={ariaHidden}
      className={className}
      data-handle-id={id}
      data-handle-type={type}
      role={role}
      style={style}
      tabIndex={tabIndex}
      title={title}
    >
      {children}
    </div>
  ),
  MarkerType: { ArrowClosed: "arrowclosed" },
  Position: { Left: "left", Right: "right" },
  useStore: (
    selector: (state: { transform: [number, number, number] }) => unknown
  ) => selector({ transform: [0, 0, 1] }),
}));

import { ScenarioSourceHandleButton } from "../source-handle-button";
import { NodeHandles } from "./node-handlers";

describe("NodeHandles", () => {
  it.each([
    {
      name: "default",
      sourceHandles: undefined,
      label: "Добавить следующий блок",
    },
    {
      name: "custom",
      sourceHandles: [{ id: "branch-source", ariaLabel: "Custom source" }],
      label: "Custom source",
    },
  ])(
    "expands card-edge source targets outward for $name source handles",
    ({ sourceHandles, label }) => {
      render(
        <NodeHandles
          kind="action"
          sourceHandles={sourceHandles}
          onCreateNodeFromSourceHandle={jest.fn()}
        />
      );
      const control = screen.getByRole("button", { name: label });
      const target = control.querySelector("[data-hit-target]");
      expect(target).toBeInstanceOf(HTMLElement);
      expect((target as HTMLElement).style.left).toBe("0px");
      expect((target as HTMLElement).style.transformOrigin).toBe("left center");
      expect(control.className).toContain("!right-0");
      expect(control.className).toContain("!translate-none");
      expect(control.className).not.toContain("translate-x-1/2");
      expect(control.style.transform).toBe("translate(50%, -50%)");
    }
  );

  it("uses the scenario translation for an otherwise unlabeled create handle", () => {
    render(
      <NodeHandles kind="action" onCreateNodeFromSourceHandle={jest.fn()} />
    );

    const handle = screen.getByLabelText("Добавить следующий блок");
    expect(handle.getAttribute("title")).toBe("Добавить следующий блок");
  });

  it("keeps a connected source handle anchored without exposing create UI", () => {
    const onCreateNodeFromSourceHandle = jest.fn();
    render(
      <NodeHandles
        kind="action"
        sourceHandles={[
          {
            id: "right-source-generative-ai::success",
            top: "42%",
            title: "Success",
            ariaLabel: "Success",
            connected: true,
            connectedLabel: "Connected: Success",
          },
        ]}
        onCreateNodeFromSourceHandle={onCreateNodeFromSourceHandle}
      />
    );

    expect(screen.queryByRole("button", { name: "Success" })).toBeNull();
    expect(screen.getByLabelText("Connected: Success")).toBeTruthy();
    expect(onCreateNodeFromSourceHandle).not.toHaveBeenCalled();
  });

  it("paints the incoming target handle above node chrome", () => {
    render(<NodeHandles kind="action" />);
    expect(screen.getByLabelText("canvasTargetHandle").className).toContain(
      "!z-30"
    );
  });

  describe("source handles the node's own rows render", () => {
    const sourceHandleIds = (container: HTMLElement) =>
      Array.from(
        container.querySelectorAll<HTMLElement>("[data-handle-type='source']")
      ).map(handle => handle.dataset.handleId);

    it("still anchors an unclaimed default output", () => {
      const { container } = render(
        <NodeHandles kind="action" suppressDefaultOutputHandle />
      );
      expect(sourceHandleIds(container)).toEqual(["right-source"]);
    });

    it("adds no hidden or default anchor for owned ids", () => {
      const { container } = render(
        <NodeHandles
          kind="action"
          suppressDefaultOutputHandle
          hiddenSourceHandles={["right-source", "legacy-aggregate"]}
          ownedSourceHandleIds={["right-source"]}
        />
      );
      expect(sourceHandleIds(container)).toEqual(["legacy-aggregate"]);
    });

    it("does not render the default output button for an owned id", () => {
      const { container } = render(
        <NodeHandles
          kind="action"
          ownedSourceHandleIds={["right-source"]}
          onCreateNodeFromSourceHandle={jest.fn()}
        />
      );
      expect(sourceHandleIds(container)).toEqual([]);
      expect(screen.queryByRole("button")).toBeNull();
    });

    it("skips owned ids among its source handles, so each id renders once", () => {
      const success = "right-source-generative-ai::success";
      const failure = "right-source-generative-ai::failure";
      const { container } = render(
        <>
          <NodeHandles
            kind="action"
            sourceHandles={[
              { id: success, top: "38%", ariaLabel: "Created" },
              { id: failure, top: "72%", ariaLabel: "Not created" },
            ]}
            ownedSourceHandleIds={[success, failure]}
            onCreateNodeFromSourceHandle={jest.fn()}
          />
          {/* The card's own route rows. */}
          <ScenarioSourceHandleButton id={success} variant="route" />
          <ScenarioSourceHandleButton id={failure} variant="route" />
        </>
      );
      // The default output keeps its hidden anchor for saved edges.
      expect(sourceHandleIds(container)).toEqual([
        "right-source",
        success,
        failure,
      ]);
      expect(
        container.querySelectorAll("[style*='top: 38%'], [style*='top: 72%']")
      ).toHaveLength(0);
    });

    it("still renders source handles the node does not own", () => {
      const { container } = render(
        <NodeHandles
          kind="action"
          sourceHandles={[{ id: "owned" }, { id: "free", ariaLabel: "Free" }]}
          ownedSourceHandleIds={["owned"]}
          onCreateNodeFromSourceHandle={jest.fn()}
        />
      );
      expect(sourceHandleIds(container)).toEqual(["right-source", "free"]);
      expect(screen.getByRole("button", { name: "Free" })).toBeTruthy();
    });
  });
});
