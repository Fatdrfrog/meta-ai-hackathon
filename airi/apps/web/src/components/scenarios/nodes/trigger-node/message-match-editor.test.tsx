/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MessageMatchEditor } from "./message-match-editor";

jest.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    children?: ReactNode;
  }) => (
    <select
      aria-label="message match mode"
      value={value}
      onChange={event => onValueChange?.(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children?: ReactNode;
  }) => <option value={value}>{children}</option>,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

describe("MessageMatchEditor", () => {
  it("reveals message matching help on demand without changing the rule", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(
      <MessageMatchEditor
        t={key => key}
        onChange={onChange}
        message={{
          mode: "any",
          pattern: "",
          keywordMatchMode: "contains",
          usesPattern: false,
          isExact: false,
          isContains: false,
        }}
      />
    );
    expect(
      screen.queryByText("triggerCatchAllOneShotHint")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("triggerAnyMessageFilterHelp")
    ).not.toBeInTheDocument();
    const help = screen.getByRole("button", {
      name: "triggerMessageMatchHelp",
    });
    help.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByText("triggerAnyMessageFilterHelp")).toBeVisible();
    await user.keyboard("{Escape}");
    expect(help).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("emits only the mode delta when switching to Any", () => {
    const onChange = jest.fn();
    render(
      <MessageMatchEditor
        t={key => key}
        onChange={onChange}
        message={{
          mode: "contains",
          pattern: "refund\\s+request",
          keywordMatchMode: "regex",
          usesPattern: true,
          isExact: false,
          isContains: true,
        }}
      />
    );

    fireEvent.change(screen.getAllByRole("combobox")[0], {
      target: { value: "any" },
    });

    expect(onChange).toHaveBeenCalledWith({ messageMatchMode: "any" });
  });
});
