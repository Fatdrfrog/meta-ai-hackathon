/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PreservedTabsContent } from "@/components/ui/preserved-tabs-content";

function Harness() {
  const [tab, setTab] = useState("draft");

  return (
    <Tabs onValueChange={setTab} value={tab}>
      <TabsList>
        <TabsTrigger value="draft">Draft</TabsTrigger>
        <TabsTrigger value="report">Report</TabsTrigger>
      </TabsList>
      <PreservedTabsContent activeValue={tab} value="draft">
        <input aria-label="Campaign draft" data-testid="draft-input" />
      </PreservedTabsContent>
      <PreservedTabsContent activeValue={tab} value="report">
        <p>Report body</p>
      </PreservedTabsContent>
    </Tabs>
  );
}

describe("PreservedTabsContent", () => {
  it("keeps a visited panel's input and hides it while another tab is open", () => {
    render(<Harness />);

    expect(screen.queryByText("Report body")).toBeNull();
    fireEvent.change(screen.getByTestId("draft-input"), {
      target: { value: "hello buyers" },
    });

    const reportTab = screen.getByRole("tab", { name: "Report" });
    fireEvent.mouseDown(reportTab, { button: 0, ctrlKey: false });
    fireEvent.click(reportTab);

    expect(screen.getByText("Report body").closest("[hidden]")).toBeNull();
    const hiddenDraft = screen.getByTestId("draft-input") as HTMLInputElement;
    expect(hiddenDraft.value).toBe("hello buyers");
    expect(hiddenDraft.closest("[hidden]")).toBeTruthy();

    const draftTab = screen.getByRole("tab", { name: "Draft" });
    fireEvent.mouseDown(draftTab, { button: 0, ctrlKey: false });
    fireEvent.click(draftTab);

    const restoredDraft = screen.getByTestId("draft-input") as HTMLInputElement;
    expect(restoredDraft.value).toBe("hello buyers");
    expect(restoredDraft.closest("[hidden]")).toBeNull();
    expect(restoredDraft.style.display).not.toBe("none");
  });
});
