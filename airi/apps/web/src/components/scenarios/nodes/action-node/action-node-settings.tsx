"use client";

import { FieldLegend, FieldSet } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ScenarioCollapsibleSection } from "../../scenario-collapsible-section";
import { ScenarioRouteSummaryRow } from "../../scenario-route";
import type { ScenarioNodeData, TranslateFn } from "../../types";
import { useScenarioGraphResources } from "../../view/graph/resources-context";
import type { ScenarioActionEditorNodeData } from "../../view/node-enrichment/types";
import { buildScenarioPromptInputVariableFields } from "../../view/scenario-variable-groups";
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
import { ActionNodeSourceControls } from "./action-node-expanded-ui";
import { resolveActionNodePortIcon } from "./action-node-port-icons";
import { resolveActionNodePorts } from "./action-node-ports";
import { ActionNodeRecipientMessages } from "./action-node-recipient-messages";
import { ActionNodeRoutingSection } from "./action-node-routing-section";
import {
  resolveActionNodeBranchState,
  resolveActionNodeModeState,
} from "./action-node-state";
import { ActionNodeWhatsAppServiceMessageSection } from "./action-node-whatsapp-service-message-section";
import { ActionNodeWhatsAppTemplateSection } from "./action-node-whatsapp-template-section";

function ActionNodeSettingsGroup({
  legend,
  children,
  "data-testid": dataTestId,
}: {
  legend: string;
  children: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <FieldSet className="min-w-0 gap-2" data-testid={dataTestId}>
      <FieldLegend variant="label" className="mb-0 text-xs">
        {legend}
      </FieldLegend>
      {children}
    </FieldSet>
  );
}

/**
 * Every route of the step with its next step, read-only: the panel can't
 * show route dots, so routes are connected on the canvas card.
 */
export function ActionNodeSettingsRoutes({
  nodeId,
  data,
  t,
}: {
  nodeId: string;
  data: ScenarioActionEditorNodeData;
  t: TranslateFn;
}) {
  const ports = useMemo(
    () => resolveActionNodePorts({ id: nodeId, nodeData: data, t }).ports,
    [data, nodeId, t]
  );
  if (ports.length === 0) return null;
  const connectedCount = ports.filter(port => port.connected).length;
  return (
    <ScenarioCollapsibleSection
      title={t("actionPanelRoutes")}
      count={ports.length}
      countLabel={t("routeCount", { count: ports.length })}
      summary={t("actionPanelRoutesSummary", {
        connected: connectedCount,
        total: ports.length,
      })}
      defaultOpen
      data-testid="action-node-settings-routes"
    >
      <div className="px-3 pb-1">
        {ports.map(port => (
          <ScenarioRouteSummaryRow
            key={port.handleId}
            icon={resolveActionNodePortIcon(port)}
            label={port.label}
            detail={port.detail}
            destinationLabel={port.destinationLabel}
            connected={port.connected}
            required={port.required}
            t={t}
          />
        ))}
      </div>
    </ScenarioCollapsibleSection>
  );
}

/**
 * Settings panel body of an action: the inline editor's sections, patched
 * through the same node commands. It renders no React Flow handles and calls
 * no React Flow hooks; the canvas card owns the ports.
 */
export function ActionNodeSettings({
  nodeId,
  data,
}: {
  nodeId: string;
  data: ScenarioActionEditorNodeData;
}) {
  const t = useTranslations("Scenarios");
  const {
    whatsAppTemplatesLoading,
    whatsAppTemplatesRefreshing,
    whatsAppFlowsLoading,
    whatsAppFlowsRefreshing,
  } = useScenarioGraphResources();
  const mode = useMemo(() => resolveActionNodeModeState(data), [data]);
  const branchState = useMemo(
    () =>
      resolveActionNodeBranchState({
        id: nodeId,
        mode,
        nodeData: data,
        renderMode: "expanded",
        t,
      }),
    [data, mode, nodeId, t]
  );
  const patchNode = useCallback(
    (patch: Partial<ScenarioNodeData>) => data.uiOnPatch(patch),
    [data]
  );
  const replyDraft = useActionNodeReplyDraft({
    nodeData: data,
    mode,
    patchNode,
    t,
  });
  const sourceControls = useActionNodeSourceControls({
    nodeData: data,
    mode,
    t,
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const promptInputFields = useMemo(
    () => buildScenarioPromptInputVariableFields(data.uiScenarioPromptInputs),
    [data.uiScenarioPromptInputs]
  );

  return (
    <div
      className="flex min-w-0 flex-col gap-3 text-xs"
      data-testid="action-node-settings"
    >
      <ActionNodeRecipientMessages
        activeScenarioId={data.uiActiveScenarioId ?? null}
        branchId={data.bulkRecipientBranchId}
        recipientCount={data.bulkRecipientCount}
        workspaceId={data.uiWorkspaceId ?? ""}
      />
      {mode.isGenerativeAI ? (
        <ActionNodeGenerativeAIEditor
          nodeId={nodeId}
          nodeData={data}
          patchNode={patchNode}
          promptInputFields={promptInputFields}
          t={t}
        />
      ) : (
        <>
          {sourceControls.hidden ? null : (
            <>
              <ActionNodeSettingsGroup
                legend={t("actionPanelChannel")}
                data-testid="action-node-settings-channel"
              >
                <ActionNodeSourceControls {...sourceControls} />
              </ActionNodeSettingsGroup>
              <Separator />
            </>
          )}
          {/* The handoff editor names its own two parts. */}
          {mode.actionType === "assign_human" ? (
            <div className="min-w-0" data-testid="action-node-settings-handoff">
              <ActionNodeHandoffEditor
                nodeData={data}
                patchNode={patchNode}
                t={t}
              />
            </div>
          ) : (
            <ActionNodeSettingsGroup
              legend={t("actionPanelMessage")}
              data-testid="action-node-settings-message"
            >
              <ActionNodeReplyEditor
                mode={mode}
                draft={replyDraft}
                nodeData={data}
                t={t}
                showLabels
              />
              <ActionNodeTelegramEditor
                mode={mode}
                draft={replyDraft}
                nodeData={data}
                patchNode={patchNode}
              />
              <ActionNodeInstagramEditor
                mode={mode}
                draft={replyDraft}
                nodeData={data}
                patchNode={patchNode}
                t={t}
              />
              {mode.isWhatsAppServiceMessage ? (
                <ActionNodeWhatsAppServiceMessageSection
                  id={nodeId}
                  nodeData={data}
                  patchNode={patchNode}
                  whatsAppFlowsLoading={whatsAppFlowsLoading}
                  whatsAppFlowsRefreshing={whatsAppFlowsRefreshing}
                  connectedOptionIds={
                    branchState.connectedWhatsAppServiceMessagePayloads
                  }
                  hasWhatsAppCoexistence={
                    data.uiSourceCapabilities.hasWhatsAppCoexistence
                  }
                />
              ) : null}
              <ActionNodeReplyWarnings mode={mode} draft={replyDraft} t={t} />
              {mode.isWhatsAppTemplateAction ? (
                <ActionNodeWhatsAppTemplateSection
                  id={nodeId}
                  branchState={branchState}
                  flowDrawerPlacement="inline"
                  loadingLabel={t("loadingItems")}
                  mode={mode}
                  nodeData={data}
                  patchNode={patchNode}
                  showPorts={false}
                  whatsAppFlowsLoading={whatsAppFlowsLoading}
                  whatsAppFlowsRefreshing={whatsAppFlowsRefreshing}
                  whatsAppTemplatesLoading={whatsAppTemplatesLoading}
                  whatsAppTemplatesRefreshing={whatsAppTemplatesRefreshing}
                />
              ) : null}
              <ActionNodeBranchSummaries branchState={branchState} t={t} />
            </ActionNodeSettingsGroup>
          )}
        </>
      )}
      <div className="flex min-w-0 flex-col">
        <ActionNodeRoutingSection
          nodeId={nodeId}
          nodeData={data}
          t={t}
          onPatch={patchNode}
          showOutcomes={showsActionNodeOutcomes(mode)}
          showPorts={false}
        />
        <ActionNodeAdvancedSection
          mode={mode}
          nodeData={data}
          patchNode={patchNode}
          promptInputFields={promptInputFields}
          showAdvanced={showAdvanced}
          onToggle={() => setShowAdvanced(current => !current)}
          onInsertToken={replyDraft.insertToken}
          t={t}
        />
        <ActionNodeSettingsRoutes nodeId={nodeId} data={data} t={t} />
      </div>
    </div>
  );
}
