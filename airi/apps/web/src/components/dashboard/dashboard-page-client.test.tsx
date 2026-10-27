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
import { createStore, Provider } from "jotai";
import { NextIntlClientProvider } from "next-intl";
import {
  DASHBOARD_UNCATEGORIZED_CATEGORY,
  type DashboardData,
} from "@/types/dashboard";
import {
  createDashboardPresetsAtom,
  dashboardFiltersAtom,
} from "./dashboard-state";
import { DashboardPageClient } from "./dashboard-page-client";

let mockLoadedData: DashboardData | null = null;
const mockBuildDashboardCsv = jest.fn((_input: unknown) => "dashboard,csv");
const mockBuildDashboardQueryPath = jest.fn();

jest.mock("next-intl", () => {
  const intl = jest.requireActual("@/test-support/next-intl-test-utils");
  return intl.createMessagesNextIntlMock({ format: intl.fillPlaceholders });
});

jest.mock("./dashboard-export", () => ({
  buildDashboardCsv: (input: unknown) => mockBuildDashboardCsv(input),
}));

jest.mock("@/lib/dashboard-query", () => {
  const actual = jest.requireActual<typeof import("@/lib/dashboard-query")>(
    "@/lib/dashboard-query"
  );
  return {
    ...actual,
    buildDashboardQueryPath: (...args: unknown[]) => {
      const [workspaceId, dateRange, filters, timeZone] = args as Parameters<
        typeof actual.buildDashboardQueryPath
      >;
      const result = actual.buildDashboardQueryPath(
        workspaceId,
        dateRange,
        filters,
        timeZone
      );
      mockBuildDashboardQueryPath(result);
      return result;
    },
  };
});

jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

jest.mock("./dashboard-client-page", () => ({
  DashboardClientPage: ({
    dateRange,
    filters,
    comparisonEnabled,
    onDataLoaded,
  }: {
    dateRange: { preset: string };
    filters: {
      channels: string[];
      categories: string[];
      internalLabels: string[];
      managerIds: string[];
    };
    comparisonEnabled?: boolean;
    onDataLoaded?: (data: DashboardData) => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() => mockLoadedData && onDataLoaded?.(mockLoadedData)}
      >
        Load dashboard fixture
      </button>
      <output data-testid="selected-channels">
        {filters.channels.join("|")}
      </output>
      <output data-testid="selected-categories">
        {filters.categories.join("|")}
      </output>
      <output data-testid="selected-labels">
        {filters.internalLabels.join("|")}
      </output>
      <output data-testid="selected-managers">
        {filters.managerIds.join("|")}
      </output>
      <output data-testid="comparison-enabled">
        {String(comparisonEnabled)}
      </output>
      <output data-testid="child-query-input">
        {JSON.stringify({ dateRange, filters })}
      </output>
    </div>
  ),
}));

const dashboardData = {
  stats: [],
  dailySeries: { current: [], previous: [] },
  conversationActivityByTime: [],
  categoryComparisons: [
    {
      category: DASHBOARD_UNCATEGORIZED_CATEGORY,
      current: 3,
      previous: 0,
      delta: 3,
      percentChange: null,
      kind: "new",
    },
  ],
  peakTime: null,
  topCategories: [{ name: DASHBOARD_UNCATEGORIZED_CATEGORY, value: 3 }],
  uncategorizedCount: 3,
  categoriesByChannel: [],
  topComplaintTag: null,
  advertisement: null,
  internalLabels: {
    taggedConversations: 1,
    unlabeledConversations: 2,
    uniqueLabels: 1,
    totalAssignments: 1,
    availableLabels: ["VIP"],
    topLabels: [],
  },
  managerOptions: [{ id: "manager-1", name: "Mira Manager" }],
  managerPerformance: [],
  firstResponse: {
    count: 0,
    medianSeconds: null,
    averageSeconds: null,
    p90Seconds: null,
    comparison: null,
  },
  comparisonPeriod: {
    preset: "30",
    strategy: "previous_period",
    timeZone: "UTC",
    current: {
      start: "2026-07-01T00:00:00.000Z",
      endExclusive: "2026-07-31T00:00:00.000Z",
    },
    previous: {
      start: "2026-06-01T00:00:00.000Z",
      endExclusive: "2026-07-01T00:00:00.000Z",
    },
  },
} as unknown as DashboardData;

const messages = {
  Sheet: { close: "Close" },
  Dialog: { close: "Close" },
  DashboardPage: {
    filters: {
      allChannels: "All channels",
      allCategories: "All categories",
      allLabels: "All labels",
      allManagers: "All managers",
      label: "Filters",
      channelCount: "{count} channels",
      categoryCount: "{count} categories",
      labelCount: "{count} labels",
      managerCount: "{count} managers",
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
    },
    presets: {
      label: "Presets",
      empty: "No presets",
      delete: "Delete: {name}",
      save: "Save current as preset",
      prompt: "Preset name",
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
    },
    actions: { export: "Export" },
  },
  DateRangeControl: {
    last7Days: "Last 7 days",
    last30Days: "Last 30 days",
    last90Days: "Last 90 days",
    thisWeek: "This week",
    last12Months: "Last 12 months",
    select: "Select",
    customRange: "Custom range",
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
    },
  },
  SectionCards: {},
};

function renderPage(workspaceId: string, store = createStore()) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <Provider store={store}>
        <DashboardPageClient workspaceId={workspaceId} />
      </Provider>
    </NextIntlClientProvider>
  );
  return store;
}

function openFilterSheet() {
  fireEvent.click(screen.getByRole("button", { name: /Active filters:/ }));
  return screen.getByRole("dialog", { name: "Dashboard filters" });
}

describe("DashboardPageClient", () => {
  let anchorClick: {
    mockClear: () => void;
    mockRestore: () => void;
  };

  beforeAll(() => {
    Object.defineProperty(window, "PointerEvent", {
      configurable: true,
      value: MouseEvent,
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: jest.fn(() => "blob:dashboard"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: jest.fn(),
    });
    anchorClick = jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
  });

  afterAll(() => {
    anchorClick.mockRestore();
  });

  beforeEach(() => {
    mockLoadedData = null;
    anchorClick.mockClear();
    mockBuildDashboardCsv.mockClear();
    mockBuildDashboardQueryPath.mockClear();
  });

  it("renders the localized responsive toolbar and accessible filter sheet", () => {
    renderPage("task-5-toolbar");

    expect(screen.getByRole("button", { name: /Last 30 days/ })).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Export" }).getAttribute("disabled")
    ).not.toBeNull();

    const sheet = openFilterSheet();
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
  });

  it("shows server-normalized ranges only after the current dashboard query loads", () => {
    mockLoadedData = dashboardData;
    renderPage("task-5-period-ranges");

    expect(screen.queryByText(/^Current:/)).toBeNull();
    expect(screen.queryByText(/^Previous:/)).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Load dashboard fixture" })
    );

    expect(
      screen.getByText("Current: Jul 1, 2026 – Jul 30, 2026")
    ).not.toBeNull();
    expect(
      screen.getByText("Previous: Jun 1, 2026 – Jun 30, 2026")
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Current period only" }));
    expect(screen.getByText(/^Current:/)).not.toBeNull();
    expect(screen.queryByText(/^Previous:/)).toBeNull();
  });

  it("localizes an uncategorized option while preserving its canonical value", () => {
    mockLoadedData = dashboardData;
    renderPage("task-5-uncategorized");

    fireEvent.click(
      screen.getByRole("button", { name: "Load dashboard fixture" })
    );
    const sheet = openFilterSheet();
    expect(
      within(sheet).queryByText(DASHBOARD_UNCATEGORIZED_CATEGORY)
    ).toBeNull();
    fireEvent.click(
      within(sheet).getByRole("checkbox", { name: "Uncategorized" })
    );
    fireEvent.click(
      within(sheet).getByRole("button", { name: "Apply filters" })
    );

    expect(screen.getByTestId("selected-categories").textContent).toBe(
      DASHBOARD_UNCATEGORIZED_CATEGORY
    );
  });

  it("keeps export guarded by the loaded query and exports the presentation comparison state", () => {
    mockLoadedData = dashboardData;
    renderPage("task-5-export");

    const exportButton = screen.getByRole("button", { name: "Export" });
    fireEvent.click(
      screen.getByRole("button", { name: "Load dashboard fixture" })
    );
    expect(exportButton.getAttribute("disabled")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Current period only" }));
    expect(exportButton.getAttribute("disabled")).toBeNull();
    fireEvent.click(exportButton);
    expect(mockBuildDashboardCsv).toHaveBeenCalledWith(
      expect.objectContaining({ comparisonEnabled: false })
    );

    const sheet = openFilterSheet();
    fireEvent.click(
      within(sheet).getByRole("checkbox", { name: "Uncategorized" })
    );
    fireEvent.click(
      within(sheet).getByRole("button", { name: "Apply filters" })
    );
    expect(exportButton.getAttribute("disabled")).not.toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Load dashboard fixture" })
    );
    expect(exportButton.getAttribute("disabled")).toBeNull();
  });

  it("defaults comparison on, cannot clear the choice, and never changes query identity", () => {
    renderPage("task-5-comparison");

    expect(screen.getByTestId("comparison-enabled").textContent).toBe("true");
    const initialQueryInput =
      screen.getByTestId("child-query-input").textContent;
    const initialBuildCalls = mockBuildDashboardQueryPath.mock.calls.length;

    const currentOnly = screen.getByRole("radio", {
      name: "Current period only",
    });
    fireEvent.click(currentOnly);
    expect(screen.getByTestId("comparison-enabled").textContent).toBe("false");
    expect(screen.getByTestId("child-query-input").textContent).toBe(
      initialQueryInput
    );
    expect(mockBuildDashboardQueryPath).toHaveBeenCalledTimes(
      initialBuildCalls
    );

    fireEvent.click(currentOnly);
    expect(screen.getByTestId("comparison-enabled").textContent).toBe("false");
    expect(mockBuildDashboardQueryPath).toHaveBeenCalledTimes(
      initialBuildCalls
    );
  });

  it("temporarily disables comparison for Last 12 months without erasing preference", () => {
    renderPage("task-5-last-12-months");

    fireEvent.click(screen.getByRole("button", { name: /Last 30 days/ }));
    fireEvent.click(screen.getByRole("button", { name: "Last 12 months" }));
    expect(screen.getByTestId("comparison-enabled").textContent).toBe("false");
    expect(
      screen
        .getByRole("radio", { name: "Current period only" })
        .getAttribute("disabled")
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Last 12 months/ }));
    fireEvent.click(screen.getByRole("button", { name: "Last 30 days" }));
    expect(screen.getByTestId("comparison-enabled").textContent).toBe("true");
  });

  it("normalizes every legacy preset array at runtime and applies it atomically", () => {
    const workspaceId = "task-5-legacy-preset";
    const store = createStore();
    store.set(createDashboardPresetsAtom(workspaceId), [
      {
        name: "Legacy",
        channels: ["WhatsApp", 42],
        categories: null,
        internalLabels: "VIP",
        managerIds: [null, "manager-1"],
      } as never,
    ]);
    const storageSpy = jest.spyOn(Storage.prototype, "setItem");
    storageSpy.mockClear();
    let filterUpdates = 0;
    const unsubscribe = store.sub(dashboardFiltersAtom, () => {
      filterUpdates += 1;
    });

    renderPage(workspaceId, store);
    const sheet = openFilterSheet();
    fireEvent.click(
      within(sheet).getByRole("button", { name: "Apply Legacy" })
    );

    expect(screen.getByTestId("selected-channels").textContent).toBe(
      "WhatsApp"
    );
    expect(screen.getByTestId("selected-categories").textContent).toBe("");
    expect(screen.getByTestId("selected-labels").textContent).toBe("");
    expect(screen.getByTestId("selected-managers").textContent).toBe(
      "manager-1"
    );
    expect(filterUpdates).toBe(1);
    expect(storageSpy).not.toHaveBeenCalled();

    unsubscribe();
    storageSpy.mockRestore();
  });

  it("saves only the canonical filter shape and clears all filters once", () => {
    const workspaceId = "task-5-save-preset";
    const store = createStore();
    store.set(dashboardFiltersAtom, {
      dateRange: { preset: "90d", from: null, to: null },
      selectedChannels: ["WhatsApp"],
      selectedCategories: ["Refunds"],
      selectedInternalLabels: ["VIP"],
      selectedManagerIds: ["manager-1"],
      availableChannels: ["WhatsApp"],
      availableCategories: ["Refunds"],
      availableInternalLabels: ["VIP"],
      availableManagers: [{ id: "manager-1", name: "Mira Manager" }],
    });
    const presetAtom = createDashboardPresetsAtom(workspaceId);

    renderPage(workspaceId, store);
    const sheet = openFilterSheet();
    fireEvent.click(
      within(sheet).getByRole("button", { name: "Save current as preset" })
    );
    const dialog = screen.getByRole("dialog", { name: "Save filter preset" });
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "Preset name" }),
      { target: { value: "Priority" } }
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save preset" })
    );

    expect(store.get(presetAtom)).toEqual([
      {
        name: "Priority",
        channels: ["WhatsApp"],
        categories: ["Refunds"],
        internalLabels: ["VIP"],
        managerIds: ["manager-1"],
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    let filterUpdates = 0;
    const unsubscribe = store.sub(dashboardFiltersAtom, () => {
      filterUpdates += 1;
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(filterUpdates).toBe(1);
    expect(store.get(dashboardFiltersAtom)).toEqual(
      expect.objectContaining({
        selectedChannels: [],
        selectedCategories: [],
        selectedInternalLabels: [],
        selectedManagerIds: [],
      })
    );
    unsubscribe();
  });

  it("keeps focus inside the filter sheet when deleting the focused preset row", async () => {
    const user = userEvent.setup();
    const workspaceId = "task-5-delete-preset-focus";
    const store = createStore();
    const presetAtom = createDashboardPresetsAtom(workspaceId);
    store.set(presetAtom, [
      {
        name: "Support",
        channels: ["WhatsApp"],
        categories: [],
        internalLabels: [],
        managerIds: [],
      },
    ]);

    renderPage(workspaceId, store);
    await user.click(screen.getByRole("button", { name: /Active filters:/ }));
    const sheet = screen.getByRole("dialog", { name: "Dashboard filters" });
    const savePreset = within(sheet).getByRole("button", {
      name: "Save current as preset",
    });

    await user.click(
      within(sheet).getByRole("button", { name: "Delete Support" })
    );
    const confirmation = screen.getByRole("alertdialog", {
      name: "Delete filter preset?",
    });
    await user.click(
      within(confirmation).getByRole("button", { name: "Delete preset" })
    );

    expect(store.get(presetAtom)).toEqual([]);
    expect(
      within(sheet).queryByRole("button", { name: "Delete Support" })
    ).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(savePreset));
  });
});
