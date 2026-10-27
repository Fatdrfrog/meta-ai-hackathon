/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { FlowBranchPreview } from "./action-node-flow-branch-preview";

describe("FlowBranchPreview", () => {
  it("heads the form answers and names an untitled option", () => {
    const handleTitles: string[] = [];
    render(
      <FlowBranchPreview
        options={[
          {
            fieldId: "size",
            fieldLabel: "Size",
            optionId: "large",
            optionTitle: "Large",
          },
          {
            fieldId: "size",
            fieldLabel: "Size",
            optionId: "draft",
            optionTitle: " ",
          },
        ]}
        renderFlowBranchHandle={params => {
          handleTitles.push(params.optionTitle);
          return null;
        }}
      />
    );
    expect(screen.getByText("flowBranchPreviewTitle")).toBeTruthy();
    expect(screen.getByText("Large")).toBeTruthy();
    expect(screen.getByText("untitledOption")).toBeTruthy();
    expect(screen.queryByText("Option")).toBeNull();
    expect(handleTitles).toEqual(["Large", "untitledOption"]);
  });
});
