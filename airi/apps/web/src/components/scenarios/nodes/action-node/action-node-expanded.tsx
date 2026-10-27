"use client";

import { CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  buildTelegramBranchSourceHandleId,
  buildWhatsAppSessionChoiceSourceHandleId,
} from "@icecore/scenario-contracts";
import { useUpdateNodeInternals } from "@xyflow/react";
import { useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FlowBranchOptionHandleRenderParams } from "../../builders/whatsapp/field-editor";
import { stopScenarioKeyboardPropagationFromEditableTarget } from "../../scenario-keyboard-events";
import type { ScenarioNodeData } from "../../types";
import { useScenarioGraphResources } from "../../view/graph/resources-context";
import type {
  ScenarioActionEditorNodeData,
  ScenarioActionEditorNodeProps,
} from "../../view/node-enrichment/types";
import {
  getBranchOptionSourceHandleCopy,
  getFlowOptionSourceHandleCopy,
  getTelegramButtonSourceHandleCopy,
  resolveBranchOptionKind,
  resolveUntitledBranchOptionLabel,
} from "../../view/scenario-source-handle-copy";
import { buildScenarioPromptInputVariableFields } from "../../view/scenario-variable-groups";
import {
  ScenarioRouteHandle,
  ScenarioRouteRow,
  bindSourceHandleCreate,
} from "../../scenario-route";
import type { ScenarioOptionBranchHandleLayout } from "../../source-handle-types";
import { NodeHandles } from "../node-handlers";
import { ScenarioNodeCard } from "../node-card";
import {
  ActionNodeAdvancedSection,
  ActionNodeBranchSummaries,
  ActionNodeGenerativeAIEditor,
  ActionNodeHandoffEditor,
  ActionNodeInstagramEditor,
  ActionNodeReplyEditor,
  ActionNodeReplyWarnings,
  ActionNodeTelegramEditor,
} from "./action-node-editor-sections";
import {
  showsActionNodeOutcomes,
  useActionNodeReplyDraft,
  useActionNodeSourceControls,
} from "./action-node-editor-state";
import {
  ActionNodeExpandedHeader,
  ActionNodeHeaderTitle,
  ActionNodeSourceControls,
  ActionNodeUnreachableRouteNotice,
  INSTAGRAM_REPLY_DISABLED_CARD_CLASS,
} from "./action-node-expanded-ui";
import { ActionNodeKindIcon } from "./action-node-kind-icon";
import { resolveActionNodePortIcon } from "./action-node-port-icons";
import { resolveActionNodePorts } from "./action-node-ports";
import { ActionNodeRecipientMessages } from "./action-node-recipient-messages";
import { ActionNodeRoutingSection } from "./action-node-routing-section";
import {
  resolveActionNodeAttachmentCount,
  resolveActionNodeBranchState,
  resolveActionNodeCardTitle,
  resolveActionNodeModeState,
  showsActionNodeLongWaitNotice,
} from "./action-node-state";
import {
  LazyActionNodeWhatsAppServiceMessageSection,
  LazyActionNodeWhatsAppTemplateSection,
} from "./lazy-action-node-sections";
import { useLazySectionRouteHandles } from "./lazy-section-route-handles";
import { useNodeInternalsRefreshOnChange } from "./use-node-internals-refresh";

type EnrichedActionNodeProps = ScenarioActionEditorNodeProps & {
  nodeData: ScenarioActionEditorNodeData;
};

function hasTemplateFlowButton(nodeData: ScenarioNodeData): boolean {
  return Boolean(
    nodeData.actionWhatsAppTemplateComponents?.some(
      component =>
        component.type === "BUTTONS" &&
        component.buttons?.some(button => button.type === "FLOW")
    )
  );
}

export function ExpandedActionNode({
  id,
  nodeData,
  selected,
}: EnrichedActionNodeProps) {
  const t = useTranslations("Scenarios");
  const updateNodeInternals = useUpdateNodeInternals();
  const nodeMeasureRef = useRef<HTMLDivElement | null>(null);
  const nodeInternalsUpdateFrameRef = useRef<number | null>(null);
  const setActionNodeRootRef = useCallback((el: HTMLDivElement | null) => {
    nodeMeasureRef.current = el;
  }, []);
  const {
    whatsAppTemplatesLoading,
    whatsAppTemplatesRefreshing,
    whatsAppFlowsLoading,
    whatsAppFlowsRefreshing,
  } = useScenarioGraphResources();
  const mode = useMemo(() => resolveActionNodeModeState(nodeData), [nodeData]);
  const branchState = useMemo(
    () =>
      resolveActionNodeBranchState({
        id,
        mode,
        nodeData,
        renderMode: "expanded",
        t,
      }),
    [id, mode, nodeData, t]
  );
  const ports = useMemo(
    () => resolveActionNodePorts({ id, nodeData, t }),
    [id, nodeData, t]
  );
  // Outputs no editor row owns (AI results, details, a shared choice route)
  // get labelled rows at the bottom; their handle ids stay the same.
  const fixedOutputRows = useMemo(() => {
    const portsByHandleId = new Map(
      ports.ports.map(port => [port.handleId, port] as const)
    );
    return (branchState.actionSourceHandles ?? []).map(handle => ({
      handle,
      port: portsByHandleId.get(handle.id),
    }));
  }, [branchState.actionSourceHandles, ports]);
  const fixedOutputHandleIds = useMemo(
    () => fixedOutputRows.map(({ handle }) => handle.id),
    [fixedOutputRows]
  );
  // Buttons are tapped ("Taps"); list rows are picked ("Picks").
  const serviceOptionKind = useMemo(
    () => resolveBranchOptionKind("whatsapp_service_message", nodeData),
    [nodeData]
  );
  const createNodeFromSourceHandle = nodeData.uiOnCreateNodeFromSourceHandle;
  const [showAdvanced, setShowAdvanced] = useState(false);

  const templateHasFlowButtonForLayout = hasTemplateFlowButton(nodeData);

  const connectedFlowBranchIds = useMemo(
    () => new Set(nodeData.uiConnections.flowBranchIds),
    [nodeData.uiConnections.flowBranchIds]
  );
  const lazySectionRoutes = useLazySectionRouteHandles(nodeData, {
    hiddenHandleIds: branchState.hiddenActionSourceHandles,
    sourceHandles: branchState.actionSourceHandles,
  });

  const refreshNodeInternals = useCallback(() => {
    updateNodeInternals(id);
  }, [id, updateNodeInternals]);

  const scheduleNodeInternalsUpdate = useCallback(() => {
    if (
      typeof window === "undefined" ||
      typeof window.requestAnimationFrame !== "function"
    ) {
      refreshNodeInternals();
      return;
    }

    if (nodeInternalsUpdateFrameRef.current !== null) {
      return;
    }

    nodeInternalsUpdateFrameRef.current = window.requestAnimationFrame(() => {
      nodeInternalsUpdateFrameRef.current = null;
      refreshNodeInternals();
    });
  }, [refreshNodeInternals]);

  useEffect(() => {
    return () => {
      if (
        nodeInternalsUpdateFrameRef.current !== null &&
        typeof window !== "undefined"
      ) {
        window.cancelAnimationFrame(nodeInternalsUpdateFrameRef.current);
      }
      nodeInternalsUpdateFrameRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const el = nodeMeasureRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      return;
    }
    // React Flow measures a new node itself: only later size changes (an
    // editor loading, a section opening) move the handles.
    let initialObservation = true;
    const ro = new ResizeObserver(() => {
      if (initialObservation) {
        initialObservation = false;
        return;
      }
      scheduleNodeInternalsUpdate();
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [scheduleNodeInternalsUpdate]);

  useNodeInternalsRefreshOnChange(
    JSON.stringify([
      branchState.nodeHandleLayoutSignature,
      branchState.flowBranchHandleSignature,
      branchState.hasTemplateFlowBranchControls,
      branchState.actionOutcomeHandleSignature,
      branchState.telegramBranchHandleSignature,
      branchState.whatsAppServiceMessageBranchHandleSignature,
      branchState.whatsAppTemplateButtonBranchHandleSignature,
    ]),
    refreshNodeInternals
  );

  const patchNode = useCallback(
    (patch: Partial<ScenarioNodeData>) => nodeData.uiOnPatch?.(patch),
    [nodeData]
  );
  const replyDraft = useActionNodeReplyDraft({ nodeData, mode, patchNode, t });
  const sourceControls = useActionNodeSourceControls({ nodeData, mode, t });

  const renderRouteHandle = useCallback(
    ({
      id,
      connected,
      title,
      ariaLabel,
      testId,
      local = false,
    }: {
      id: string;
      connected: boolean;
      title: string;
      ariaLabel: string;
      testId: string;
      local?: boolean;
    }) => (
      <ScenarioRouteHandle
        id={id}
        inset={!local}
        local={local}
        connected={connected}
        title={title}
        ariaLabel={ariaLabel}
        testId={testId}
        onInteractionStart={refreshNodeInternals}
        onCreateNode={bindSourceHandleCreate(createNodeFromSourceHandle, id)}
      />
    ),
    [createNodeFromSourceHandle, refreshNodeInternals]
  );

  const renderTelegramButtonBranchHandle = useCallback(
    ({
      button,
    }: {
      button: {
        text: string;
        payload: string;
      };
      rowIndex: number;
      buttonIndex: number;
    }) => {
      const branchHandleId = buildTelegramBranchSourceHandleId(button.payload);
      const label = button.text.trim() || t("untitledButton");
      const copy = getTelegramButtonSourceHandleCopy(t, label);
      return renderRouteHandle({
        id: branchHandleId,
        connected: branchState.connectedTelegramBranchPayloads.has(
          button.payload
        ),
        title: copy.tooltip,
        ariaLabel: copy.label,
        testId: "telegram-branch-handle",
        local: true,
      });
    },
    [branchState.connectedTelegramBranchPayloads, renderRouteHandle, t]
  );

  const renderWhatsAppServiceOptionBranchHandle = useCallback(
    (
      option: { id: string; label: string },
      layout?: ScenarioOptionBranchHandleLayout
    ) => {
      const branchHandleId = buildWhatsAppSessionChoiceSourceHandleId(
        option.id
      );
      const copy = getBranchOptionSourceHandleCopy(
        t,
        "whatsapp_service_message",
        serviceOptionKind,
        option.label || resolveUntitledBranchOptionLabel(serviceOptionKind, t)
      );
      return renderRouteHandle({
        id: branchHandleId,
        connected: branchState.connectedWhatsAppServiceMessagePayloads.has(
          option.id
        ),
        title: copy.tooltip,
        ariaLabel: copy.label,
        testId: "whatsapp-service-message-branch-handle",
        local: layout?.local,
      });
    },
    [
      branchState.connectedWhatsAppServiceMessagePayloads,
      renderRouteHandle,
      serviceOptionKind,
      t,
    ]
  );

  const renderInlineFlowBranchHandle = useCallback(
    (params: FlowBranchOptionHandleRenderParams) => {
      const copy = getFlowOptionSourceHandleCopy(
        t,
        params.optionTitle || t("untitledOption")
      );
      return renderRouteHandle({
        id: params.handleId,
        connected: connectedFlowBranchIds.has(params.branchId),
        title: copy.tooltip,
        ariaLabel: copy.label,
        testId: "inline-flow-branch-handle",
        local: true,
      });
    },
    [connectedFlowBranchIds, renderRouteHandle, t]
  );

  const promptInputVariableFields = useMemo(
    () =>
      buildScenarioPromptInputVariableFields(nodeData.uiScenarioPromptInputs),
    [nodeData.uiScenarioPromptInputs]
  );

  const templateActionCardWidthClassName = templateHasFlowButtonForLayout
    ? "w-[384px] max-w-[calc(100vw-2rem)]"
    : "w-[364px] max-w-[calc(100vw-2rem)]";
  return (
    <div
      ref={setActionNodeRootRef}
      className="relative w-max min-w-0"
      onKeyDown={stopScenarioKeyboardPropagationFromEditableTarget}
    >
      <ScenarioNodeCard
        selected={selected}
        muted={mode.isInstagramReplyDisabled}
        className={cn(
          "gap-0 overflow-visible border-emerald-300/70 p-0",
          mode.isInstagramReplyDisabled && INSTAGRAM_REPLY_DISABLED_CARD_CLASS,
          mode.isWhatsAppTemplateAction
            ? templateActionCardWidthClassName
            : mode.isWhatsAppServiceMessage
              ? "w-[368px] max-w-[calc(100vw_-_24px)]"
              : "w-max max-w-[440px]"
        )}
      >
        <NodeHandles
          kind="action"
          hiddenSourceHandles={branchState.hiddenActionSourceHandles}
          cornerSourceHandles={branchState.cornerActionSourceHandles}
          sourceHandles={branchState.actionSourceHandles}
          outputHandleOverride={branchState.outputHandleOverride}
          suppressDefaultOutputHandle={
            branchState.suppressDefaultActionOutputHandle
          }
          defaultSourceHandleTitle={
            branchState.defaultActionSourceHandleCopy?.tooltip
          }
          defaultSourceHandleAriaLabel={
            branchState.defaultActionSourceHandleCopy?.label
          }
          ownedSourceHandleIds={fixedOutputHandleIds}
          onCreateNodeFromSourceHandle={(sourceHandleId, point) =>
            nodeData.uiOnCreateNodeFromSourceHandle?.(
              sourceHandleId,
              point.clientX,
              point.clientY
            )
          }
        />
        <div className="relative flex flex-col gap-2 overflow-visible rounded-[inherit]">
          <ActionNodeExpandedHeader
            leading={
              <ActionNodeHeaderTitle
                icon={<ActionNodeKindIcon nodeData={nodeData} />}
                title={resolveActionNodeCardTitle(nodeData, t)}
              />
            }
            incomingRouteCount={nodeData.uiIncomingRouteCount}
            attachmentCount={resolveActionNodeAttachmentCount(nodeData)}
            flowBranchOptionLabel={nodeData.flowBranchOptionLabel}
            instagramBranchLabel={nodeData.instagramBranchLabel}
            instagramReplyDisabledReason={mode.instagramReplyDisabledReason}
            longWaitNotice={showsActionNodeLongWaitNotice(nodeData)}
            onRemove={nodeData.uiOnRemove}
            recipientMessages={
              <ActionNodeRecipientMessages
                activeScenarioId={nodeData.uiActiveScenarioId ?? null}
                branchId={nodeData.bulkRecipientBranchId}
                recipientCount={nodeData.bulkRecipientCount}
                workspaceId={nodeData.uiWorkspaceId ?? ""}
              />
            }
            t={t}
            telegramBranchLabel={nodeData.telegramBranchLabel}
            unreachableRouteNotice={
              <ActionNodeUnreachableRouteNotice
                ports={ports}
                nodeData={nodeData}
                t={t}
              />
            }
            whatsAppSessionChoiceLabel={nodeData.whatsAppSessionChoiceLabel}
          />
          <CardContent className="space-y-1.5 overflow-visible rounded-[inherit] px-3 py-0 text-xs">
            {!mode.isGenerativeAI ? (
              <ActionNodeSourceControls {...sourceControls} />
            ) : null}

            {mode.isGenerativeAI ? (
              <ActionNodeGenerativeAIEditor
                nodeId={id}
                nodeData={nodeData}
                patchNode={patchNode}
                promptInputFields={promptInputVariableFields}
                t={t}
              />
            ) : null}

            <ActionNodeReplyEditor
              mode={mode}
              draft={replyDraft}
              nodeData={nodeData}
              t={t}
            />

            <ActionNodeTelegramEditor
              mode={mode}
              draft={replyDraft}
              nodeData={nodeData}
              patchNode={patchNode}
              renderButtonBranchHandle={renderTelegramButtonBranchHandle}
              routeAnchorHandleIds={lazySectionRoutes.telegram}
              onRouteAnchorsRemoved={scheduleNodeInternalsUpdate}
            />

            <ActionNodeInstagramEditor
              mode={mode}
              draft={replyDraft}
              nodeData={nodeData}
              patchNode={patchNode}
              t={t}
            />

            {mode.isWhatsAppServiceMessage ? (
              <LazyActionNodeWhatsAppServiceMessageSection
                id={id}
                nodeData={nodeData}
                patchNode={patchNode}
                whatsAppFlowsLoading={whatsAppFlowsLoading}
                whatsAppFlowsRefreshing={whatsAppFlowsRefreshing}
                renderOptionBranchHandle={
                  renderWhatsAppServiceOptionBranchHandle
                }
                connectedOptionIds={
                  branchState.connectedWhatsAppServiceMessagePayloads
                }
                renderFlowBranchHandle={renderInlineFlowBranchHandle}
                onLayoutChange={scheduleNodeInternalsUpdate}
                hasWhatsAppCoexistence={
                  nodeData.uiSourceCapabilities.hasWhatsAppCoexistence
                }
                routeAnchorHandleIds={lazySectionRoutes.serviceMessage}
                onRouteAnchorsRemoved={scheduleNodeInternalsUpdate}
              />
            ) : null}

            <ActionNodeReplyWarnings mode={mode} draft={replyDraft} t={t} />

            <ActionNodeBranchSummaries branchState={branchState} t={t} />

            {mode.actionType === "assign_human" ? (
              <ActionNodeHandoffEditor
                nodeData={nodeData}
                patchNode={patchNode}
                t={t}
              />
            ) : null}

            {mode.isWhatsAppTemplateAction ? (
              <LazyActionNodeWhatsAppTemplateSection
                id={id}
                branchState={branchState}
                createNodeFromSourceHandle={createNodeFromSourceHandle}
                loadingLabel={t("loadingItems")}
                mode={mode}
                nodeData={nodeData}
                patchNode={patchNode}
                refreshNodeInternals={refreshNodeInternals}
                renderInlineFlowBranchHandle={renderInlineFlowBranchHandle}
                scheduleNodeInternalsUpdate={scheduleNodeInternalsUpdate}
                whatsAppFlowsLoading={whatsAppFlowsLoading}
                whatsAppFlowsRefreshing={whatsAppFlowsRefreshing}
                whatsAppTemplatesLoading={whatsAppTemplatesLoading}
                whatsAppTemplatesRefreshing={whatsAppTemplatesRefreshing}
                routeAnchorHandleIds={lazySectionRoutes.template}
                onRouteAnchorsRemoved={scheduleNodeInternalsUpdate}
              />
            ) : null}

            <ActionNodeRoutingSection
              nodeId={id}
              nodeData={nodeData}
              t={t}
              onPatch={patchNode}
              onHandlesChanged={refreshNodeInternals}
              inset
              showOutcomes={showsActionNodeOutcomes(mode)}
            />

            <ActionNodeAdvancedSection
              mode={mode}
              nodeData={nodeData}
              patchNode={patchNode}
              promptInputFields={promptInputVariableFields}
              showAdvanced={showAdvanced}
              onToggle={() => setShowAdvanced(prev => !prev)}
              onInsertToken={replyDraft.insertToken}
              t={t}
            />
          </CardContent>
          {fixedOutputRows.length > 0 ? (
            <div
              className="overflow-visible border-t border-border/60 pb-1"
              data-testid="action-node-fixed-outputs"
            >
              {fixedOutputRows.map(({ handle, port }) => (
                <ScenarioRouteRow
                  key={handle.id}
                  handleId={handle.id}
                  sourceLabel={port?.label || handle.title || ""}
                  icon={port ? resolveActionNodePortIcon(port) : undefined}
                  detail={port?.detail}
                  accessibleLabel={port?.accessibleLabel}
                  connected={port?.connected ?? handle.connected}
                  connectable={port?.connectable}
                  required={port?.required}
                  destinationLabel={port?.destinationLabel}
                  onInteractionStart={refreshNodeInternals}
                  onCreateNode={bindSourceHandleCreate(
                    createNodeFromSourceHandle,
                    handle.id
                  )}
                  data-testid="action-node-fixed-output"
                />
              ))}
            </div>
          ) : null}
        </div>
      </ScenarioNodeCard>
    </div>
  );
}
