/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { ComponentProps } from "react";
import type { ScenarioSummary } from "../types";
import {
  buildScenarioHierarchy,
  buildScenarioListLayout,
} from "./hierarchy/utils";
import { ScenariosSidebar } from "./scenarios-sidebar";

const mockUseIsMobile = jest.fn(() => false);

jest.mock("next-intl", () => ({
  useTranslations:
    () => (key: string, values?: Record<string, string | number>) =>
      values?.name ? `${key}:${values.name}` : key,
}));

jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => mockUseIsMobile(),
}));

function renderSidebar(layoutMode: "comfortable" | "compact" | "rail"): void {
  const props = {
    newButtonLabel: "New",
    scenariosCount: 0,
    activeScenarioId: null,
    activeLabel: "Active",
    draftLabel: "Draft",
    isCreatingScenario: false,
    layoutMode,
    items: [],
    onCreateScenario: jest.fn(),
    onSelectScenario: jest.fn(),
    onScenarioNameCommit: jest.fn(),
    onReorder: jest.fn(),
  } satisfies ComponentProps<typeof ScenariosSidebar>;

  render(<ScenariosSidebar {...props} />);
}

function scenario(
  name: string,
  overrides: Partial<ScenarioSummary> = {}
): ScenarioSummary {
  return {
    _id: "scenario-1",
    name,
    description: "",
    status: "draft",
    mode: "conversation",
    timezone: null,
    priority: 0,
    presetId: null,
    presetVersion: null,
    segmentKey: null,
    matchingRole: "default",
    entryPolicy: "once_per_conversation",
    linkedParentScenarioIds: [],
    nodeCount: 0,
    edgeCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function layoutItems(name: string, overrides: Partial<ScenarioSummary> = {}) {
  return buildScenarioListLayout(
    buildScenarioHierarchy([scenario(name, overrides)])
  );
}

describe("ScenariosSidebar", () => {
  beforeEach(() => {
    mockUseIsMobile.mockReturnValue(false);
  });

  it.each(["comfortable", "compact", "rail"] as const)(
    "does not render a separate workflow templates button in %s layout",
    layoutMode => {
      renderSidebar(layoutMode);

      expect(
        screen.queryByRole("button", { name: "Workflow templates" })
      ).not.toBeInTheDocument();
    }
  );

  it("says why New is disabled when the plan limit is reached", () => {
    const props = {
      newButtonLabel: "New",
      scenariosCount: 1,
      activeScenarioId: null,
      activeLabel: "Active",
      draftLabel: "Draft",
      isCreatingScenario: false,
      createDisabled: true,
      createLimitNotice: <span>Upgrade to create more</span>,
      items: layoutItems("Welcome"),
      onCreateScenario: jest.fn(),
      onSelectScenario: jest.fn(),
      onScenarioNameCommit: jest.fn(),
      onReorder: jest.fn(),
    } satisfies ComponentProps<typeof ScenariosSidebar>;
    const { rerender } = render(<ScenariosSidebar {...props} />);

    expect(screen.getByRole("button", { name: "New" })).toBeDisabled();
    expect(screen.getByText("Upgrade to create more")).toBeInTheDocument();

    rerender(<ScenariosSidebar {...props} createDisabled={false} />);
    expect(
      screen.queryByText("Upgrade to create more")
    ).not.toBeInTheDocument();
  });

  it("commits a scenario name only once when Enter moves focus away", async () => {
    const onScenarioNameCommit = jest.fn();
    render(
      <ScenariosSidebar
        newButtonLabel="New"
        scenariosCount={1}
        activeScenarioId="scenario-1"
        activeLabel="Active"
        draftLabel="Draft"
        isCreatingScenario={false}
        items={layoutItems("Alpha")}
        onCreateScenario={jest.fn()}
        onSelectScenario={jest.fn()}
        onScenarioNameCommit={onScenarioNameCommit}
        onReorder={jest.fn()}
      />
    );

    const input = screen.getByDisplayValue("Alpha");
    await act(async () => {
      fireEvent.change(input, { target: { value: "Beta" } });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.blur(input);
      await Promise.resolve();
    });

    expect(onScenarioNameCommit).toHaveBeenCalledTimes(1);
    expect(onScenarioNameCommit).toHaveBeenCalledWith("scenario-1", "Beta");
  });

  it("restores the persisted scenario name when Escape cancels editing", () => {
    const onScenarioNameCommit = jest.fn();

    render(
      <ScenariosSidebar
        newButtonLabel="New"
        scenariosCount={1}
        activeScenarioId="scenario-1"
        activeLabel="Active"
        draftLabel="Draft"
        isCreatingScenario={false}
        items={layoutItems("Alpha")}
        onCreateScenario={jest.fn()}
        onSelectScenario={jest.fn()}
        onScenarioNameCommit={onScenarioNameCommit}
        onReorder={jest.fn()}
      />
    );
    const input = screen.getByDisplayValue("Alpha");
    fireEvent.change(input, { target: { value: "Beta" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);

    expect(input).toHaveValue("Alpha");
    expect(onScenarioNameCommit).not.toHaveBeenCalled();
  });

  it("keeps the edited row mounted until a searched scenario name is committed", () => {
    render(
      <ScenariosSidebar
        newButtonLabel="New"
        searchPlaceholder="Search scenarios"
        scenariosCount={1}
        activeScenarioId="scenario-1"
        activeLabel="Active"
        draftLabel="Draft"
        isCreatingScenario={false}
        items={layoutItems("Alpha")}
        onCreateScenario={jest.fn()}
        onSelectScenario={jest.fn()}
        onScenarioNameCommit={jest.fn()}
        onReorder={jest.fn()}
      />
    );
    fireEvent.change(screen.getByPlaceholderText("Search scenarios"), {
      target: { value: "Alpha" },
    });
    fireEvent.change(screen.getByPlaceholderText("scenarioNamePlaceholder"), {
      target: { value: "Beta" },
    });

    expect(screen.getByDisplayValue("Beta")).toBeInTheDocument();
  });

  it("caps scenario names at the shared editor limit", () => {
    render(
      <ScenariosSidebar
        newButtonLabel="New"
        scenariosCount={1}
        activeScenarioId="scenario-1"
        activeLabel="Active"
        draftLabel="Draft"
        isCreatingScenario={false}
        items={layoutItems("Alpha")}
        onCreateScenario={jest.fn()}
        onSelectScenario={jest.fn()}
        onScenarioNameCommit={jest.fn()}
        onReorder={jest.fn()}
      />
    );

    expect(screen.getByDisplayValue("Alpha")).toHaveAttribute(
      "maxlength",
      "120"
    );
  });

  it("exposes both entry policies as the only editable routing setting", () => {
    const onScenarioRoutingSettingsChange = jest.fn();
    render(
      <ScenariosSidebar
        newButtonLabel="New"
        scenariosCount={1}
        activeScenarioId="scenario-1"
        activeLabel="Active"
        draftLabel="Draft"
        isCreatingScenario={false}
        items={layoutItems("Alpha", {
          matchingRole: "fallback",
          entryPolicy: "once_per_conversation",
        })}
        onCreateScenario={jest.fn()}
        onSelectScenario={jest.fn()}
        onScenarioNameCommit={jest.fn()}
        onScenarioRoutingSettingsChange={onScenarioRoutingSettingsChange}
        onReorder={jest.fn()}
      />
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "scenarioSettingsFor:Alpha",
      })
    );

    const policySelect = screen.getByRole("combobox", {
      name: "scenarioEntryPolicy",
    });
    expect(policySelect).toHaveTextContent("scenarioEntryOncePerConversation");
    fireEvent.click(policySelect);
    fireEvent.click(screen.getByText("scenarioEntryRepeatable"));
    expect(onScenarioRoutingSettingsChange).toHaveBeenCalledWith("scenario-1", {
      entryPolicy: "repeatable",
    });
    expect(screen.getByText("scenarioEntryPolicyHint")).toBeInTheDocument();
  });

  it("does not make hidden fallback metadata searchable", () => {
    render(
      <ScenariosSidebar
        newButtonLabel="New"
        scenariosCount={1}
        activeScenarioId="scenario-1"
        activeLabel="Active"
        draftLabel="Draft"
        isCreatingScenario={false}
        items={layoutItems("Welcome", {
          matchingRole: "fallback",
        })}
        onCreateScenario={jest.fn()}
        onSelectScenario={jest.fn()}
        onScenarioNameCommit={jest.fn()}
        onScenarioRoutingSettingsChange={jest.fn()}
        onReorder={jest.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("Search scenarios"), {
      target: { value: "fallback" },
    });

    expect(screen.queryByDisplayValue("Welcome")).not.toBeInTheDocument();
  });

  it("does not search preserved keyword configuration while a trigger is Any", () => {
    const preservedTriggerConfig = {
      enabled: true,
      keywordPattern: "refund",
      keywordMatchMode: "regex" as const,
    };

    render(
      <ScenariosSidebar
        newButtonLabel="New"
        scenariosCount={1}
        activeScenarioId="scenario-1"
        activeLabel="Active"
        draftLabel="Draft"
        isCreatingScenario={false}
        items={layoutItems("Welcome", {
          builderSummary: {
            triggers: [
              {
                triggerNodeId: "trigger-1",
                triggerConfig: preservedTriggerConfig,
                label: "Any message",
              },
            ],
          },
        })}
        onCreateScenario={jest.fn()}
        onSelectScenario={jest.fn()}
        onScenarioNameCommit={jest.fn()}
        onReorder={jest.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("Search scenarios"), {
      target: { value: "refund" },
    });

    expect(screen.queryByDisplayValue("Welcome")).not.toBeInTheDocument();
  });

  it("still searches keyword configuration for a Contains trigger", () => {
    const triggerConfig = {
      enabled: true,
      messageMatchMode: "contains" as const,
      keywordPattern: "refund",
      keywordMatchMode: "contains" as const,
    };

    render(
      <ScenariosSidebar
        newButtonLabel="New"
        scenariosCount={1}
        activeScenarioId="scenario-1"
        activeLabel="Active"
        draftLabel="Draft"
        isCreatingScenario={false}
        items={layoutItems("Welcome", {
          builderSummary: {
            triggers: [
              {
                triggerNodeId: "trigger-1",
                triggerConfig,
                label: "Contains",
              },
            ],
          },
        })}
        onCreateScenario={jest.fn()}
        onSelectScenario={jest.fn()}
        onScenarioNameCommit={jest.fn()}
        onReorder={jest.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("Search scenarios"), {
      target: { value: "refund" },
    });

    expect(screen.getByDisplayValue("Welcome")).toBeInTheDocument();
  });

  it("keeps the selected scenario settings accessible in rail layout", () => {
    render(
      <ScenariosSidebar
        newButtonLabel="New"
        scenariosCount={1}
        activeScenarioId="scenario-1"
        activeLabel="Active"
        draftLabel="Draft"
        isCreatingScenario={false}
        layoutMode="rail"
        items={layoutItems("Alpha")}
        onCreateScenario={jest.fn()}
        onSelectScenario={jest.fn()}
        onScenarioNameCommit={jest.fn()}
        onScenarioRoutingSettingsChange={jest.fn()}
        onReorder={jest.fn()}
      />
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "scenarioSettingsFor:Alpha",
      })
    );

    expect(
      screen.getByRole("combobox", {
        name: "scenarioEntryPolicy",
      })
    ).toHaveTextContent("scenarioEntryOncePerConversation");
  });

  it.each(["comfortable", "compact", "rail"] as const)(
    "saves the selected scenario status through the same command in %s layout",
    async layoutMode => {
      let finishSave!: (saved: boolean) => void;
      const onScenarioSettingsSave = jest.fn(
        () =>
          new Promise<boolean>(resolve => {
            finishSave = resolve;
          })
      );
      render(
        <ScenariosSidebar
          newButtonLabel="New"
          scenariosCount={1}
          activeScenarioId="scenario-1"
          activeLabel="Active"
          draftLabel="Draft"
          isCreatingScenario={false}
          layoutMode={layoutMode}
          items={layoutItems("Alpha")}
          onCreateScenario={jest.fn()}
          onSelectScenario={jest.fn()}
          onScenarioNameCommit={jest.fn()}
          onScenarioSettingsSave={onScenarioSettingsSave}
          onReorder={jest.fn()}
        />
      );

      const statusSwitch = screen.getByRole("switch", {
        name: "Active / Draft",
      });
      fireEvent.click(statusSwitch);

      expect(onScenarioSettingsSave).toHaveBeenCalledWith({
        scenarioId: "scenario-1",
        status: "active",
        priority: 1,
      });
      expect(statusSwitch).toBeDisabled();
      expect(statusSwitch).not.toBeChecked();

      await act(async () => {
        finishSave(false);
      });

      expect(statusSwitch).toBeEnabled();
      expect(statusSwitch).not.toBeChecked();
    }
  );

  it("opens scenario settings below the trigger on narrow screens", () => {
    mockUseIsMobile.mockReturnValue(true);

    render(
      <ScenariosSidebar
        newButtonLabel="New"
        scenariosCount={1}
        activeScenarioId="scenario-1"
        activeLabel="Active"
        draftLabel="Draft"
        isCreatingScenario={false}
        items={layoutItems("Alpha")}
        onCreateScenario={jest.fn()}
        onSelectScenario={jest.fn()}
        onScenarioNameCommit={jest.fn()}
        onScenarioRoutingSettingsChange={jest.fn()}
        onReorder={jest.fn()}
      />
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "scenarioSettingsFor:Alpha",
      })
    );

    expect(screen.getByRole("dialog")).toHaveAttribute("data-side", "bottom");
  });

  it("does not expose conversation routing settings for bulk campaigns", () => {
    render(
      <ScenariosSidebar
        newButtonLabel="New"
        scenariosCount={1}
        activeScenarioId="scenario-1"
        activeLabel="Active"
        draftLabel="Draft"
        isCreatingScenario={false}
        items={layoutItems("Campaign", {
          mode: "bulk_campaign",
        })}
        onCreateScenario={jest.fn()}
        onSelectScenario={jest.fn()}
        onScenarioNameCommit={jest.fn()}
        onScenarioRoutingSettingsChange={jest.fn()}
        onReorder={jest.fn()}
      />
    );

    expect(
      screen.queryByRole("button", {
        name: "scenarioSettingsFor:Campaign",
      })
    ).not.toBeInTheDocument();
  });

  it("identifies the scenario for each settings action", () => {
    const alpha = scenario("Alpha", {
      _id: "scenario-alpha",
    });
    const beta = scenario("Beta", {
      _id: "scenario-beta",
    });

    render(
      <ScenariosSidebar
        newButtonLabel="New"
        scenariosCount={2}
        activeScenarioId="scenario-alpha"
        activeLabel="Active"
        draftLabel="Draft"
        isCreatingScenario={false}
        items={buildScenarioListLayout(buildScenarioHierarchy([alpha, beta]))}
        onCreateScenario={jest.fn()}
        onSelectScenario={jest.fn()}
        onScenarioNameCommit={jest.fn()}
        onScenarioRoutingSettingsChange={jest.fn()}
        onReorder={jest.fn()}
      />
    );

    expect(
      screen.getByRole("button", {
        name: "scenarioSettingsFor:Alpha",
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "scenarioSettingsFor:Beta",
      })
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "scenarioSettingsFor:Beta",
      })
    );
    expect(
      screen.getByRole("dialog", {
        name: "scenarioSettingsFor:Beta",
      })
    ).toBeInTheDocument();
  });

  it.each(["comfortable", "rail"] as const)(
    "reads a scenario ahead when the pointer or focus reaches it, and cancels when they leave (%s)",
    layoutMode => {
      const onPrefetchScenario = jest.fn();
      const onCancelScenarioPrefetch = jest.fn();
      const onSelectScenario = jest.fn();
      render(
        <ScenariosSidebar
          newButtonLabel="New"
          scenariosCount={1}
          activeScenarioId={null}
          activeLabel="Active"
          draftLabel="Draft"
          isCreatingScenario={false}
          layoutMode={layoutMode}
          items={layoutItems("Alpha")}
          onCreateScenario={jest.fn()}
          onSelectScenario={onSelectScenario}
          onPrefetchScenario={onPrefetchScenario}
          onCancelScenarioPrefetch={onCancelScenarioPrefetch}
          onScenarioNameCommit={jest.fn()}
          onReorder={jest.fn()}
        />
      );
      const entry =
        layoutMode === "rail"
          ? screen.getByRole("button", { name: "Alpha" })
          : screen.getByDisplayValue("Alpha").closest('[role="button"]');
      if (!entry) throw new Error("Scenario entry must render");

      fireEvent.pointerEnter(entry);
      fireEvent.focus(entry);

      expect(onPrefetchScenario).toHaveBeenCalledTimes(2);
      expect(onPrefetchScenario).toHaveBeenCalledWith("scenario-1");
      expect(onCancelScenarioPrefetch).not.toHaveBeenCalled();

      fireEvent.pointerLeave(entry);
      fireEvent.blur(entry);

      expect(onCancelScenarioPrefetch).toHaveBeenCalledTimes(2);
      expect(onCancelScenarioPrefetch).toHaveBeenCalledWith("scenario-1");
      expect(onSelectScenario).not.toHaveBeenCalled();
    }
  );
});
