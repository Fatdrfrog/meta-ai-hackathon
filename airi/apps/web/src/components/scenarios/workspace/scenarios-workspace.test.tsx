/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { loadRegisteredBusinessPhonesAudienceAction } from "@/features/panel/scenarios/actions";
import { ScenariosWorkspace } from "./scenarios-workspace";
import type { ScenarioAutomationHeaderActions } from "./use-scenario-view-signals";

const mockScenariosView = jest.fn();

jest.mock("@/features/panel/scenarios/actions", () => ({
  loadRegisteredBusinessPhonesAudienceAction: jest.fn(async () => null),
}));

const mockLoadAudience = jest.mocked(
  loadRegisteredBusinessPhonesAudienceAction
);

jest.mock("./scenarios-view", () => ({
  ScenariosView: (props: Record<string, unknown>) => {
    mockScenariosView(props);
    return <div data-testid="scenarios-view" />;
  },
}));

function createHeaderActions(): ScenarioAutomationHeaderActions {
  return {
    hasScenario: true,
    canCreate: true,
    isCreatingScenario: false,
    canDelete: true,
    saveStatus: "saved",
    canvasInteractionMode: "select",
    isTriggerLogVisible: false,
    onCreateScenario: jest.fn(),
    onOpenNodePalette: jest.fn(),
    onCanvasInteractionModeChange: jest.fn(),
    onToggleTriggerLog: jest.fn(),
    onDeleteScenario: jest.fn(),
  };
}

function publishHeaderActions(actions: ScenarioAutomationHeaderActions) {
  const latestProps = mockScenariosView.mock.calls.at(-1)?.[0] as {
    onAutomationActionsChange: (
      actions: ScenarioAutomationHeaderActions
    ) => void;
  };
  act(() => latestProps.onAutomationActionsChange(actions));
}

describe("ScenariosWorkspace", () => {
  beforeEach(() => {
    mockScenariosView.mockClear();
    mockLoadAudience.mockClear();
    window.localStorage.clear();
  });

  it.each([
    ["the server found it disabled", false, 0],
    ["the server enabled it", true, 1],
  ])(
    "loads the registered-phones audience only when %s",
    async (_label, registeredAudienceEnabled, expectedLoads) => {
      mockLoadAudience.mockResolvedValue(null);
      render(
        <ScenariosWorkspace
          workspaceId="workspace-1"
          hasWhatsApp
          hasConnectedSources
          registeredAudienceEnabled={registeredAudienceEnabled}
        />
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockLoadAudience).toHaveBeenCalledTimes(expectedLoads);
    }
  );

  it("hands the page's scenario read to the editor, and only the editor's own props", () => {
    const initialScenarioDetail = Promise.resolve(null);
    render(
      <ScenariosWorkspace
        workspaceId="workspace-1"
        hasWhatsApp={false}
        hasConnectedSources
        registeredAudienceEnabled
        initialScenarioDetail={initialScenarioDetail}
      />
    );
    const props = mockScenariosView.mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    expect(props.initialScenarioDetail).toBe(initialScenarioDetail);
    expect(props).not.toHaveProperty("registeredAudienceEnabled");
    expect(props).not.toHaveProperty("onLoadingChange");
  });

  it("passes an Airi chat scenario draft into Airi Create from handoff storage", async () => {
    window.localStorage.setItem(
      "airi:scenario-generator-draft:v1:workspace-1",
      JSON.stringify({
        id: "airi-campaign:pricing-leads",
        workspaceId: "workspace-1",
        title: "Pricing lead win-back",
        summary: "Recover pricing leads.",
        prompt: "@WhatsApp Build a follow-up workflow for pricing leads.",
        workflowKind: "follow_up_workflow",
        sendMode: "trigger",
        channels: ["whatsapp"],
        triggerStrategy: "customer_intent_or_classification",
        sourceIds: ["wa-1"],
      })
    );

    render(
      <ScenariosWorkspace
        workspaceId="workspace-1"
        hasWhatsApp
        hasConnectedSources
        registeredAudienceEnabled={false}
        openAiriCreateOnMount
      />
    );

    await waitFor(() => {
      expect(mockScenariosView).toHaveBeenLastCalledWith(
        expect.objectContaining({
          openAiriCreateOnMount: true,
          initialAiriCreateDraft: expect.objectContaining({
            title: "Pricing lead win-back",
            prompt: expect.stringContaining("@WhatsApp"),
          }),
        })
      );
    });
  });

  it("passes the node settings flag to the scenario editor", () => {
    render(
      <ScenariosWorkspace
        workspaceId="workspace-1"
        hasWhatsApp={false}
        hasConnectedSources
        registeredAudienceEnabled={false}
        nodeSettingsPanelEnabled
      />
    );
    expect(mockScenariosView).toHaveBeenLastCalledWith(
      expect.objectContaining({ nodeSettingsPanelEnabled: true })
    );
  });

  it("uses the top plus button for new nodes when a scenario canvas is open", async () => {
    const onCreateScenario = jest.fn();
    const onOpenNodePalette = jest.fn();

    render(
      <ScenariosWorkspace
        workspaceId="workspace-1"
        hasWhatsApp
        hasConnectedSources
        registeredAudienceEnabled={false}
      />
    );

    await waitFor(() => {
      expect(mockScenariosView).toHaveBeenCalled();
    });

    publishHeaderActions({
      ...createHeaderActions(),
      onCreateScenario,
      onOpenNodePalette,
    });

    fireEvent.click(screen.getByRole("button", { name: "newNode" }));

    expect(onOpenNodePalette).toHaveBeenCalledTimes(1);
    expect(onCreateScenario).not.toHaveBeenCalled();
  });

  it("preserves save feedback, canvas controls and deletion availability", () => {
    render(
      <ScenariosWorkspace
        workspaceId="workspace-1"
        hasWhatsApp={false}
        hasConnectedSources
        registeredAudienceEnabled={false}
      />
    );
    const actions = createHeaderActions();
    publishHeaderActions({
      ...actions,
      canDelete: false,
      saveStatus: "saving",
    });

    expect(screen.getByRole("status")).toHaveTextContent("saving");
    expect(screen.getByRole("button", { name: "delete" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "canvasModePan" }));
    expect(actions.onCanvasInteractionModeChange).toHaveBeenCalledWith("pan");
    fireEvent.click(screen.getByRole("button", { name: "showTriggerLog" }));
    expect(actions.onToggleTriggerLog).toHaveBeenCalledTimes(1);

    publishHeaderActions({ ...actions, saveStatus: "unsaved" });
    expect(screen.getByRole("status")).toHaveTextContent("unsavedChanges");
    fireEvent.click(screen.getByRole("button", { name: "delete" }));
    expect(actions.onDeleteScenario).toHaveBeenCalledTimes(1);
  });

  it("clears the previous workspace toolbar while the next editor loads", () => {
    const { rerender } = render(
      <ScenariosWorkspace
        workspaceId="workspace-1"
        hasWhatsApp={false}
        hasConnectedSources
        registeredAudienceEnabled={false}
      />
    );
    publishHeaderActions(createHeaderActions());
    expect(screen.getByRole("button", { name: "newNode" })).toBeInTheDocument();

    rerender(
      <ScenariosWorkspace
        workspaceId="workspace-2"
        hasWhatsApp={false}
        hasConnectedSources
        registeredAudienceEnabled={false}
      />
    );

    expect(
      screen.queryByRole("button", { name: "newNode" })
    ).not.toBeInTheDocument();
    expect(mockScenariosView).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceId: "workspace-2" })
    );
  });
});
