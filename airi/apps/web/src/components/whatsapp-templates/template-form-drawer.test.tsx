/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { TemplateFormDrawer } from "./template-form-drawer";

jest.mock("./template-editor-form", () => ({
  TemplateEditorForm: () => <div>Template form</div>,
}));

it("names the creation drawer without referencing a missing description", () => {
  render(
    <TemplateFormDrawer
      open
      workspaceId="workspace-a"
      onOpenChange={jest.fn()}
      onSuccess={jest.fn()}
    />
  );
  const dialog = screen.getByRole("dialog", { name: "form.createNew" });
  expect(dialog.getAttribute("aria-describedby")).toBeNull();
});
