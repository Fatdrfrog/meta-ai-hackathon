"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useUpdateNodeInternals } from "@xyflow/react";
import { ListFilter, UsersRound } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  useCallback,
  useId,
  useMemo,
  useState,
  type SyntheticEvent,
} from "react";
import { ScenarioHiddenSourceHandles } from "../../scenario-hidden-source-handles";
import { stopScenarioKeyboardPropagationFromEditableTarget } from "../../scenario-keyboard-events";
import { resolveActionPreview } from "../../scenario-node-labels";
import {
  ScenarioRouteRow,
  SCENARIO_ROUTE_ROW_CLASS,
  bindSourceHandleCreate,
} from "../../scenario-route";
import type { TranslateFn } from "../../types";
import type {
  ScenarioActionEditorNodeData,
  ScenarioActionEditorNodeProps,
} from "../../view/node-enrichment/types";
import { ScenarioNodeCard } from "../node-card";
import { NodeHandles } from "../node-handlers";
import { ScenarioNodeSettingsButton } from "../node-settings-button";
import { EndScenarioActionNode } from "./action-node-end-scenario";
import {
  ACTION_NODE_CARD_CONTROL_CLASS,
  ActionNodeAttachmentChip,
  ActionNodeBranchContext,
  ActionNodeHeaderChrome,
  ActionNodeHeaderTitle,
  ActionNodeLongWaitNotice,
  ActionNodePreview,
  ActionNodeUnreachableRouteNotice,
  INSTAGRAM_REPLY_DISABLED_CARD_CLASS,
} from "./action-node-expanded-ui";
import { ActionNodeKindIcon } from "./action-node-kind-icon";
import { useNodeInternalsRefreshOnChange } from "./use-node-internals-refresh";
import { resolveActionNodePortIcon } from "./action-node-port-icons";
import {
  actionNodePortNeedsNextStep,
  resolveActionNodePorts,
  splitActionNodeCardRows,
  type ActionNodePort,
  type ActionNodePorts,
} from "./action-node-ports";
import {
  isTerminalActionNode,
  resolveActionNodeAttachmentCount,
  resolveActionNodeCardTitle,
  resolveActionNodeModeState,
  resolveActionNodeRoutingState,
  showsActionNodeLongWaitNotice,
} from "./action-node-state";

type ActionNodeCardProps = ScenarioActionEditorNodeProps & {
  /**
   * A large graph's unselected card: it lists only linked routes and keeps
   * the rest behind "+N more", close to the old compact card's height.
   */
  compact?: boolean;
};

/**
 * Read-only canvas card of an action: the node settings panel edits it, or
 * the inline editor once it is selected. It keeps a row and a port for every
 * route, linked or not, so routes can be drag-connected from the card. End
 * scenario stays a terminal card.
 */
export function ActionNodeCard(props: ActionNodeCardProps) {
  if (isTerminalActionNode(props.data)) {
    // Selection no longer resizes it: settings live in the panel.
    return <EndScenarioActionNode {...props} compact />;
  }
  return <ActionNodeRoutesCard {...props} />;
}

function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

type ActionNodeCardRouteState = {
  ports: ActionNodePorts;
  rows: ActionNodePort[];
  overflow: ActionNodePort[];
  overflowShown: boolean;
  rowHandleIds: string[];
  refreshNodeInternals: () => void;
  toggleOverflow: () => void;
};

/** The card's route rows and the "+N more" state. */
function useActionNodeCardRoutes({
  id,
  nodeData,
  compact,
  t,
}: {
  id: string;
  nodeData: ScenarioActionEditorNodeData;
  compact: boolean;
  t: TranslateFn;
}): ActionNodeCardRouteState {
  const updateNodeInternals = useUpdateNodeInternals();
  const [showAllRoutes, setShowAllRoutes] = useState(false);
  const ports = useMemo(
    () => resolveActionNodePorts({ id, nodeData, t }),
    [id, nodeData, t]
  );
  const { rows, overflow } = useMemo(
    () => splitActionNodeCardRows(ports.ports, compact),
    [compact, ports]
  );
  const overflowShown = showAllRoutes && overflow.length > 0;
  const rowHandleIds = useMemo(
    () => [...rows, ...overflow].map(port => port.handleId),
    [overflow, rows]
  );
  // Rows or anchors that move change where edges leave the card.
  const layoutSignature = [
    ports.signature,
    rows.map(port => port.handleId).join(","),
    overflowShown ? "open" : "closed",
  ].join("|");
  const refreshNodeInternals = useCallback(
    () => updateNodeInternals(id),
    [id, updateNodeInternals]
  );
  useNodeInternalsRefreshOnChange(layoutSignature, refreshNodeInternals);
  const toggleOverflow = useCallback(
    () => setShowAllRoutes(shown => !shown),
    []
  );

  return {
    ports,
    rows,
    overflow,
    overflowShown,
    rowHandleIds,
    refreshNodeInternals,
    toggleOverflow,
  };
}

function ActionNodeRoutesCard({
  id,
  data: nodeData,
  selected,
  compact = false,
}: ActionNodeCardProps) {
  const t = useTranslations("Scenarios");
  const overflowId = useId();
  const mode = useMemo(() => resolveActionNodeModeState(nodeData), [nodeData]);
  const routes = useActionNodeCardRoutes({ id, nodeData, compact, t });
  const title = resolveActionNodeCardTitle(nodeData, t);
  const preview = resolveActionPreview({ nodeData, t });
  const openSettings = nodeData.uiUsesSettingsPanel
    ? nodeData.uiOnOpenSettings
    : undefined;

  return (
    <div
      className="relative w-max min-w-0"
      data-testid="scenario-action-node-card"
      data-compact={compact ? "true" : undefined}
      onKeyDown={stopScenarioKeyboardPropagationFromEditableTarget}
    >
      <ScenarioNodeCard
        selected={selected}
        interactive
        className={cn(
          "w-[300px] max-w-[300px] gap-0 overflow-visible border-emerald-300/70 py-0 hover:ring-emerald-200/70",
          mode.isInstagramReplyDisabled && INSTAGRAM_REPLY_DISABLED_CARD_CLASS
        )}
      >
        <NodeHandles
          kind="action"
          compact
          suppressDefaultOutputHandle
          hiddenSourceHandles={routes.ports.hiddenAnchorIds}
          cornerSourceHandles={routes.ports.cornerAnchorIds}
          ownedSourceHandleIds={routes.rowHandleIds}
        />
        <CardHeader className="gap-1.5 px-3 pb-2 pt-2">
          <ActionNodeHeaderChrome
            leading={
              <ActionNodeHeaderTitle
                icon={<ActionNodeKindIcon nodeData={nodeData} />}
                title={title}
              />
            }
            actions={
              openSettings ? (
                <ScenarioNodeSettingsButton
                  nodeId={id}
                  label={t("settings")}
                  accessibleLabel={t("nodeSettingsOpenFor", { label: title })}
                  expanded={nodeData.uiIsEditorExpanded}
                  onOpen={openSettings}
                  iconOnly
                  testId="scenario-action-node-settings"
                />
              ) : null
            }
            instagramReplyDisabledReason={mode.instagramReplyDisabledReason}
            onRemove={nodeData.uiOnRemove}
            t={t}
          />
          <ActionNodeBranchContext
            incomingRouteCount={nodeData.uiIncomingRouteCount}
            flowBranchOptionLabel={nodeData.flowBranchOptionLabel}
            instagramBranchLabel={nodeData.instagramBranchLabel}
            t={t}
            telegramBranchLabel={nodeData.telegramBranchLabel}
            whatsAppSessionChoiceLabel={nodeData.whatsAppSessionChoiceLabel}
          />
          <ActionNodePreview
            preview={preview}
            validationMode={nodeData.uiValidationMode}
            testId="action-node-card-preview"
          />
          <ActionNodeCardChips nodeData={nodeData} t={t} />
          {showsActionNodeLongWaitNotice(nodeData) ? (
            <ActionNodeLongWaitNotice t={t} />
          ) : null}
          <ActionNodeUnreachableRouteNotice
            ports={routes.ports}
            nodeData={nodeData}
            t={t}
          />
        </CardHeader>
        {routes.ports.ports.length > 0 ? (
          <ActionNodeCardRouteList
            routes={routes}
            overflowId={overflowId}
            onCreateNodeFromSourceHandle={
              nodeData.uiOnCreateNodeFromSourceHandle
            }
            t={t}
          />
        ) : null}
      </ScenarioNodeCard>
    </div>
  );
}

/** Run-if, attachment and recipient counts under the preview. */
function ActionNodeCardChips({
  nodeData,
  t,
}: {
  nodeData: ScenarioActionEditorNodeData;
  t: TranslateFn;
}) {
  const runConditionCount = resolveActionNodeRoutingState(
    nodeData,
    t
  ).runConditionCount;
  const attachmentCount = resolveActionNodeAttachmentCount(nodeData);
  const recipientCount = nodeData.bulkRecipientCount ?? 0;
  const hasChips =
    runConditionCount > 0 || attachmentCount > 0 || recipientCount > 0;
  if (!hasChips) return null;

  return (
    <div className="flex min-w-0 flex-wrap gap-1.5">
      {runConditionCount > 0 ? (
        <Badge
          variant="secondary"
          className="h-5 max-w-full px-1.5 text-[10px]"
        >
          <ListFilter aria-hidden />
          <span className="truncate">
            {t("actionCardRunIfCount", { count: runConditionCount })}
          </span>
        </Badge>
      ) : null}
      {attachmentCount > 0 ? (
        <ActionNodeAttachmentChip count={attachmentCount} t={t} />
      ) : null}
      {recipientCount > 0 ? (
        <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
          <UsersRound aria-hidden />
          {t("columnSplitPathRecipientCount", {
            count: recipientCount,
          })}
        </Badge>
      ) : null}
    </div>
  );
}

function ActionNodeCardRouteList({
  routes,
  overflowId,
  onCreateNodeFromSourceHandle,
  t,
}: {
  routes: ActionNodeCardRouteState;
  overflowId: string;
  onCreateNodeFromSourceHandle: ScenarioActionEditorNodeData["uiOnCreateNodeFromSourceHandle"];
  t: TranslateFn;
}) {
  const { rows, overflow, overflowShown } = routes;
  const renderRouteRow = (port: ActionNodePort) => (
    <ScenarioRouteRow
      key={port.handleId}
      handleId={port.handleId}
      sourceLabel={port.label}
      icon={resolveActionNodePortIcon(port)}
      detail={port.detail}
      accessibleLabel={port.accessibleLabel}
      connected={port.connected}
      connectable={port.connectable}
      required={port.required}
      destinationLabel={port.destinationLabel}
      onInteractionStart={routes.refreshNodeInternals}
      onCreateNode={bindSourceHandleCreate(
        onCreateNodeFromSourceHandle,
        port.handleId
      )}
      data-testid="action-node-port"
    />
  );

  return (
    <div
      className="overflow-visible border-t border-border/60 pb-1"
      data-testid="action-node-ports"
    >
      {rows.map(renderRouteRow)}
      <div id={overflowId} data-testid="action-node-ports-overflow">
        {overflowShown ? overflow.map(renderRouteRow) : null}
      </div>
      {overflow.length > 0 ? (
        <ActionNodeCardMoreRoutes
          overflow={overflow}
          overflowShown={overflowShown}
          overflowId={overflowId}
          onToggle={routes.toggleOverflow}
          t={t}
        />
      ) : null}
    </div>
  );
}

/**
 * The "+N more" toggle. While it is closed, the hidden routes keep their
 * handles on this row so their edges stay attached.
 */
function ActionNodeCardMoreRoutes({
  overflow,
  overflowShown,
  overflowId,
  onToggle,
  t,
}: {
  overflow: ActionNodePort[];
  overflowShown: boolean;
  overflowId: string;
  onToggle: () => void;
  t: TranslateFn;
}) {
  const hiddenRequiredCount = overflow.filter(
    actionNodePortNeedsNextStep
  ).length;

  return (
    <div
      className={SCENARIO_ROUTE_ROW_CLASS}
      data-testid="action-node-ports-more"
    >
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className={cn(
          ACTION_NODE_CARD_CONTROL_CLASS,
          "-ml-2 h-6 min-w-6 px-2 text-[11px] font-normal text-muted-foreground hover:text-foreground"
        )}
        aria-expanded={overflowShown}
        aria-controls={overflowId}
        aria-label={
          overflowShown
            ? undefined
            : t("actionPortsMoreLabel", { count: overflow.length })
        }
        onPointerDown={stopPropagation}
        onClick={event => {
          event.stopPropagation();
          onToggle();
        }}
      >
        {overflowShown
          ? t("actionPortsLess")
          : t("actionPortsMore", { count: overflow.length })}
      </Button>
      {!overflowShown && hiddenRequiredCount > 0 ? (
        <Badge
          variant="destructive"
          className="h-5 min-w-0 px-1.5 text-[10px] font-normal"
          data-testid="action-node-ports-hidden-required"
        >
          <span className="truncate">
            {t("actionPortsHiddenRequired", {
              count: hiddenRequiredCount,
            })}
          </span>
        </Badge>
      ) : null}
      {/* Edges of hidden routes leave from this row. */}
      {overflowShown ? null : (
        <ScenarioHiddenSourceHandles
          handleIds={overflow.map(port => port.handleId)}
        />
      )}
    </div>
  );
}
