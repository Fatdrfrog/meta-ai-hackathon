/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { ActiveFilters } from "./active-filters";

jest.mock("next-intl", () => {
  const intl = jest.requireActual("@/test-support/next-intl-test-utils");
  return intl.createMessagesNextIntlMock({ format: intl.fillPlaceholders });
});

const messages = {
  DashboardClientPage: {
    uncategorized: "Uncategorized",
    missingValue: "—",
    activeFilters: {
      label: "Active filters",
      count: "Active filters: {count}",
      clearAll: "Clear all",
      remove: "Remove {value}",
      removeAction: "Remove",
    },
  },
};

describe("ActiveFilters", () => {
  it("renders every selected value and removes only the requested chip", () => {
    const onRemove = jest.fn();

    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ActiveFilters
          filters={{
            channels: ["WhatsApp"],
            categories: ["Refunds"],
            internalLabels: ["VIP"],
            managerIds: ["manager-1"],
          }}
          managers={[{ id: "manager-1", name: "Mira Manager" }]}
          onRemove={onRemove}
          onClearAll={jest.fn()}
        />
      </NextIntlClientProvider>
    );

    expect(screen.getByText("Active filters")).not.toBeNull();
    expect(screen.getByText("WhatsApp")).not.toBeNull();
    expect(screen.getByText("Refunds")).not.toBeNull();
    expect(screen.getByText("VIP")).not.toBeNull();
    expect(screen.getByText("Mira Manager")).not.toBeNull();
    expect(screen.getAllByText("Remove")).toHaveLength(4);
    expect(document.querySelector("svg")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove Refunds" }));

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith("categories", "Refunds");
  });

  it("clears all four dimensions through one callback and hides when empty", () => {
    const onClearAll = jest.fn();
    const { rerender } = render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ActiveFilters
          filters={{
            channels: ["WhatsApp"],
            categories: ["Refunds"],
            internalLabels: ["VIP"],
            managerIds: ["manager-1"],
          }}
          managers={[{ id: "manager-1", name: "Mira Manager" }]}
          onRemove={jest.fn()}
          onClearAll={onClearAll}
        />
      </NextIntlClientProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onClearAll).toHaveBeenCalledTimes(1);

    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ActiveFilters
          filters={{
            channels: [],
            categories: [],
            internalLabels: [],
            managerIds: [],
          }}
          managers={[]}
          onRemove={jest.fn()}
          onClearAll={onClearAll}
        />
      </NextIntlClientProvider>
    );

    expect(screen.queryByText("Active filters")).toBeNull();
  });
});
