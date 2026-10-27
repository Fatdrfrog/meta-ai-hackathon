/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { TemplateFormSection } from "./template-editor-form-layout";

describe("TemplateFormSection", () => {
  it("keeps the section title beside the action instead of stretching a large empty gap", () => {
    render(
      <TemplateFormSection title="Footer (Optional)" action={<button>Add footer</button>}>
        <p>Footer field</p>
      </TemplateFormSection>
    );

    const heading = screen.getByRole("heading", { name: "Footer (Optional)" });
    const action = screen.getByRole("button", { name: "Add footer" });
    const row = heading.parentElement;
    expect(row).toBeTruthy();
    expect(row).toContainElement(action);
    expect(row?.querySelector('[data-slot="separator"]')).not.toBeNull();
    expect(screen.getByText("Footer field")).toBeInTheDocument();
  });
});
