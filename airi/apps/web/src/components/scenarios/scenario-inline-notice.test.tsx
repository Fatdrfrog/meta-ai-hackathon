/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { ScenarioInlineNotice } from "./scenario-inline-notice";
import { installResizeObserver } from "@/test-support/dom-test-utils";

beforeAll(() => {
  installResizeObserver();
});

describe("ScenarioInlineNotice", () => {
  it("has no live role by default", () => {
    render(
      <ScenarioInlineNotice data-testid="notice">
        No message yet
      </ScenarioInlineNotice>
    );

    const notice = screen.getByTestId("notice");
    expect(notice).not.toHaveAttribute("role");
    expect(notice).toHaveAttribute("data-tone", "warning");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(notice).toHaveTextContent("No message yet");
  });

  it.each([
    ["error", "alert"],
    ["warning", "status"],
    ["info", "status"],
  ] as const)("announces a live %s notice as %s", (tone, role) => {
    render(
      <ScenarioInlineNotice tone={tone} live>
        Saved by a newer version.
      </ScenarioInlineNotice>
    );

    expect(screen.getByRole(role)).toHaveTextContent(
      "Saved by a newer version."
    );
  });

  it("hides its icon from screen readers", () => {
    render(
      <ScenarioInlineNotice tone="error" data-testid="notice">
        Choose a template
      </ScenarioInlineNotice>
    );

    const icon = screen.getByTestId("notice").querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon?.closest("[aria-hidden='true']")).not.toBeNull();
  });

  it("renders its action and opens its details on click", async () => {
    const user = userEvent.setup();
    const onShow = jest.fn();
    render(
      <ScenarioInlineNotice
        tone="error"
        details="The first field is inside Button, links and files."
        detailsLabel="About 2 issues"
        action={
          <button type="button" onClick={onShow}>
            Show
          </button>
        }
      >
        2 issues
      </ScenarioInlineNotice>
    );

    await user.click(screen.getByRole("button", { name: "Show" }));
    expect(onShow).toHaveBeenCalledTimes(1);

    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "About 2 issues" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "The first field is inside Button, links and files."
    );
  });
});
