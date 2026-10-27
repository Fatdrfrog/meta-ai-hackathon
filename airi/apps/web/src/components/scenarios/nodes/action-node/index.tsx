"use client";

import { memo } from "react";
import type { ScenarioActionEditorNodeProps } from "../../view/node-enrichment/types";
import { areNodePropsEqual } from "../node-memo-utils";
import { ExpandedActionNode } from "./action-node-expanded";
import { COMPACT_ACTION_NODE_MIN_ACTIONS } from "./action-node-utils";
import { ScenarioSourceHandlePresentationProvider } from "../../source-handle-presentation-context";
import { useTranslations } from "next-intl";
import { EndScenarioActionNode } from "./action-node-end-scenario";
import { ActionNodeCard } from "./action-node-card";

function ActionNodeBody(props: ScenarioActionEditorNodeProps) {
  const nodeData = props.data;
  // Node settings edit every action; its card stays read-only at any size.
  if (nodeData.uiUsesSettingsPanel) {
    return <ActionNodeCard {...props} />;
  }
  const compact =
    !nodeData.uiIsEditorExpanded &&
    nodeData.uiActionNodeCount >= COMPACT_ACTION_NODE_MIN_ACTIONS;
  if (nodeData.actionType === "end_scenario") {
    return <EndScenarioActionNode {...props} compact={compact} />;
  }
  // Large graphs show unselected actions as the same read-only card.
  if (compact) {
    return <ActionNodeCard {...props} compact />;
  }

  return <ExpandedActionNode {...props} nodeData={nodeData} />;
}

export const ActionNode = memo(function ActionNode(
  props: ScenarioActionEditorNodeProps
) {
  const t = useTranslations("Scenarios");
  return (
    <ScenarioSourceHandlePresentationProvider
      value={{
        chooseLabel: t("routeChooseNextStep"),
        unlinkedStatus: t("sourceHandleStatusUnlinked"),
        linkedPrefix: t("sourceHandleStatusLinked"),
        connectedStatus: t("sourceHandleStatusConnected"),
        requiredStatus: t("sourceHandleStatusRequired"),
        destinationsBySourceHandle:
          props.data.uiConnections.destinationsBySourceHandle,
      }}
    >
      <ActionNodeBody {...props} />
    </ScenarioSourceHandlePresentationProvider>
  );
}, areNodePropsEqual);
