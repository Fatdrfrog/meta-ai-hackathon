/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

jest.mock("./inline-editor", () => ({
  WhatsAppInlineEditor: ({
    value,
    ariaLabel,
  }: {
    value: string;
    ariaLabel?: string;
  }) => <textarea aria-label={ariaLabel} defaultValue={value} />,
}));

import { scenarioEditorChunks } from "../../scenario-editor-chunks";
import { LazyWhatsAppInlineEditor } from "./lazy-inline-editor";

// Its own file: the cold case in lazy-inline-editor.test.tsx needs a chunk
// that no earlier test has loaded.
describe("LazyWhatsAppInlineEditor after a warm-up", () => {
  it("renders a warmed editor at once", async () => {
    await scenarioEditorChunks.whatsAppInlineEditor.load();
    render(
      <LazyWhatsAppInlineEditor
        value="Warm"
        onChange={jest.fn()}
        ariaLabel="scenarioMessageEditorLabel"
      />
    );
    expect(
      screen.getByRole("textbox", { name: "scenarioMessageEditorLabel" })
    ).toHaveValue("Warm");
  });
});
