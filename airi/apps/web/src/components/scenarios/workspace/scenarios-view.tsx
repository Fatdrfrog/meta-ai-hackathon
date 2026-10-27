"use client";
import { ScenarioGraphUndoContext } from "../view/graph/undo-context";

import { FreePlanUpsell } from "@/components/limits/free-plan-upsell";
import { memo, useMemo } from "react";
import {
  ResizableHandle,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScenariosGraphPane } from "../view/scenarios-graph-pane";
import { ScenarioPlaybookResults } from "../view/scenario-playbook-results";
import { isRevenuePlaybookPresetId } from "../view/scenario-revenue-playbooks";
import { ScenariosSidebarPanel } from "../view/scenarios-sidebar-panel";
import { ScenariosViewDialogs } from "../view/scenarios-view-dialogs";
import {
  ScenariosViewEmptyState,
  ScenariosViewLoadingState,
} from "../view/scenarios-view-shell";
import { useScenarioChunkWarmup } from "./use-scenario-chunk-warmup";
import {
  useScenariosWorkspaceController,
  type UseScenariosWorkspaceControllerParams,
} from "./use-scenarios-workspace-controller";

type ScenariosViewProps = UseScenariosWorkspaceControllerParams;

function emptyStateCopyKeys(
  hasConnectedSources: boolean,
  demoCreateFailed: boolean,
  scenarioCreateLocked: boolean
) {
  // A locked workspace never auto-creates the demo, so it gets the regular
  // empty state with its limit notice instead of "setting up a demo".
  if (hasConnectedSources || scenarioCreateLocked) {
    return {
      title: "scenarioEmptyTitle",
      description: "scenarioEmptyDescription",
    };
  }
  return demoCreateFailed
    ? {
        title: "scenarioOnboardingFailedTitle",
        description: "scenarioOnboardingFailedDescription",
      }
    : {
        title: "scenarioOnboardingCreatingTitle",
        description: "scenarioOnboardingCreatingDescription",
      };
}

// Its props are page data, state setters and memoized values, so the
// workspace frame's own updates (toolbar actions) do not re-render it.
export const ScenariosView = memo(function ScenariosView(
  props: ScenariosViewProps
) {
  const {
    t,
    workspaceId,
    hasConnectedSources,
    isFreePlan,
    scenarioCreateLocked,
    loadingScenarios,
    scenarios,
    activeScenarioId,
    activeScenarioPresetId,
    isCreatingScenario,
    scenarioListLayoutItems,
    subscenarioIndicatorByScenarioId,
    activeScenarioGraphSettings,
    demoCreateFailed,
    isAutoCreatingDemo,
    graph,
    dialogs,
    sidebar,
    emptyState,
  } = useScenariosWorkspaceController(props);
  useScenarioChunkWarmup({
    scenarios,
    activeScenarioId,
    loadingScenarios,
    loadingFlow: graph.canvas.loadingFlow,
    nodeSettingsPanelEnabled: graph.resources.nodeSettingsPanelEnabled,
  });
  // One element across renders, so the memoized sidebar keeps its props.
  const createLimitNotice = useMemo(
    () => (isFreePlan ? <FreePlanUpsell workspaceId={workspaceId} /> : null),
    [isFreePlan, workspaceId]
  );

  if (loadingScenarios) {
    return <ScenariosViewLoadingState label={t("loading")} />;
  }

  if (scenarios.length === 0) {
    const emptyCopy = emptyStateCopyKeys(
      hasConnectedSources,
      demoCreateFailed,
      scenarioCreateLocked
    );
    return (
      <>
        <ScenariosViewEmptyState
          title={t(emptyCopy.title)}
          description={t(emptyCopy.description)}
          createLabel={t("new")}
          demoCreateLabel={t("scenarioOnboardingCreateDemo")}
          connectSourceLabel={t("scenarioOnboardingConnectSource")}
          connectSourceHref={`/panel/w/${workspaceId}/settings/integrations`}
          isCreating={isCreatingScenario}
          isAutoCreatingDemo={isAutoCreatingDemo}
          showDemoRetry={
            !hasConnectedSources && demoCreateFailed && !scenarioCreateLocked
          }
          showConnectSource={!hasConnectedSources}
          createDisabled={scenarioCreateLocked}
          limitNotice={createLimitNotice}
          onCreateScenario={emptyState.onCreateScenario}
          onCreateDemoScenario={emptyState.onCreateDemoScenario}
        />
        <ScenariosViewDialogs {...dialogs} />
      </>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {activeScenarioId && isRevenuePlaybookPresetId(activeScenarioPresetId) ? (
        <ScenarioPlaybookResults
          key={`${workspaceId}:${activeScenarioId}`}
          workspaceId={workspaceId}
          scenarioId={activeScenarioId}
        />
      ) : null}
      <div className="flex min-h-0 flex-1">
        <ResizablePanelGroup direction="horizontal" className="h-full">
          <ScenariosSidebarPanel
            newButtonLabel={t("new")}
            searchPlaceholder={t("sidebarSearchPlaceholder")}
            searchEmptyLabel={t("sidebarSearchEmpty")}
            searchClearLabel={t("clear")}
            journeysLabel={t("sidebarViewJourneys")}
            flatLabel={t("sidebarViewFlat")}
            scenariosCount={scenarios.length}
            activeScenarioId={activeScenarioId}
            pendingScenarioId={sidebar.pendingScenarioId}
            activeLabel={t("active")}
            draftLabel={t("draft")}
            isCreatingScenario={isCreatingScenario}
            createDisabled={scenarioCreateLocked}
            createLimitNotice={createLimitNotice}
            items={scenarioListLayoutItems}
            onCreateScenario={sidebar.onCreateScenario}
            onSelectScenario={sidebar.onSelectScenario}
            onPrefetchScenario={sidebar.onPrefetchScenario}
            onCancelScenarioPrefetch={sidebar.onCancelScenarioPrefetch}
            onScenarioNameCommit={sidebar.onScenarioNameCommit}
            onReorder={sidebar.onReorder}
            onScenarioSettingsSave={sidebar.onScenarioSettingsSave}
            onScenarioRoutingSettingsChange={
              sidebar.onScenarioRoutingSettingsChange
            }
            subscenarioIndicatorByScenarioId={subscenarioIndicatorByScenarioId}
            onDeleteScenario={sidebar.onDeleteScenario}
            onNormalizeScenarioLayout={sidebar.onNormalizeScenarioLayout}
            normalizeScenarioLayoutDisabled={
              sidebar.normalizeScenarioLayoutDisabled
            }
            normalizeScenarioLayoutTitle={t("normalizeLayoutTooltip")}
          />

          <ResizableHandle withHandle />

          <ScenarioGraphUndoContext.Provider value={graph.historyControls}>
            <ScenariosGraphPane
              data={graph.data}
              resources={graph.resources}
              scenarioSettings={activeScenarioGraphSettings}
              nodeBridge={graph.nodeBridge}
              canvas={graph.canvas}
              triggerLog={graph.triggerLog}
            />
          </ScenarioGraphUndoContext.Provider>
        </ResizablePanelGroup>
      </div>
      <ScenariosViewDialogs {...dialogs} />
    </div>
  );
});
