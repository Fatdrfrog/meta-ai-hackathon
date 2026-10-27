/**
 * @jest-environment jsdom
 */

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { DateRange } from "@/components/ui/date-range-control";
import type { DashboardComparisonPeriod } from "@/types/dashboard";
import { DashboardToolbar } from "./dashboard-toolbar";
import { installMatchMedia } from "@/test-support/dom-test-utils";

jest.mock("next-intl", () => {
  const intl = jest.requireActual("@/test-support/next-intl-test-utils");
  return intl.createMessagesNextIntlMock({ format: intl.fillPlaceholders });
});

jest.mock("@/components/ui/date-range-control", () => ({
  DateRangeControl: ({
    value,
    onChange,
  }: {
    value: DateRange;
    onChange: (value: DateRange) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        onChange({ preset: "all", from: null, to: null } as DateRange)
      }
    >
      Range: {value.preset}
    </button>
  ),
}));

const messages = {
  Sheet: { close: "Close" },
  Dialog: { close: "Close" },
  DashboardPage: {
    filters: {
      label: "Filters",
      channels: "Channels",
      noChannels: "No channels",
      categories: "Categories",
      noCategories: "No categories",
      internalLabels: "Internal labels",
      noInternalLabels: "No internal labels",
      managers: "Managers",
      noManagers: "No managers",
      sheetTitle: "Dashboard filters",
      sheetDescription: "Apply filters to every dashboard section.",
      apply: "Apply filters",
      clearSelection: "Clear selection",
      cancel: "Cancel",
    },
    presets: {
      label: "Presets",
      empty: "No presets",
      save: "Save current as preset",
      saveTitle: "Save filter preset",
      saveDescription: "Reuse this filter selection later.",
      nameLabel: "Preset name",
      namePlaceholder: "For example, Support leads",
      cancel: "Cancel",
      confirmSave: "Save preset",
      apply: "Apply {name}",
      deleteAria: "Delete {name}",
      deleteTitle: "Delete filter preset?",
      deleteDescription: "Delete {name}. This cannot be undone.",
      deleteCancel: "Keep preset",
      deleteConfirm: "Delete preset",
      deleteAction: "Delete",
    },
    actions: { export: "Export" },
  },
  DashboardClientPage: {
    uncategorized: "Uncategorized",
    missingValue: "—",
    comparison: {
      label: "Period comparison",
      enabled: "Compare with previous period",
      disabled: "Current period only",
      unavailable: "Comparison is unavailable for this range",
      currentPeriod: "Current: {range}",
      previousPeriod: "Previous: {range}",
    },
    activeFilters: {
      label: "Active filters",
      count: "Active filters: {count}",
      clearAll: "Clear all",
      remove: "Remove {value}",
      removeAction: "Remove",
    },
  },
};

const baseProps = {
  dateRange: { preset: "30d", from: null, to: null } as DateRange,
  filters: {
    channels: ["WhatsApp"],
    categories: ["Refunds"],
    internalLabels: ["VIP"],
    managerIds: ["manager-1"],
  },
  options: {
    channels: ["WhatsApp", "Telegram"],
    categories: ["Refunds", "Billing"],
    internalLabels: ["VIP", "Escalated"],
    managers: [{ id: "manager-1", name: "Mira Manager" }],
  },
  presets: [
    {
      name: "Support",
      channels: ["WhatsApp"],
      categories: ["Refunds"],
      internalLabels: [],
      managerIds: [],
    },
  ],
  comparisonEnabled: true,
  comparisonAvailable: true,
  comparisonPeriod: {
    preset: "30d",
    strategy: "adjacent_equal_duration",
    timeZone: "Asia/Qyzylorda",
    current: {
      start: "2026-07-06T07:00:00.000Z",
      endExclusive: "2026-08-05T07:00:00.000Z",
    },
    previous: {
      start: "2026-06-06T07:00:00.000Z",
      endExclusive: "2026-07-06T07:00:00.000Z",
    },
  } satisfies DashboardComparisonPeriod,
  exportDisabled: false,
  onDateRangeChange: jest.fn(),
  onComparisonChange: jest.fn(),
  onFiltersChange: jest.fn(),
  onSavePreset: jest.fn(),
  onApplyPreset: jest.fn(),
  onDeletePreset: jest.fn(),
  onExport: jest.fn(),
};

function renderToolbar(overrides: Partial<typeof baseProps> = {}) {
  const props = {
    ...baseProps,
    onDateRangeChange: jest.fn(),
    onComparisonChange: jest.fn(),
    onFiltersChange: jest.fn(),
    onSavePreset: jest.fn(),
    onApplyPreset: jest.fn(),
    onDeletePreset: jest.fn(),
    onExport: jest.fn(),
    ...overrides,
  };

  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DashboardToolbar {...props} />
    </NextIntlClientProvider>
  );

  return props;
}

describe("DashboardToolbar", () => {
  it("shows text actions without icons and cancels a keyboard-edited draft without applying it", async () => {
    const user = userEvent.setup();
    const props = renderToolbar();
    expect(document.querySelector("svg")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Active filters: 4" }));
    const sheet = screen.getByRole("dialog", { name: "Dashboard filters" });
    expect(sheet.querySelector("svg")).toBeNull();
    expect(
      within(sheet).getByRole("button", { name: "Delete Support" }).textContent
    ).toBe("Delete");
    const telegram = within(sheet).getByRole("checkbox", { name: "Telegram" });
    telegram.focus();
    await user.keyboard(" ");
    expect(telegram.getAttribute("aria-checked")).toBe("true");
    await user.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(props.onFiltersChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Active filters: 4" }));
    expect(
      screen
        .getByRole("checkbox", { name: "Telegram" })
        .getAttribute("aria-checked")
    ).toBe("false");
    await user.click(
      screen.getByRole("button", { name: "Save current as preset" })
    );
    expect(
      screen
        .getByRole("dialog", { name: "Save filter preset" })
        .querySelector("svg")
    ).toBeNull();
  });

  beforeAll(() => {
    Object.defineProperty(window, "PointerEvent", {
      configurable: true,
      value: MouseEvent,
    });
    Object.defineProperty(globalThis, "CSS", {
      configurable: true,
      value: { escape: (value: string) => value },
    });
  });

  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1024,
    });
    installMatchMedia(() => window.innerWidth < 768);
  });

  it("shows the exact normalized current and previous ranges globally", () => {
    renderToolbar();

    expect(
      screen.getByText("Current: Jul 6, 2026, 12:00 PM – Aug 5, 2026, 12:00 PM")
    ).not.toBeNull();
    expect(
      screen.getByText(
        "Previous: Jun 6, 2026, 12:00 PM – Jul 6, 2026, 12:00 PM"
      )
    ).not.toBeNull();
  });

  it("keeps desktop toolbar actions compact without sacrificing mobile width", () => {
    renderToolbar();

    const range = screen.getByRole("button", { name: "Range: 30d" });
    expect(range.parentElement?.className).toContain("sm:w-[260px]");

    const exportButton = screen.getByRole("button", { name: "Export" });
    expect(exportButton.parentElement?.className).toContain("sm:w-fit");
    expect(exportButton.className).not.toContain("btn-push");
  });

  it.each([
    { comparisonEnabled: false, comparisonAvailable: true },
    { comparisonEnabled: true, comparisonAvailable: false },
  ])("hides the previous range when comparison is inactive", state => {
    renderToolbar(state);

    expect(screen.getByText(/^Current:/)).not.toBeNull();
    expect(screen.queryByText(/^Previous:/)).toBeNull();
  });

  it("reports the total active count and applies all four filter groups once", () => {
    const props = renderToolbar();

    const trigger = screen.getByRole("button", { name: "Active filters: 4" });
    expect(within(trigger).getByText("4")).not.toBeNull();
    fireEvent.click(trigger);

    const sheet = screen.getByRole("dialog", { name: "Dashboard filters" });
    expect(
      within(sheet).getByText("Apply filters to every dashboard section.")
    ).not.toBeNull();
    expect(
      within(sheet).getByRole("group", { name: "Channels" })
    ).not.toBeNull();
    expect(
      within(sheet).getByRole("group", { name: "Categories" })
    ).not.toBeNull();
    expect(
      within(sheet).getByRole("group", { name: "Internal labels" })
    ).not.toBeNull();
    expect(
      within(sheet).getByRole("group", { name: "Managers" })
    ).not.toBeNull();

    fireEvent.click(within(sheet).getByRole("checkbox", { name: "Telegram" }));
    fireEvent.click(
      within(sheet).getByRole("button", { name: "Apply filters" })
    );

    expect(props.onFiltersChange).toHaveBeenCalledTimes(1);
    expect(props.onFiltersChange).toHaveBeenCalledWith({
      channels: ["WhatsApp", "Telegram"],
      categories: ["Refunds"],
      internalLabels: ["VIP"],
      managerIds: ["manager-1"],
    });
  });

  it("keeps single-selection comparison controlled and disables it for Last 12 months", () => {
    const props = renderToolbar();

    const previous = screen.getByRole("radio", {
      name: "Compare with previous period",
    });
    expect(previous.getAttribute("data-state")).toBe("on");

    fireEvent.click(previous);
    expect(props.onComparisonChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("radio", { name: "Current period only" }));
    expect(props.onComparisonChange).toHaveBeenCalledWith(false);

    const { unmount } = render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <DashboardToolbar
          {...baseProps}
          dateRange={{ preset: "all", from: null, to: null } as DateRange}
          comparisonEnabled={false}
          comparisonAvailable={false}
        />
      </NextIntlClientProvider>
    );

    expect(
      screen
        .getAllByRole("radio", { name: "Current period only" })
        .at(-1)
        ?.getAttribute("disabled")
    ).not.toBeNull();
    expect(
      screen.getByText("Comparison is unavailable for this range")
    ).not.toBeNull();
    unmount();
  });

  it("uses accessible preset dialogs and confirms deletion before mutating", () => {
    const promptSpy = jest.spyOn(window, "prompt").mockImplementation(() => {
      throw new Error("native prompt must not be used");
    });
    const props = renderToolbar();

    fireEvent.click(screen.getByRole("button", { name: "Active filters: 4" }));
    const sheet = screen.getByRole("dialog", { name: "Dashboard filters" });

    fireEvent.click(
      within(sheet).getByRole("button", { name: "Save current as preset" })
    );
    const saveDialog = screen.getByRole("dialog", {
      name: "Save filter preset",
    });
    expect(
      within(saveDialog).getByText("Reuse this filter selection later.")
    ).not.toBeNull();
    fireEvent.change(
      within(saveDialog).getByRole("textbox", { name: "Preset name" }),
      { target: { value: "Priority" } }
    );
    fireEvent.click(
      within(saveDialog).getByRole("button", { name: "Save preset" })
    );
    expect(props.onSavePreset).toHaveBeenCalledWith("Priority");
    expect(promptSpy).not.toHaveBeenCalled();

    fireEvent.click(
      within(sheet).getByRole("button", { name: "Apply Support" })
    );
    expect(props.onApplyPreset).toHaveBeenCalledWith(baseProps.presets[0]);

    fireEvent.click(screen.getByRole("button", { name: "Active filters: 4" }));
    const reopenedSheet = screen.getByRole("dialog", {
      name: "Dashboard filters",
    });
    fireEvent.click(
      within(reopenedSheet).getByRole("button", { name: "Delete Support" })
    );
    expect(props.onDeletePreset).not.toHaveBeenCalled();

    const deleteDialog = screen.getByRole("alertdialog", {
      name: "Delete filter preset?",
    });
    expect(
      within(deleteDialog).getByText("Delete Support. This cannot be undone.")
    ).not.toBeNull();
    fireEvent.click(
      within(deleteDialog).getByRole("button", { name: "Delete preset" })
    );
    expect(props.onDeletePreset).toHaveBeenCalledWith("Support");
  });

  it("returns focus to the save preset trigger after every close path", async () => {
    const user = userEvent.setup();
    const props = renderToolbar();

    await user.click(screen.getByRole("button", { name: "Active filters: 4" }));
    const sheet = screen.getByRole("dialog", { name: "Dashboard filters" });
    const saveTrigger = within(sheet).getByRole("button", {
      name: "Save current as preset",
    });

    await user.click(saveTrigger);
    const saveDialog = screen.getByRole("dialog", {
      name: "Save filter preset",
    });
    await user.click(
      within(saveDialog).getByRole("button", { name: "Cancel" })
    );

    await waitFor(() => expect(document.activeElement).toBe(saveTrigger));

    await user.click(saveTrigger);
    const presetName = screen.getByRole("textbox", { name: "Preset name" });
    await user.type(presetName, "Priority");
    await user.click(screen.getByRole("button", { name: "Save preset" }));

    expect(props.onSavePreset).toHaveBeenCalledWith("Priority");
    await waitFor(() => expect(document.activeElement).toBe(saveTrigger));

    await user.click(saveTrigger);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(saveTrigger));
  });

  it("returns focus to the exact delete trigger after canceling", async () => {
    const user = userEvent.setup();
    renderToolbar();

    await user.click(screen.getByRole("button", { name: "Active filters: 4" }));
    const sheet = screen.getByRole("dialog", { name: "Dashboard filters" });
    const deleteTrigger = within(sheet).getByRole("button", {
      name: "Delete Support",
    });

    await user.click(deleteTrigger);
    const deleteDialog = screen.getByRole("alertdialog", {
      name: "Delete filter preset?",
    });
    await user.click(
      within(deleteDialog).getByRole("button", { name: "Keep preset" })
    );

    await waitFor(() => expect(document.activeElement).toBe(deleteTrigger));

    await user.click(deleteTrigger);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(deleteTrigger));
  });

  it("moves focus to the stable save trigger after confirming deletion", async () => {
    const user = userEvent.setup();
    const props = renderToolbar();

    await user.click(screen.getByRole("button", { name: "Active filters: 4" }));
    const sheet = screen.getByRole("dialog", { name: "Dashboard filters" });
    const deleteTrigger = within(sheet).getByRole("button", {
      name: "Delete Support",
    });
    const saveTrigger = within(sheet).getByRole("button", {
      name: "Save current as preset",
    });

    await user.click(deleteTrigger);
    const deleteDialog = screen.getByRole("alertdialog", {
      name: "Delete filter preset?",
    });
    await user.click(
      within(deleteDialog).getByRole("button", { name: "Delete preset" })
    );

    expect(props.onDeletePreset).toHaveBeenCalledWith("Support");
    await waitFor(() => expect(document.activeElement).toBe(saveTrigger));
  });

  it("preserves destructive confirmation semantics and cancel focus on mobile", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 375,
    });
    const user = userEvent.setup();
    const props = renderToolbar();

    await user.click(screen.getByRole("button", { name: "Active filters: 4" }));
    const sheet = screen.getByRole("dialog", { name: "Dashboard filters" });
    const deleteTrigger = within(sheet).getByRole("button", {
      name: "Delete Support",
    });

    await user.click(deleteTrigger);
    const deleteDialog = await screen.findByRole("alertdialog", {
      name: "Delete filter preset?",
    });
    const cancel = within(deleteDialog).getByRole("button", {
      name: "Keep preset",
    });

    expect(window.matchMedia).toHaveBeenCalledWith("(max-width: 767px)");
    expect(
      within(deleteDialog).getByText("Delete Support. This cannot be undone.")
    ).not.toBeNull();
    expect(props.onDeletePreset).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    await user.keyboard("{Enter}");
    const animationEnd = new Event("animationend", { bubbles: true });
    Object.defineProperty(animationEnd, "animationName", {
      value: window.getComputedStyle(deleteDialog).animationName,
    });
    fireEvent(deleteDialog, animationEnd);
    expect(props.onDeletePreset).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(deleteTrigger));
  });
});
