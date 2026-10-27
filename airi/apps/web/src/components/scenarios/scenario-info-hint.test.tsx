/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import type { ComponentProps } from "react";

const mockContentProps: Array<Record<string, unknown>> = [];

jest.mock("@/components/ui/popover", () => {
  const actual = jest.requireActual<typeof import("@/components/ui/popover")>(
    "@/components/ui/popover"
  );
  const { PopoverContent } = actual;
  return {
    ...actual,
    PopoverContent: (props: ComponentProps<typeof PopoverContent>) => {
      mockContentProps.push(props as Record<string, unknown>);
      return <PopoverContent {...props} />;
    },
  };
});

import { ScenarioInfoHint } from "./scenario-info-hint";
import { installResizeObserver } from "@/test-support/dom-test-utils";

beforeAll(() => {
  installResizeObserver();
});

beforeEach(() => {
  mockContentProps.length = 0;
});

const HINT = "Runs only when all conditions match.";

function renderHint(
  props: Partial<ComponentProps<typeof ScenarioInfoHint>> = {}
) {
  const parentClick = jest.fn();
  const parentPointerDown = jest.fn();
  const parentKeyDown = jest.fn();
  render(
    <div
      onClick={parentClick}
      onPointerDown={parentPointerDown}
      onKeyDown={parentKeyDown}
    >
      <ScenarioInfoHint label="About Only if" {...props}>
        {HINT}
      </ScenarioInfoHint>
    </div>
  );
  return {
    trigger: screen.getByRole("button", { name: "About Only if" }),
    parentClick,
    parentPointerDown,
    parentKeyDown,
  };
}

describe("ScenarioInfoHint", () => {
  it("toggles on click and closes on a second click", async () => {
    const user = userEvent.setup();
    const { trigger } = renderHint();

    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toHaveTextContent(HINT);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    await user.click(trigger);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it.each(["{Enter}", " "])("toggles with %s", async key => {
    const user = userEvent.setup();
    const { trigger } = renderHint();

    trigger.focus();
    await user.keyboard(key);
    expect(screen.getByRole("dialog")).toHaveTextContent(HINT);
    // The trigger keeps focus, so the canvas and panel stay where they were.
    expect(trigger).toHaveFocus();

    await user.keyboard(key);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape and keeps focus on the trigger", async () => {
    const user = userEvent.setup();
    const { trigger, parentKeyDown } = renderHint();

    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
    expect(parentKeyDown).not.toHaveBeenCalled();
  });

  it("never opens on hover", async () => {
    const user = userEvent.setup();
    const { trigger } = renderHint();

    await user.hover(trigger);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).not.toHaveAttribute("title");
  });

  it("keeps clicks and pointer presses away from the card around it", async () => {
    const user = userEvent.setup();
    const { trigger, parentClick, parentPointerDown } = renderHint();

    await user.click(trigger);
    await user.click(screen.getByRole("dialog"));

    expect(parentClick).not.toHaveBeenCalled();
    expect(parentPointerDown).not.toHaveBeenCalled();
    expect(trigger.className).toContain("nodrag");
    expect(trigger.className).toContain("nopan");
    expect(trigger.className).toContain("nokey");
  });

  it("renders a hidden copy for aria-describedby", () => {
    const { trigger } = renderHint({ describedById: "cancel-words-hint" });

    const copy = document.getElementById("cancel-words-hint");
    expect(copy).toHaveTextContent(HINT);
    expect(copy).toHaveClass("sr-only");
    expect(trigger).toHaveAttribute("aria-describedby", "cancel-words-hint");
  });

  it("describes the closed trigger with its sentence for screen readers", () => {
    renderHint();

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: "About Only if", description: HINT })
    ).toBeInTheDocument();
    expect(screen.getByText(HINT)).toHaveClass("sr-only");
  });

  it("follows the trigger when the canvas moves and keeps focus off the content", async () => {
    const user = userEvent.setup();
    const { trigger } = renderHint({ side: "right" });

    await user.click(trigger);
    const props = mockContentProps.at(-1);
    expect(props?.updatePositionStrategy).toBe("always");
    expect(props?.side).toBe("right");
    expect(screen.getByRole("dialog")).not.toHaveFocus();
  });
});
