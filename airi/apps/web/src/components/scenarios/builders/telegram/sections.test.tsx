/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import {
  TelegramReplyBuilderComposer,
  TelegramReplyBuilderRows,
} from "./sections";

describe("TelegramReplyBuilderSections", () => {
  it("keeps button text keyboard events inside the quick reply input", () => {
    const parentKeyDown = jest.fn();

    render(
      <div onKeyDown={parentKeyDown}>
        <TelegramReplyBuilderRows
          draftText=""
          missingPayloads={new Set()}
          rows={[[{ text: "Kazakh", payload: "kazakh" }]]}
          totalCount={1}
          onAddToRow={jest.fn()}
          onRemoveButton={jest.fn()}
          onRemoveRow={jest.fn()}
          onTextChange={jest.fn()}
        />
      </div>
    );

    fireEvent.keyDown(screen.getByDisplayValue("Kazakh"), {
      key: "Backspace",
    });
    fireEvent.keyDown(screen.getByDisplayValue("Kazakh"), {
      key: "ArrowLeft",
    });

    expect(parentKeyDown).not.toHaveBeenCalled();
  });

  it("keeps composer Enter local while preserving add behavior", () => {
    const parentKeyDown = jest.fn();
    const onAddNewRow = jest.fn();

    render(
      <div onKeyDown={parentKeyDown}>
        <TelegramReplyBuilderComposer
          draftText="Russian"
          hasRows={false}
          totalCount={0}
          onAddToLastRow={jest.fn()}
          onAddNewRow={onAddNewRow}
          onDraftTextChange={jest.fn()}
        />
      </div>
    );

    fireEvent.keyDown(screen.getByDisplayValue("Russian"), { key: "Enter" });

    expect(onAddNewRow).toHaveBeenCalledTimes(1);
    expect(parentKeyDown).not.toHaveBeenCalled();
  });

  it("names the composer input and its add button", () => {
    render(
      <TelegramReplyBuilderComposer
        draftText=""
        hasRows
        totalCount={1}
        onAddToLastRow={jest.fn()}
        onAddNewRow={jest.fn()}
        onDraftTextChange={jest.fn()}
      />
    );

    expect(
      screen
        .getByRole("textbox", { name: "telegramBuilderAddLabel" })
        .getAttribute("placeholder")
    ).toBe("telegramBuilderAddPlaceholder");
    const addButton = screen.getByRole("button", {
      name: "telegramBuilderAddButton",
    });
    expect(addButton).toHaveProperty("disabled", true);
    expect(addButton.getAttribute("title")).toBeNull();
  });

  it("offers a new row only while the composer has text", () => {
    const onAddNewRow = jest.fn();
    const props = {
      hasRows: true,
      totalCount: 1,
      onAddToLastRow: jest.fn(),
      onAddNewRow,
      onDraftTextChange: jest.fn(),
    };
    const view = render(
      <TelegramReplyBuilderComposer draftText="" {...props} />
    );

    expect(
      screen.queryByRole("button", { name: "telegramBuilderNewRowWithButton" })
    ).toBeNull();

    view.rerender(
      <TelegramReplyBuilderComposer draftText="Prices" {...props} />
    );
    fireEvent.click(
      screen.getByRole("button", { name: "telegramBuilderNewRowWithButton" })
    );

    expect(onAddNewRow).toHaveBeenCalledTimes(1);
  });

  it("shows the button limit instead of hiding the composer silently", () => {
    render(
      <TelegramReplyBuilderComposer
        draftText=""
        hasRows
        totalCount={8}
        onAddToLastRow={jest.fn()}
        onAddNewRow={jest.fn()}
        onDraftTextChange={jest.fn()}
      />
    );

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("telegramBuilderMaxButtons")).toBeTruthy();
  });

  it("labels row controls without native titles", () => {
    const onRemoveButton = jest.fn();
    const onRemoveRow = jest.fn();
    const parentClick = jest.fn();

    render(
      <div onClick={parentClick}>
        <TelegramReplyBuilderRows
          draftText="New"
          missingPayloads={new Set()}
          rows={[
            [{ text: "Kazakh", payload: "kazakh" }],
            [{ text: "Russian", payload: "russian" }],
          ]}
          totalCount={2}
          onAddToRow={jest.fn()}
          onRemoveButton={onRemoveButton}
          onRemoveRow={onRemoveRow}
          onTextChange={jest.fn()}
        />
      </div>
    );

    const addToRow = screen.getAllByRole("button", {
      name: "telegramBuilderAddToThisRow",
    });
    expect(addToRow).toHaveLength(2);
    expect(addToRow[0].getAttribute("title")).toBeNull();
    expect(
      screen.getAllByRole("textbox", { name: "buttonText" })[0]
    ).toHaveProperty("placeholder", "telegramBuilderButtonTextPlaceholder");

    fireEvent.click(
      screen.getAllByRole("button", { name: "telegramBuilderRemoveButton" })[1]
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "telegramBuilderRemoveRow" })[0]
    );

    expect(onRemoveButton).toHaveBeenCalledWith(1, 0);
    expect(onRemoveRow).toHaveBeenCalledWith(0);
    expect(parentClick).not.toHaveBeenCalled();
  });
});
