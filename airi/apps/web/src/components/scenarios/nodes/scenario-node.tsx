"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getPostActionConditionHandleId,
  getScenarioLogicType,
  getVisiblePostActionConditionTypes,
  isInteractiveNoReplyConditionNodeData,
  isPostActionConditionNodeData,
} from "@icecore/scenario-contracts";
import { isRecipientColumnSplitNodeData } from "@/lib/scenarios/recipient-column-split";
import { cn } from "@/lib/utils";
import { AlertTriangle, BrainCircuit, GitBranch, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { memo } from "react";
import type { ScenarioNodeData, TranslateFn } from "../types";
import type { ScenarioContextOrLogicEditorNodeProps } from "../view/node-enrichment/types";
import { SCENARIO_HANDLE_RULES } from "../graph/config";
import { ScenarioSourceHandlePresentationProvider } from "../source-handle-presentation-context";
import { ScenarioNodeContextSection } from "./context-section";
import { ScenarioNodeLogicSection } from "./logic-section";
import { ScenarioNodeCard } from "./node-card";
import { NodeHandles } from "./node-handlers";
import { areNodePropsEqual } from "./node-memo-utils";
import { getAudienceModeLabel } from "./utils";

const kindConfig: Record<
  "context" | "logic",
  {
    badgeKey: string;
    icon: React.ComponentType<{ className?: string }>;
    borderClassName: string;
    iconClassName: string;
  }
> = {
  context: {
    badgeKey: "badgeContext",
    icon: BrainCircuit,
    borderClassName: "border-blue-300/70",
    iconClassName: "text-blue-500",
  },
  logic: {
    badgeKey: "badgeLogic",
    icon: GitBranch,
    borderClassName: "border-violet-300/70",
    iconClassName: "text-violet-500",
  },
};

function resolveScenarioNodeLabel(
  nodeData: ScenarioContextOrLogicEditorNodeProps["data"],
  t: TranslateFn
) {
  switch (nodeData.kind) {
    case "context": {
      if (nodeData.contextSources && nodeData.contextSources.length > 0) {
        const first = nodeData.contextSources[0];
        const option = (nodeData.uiContextOptions || []).find(
          item => item.id === first.optionId
        );
        return nodeData.contextSources.length === 1
          ? option?.title || t("badgeContext")
          : t("badgeContext");
      }

      const option = (nodeData.uiContextOptions || []).find(
        item => item.id === nodeData.contextOptionId
      );
      return option?.title || t("badgeContext");
    }
    case "logic": {
      if (isPostActionConditionNodeData(nodeData)) {
        return isInteractiveNoReplyConditionNodeData(nodeData)
          ? t("interactiveNoReplyLabel")
          : t("postActionConditionLabel");
      }
      if (isRecipientColumnSplitNodeData(nodeData)) {
        return t("recipientColumnSplitLabel");
      }
      return getAudienceModeLabel(nodeData.audienceMode || "all", t);
    }
    default: {
      const _exhaustive: never = nodeData;
      return _exhaustive;
    }
  }
}

export const ScenarioNode = memo(function ScenarioNode({
  data,
  selected,
}: ScenarioContextOrLogicEditorNodeProps) {
  const t = useTranslations("Scenarios");
  const nodeData = data;
  const config = kindConfig[nodeData.kind];
  const Icon = config.icon;
  const logicType = getScenarioLogicType(nodeData);
  const nodeLabel = resolveScenarioNodeLabel(nodeData, t);

  const patchNode = (patch: Partial<ScenarioNodeData>) => {
    nodeData.uiOnPatch?.(patch);
  };

  const knowledgeDisabled = Boolean(
    nodeData.kind === "context" ? nodeData.uiKnowledgeDisabledReason : false
  );

  const isLogicNode = nodeData.kind === "logic";
  const defaultOutputHandleId = SCENARIO_HANDLE_RULES.logic.outputHandleId;
  const postActionHandleIds =
    isLogicNode && logicType === "post_action_condition"
      ? getVisiblePostActionConditionTypes(nodeData).map(branchType =>
          getPostActionConditionHandleId(branchType)
        )
      : [];
  const hideDefaultLogicOutput =
    isLogicNode &&
    (logicType === "post_action_condition" || logicType === "audience_filter");
  const hiddenLogicHandleIds = [
    ...postActionHandleIds,
    ...(hideDefaultLogicOutput && defaultOutputHandleId
      ? [defaultOutputHandleId]
      : []),
  ];

  return (
    <ScenarioSourceHandlePresentationProvider
      value={{
        chooseLabel: t("routeChooseNextStep"),
        unlinkedStatus: t("sourceHandleStatusUnlinked"),
        linkedPrefix: t("sourceHandleStatusLinked"),
        connectedStatus: t("sourceHandleStatusConnected"),
        requiredStatus: t("sourceHandleStatusRequired"),
        destinationsBySourceHandle:
          nodeData.kind === "logic"
            ? nodeData.uiDestinationsBySourceHandle
            : undefined,
      }}
    >
      <ScenarioNodeCard
        selected={selected}
        muted={knowledgeDisabled}
        className={cn(
          "min-w-[280px] max-w-[360px]",
          logicType === "recipient_column_split" &&
            "min-w-[340px] max-w-[420px]",
          config.borderClassName
        )}
      >
        <NodeHandles
          kind={nodeData.kind}
          onCreateNodeFromSourceHandle={(sourceHandleId, point) =>
            nodeData.uiOnCreateNodeFromSourceHandle?.(
              sourceHandleId,
              point.clientX,
              point.clientY
            )
          }
          hiddenSourceHandles={
            hiddenLogicHandleIds.length > 0 ? hiddenLogicHandleIds : undefined
          }
          suppressDefaultOutputHandle={
            logicType === "recipient_column_split" || hideDefaultLogicOutput
          }
        />
        <CardHeader className="space-y-1.5 px-3 pb-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <Badge
                variant="secondary"
                className="h-5 px-1.5 text-[11px] uppercase"
              >
                {t(config.badgeKey)}
              </Badge>
              <Icon className={cn("h-4 w-4 shrink-0", config.iconClassName)} />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              onClick={nodeData.uiOnRemove}
              aria-label={t("removeBlock")}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
          <CardTitle className="line-clamp-2 text-sm leading-tight">
            {nodeLabel}
          </CardTitle>
          {nodeData.flowBranchOptionLabel ? (
            <div className="flex items-center gap-1 text-[10px] text-violet-600 dark:text-violet-400">
              <GitBranch className="h-3 w-3" />
              <span>{nodeData.flowBranchOptionLabel}</span>
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-1.5 p-3 pt-0 text-xs">
          {knowledgeDisabled && nodeData.kind === "context" ? (
            <div className="flex items-center gap-2 rounded-md border border-dashed border-muted-foreground/40 bg-muted/30 p-2.5 text-[11px] text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span>{nodeData.uiKnowledgeDisabledReason}</span>
            </div>
          ) : null}

          {!knowledgeDisabled && nodeData.kind === "context" ? (
            <ScenarioNodeContextSection nodeData={nodeData} t={t} />
          ) : null}

          {nodeData.kind === "logic" ? (
            <ScenarioNodeLogicSection
              nodeData={nodeData}
              patchNode={patchNode}
              t={t}
              reuseCanvasSourceHandles
            />
          ) : null}
        </CardContent>
      </ScenarioNodeCard>
    </ScenarioSourceHandlePresentationProvider>
  );
}, areNodePropsEqual);
