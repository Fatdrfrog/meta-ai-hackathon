/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { ScenarioCreateTypeDialog } from "./scenario-create-type-dialog";

jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <header>{children}</header>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h1>{children}</h1>
  ),
}));

describe("ScenarioCreateTypeDialog", () => {
  it("opens the configured sales playbook path without creating a blank scenario", () => {
    const onSelect = jest.fn();
    const onSelectRevenuePlaybook = jest.fn();
    render(
      <ScenarioCreateTypeDialog
        open
        onOpenChange={jest.fn()}
        onSelect={onSelect}
        onSelectRevenuePlaybook={onSelectRevenuePlaybook}
      />
    );
    fireEvent.click(
      screen.getByRole("button", { name: /revenuePlaybooks.entryTitle/i })
    );
    expect(onSelectRevenuePlaybook).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
  it("offers only incoming-message scenario producers", () => {
    const onSelect = jest.fn();
    render(
      <ScenarioCreateTypeDialog
        open
        onOpenChange={jest.fn()}
        onSelect={onSelect}
      />
    );

    expect(screen.queryByText("createTypePaymentTitle")).toBeNull();
    expect(screen.queryByText("createTypeFollowupTitle")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: /createTypeKeywordTitle/i })
    );
    expect(onSelect).toHaveBeenCalledWith("keyword");
  });
});
