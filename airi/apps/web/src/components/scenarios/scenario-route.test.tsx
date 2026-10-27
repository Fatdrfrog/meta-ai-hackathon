/**
 * @jest-environment jsdom
 */

import type { ReactNode } from "react";

jest.mock("@xyflow/react", () => ({
  Handle: ({
    children,
    className,
    id,
    isConnectable,
    title,
    "aria-label": ariaLabel,
    "data-route-status": routeStatus,
    "data-route-required": routeRequired,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    className?: string;
    id?: string;
    isConnectable?: boolean;
    title?: string;
    "aria-label"?: string;
    "data-route-status"?: string;
    "data-route-required"?: string;
    "data-testid"?: string;
  }) => (
    <div
      aria-label={ariaLabel}
      className={className}
      data-handle-id={id}
      data-is-connectable={String(isConnectable)}
      data-route-status={routeStatus}
      data-route-required={routeRequired}
      data-testid={testId}
      title={title}
    >
      {children}
    </div>
  ),
  Position: { Right: "right", Left: "left", Top: "top", Bottom: "bottom" },
  useStore: (
    selector: (state: { transform: [number, number, number] }) => unknown
  ) => selector({ transform: [0, 0, 1] }),
}));

import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Clock, MousePointerClick } from "lucide-react";
import { ScenarioRouteRow, ScenarioRouteSummaryRow } from "./scenario-route";
import { ScenarioSourceHandlePresentationProvider } from "./source-handle-presentation-context";
import type { ScenarioSourceHandlePresentation } from "./source-handle-types";

const PRESENTATION: ScenarioSourceHandlePresentation = {
  chooseLabel: "Choose next step",
  unlinkedStatus: "Not connected",
  linkedPrefix: "Next:",
  connectedStatus: "Connected",
  requiredStatus: "Needs a next step",
};

function renderInCard(children: ReactNode) {
  return render(
    <ScenarioSourceHandlePresentationProvider value={PRESENTATION}>
      {children}
    </ScenarioSourceHandlePresentationProvider>
  );
}

const t = (key: string) => key;

describe("ScenarioRouteRow", () => {
  it("leads with a decorative kind icon", () => {
    renderInCard(
      <ScenarioRouteRow
        handleId="choice-yes"
        sourceLabel="Yes"
        icon={MousePointerClick}
      />
    );

    const icon = screen
      .getByTestId("scenario-route-row")
      .querySelector(".lucide-mouse-pointer-click");
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon).toHaveClass("size-3", "text-muted-foreground");
  });

  it("keeps the detail in its own span that never truncates", () => {
    renderInCard(
      <ScenarioRouteRow
        handleId="no-reply"
        sourceLabel="No reply"
        detail="30 min"
        icon={Clock}
      />
    );

    const label = screen.getByText("No reply");
    const detail = screen.getByText("30 min");
    expect(label).not.toBe(detail);
    expect(label).toHaveClass("line-clamp-2", "break-words");
    expect(detail).toHaveClass(
      "shrink-0",
      "tabular-nums",
      "text-muted-foreground"
    );
    expect(detail.className).not.toMatch(/truncate|line-clamp/);
  });

  it("names the dot from the label and detail by default", () => {
    renderInCard(
      <ScenarioRouteRow
        handleId="no-reply"
        sourceLabel="No reply"
        detail="30 min"
      />
    );

    expect(screen.getByTestId("scenario-route-dot")).toHaveAttribute(
      "aria-label",
      "No reply · 30 min. Not connected"
    );
  });

  it("names the dot from accessibleLabel and its next step", () => {
    renderInCard(
      <ScenarioRouteRow
        handleId="choice-yes"
        sourceLabel="Yes"
        accessibleLabel="Taps “Yes”"
        destinationLabel="Send price list"
      />
    );

    expect(screen.getByTestId("scenario-route-dot")).toHaveAttribute(
      "aria-label",
      "Taps “Yes”. Next: Send price list"
    );
  });

  it("shows the next step on a second line", () => {
    renderInCard(
      <ScenarioRouteRow
        handleId="choice-yes"
        sourceLabel="Yes"
        destinationLabel={"Send price list\nsecond line"}
      />
    );

    const row = screen.getByTestId("scenario-route-row");
    expect(row).toHaveAttribute("data-connected", "true");
    const destination = within(row).getByText("Send price list");
    expect(destination).toHaveClass("line-clamp-2", "break-words");
    const arrow = destination.parentElement?.querySelector(
      ".lucide-corner-down-right"
    );
    expect(arrow).toHaveAttribute("aria-hidden", "true");
    expect(row).toHaveAttribute("title", "Yes → Send price list");
  });

  it("shows no next-step line while unlinked", () => {
    renderInCard(<ScenarioRouteRow handleId="choice-yes" sourceLabel="Yes" />);

    const row = screen.getByTestId("scenario-route-row");
    expect(row).toHaveAttribute("data-connected", "false");
    expect(row.querySelector(".lucide-corner-down-right")).toBeNull();
    expect(row.className).not.toContain("text-muted-foreground");
  });

  it("passes connectable={false} to the handle", () => {
    renderInCard(
      <ScenarioRouteRow
        handleId="any-reply"
        sourceLabel="Any reply"
        connectable={false}
        onCreateNode={jest.fn()}
      />
    );

    expect(screen.getByTestId("scenario-route-dot")).toHaveAttribute(
      "data-is-connectable",
      "false"
    );
  });

  it("marks an unlinked required route", () => {
    renderInCard(
      <ScenarioRouteRow
        handleId="telegram-button"
        sourceLabel="Taps “Order”"
        required
      />
    );

    const dot = screen.getByTestId("scenario-route-dot");
    expect(dot).toHaveAttribute("data-route-required", "true");
    expect(dot).toHaveAttribute(
      "aria-label",
      "Taps “Order”. Needs a next step"
    );
    expect(dot.className).toContain("!bg-rose-500");
  });

  it("names the route once on an external anchor row", () => {
    renderInCard(
      <ScenarioRouteRow
        handleId="right-source"
        sourceLabel="Reply"
        externalAnchor
        destinationLabel="Delivery details"
        onCreateNode={jest.fn()}
      />
    );

    expect(screen.getAllByText("Reply")).toHaveLength(1);
    expect(screen.getAllByText("Delivery details")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Reply. Next: Delivery details" })
    ).toHaveTextContent("Delivery details");
  });

  it("offers the next-step choice on an unlinked external anchor row", () => {
    renderInCard(
      <ScenarioRouteRow
        handleId="right-source"
        sourceLabel="Reply"
        externalAnchor
        onCreateNode={jest.fn()}
      />
    );

    expect(screen.getAllByText("Reply")).toHaveLength(1);
    // The name contains the visible text (WCAG 2.5.3 Label in Name).
    expect(
      screen.getByRole("button", { name: "Reply. Choose next step" })
    ).toHaveTextContent("Choose next step");
  });

  it("keeps the required status on an unlinked external anchor row", () => {
    renderInCard(
      <ScenarioRouteRow
        handleId="right-source"
        sourceLabel="Reply"
        externalAnchor
        required
        onCreateNode={jest.fn()}
      />
    );

    expect(
      screen.getByRole("button", {
        name: "Reply. Needs a next step. Choose next step",
      })
    ).toHaveTextContent("Choose next step");
  });
});

describe("ScenarioRouteSummaryRow", () => {
  it("shows the next step of a linked route", () => {
    render(
      <ScenarioRouteSummaryRow
        icon={Clock}
        label="No reply"
        detail="1 day"
        destinationLabel="Send a reminder"
        t={t}
      />
    );

    const row = screen.getByTestId("scenario-route-summary-row");
    expect(row).toHaveAttribute("data-route-status", "linked");
    expect(within(row).getByText("No reply")).toBeInTheDocument();
    expect(within(row).getByText("1 day")).toBeInTheDocument();
    expect(within(row).getByText("Send a reminder")).toBeInTheDocument();
    expect(row.querySelector(".lucide-clock")).toHaveAttribute(
      "aria-hidden",
      "true"
    );
    expect(within(row).queryByText(/sourceHandleStatus/)).toBeNull();
    // Read-only: no route dot in the panel.
    expect(row.querySelector("[data-handle-id]")).toBeNull();
  });

  it.each([
    [{}, "unlinked", "sourceHandleStatusUnlinked"],
    [{ required: true }, "required", "sourceHandleStatusRequired"],
    [{ connected: true }, "connected", "sourceHandleStatusConnected"],
  ])(
    "shows the status of a route without a named next step %#",
    (props, status, key) => {
      render(<ScenarioRouteSummaryRow label="Taps “Yes”" t={t} {...props} />);

      const row = screen.getByTestId("scenario-route-summary-row");
      expect(row).toHaveAttribute("data-route-status", status);
      expect(within(row).getByText(key)).toBeInTheDocument();
    }
  );
});
