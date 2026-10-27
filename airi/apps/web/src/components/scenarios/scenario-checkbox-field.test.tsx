/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { ScenarioCheckboxField } from "./scenario-checkbox-field";
import { installResizeObserver } from "@/test-support/dom-test-utils";

beforeAll(() => {
  installResizeObserver();
});

describe("ScenarioCheckboxField", () => {
  it("toggles from its label", async () => {
    const user = userEvent.setup();
    const onCheckedChange = jest.fn();
    render(
      <ScenarioCheckboxField
        label="Payment confirmed"
        checked={false}
        onCheckedChange={onCheckedChange}
      />
    );

    await user.click(screen.getByText("Payment confirmed"));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(
      screen.getByRole("checkbox", { name: "Payment confirmed" })
    ).not.toHaveAttribute("aria-describedby");
  });

  it("shows a text hint under the label by default", () => {
    render(
      <ScenarioCheckboxField
        label="Nudge once"
        hint="Sends one reminder. Extra cost."
        checked
        onCheckedChange={jest.fn()}
      />
    );

    const checkbox = screen.getByRole("checkbox", { name: "Nudge once" });
    expect(checkbox).toHaveAccessibleDescription(
      "Sends one reminder. Extra cost."
    );
    expect(screen.getByText("Sends one reminder. Extra cost.")).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("puts the hint behind an info button in info mode", async () => {
    const user = userEvent.setup();
    const onCheckedChange = jest.fn();
    render(
      <ScenarioCheckboxField
        label="Block unsafe requests"
        hint="Checks the customer's text before creating."
        hintMode="info"
        hintLabel="About Block unsafe requests"
        checked={false}
        onCheckedChange={onCheckedChange}
      />
    );

    const checkbox = screen.getByRole("checkbox", {
      name: "Block unsafe requests",
    });
    // The hidden copy still describes the checkbox.
    expect(checkbox).toHaveAccessibleDescription(
      "Checks the customer's text before creating."
    );
    expect(screen.queryByRole("dialog")).toBeNull();

    const info = screen.getByRole("button", {
      name: "About Block unsafe requests",
    });
    await user.click(info);
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Checks the customer's text before creating."
    );
    expect(onCheckedChange).not.toHaveBeenCalled();

    const label = screen.getByText("Block unsafe requests");
    expect(label.tagName).toBe("LABEL");
    expect(label).toHaveAttribute("for", checkbox.id);
  });
});
