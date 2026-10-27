"use client";

import { CampaignVariableMapper } from "@/components/campaigns/CampaignVariableMapper";
import { Button } from "@/components/ui/button";
import { retainCampaignVariableConfigs } from "@/lib/campaign/campaign-variable-values";
import { cn } from "@/lib/utils";
import type { CampaignVariableSourceConfig } from "@icecore/scenario-contracts";
import { getTemplateVariables } from "@icecore/shared/types/whatsapp";
import { useTranslations } from "next-intl";
import { useMemo, type SyntheticEvent } from "react";
import type { ScenarioNodeData } from "../../types";
import type { ScenarioActionEditorNodeData } from "../../view/node-enrichment/types";
import { ScenarioInlineNotice } from "../../scenario-inline-notice";
import { ActionNodeWhatsAppTemplateBindings } from "./action-node-whatsapp-template-bindings";

const CARD_CONTROL_CLASS = "nodrag nopan nokey";
// One empty value for every render, so the mapper's memos keep their inputs.
const NO_VARIABLE_CONFIGS: Record<string, CampaignVariableSourceConfig> = {};

function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

/**
 * Where the template's variables come from: conversation values on a step,
 * or the campaign's recipient columns when this step is a bulk send.
 */
export function ActionNodeWhatsAppTemplateVariables({
  id,
  nodeData,
  showPorts,
  patchNode,
}: {
  id: string;
  nodeData: ScenarioActionEditorNodeData;
  /** The canvas card folds the conversation values into a section. */
  showPorts: boolean;
  patchNode: (patch: Partial<ScenarioNodeData>) => void;
}) {
  const t = useTranslations("Scenarios");
  const bulkRouteTemplateVariables = useMemo(
    () =>
      getTemplateVariables({
        name: nodeData.actionWhatsAppTemplateName || "",
        language: nodeData.actionWhatsAppTemplateLanguage || "en",
        status: "APPROVED",
        category: "UTILITY",
        components: nodeData.actionWhatsAppTemplateComponents || [],
      }),
    [
      nodeData.actionWhatsAppTemplateComponents,
      nodeData.actionWhatsAppTemplateLanguage,
      nodeData.actionWhatsAppTemplateName,
    ]
  );

  return (
    <>
      {nodeData.uiBulkPrimaryAction &&
      nodeData.actionWhatsAppTemplateBindings !== undefined ? (
        <ScenarioInlineNotice
          tone="error"
          className="nodrag w-full min-w-0"
          data-testid="whatsapp-template-bulk-conflict"
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn(
                CARD_CONTROL_CLASS,
                "h-auto min-h-7 whitespace-normal px-2 text-[11px]"
              )}
              onPointerDown={stopPropagation}
              onClick={event => {
                event.stopPropagation();
                patchNode({ actionWhatsAppTemplateBindings: undefined });
              }}
            >
              {t("whatsappTemplateBindingsUseCampaign")}
            </Button>
          }
        >
          {t("whatsappTemplateBindingsBulkConflict")}
        </ScenarioInlineNotice>
      ) : null}

      {!nodeData.uiBulkPrimaryAction ? (
        <ActionNodeWhatsAppTemplateBindings
          key={`${nodeData.uiWorkspaceId}:${nodeData.uiActiveScenarioId}:${id}:${nodeData.actionWhatsAppTemplateId || nodeData.actionWhatsAppTemplateName}:${nodeData.actionWhatsAppTemplateLanguage}`}
          nodeId={id}
          components={nodeData.actionWhatsAppTemplateComponents}
          bindings={nodeData.actionWhatsAppTemplateBindings}
          promptInputs={nodeData.uiScenarioPromptInputs}
          collapsible={showPorts}
          onChange={actionWhatsAppTemplateBindings =>
            patchNode({ actionWhatsAppTemplateBindings })
          }
        />
      ) : null}

      {nodeData.uiBulkPrimaryAction &&
      nodeData.uiBulkRouteRecipients &&
      nodeData.uiBulkRouteRecipients.length > 0 &&
      bulkRouteTemplateVariables.length > 0 ? (
        <CampaignVariableMapper
          templateVariables={bulkRouteTemplateVariables}
          recipients={nodeData.uiBulkRouteRecipients}
          variableConfigs={
            nodeData.actionCampaignVariableConfigs || NO_VARIABLE_CONFIGS
          }
          onVariableConfigsChange={(
            configs: Record<string, CampaignVariableSourceConfig>
          ) =>
            patchNode({
              actionCampaignVariableConfigs: retainCampaignVariableConfigs({
                templateVariables: bulkRouteTemplateVariables,
                previous: configs,
              }),
            })
          }
          title={t("bulkNodeVariables")}
        />
      ) : null}
    </>
  );
}
