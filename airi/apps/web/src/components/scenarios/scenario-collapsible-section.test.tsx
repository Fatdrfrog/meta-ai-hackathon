/**
 * @jest-environment jsdom
 */

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { useState } from "react";
import { ScenarioCollapsibleSection } from "./scenario-collapsible-section";
import { openScenarioCollapsibleAncestors } from "./scenario-collapsible-section-dom";
import { installResizeObserver } from "@/test-support/dom-test-utils";

beforeAll(() => {
  installResizeObserver();
});

function trigger(name: string | RegExp = /After sending/) {
  // Triggers of sections nested in a closed keepMounted section are hidden.
  return screen.getByRole("button", { name, hidden: true });
}

describe("ScenarioCollapsibleSection", () => {
  it("toggles aria-expanded and its content", async () => {
    const user = userEvent.setup();
    render(
      <ScenarioCollapsibleSection title="After sending">
        <p>Outcome editor</p>
      </ScenarioCollapsibleSection>
    );

    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Outcome editor")).toBeNull();

    await user.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Outcome editor")).toBeVisible();

    await user.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the trigger inert for the canvas", async () => {
    const user = userEvent.setup();
    const parentClick = jest.fn();
    const parentPointerDown = jest.fn();
    render(
      <div onClick={parentClick} onPointerDown={parentPointerDown}>
        <ScenarioCollapsibleSection title="After sending">
          <p>Outcome editor</p>
        </ScenarioCollapsibleSection>
      </div>
    );

    await user.click(trigger());
    expect(parentClick).not.toHaveBeenCalled();
    expect(parentPointerDown).not.toHaveBeenCalled();
    expect(trigger().className).toContain("nodrag");
    expect(trigger().className).toContain("nopan");
    expect(trigger().className).toContain("nokey");
  });

  it("renders the info button next to the trigger, not inside it", async () => {
    const user = userEvent.setup();
    render(
      <ScenarioCollapsibleSection
        title="Only if"
        info={{
          label: "About Only if",
          text: "Runs only when all conditions match.",
        }}
      >
        <p>Conditions</p>
      </ScenarioCollapsibleSection>
    );

    const sectionTrigger = trigger("Only if");
    const info = screen.getByRole("button", { name: "About Only if" });
    expect(sectionTrigger.contains(info)).toBe(false);
    expect(info.parentElement).toBe(sectionTrigger.parentElement);

    await user.click(info);
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Runs only when all conditions match."
    );
    expect(sectionTrigger).toHaveAttribute("aria-expanded", "false");
  });

  it("names the count for screen readers", () => {
    render(
      <ScenarioCollapsibleSection
        title="After sending"
        count={2}
        countLabel="2 routes"
      >
        <p>Outcome editor</p>
      </ScenarioCollapsibleSection>
    );

    expect(trigger()).toHaveAccessibleName("After sending 2 routes");
    expect(within(trigger()).getByText("2 routes")).toHaveClass("sr-only");
    expect(within(trigger()).getByText("2")).toHaveAttribute(
      "aria-hidden",
      "true"
    );
  });

  it("shows no count badge for zero", () => {
    render(
      <ScenarioCollapsibleSection title="After sending" count={0}>
        <p>Outcome editor</p>
      </ScenarioCollapsibleSection>
    );
    expect(trigger()).toHaveAccessibleName("After sending");
  });

  it("shows the summary and collapsed content only while closed", async () => {
    const user = userEvent.setup();
    render(
      <ScenarioCollapsibleSection
        title="After sending"
        summary="No reply · 30 min"
        collapsedContent={<div data-testid="route-rows">Route rows</div>}
      >
        <p>Outcome editor</p>
      </ScenarioCollapsibleSection>
    );

    expect(screen.getByText("No reply · 30 min")).toBeInTheDocument();
    expect(screen.getByTestId("route-rows")).toBeInTheDocument();

    await user.click(trigger());
    expect(screen.queryByText("No reply · 30 min")).toBeNull();
    expect(screen.queryByTestId("route-rows")).toBeNull();
    expect(screen.getByText("Outcome editor")).toBeInTheDocument();
  });

  it("keeps closed children mounted but hidden with keepMounted", async () => {
    const user = userEvent.setup();
    render(
      <ScenarioCollapsibleSection title="More details" keepMounted>
        <input aria-label="Email" defaultValue="a@b.co" />
      </ScenarioCollapsibleSection>
    );

    const field = screen.getByLabelText("Email");
    expect(field).toBeInTheDocument();
    expect(field).not.toBeVisible();

    await user.click(trigger(/More details/));
    expect(screen.getByLabelText("Email")).toBe(field);
    expect(field).toBeVisible();
  });

  it("unmounts closed children without keepMounted", () => {
    render(
      <ScenarioCollapsibleSection title="More details">
        <input aria-label="Email" />
      </ScenarioCollapsibleSection>
    );
    expect(screen.queryByLabelText("Email")).toBeNull();
  });

  it("opens once when errors appear", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [errors, setErrors] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setErrors(count => count + 1)}>
            Add error
          </button>
          <button type="button" onClick={() => setErrors(0)}>
            Fix errors
          </button>
          <ScenarioCollapsibleSection
            title="More details"
            errorCount={errors}
            errorCountLabel={`${errors} issues`}
            keepMounted
          >
            <input aria-label="Email" />
          </ScenarioCollapsibleSection>
        </>
      );
    }
    render(<Harness />);

    const section = () => trigger(/More details/);
    expect(section()).toHaveAttribute("aria-expanded", "false");

    await user.click(screen.getByRole("button", { name: "Add error" }));
    expect(section()).toHaveAttribute("aria-expanded", "true");
    expect(section()).toHaveAccessibleName("More details 1 issues");
    expect(
      screen.getByTestId("scenario-collapsible-error-count")
    ).toHaveTextContent("1");

    // Closed by the merchant, it stays closed while errors remain.
    await user.click(section());
    await user.click(screen.getByRole("button", { name: "Add error" }));
    expect(section()).toHaveAttribute("aria-expanded", "false");

    await user.click(screen.getByRole("button", { name: "Fix errors" }));
    expect(screen.queryByTestId("scenario-collapsible-error-count")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add error" }));
    expect(section()).toHaveAttribute("aria-expanded", "true");
  });

  it("opens by default when it mounts with an error", () => {
    render(
      <ScenarioCollapsibleSection title="More details" errorCount={1}>
        <input aria-label="Email" />
      </ScenarioCollapsibleSection>
    );
    expect(trigger(/More details/)).toHaveAttribute("aria-expanded", "true");
  });

  it("asks a controlled owner to open when errors appear", () => {
    const onOpenChange = jest.fn();
    const { rerender } = render(
      <ScenarioCollapsibleSection
        title="More details"
        open={false}
        onOpenChange={onOpenChange}
        errorCount={0}
      >
        <input aria-label="Email" />
      </ScenarioCollapsibleSection>
    );
    rerender(
      <ScenarioCollapsibleSection
        title="More details"
        open={false}
        onOpenChange={onOpenChange}
        errorCount={2}
      >
        <input aria-label="Email" />
      </ScenarioCollapsibleSection>
    );
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("marks its root for ancestors lookups", () => {
    render(
      <ScenarioCollapsibleSection
        title="After sending"
        errorCount={0}
        data-testid="section"
      >
        <p>Outcome editor</p>
      </ScenarioCollapsibleSection>
    );
    const root = screen.getByTestId("section");
    expect(root).toHaveAttribute("data-scenario-collapsible");
    expect(root).toHaveAttribute("data-state", "closed");
    expect(root).toHaveAttribute("data-error-count", "0");
  });

  it("opens nested closed sections around a field", () => {
    render(
      <ScenarioCollapsibleSection title="Button, links and files" keepMounted>
        <ScenarioCollapsibleSection title="More details" keepMounted>
          <input aria-label="Website" />
        </ScenarioCollapsibleSection>
      </ScenarioCollapsibleSection>
    );

    expect(trigger(/Button, links and files/)).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    expect(trigger(/More details/)).toHaveAttribute("aria-expanded", "false");

    act(() => {
      openScenarioCollapsibleAncestors(screen.getByLabelText("Website"));
    });

    expect(trigger(/Button, links and files/)).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    expect(trigger(/More details/)).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Website")).toBeVisible();
  });

  it("uses a small text trigger in the inline variant", () => {
    render(
      <ScenarioCollapsibleSection
        title="Cancel if a message contains"
        variant="inline"
        data-testid="section"
      >
        <textarea aria-label="Phrases" />
      </ScenarioCollapsibleSection>
    );
    expect(screen.getByTestId("section")).toHaveAttribute(
      "data-variant",
      "inline"
    );
    expect(screen.getByTestId("section").className).not.toContain("border-t");
    expect(trigger(/Cancel if a message contains/).className).toContain("h-6");
  });
});
