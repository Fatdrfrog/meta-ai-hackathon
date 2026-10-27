/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { ScenarioCustomerMultiSelect } from "./customer-multi-select";

const t = (key: string) => key;

describe("ScenarioCustomerMultiSelect", () => {
  it("names the search field instead of relying on its example placeholder", () => {
    render(
      <ScenarioCustomerMultiSelect
        customers={[]}
        selectedCustomerIds={[]}
        t={t}
        onToggle={jest.fn()}
      />
    );
    const search = screen.getByRole("textbox", {
      name: "searchCustomersLabel",
    });
    expect(search.getAttribute("placeholder")).toBe("searchCustomers");
  });

  it("says there are no customers yet, and that none match once a query is typed", () => {
    render(
      <ScenarioCustomerMultiSelect
        customers={[]}
        selectedCustomerIds={[]}
        t={t}
        onToggle={jest.fn()}
      />
    );
    expect(screen.getByText("noCustomersYet")).toBeTruthy();
    fireEvent.change(
      screen.getByRole("textbox", { name: "searchCustomersLabel" }),
      { target: { value: "anna" } }
    );
    expect(screen.getByText("noCustomersMatch")).toBeTruthy();
    expect(screen.queryByText("noCustomersYet")).toBeNull();
  });

  it("toggles a customer and disables every control when read-only", () => {
    const onToggle = jest.fn();
    const { rerender } = render(
      <ScenarioCustomerMultiSelect
        customers={[{ id: "c1", label: "Anna" }]}
        selectedCustomerIds={[]}
        t={t}
        onToggle={onToggle}
      />
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Anna" }));
    expect(onToggle).toHaveBeenCalledWith("c1");
    rerender(
      <ScenarioCustomerMultiSelect
        customers={[{ id: "c1", label: "Anna" }]}
        selectedCustomerIds={[]}
        t={t}
        onToggle={onToggle}
        disabled
      />
    );
    expect(
      screen.getByRole("checkbox", { name: "Anna" }).hasAttribute("disabled")
    ).toBe(true);
    expect(
      screen
        .getByRole("textbox", { name: "searchCustomersLabel" })
        .hasAttribute("disabled")
    ).toBe(true);
  });
});
