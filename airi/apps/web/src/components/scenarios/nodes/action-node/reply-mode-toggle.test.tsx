/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { useState } from "react";
import {
  ReplyModeToggle,
  type ReplyModeToggleValue,
} from "./reply-mode-toggle";

const t = (key: string) => key;

function Harness({
  initial = "fixed",
  onChange = jest.fn(),
}: {
  initial?: ReplyModeToggleValue;
  onChange?: (value: ReplyModeToggleValue) => void;
}) {
  const [value, setValue] = useState<ReplyModeToggleValue>(initial);
  return (
    <ReplyModeToggle
      value={value}
      t={t}
      onChange={next => {
        onChange(next);
        setValue(next);
      }}
    >
      <button type="button">Variables</button>
    </ReplyModeToggle>
  );
}

describe("ReplyModeToggle", () => {
  it("exposes the two modes as radios in order", () => {
    render(<Harness />);

    const group = screen.getByRole("group", { name: "actionReplyModeLabel" });
    expect(group).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios.map(radio => radio.textContent)).toEqual([
      "replyModeFixed",
      "replyModeAi",
    ]);
    expect(
      screen.getByRole("radio", { name: "replyModeFixed" })
    ).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "replyModeAi" })).toHaveAttribute(
      "aria-checked",
      "false"
    );
    for (const radio of radios) {
      expect(radio.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("switches modes", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole("radio", { name: "replyModeAi" }));

    expect(onChange).toHaveBeenCalledWith("ai");
    expect(screen.getByRole("radio", { name: "replyModeAi" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
  });

  it("ignores a second click that would clear the mode", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<Harness initial="ai" onChange={onChange} />);

    await user.click(screen.getByRole("radio", { name: "replyModeAi" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "replyModeAi" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
  });

  it("wraps with its trailing controls and never clips labels", () => {
    render(<Harness />);

    const toolbar = screen.getByRole("group").parentElement;
    expect(toolbar).toHaveClass("flex", "flex-wrap");
    expect(toolbar).toContainElement(
      screen.getByRole("button", { name: "Variables" })
    );
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toHaveClass("flex-none", "px-2");
      expect(radio).not.toHaveClass("flex-1");
    }
  });

  it("keeps clicks away from the canvas card", async () => {
    const user = userEvent.setup();
    const parentClick = jest.fn();
    const parentPointerDown = jest.fn();
    render(
      <div onClick={parentClick} onPointerDown={parentPointerDown}>
        <ReplyModeToggle value="fixed" t={t} onChange={jest.fn()} />
      </div>
    );

    await user.click(screen.getByRole("radio", { name: "replyModeAi" }));

    expect(parentClick).not.toHaveBeenCalled();
    expect(parentPointerDown).not.toHaveBeenCalled();
    expect(screen.getByRole("group")).toHaveClass("nodrag", "nopan", "nokey");
  });

  it("disables both modes", () => {
    render(
      <ReplyModeToggle value="fixed" t={t} onChange={jest.fn()} disabled />
    );
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toBeDisabled();
    }
  });
});
