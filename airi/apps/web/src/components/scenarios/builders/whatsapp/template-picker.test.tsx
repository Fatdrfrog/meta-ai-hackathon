/**
 * @jest-environment jsdom
 */

jest.mock("next/image", () => ({
  __esModule: true,
  default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img {...props} alt={props.alt ?? ""} />
  ),
}));

import { fireEvent, render, screen } from "@testing-library/react";
import { TemplatePicker } from "./template-picker";

describe("TemplatePicker existing Flow identity", () => {
  it("keeps same-id Flows from different sources independently selectable", () => {
    const primaryFlow = {
      id: "shared-flow",
      name: "Appointments",
      sourceId: "source-primary",
      status: "PUBLISHED",
    };
    const secondaryFlow = {
      id: "shared-flow",
      name: "Appointments",
      sourceId: "source-secondary",
      status: "PUBLISHED",
    };
    const onSelectExistingFlow = jest.fn();

    render(
      <TemplatePicker
        onSelect={jest.fn()}
        existingFlows={[primaryFlow, secondaryFlow]}
        onSelectExistingFlow={onSelectExistingFlow}
        sourceLabelById={
          new Map([
            ["source-primary", "Primary WhatsApp"],
            ["source-secondary", "Secondary WhatsApp"],
          ])
        }
      />
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Appointments Secondary WhatsApp",
      })
    );

    expect(onSelectExistingFlow).toHaveBeenCalledWith(secondaryFlow);
    // Published is the normal state and gets no badge.
    expect(screen.queryByText("PUBLISHED")).toBeNull();
    expect(screen.queryByText("flowStatusDraft")).toBeNull();
  });

  it("badges only unpublished forms and never shows raw IDs", () => {
    render(
      <TemplatePicker
        onSelect={jest.fn()}
        existingFlows={[
          { id: "flow-draft", name: "Survey", status: "DRAFT" },
          { id: "flow-unnamed", name: " ", status: "PUBLISHED" },
          { id: "flow-blocked", name: "Old", status: "BLOCKED" },
        ]}
        onSelectExistingFlow={jest.fn()}
      />
    );

    expect(
      screen.getByRole("button", { name: "Survey flowStatusDraft" })
    ).toBeTruthy();
    const unnamed = screen.getByRole("button", { name: "untitledForm" });
    expect(unnamed.getAttribute("title")).toBe("flow-unnamed");
    expect(screen.queryByText("flow-unnamed")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Old flowStatusBlocked" })
    ).toBeTruthy();
    expect(screen.queryByText("DRAFT")).toBeNull();
  });

  it("shows placeholder chips while the form list loads", () => {
    render(
      <TemplatePicker
        onSelect={jest.fn()}
        existingFlows={[]}
        existingFlowsLoading
      />
    );

    expect(screen.getByTestId("flow-picker-loading").textContent).toBe(
      "flowPickerExistingLoading"
    );
    expect(screen.getByText("flowPickerDescription")).toBeTruthy();
  });

  it("offers only the Flow embedded in an approved template", () => {
    render(
      <TemplatePicker
        onSelect={jest.fn()}
        existingFlows={[
          {
            id: "approved-flow",
            name: "Approved appointments",
            sourceId: "source-primary",
          },
          {
            id: "unrelated-flow",
            name: "Unrelated survey",
            sourceId: "source-primary",
          },
        ]}
        constrainedFlowId="approved-flow"
        onSelectExistingFlow={jest.fn()}
      />
    );

    expect(screen.getByText("Approved appointments")).toBeTruthy();
    expect(screen.queryByText("Unrelated survey")).toBeNull();
    expect(screen.queryByText("flowTemplateLeadGenTitle")).toBeNull();
    expect(screen.getByText("flowTemplateOwnedDescription")).toBeTruthy();
  });
});
