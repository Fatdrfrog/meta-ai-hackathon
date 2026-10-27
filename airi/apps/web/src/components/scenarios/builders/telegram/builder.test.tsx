/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { TelegramReplyBuilder } from ".";
import type { TelegramQuickReplyDraft } from "./utils";

function renderBuilder({
  onChange = jest.fn(),
  onButtonListChanged = jest.fn(),
  onInsertToken,
  connectedPayloads,
  quickReplies = [[{ text: "Sales", payload: "sales" }]],
}: {
  onChange?: jest.Mock;
  onButtonListChanged?: jest.Mock;
  onInsertToken?: jest.Mock;
  connectedPayloads?: string[];
  quickReplies?: TelegramQuickReplyDraft[][];
} = {}) {
  function Harness() {
    const [rows, setRows] = useState(quickReplies);

    return (
      <TelegramReplyBuilder
        quickReplies={rows}
        connectedPayloads={connectedPayloads}
        messageText="Pick a team"
        onMessageTextChange={() => {}}
        onInsertToken={onInsertToken}
        onChange={next => {
          setRows(next);
          onChange(next);
        }}
        onButtonListChanged={onButtonListChanged}
      />
    );
  }

  render(<Harness />);

  return { onChange, onButtonListChanged };
}

describe("TelegramReplyBuilder", () => {
  it("defers branch sync while a quick reply label is being typed", () => {
    const { onChange, onButtonListChanged } = renderBuilder();

    fireEvent.change(screen.getByDisplayValue("Sales"), {
      target: { value: "Support" },
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith([
      [expect.objectContaining({ text: "Support", payload: "sales" })],
    ]);
    expect(onButtonListChanged).not.toHaveBeenCalled();

    fireEvent.blur(screen.getByDisplayValue("Support"));

    expect(onButtonListChanged).toHaveBeenCalledTimes(1);
    expect(onButtonListChanged).toHaveBeenLastCalledWith([
      [expect.objectContaining({ text: "Support", payload: "sales" })],
    ]);
  });

  it("syncs branches immediately when a quick reply is added", () => {
    const { onChange, onButtonListChanged } = renderBuilder();

    fireEvent.change(
      screen.getByPlaceholderText("telegramBuilderAddPlaceholder"),
      {
        target: { value: "Billing" },
      }
    );
    fireEvent.click(
      screen.getByRole("button", { name: "telegramBuilderAddButton" })
    );

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onButtonListChanged).toHaveBeenCalledTimes(1);
    expect(onButtonListChanged).toHaveBeenLastCalledWith([
      [
        expect.objectContaining({ text: "Sales", payload: "sales" }),
        expect.objectContaining({ text: "Billing" }),
      ],
    ]);
  });

  it("shows only the message and buttons, without a fake chat header", () => {
    renderBuilder();

    expect(screen.queryByText("Airi")).toBeNull();
    expect(screen.queryByText("12:34")).toBeNull();
    expect(
      screen.getByRole("textbox", { name: "scenarioMessageEditorLabel" })
    ).toHaveProperty("value", "Pick a team");
  });

  it("offers Variables for the fixed text when the editor can insert them", () => {
    const onInsertToken = jest.fn();
    renderBuilder({ onInsertToken });

    expect(
      screen.getByTestId("whatsapp-service-message-variables")
    ).toBeTruthy();
  });

  it("hides Variables without an insert callback", () => {
    renderBuilder();

    expect(screen.queryByTestId("whatsapp-service-message-variables")).toBe(
      null
    );
  });

  it("names the missing-route dot instead of a native title", () => {
    renderBuilder({ connectedPayloads: [] });

    expect(
      screen.getByRole("img", { name: "sourceHandleStatusUnlinked" })
    ).toBeTruthy();
    expect(
      screen.getByRole("textbox", { name: "buttonText" }).getAttribute("title")
    ).toBeNull();
  });

  it("says why the composer is gone at the button limit", () => {
    renderBuilder({
      quickReplies: [
        Array.from({ length: 8 }, (_, index) => ({
          text: `Option ${index + 1}`,
          payload: `option_${index + 1}`,
        })),
      ],
    });

    expect(screen.queryByPlaceholderText("telegramBuilderAddPlaceholder")).toBe(
      null
    );
    expect(screen.getByText("telegramBuilderMaxButtons")).toBeTruthy();
  });
});
