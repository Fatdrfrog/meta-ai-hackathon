/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

const mockEditorModuleLoaded = jest.fn();

jest.mock("./inline-editor", () => {
  mockEditorModuleLoaded();
  return {
    WhatsAppInlineEditor: ({
      value,
      ariaLabel,
    }: {
      value: string;
      ariaLabel?: string;
    }) => <textarea aria-label={ariaLabel} defaultValue={value} />,
  };
});

import { LazyWhatsAppInlineEditor } from "./lazy-inline-editor";

// Read before any test runs, so the check does not depend on test order.
const editorLoadedOnImport = mockEditorModuleLoaded.mock.calls.length > 0;

describe("LazyWhatsAppInlineEditor", () => {
  it("does not download the editor on import", () => {
    expect(editorLoadedOnImport).toBe(false);
  });

  // The only test here that renders: the chunk loads once per test file,
  // so the warm case lives in lazy-inline-editor.warm.test.tsx.
  it("shows the message at the editor's height until TipTap loads", async () => {
    render(
      <LazyWhatsAppInlineEditor
        value="Hello there"
        onChange={jest.fn()}
        ariaLabel="scenarioMessageEditorLabel"
        className="min-h-[88px]"
        error="Label is required"
      />
    );

    const preview = screen.getByText("Hello there");
    expect(preview.closest(".whatsapp-inline-editor")).toHaveClass(
      "min-h-[88px]"
    );
    // A validation error stays readable while TipTap loads.
    expect(screen.getByText("Label is required")).toBeInTheDocument();
    expect(
      await screen.findByRole("textbox", { name: "scenarioMessageEditorLabel" })
    ).toHaveValue("Hello there");
    expect(mockEditorModuleLoaded).toHaveBeenCalledTimes(1);
  });
});
