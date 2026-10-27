"use client";

import { cn } from "@/lib/utils";
import type {
  ScenarioActionOutcomes,
  ScenarioActionRunCondition,
  ScenarioActionRunConditions,
} from "@icecore/scenario-contracts";
import type { ScenarioNodeData, TranslateFn } from "../../types";
import type { ScenarioActionEditorNodeData } from "../../view/node-enrichment/types";
import { ScenarioCollapsibleSection } from "../../scenario-collapsible-section";
import { ScenarioInlineNotice } from "../../scenario-inline-notice";
import {
  ActionNodeOutcomeRouteRows,
  ActionNodeOutcomesEditor,
} from "./action-node-outcomes-editor";
import { resolveActionNodePortIcon } from "./action-node-port-icons";
import type { ActionNodePort } from "./action-node-ports";
import { countRemovedRunConditionValues } from "./action-node-run-condition-values";
import { ActionNodeRunConditionsEditor } from "./action-node-run-conditions";
import { ScenarioRouteRow, bindSourceHandleCreate } from "../../scenario-route";
import {
  ACTION_NODE_DEFAULT_HANDLE_ID,
  useActionNodeRouting,
  type ActionNodeMessageBranch,
  type ActionNodeRouting,
} from "./use-action-node-routing";

type ActionNodeRoutingSectionProps = {
  nodeId: string;
  nodeData: ScenarioActionEditorNodeData;
  t: TranslateFn;
  onPatch: (patch: Partial<ScenarioNodeData>) => void;
  onHandlesChanged?: () => void;
  showOutcomes?: boolean;
  showMessageBranches?: boolean;
  /** Compact cards only surface routes that already exist on the canvas. */
  messageBranchesMode?: "all" | "connected";
  inset?: boolean;
  /**
   * Render route handles. Node settings pass false: the canvas card owns the
   * ports, and handles cannot render outside React Flow.
   */
  showPorts?: boolean;
};

export function ActionNodeRoutingSection({
  nodeId,
  nodeData,
  t,
  onPatch,
  onHandlesChanged,
  showOutcomes = true,
  showMessageBranches = false,
  messageBranchesMode = "all",
  inset = false,
  showPorts = true,
}: ActionNodeRoutingSectionProps) {
  const routing = useActionNodeRouting({
    nodeId,
    nodeData,
    t,
    messageBranchesMode,
  });
  // Opening or closing a section moves the route handles below it.
  const remeasureHandles = onHandlesChanged
    ? () => onHandlesChanged()
    : undefined;

  return (
    <div
      className={cn(
        "mt-1 overflow-visible border-t border-border/60",
        inset && "-mx-3"
      )}
      data-action-routing-node-id={nodeId}
    >
      {routing.readOnly ? (
        <ScenarioInlineNotice
          tone="info"
          className="mx-3 my-2 w-auto"
          data-testid="action-routing-read-only"
        >
          {t("actionRoutingReadOnly")}
        </ScenarioInlineNotice>
      ) : null}
      {showPorts ? (
        <ActionNodeRoutingTopRoutes
          messageBranches={
            showMessageBranches ? routing.visibleMessageBranches : null
          }
          defaultPort={routing.defaultPort}
          onCreateNodeFromSourceHandle={nodeData.uiOnCreateNodeFromSourceHandle}
          onHandlesChanged={onHandlesChanged}
        />
      ) : null}
      <ActionNodeRoutingRunIfSection
        routing={routing}
        t={t}
        onPatch={onPatch}
        onOpenChange={remeasureHandles}
      />

      {showOutcomes ? (
        <ActionNodeRoutingOutcomesSection
          routing={routing}
          nodeData={nodeData}
          t={t}
          onPatch={onPatch}
          onHandlesChanged={onHandlesChanged}
          onOpenChange={remeasureHandles}
          showPorts={showPorts}
        />
      ) : null}
    </div>
  );
}

/**
 * Route rows above the sections: a service message's choice branches, then
 * its default output while an edge uses it.
 */
function ActionNodeRoutingTopRoutes({
  messageBranches,
  defaultPort,
  onCreateNodeFromSourceHandle,
  onHandlesChanged,
}: {
  messageBranches: ActionNodeMessageBranch[] | null;
  defaultPort: ActionNodePort | undefined;
  onCreateNodeFromSourceHandle: ScenarioActionEditorNodeData["uiOnCreateNodeFromSourceHandle"];
  onHandlesChanged?: () => void;
}) {
  return (
    <>
      {messageBranches
        ? messageBranches.map(branch => (
            <ScenarioRouteRow
              key={branch.handleId}
              handleId={branch.handleId}
              sourceLabel={branch.label}
              externalAnchor={branch.handleId === ACTION_NODE_DEFAULT_HANDLE_ID}
              connected={branch.connected}
              onInteractionStart={onHandlesChanged}
              onCreateNode={bindSourceHandleCreate(
                onCreateNodeFromSourceHandle,
                branch.handleId
              )}
            />
          ))
        : null}
      {defaultPort ? (
        <ScenarioRouteRow
          handleId={defaultPort.handleId}
          sourceLabel={defaultPort.label}
          icon={resolveActionNodePortIcon(defaultPort)}
          accessibleLabel={defaultPort.accessibleLabel}
          externalAnchor
          connected={defaultPort.connected}
          destinationLabel={defaultPort.destinationLabel}
          onInteractionStart={onHandlesChanged}
          onCreateNode={bindSourceHandleCreate(
            onCreateNodeFromSourceHandle,
            defaultPort.handleId
          )}
        />
      ) : null}
    </>
  );
}

function ActionNodeRoutingRunIfSection({
  routing,
  t,
  onPatch,
  onOpenChange,
}: {
  routing: ActionNodeRouting;
  t: TranslateFn;
  onPatch: ActionNodeRoutingSectionProps["onPatch"];
  onOpenChange: (() => void) | undefined;
}) {
  const { audienceOptions, conditions, readOnly } = routing;
  const runIfTitle = t("actionRunIf");
  const removedRunIfValues = countRemovedRunConditionValues(
    conditions,
    audienceOptions
  );

  const patchRunConditions = (
    nextConditions: ScenarioActionRunCondition[]
  ): void => {
    if (readOnly) return;
    const actionRunConditions: ScenarioActionRunConditions = {
      version: 1,
      match: "all",
      conditions: nextConditions,
    };
    onPatch({ actionRunConditions });
  };

  return (
    <ScenarioCollapsibleSection
      title={runIfTitle}
      count={conditions.length}
      countLabel={t("actionCardRunIfCount", { count: conditions.length })}
      errorCount={removedRunIfValues}
      errorCountLabel={t("whatsappServiceValidationIssueCount", {
        count: removedRunIfValues,
      })}
      info={
        conditions.length === 0
          ? {
              label: t("infoHintLabel", { topic: runIfTitle }),
              text: t("actionRunIfInfo"),
            }
          : undefined
      }
      onOpenChange={onOpenChange}
      data-testid="action-routing-run-if"
    >
      <div className="px-3">
        <ActionNodeRunConditionsEditor
          audienceOptions={audienceOptions}
          conditions={conditions}
          readOnly={readOnly}
          t={t}
          onChange={patchRunConditions}
        />
        {conditions.length > 0 ? (
          <p
            className="pb-2 text-[11px] leading-snug text-muted-foreground"
            data-testid="action-routing-run-if-skip-note"
          >
            {t("actionRunIfSkipNote")}
          </p>
        ) : null}
      </div>
    </ScenarioCollapsibleSection>
  );
}

function ActionNodeRoutingOutcomesSection({
  routing,
  nodeData,
  t,
  onPatch,
  onHandlesChanged,
  onOpenChange,
  showPorts,
}: {
  routing: ActionNodeRouting;
  nodeData: ScenarioActionEditorNodeData;
  t: TranslateFn;
  onPatch: ActionNodeRoutingSectionProps["onPatch"];
  onHandlesChanged?: () => void;
  onOpenChange: (() => void) | undefined;
  showPorts: boolean;
}) {
  const { isService, outcomePorts, readOnly } = routing;

  const patchOutcomes = (actionOutcomes: ScenarioActionOutcomes): void => {
    if (readOnly) return;
    onPatch({ actionOutcomes });
  };

  return (
    <ScenarioCollapsibleSection
      title={t("actionOutcomes")}
      count={outcomePorts.length}
      countLabel={t("routeCount", { count: outcomePorts.length })}
      defaultOpen={outcomePorts.length > 0}
      collapsedContent={
        showPorts ? (
          <ActionNodeOutcomeRouteRows
            nodeData={nodeData}
            onHandlesChanged={onHandlesChanged}
            ports={outcomePorts}
          />
        ) : null
      }
      onOpenChange={onOpenChange}
      data-testid="action-routing-outcomes"
    >
      <div className={isService ? undefined : "px-3"}>
        <ActionNodeOutcomesEditor
          serviceMode={isService}
          connectedHandleIds={routing.connectedHandleIds}
          nodeData={nodeData}
          outcomes={routing.outcomes}
          outcomePorts={outcomePorts}
          readOnly={readOnly}
          t={t}
          onChange={patchOutcomes}
          onHandlesChanged={onHandlesChanged}
          showPorts={showPorts}
        />
      </div>
    </ScenarioCollapsibleSection>
  );
}
