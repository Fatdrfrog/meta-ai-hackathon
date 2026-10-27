"use client";

import type { WhatsAppFlowConfig } from "@/components/scenarios/types";
import { useTransitionOwnerKey } from "@/hooks/use-transition-owner-key";
import { sanitizeWhatsAppFlowConfig } from "@/lib/scenarios/whatsapp-flow-config";
import { getSingleFlowIdFromWhatsAppTemplateComponents } from "@/lib/scenarios/whatsapp-template-flow";
import { findSelectedWhatsAppTemplate } from "@/lib/whatsapp/templates/selection-utils";
import { resolveWhatsAppFlowProviderId } from "@icecore/scenario-contracts";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { ScenarioNodeData } from "../../types";
import type { ScenarioActionEditorNodeData } from "../../view/node-enrichment/types";
import { useLatestRef } from "../../view/use-latest-ref";
import type { ActionNodeModeState } from "./action-node-state";
import {
  INITIAL_TEMPLATE_EDITOR_UI_STATE,
  reduceTemplateEditorUiState,
} from "./action-node-template-editor";
import { showScenarioErrorToast } from "./action-node-utils";

type TemplateControlsNodeData = Pick<
  ScenarioActionEditorNodeData,
  | "actionWhatsAppTemplateComponents"
  | "actionFlowConfig"
  | "actionReplyCtaFlowId"
  | "actionWhatsAppTemplateId"
  | "actionWhatsAppTemplateName"
  | "actionWhatsAppTemplateLanguage"
  | "uiActiveScenarioId"
> & {
  uiWhatsAppTemplates: Pick<
    ScenarioActionEditorNodeData["uiWhatsAppTemplates"],
    "options" | "selectedValue" | "onOpenChange" | "select"
  >;
  uiWhatsAppFlows: Pick<
    ScenarioActionEditorNodeData["uiWhatsAppFlows"],
    "options" | "openPicker" | "select"
  >;
};

export function useWhatsAppTemplateControls({
  id,
  nodeData,
  mode,
  patchNode,
  flowExistingLoadFailedMessage,
}: {
  id: string;
  nodeData: TemplateControlsNodeData;
  mode: Pick<
    ActionNodeModeState,
    | "templateEditorWorkspaceId"
    | "canEditTemplateFlow"
    | "isWhatsAppTemplateAction"
  >;
  patchNode: (patch: Partial<ScenarioNodeData>) => void;
  flowExistingLoadFailedMessage: string;
}) {
  const templates = nodeData.uiWhatsAppTemplates;
  const flows = nodeData.uiWhatsAppFlows;
  const {
    templateEditorWorkspaceId: workspaceId,
    canEditTemplateFlow,
    isWhatsAppTemplateAction,
  } = mode;
  const [uiState, dispatch] = useReducer(
    reduceTemplateEditorUiState,
    INITIAL_TEMPLATE_EDITOR_UI_STATE
  );
  const requestSequenceRef = useRef(0);

  const selectedTemplateOption = useMemo(
    () =>
      findSelectedWhatsAppTemplate({
        templates: templates.options,
        value: templates.selectedValue,
        templateId: nodeData.actionWhatsAppTemplateId,
        name: nodeData.actionWhatsAppTemplateName,
        language: nodeData.actionWhatsAppTemplateLanguage,
      }),
    [
      nodeData.actionWhatsAppTemplateId,
      nodeData.actionWhatsAppTemplateLanguage,
      nodeData.actionWhatsAppTemplateName,
      templates.options,
      templates.selectedValue,
    ]
  );
  const selectedTemplateId =
    nodeData.actionWhatsAppTemplateId?.trim() ||
    selectedTemplateOption?.id?.trim() ||
    "";
  const selectedTemplateLanguage =
    selectedTemplateOption?.language?.trim() || null;
  const selectedTemplateCategory =
    selectedTemplateOption?.category?.trim() || undefined;
  const inlineFlowId = useMemo(
    () =>
      canEditTemplateFlow
        ? getSingleFlowIdFromWhatsAppTemplateComponents(
            nodeData.actionWhatsAppTemplateComponents
          )
        : null,
    [canEditTemplateFlow, nodeData.actionWhatsAppTemplateComponents]
  );
  const inlineFlowConfig = useMemo(() => {
    if (!nodeData.actionFlowConfig || !inlineFlowId) return null;
    return resolveWhatsAppFlowProviderId({
      flowConfig: nodeData.actionFlowConfig,
    }) === inlineFlowId
      ? nodeData.actionFlowConfig
      : null;
  }, [inlineFlowId, nodeData.actionFlowConfig]);

  const visitOwnerKey = useTransitionOwnerKey(
    JSON.stringify([
      workspaceId,
      nodeData.uiActiveScenarioId ?? null,
      id,
      selectedTemplateId,
      nodeData.actionWhatsAppTemplateName?.trim() || "",
      nodeData.actionWhatsAppTemplateLanguage?.trim() || "",
      templates.selectedValue,
      inlineFlowId,
      canEditTemplateFlow,
      isWhatsAppTemplateAction,
    ])
  );
  const visitOwnerKeyRef = useLatestRef(visitOwnerKey);

  const invalidatePresentationRequest = useCallback(() => {
    requestSequenceRef.current += 1;
  }, []);

  useEffect(() => {
    invalidatePresentationRequest();
    dispatch({ type: "template-value-synced" });
  }, [invalidatePresentationRequest, visitOwnerKey]);

  useEffect(
    () => () => {
      requestSequenceRef.current += 1;
      visitOwnerKeyRef.current = "";
    },
    [visitOwnerKeyRef]
  );

  const setTemplatePickerOpen = useCallback(
    (open: boolean) => {
      dispatch({ type: "set-select-open", open });
      templates.onOpenChange(open);
    },
    [templates]
  );

  const selectTemplate = useCallback(
    (value: string) => {
      invalidatePresentationRequest();
      dispatch({ type: "select-template", value });
      templates.onOpenChange(false);
      templates.select(value);
    },
    [invalidatePresentationRequest, templates]
  );

  const closeInlineFlow = useCallback(() => {
    invalidatePresentationRequest();
    dispatch({ type: "set-flow-open", open: false });
  }, [invalidatePresentationRequest]);

  const changeInlineFlowConfig = useCallback(
    (config: WhatsAppFlowConfig) => {
      const sanitized = sanitizeWhatsAppFlowConfig(config) ?? config;
      const providerFlowId = resolveWhatsAppFlowProviderId({
        flowConfig: config,
        legacyFlowId: nodeData.actionReplyCtaFlowId,
      });
      const cta = (sanitized.ctaText || "").trim().slice(0, 30);
      patchNode({
        actionFlowConfig: sanitized,
        ...(providerFlowId
          ? {
              actionReplyCtaType: "flow" as const,
              actionReplyCtaFlowId: providerFlowId,
              ...(typeof sanitized.metaFlowName === "string" &&
              sanitized.metaFlowName.trim()
                ? { actionReplyCtaFlowName: sanitized.metaFlowName }
                : {}),
              ...(cta ? { actionReplyCtaLabel: cta } : {}),
            }
          : {}),
      });
    },
    [nodeData.actionReplyCtaFlowId, patchNode]
  );

  const openInlineFlow = useCallback(
    async (requestedFlowId: string) => {
      const normalizedFlowId = requestedFlowId.trim();
      if (!normalizedFlowId) return;
      if (visitOwnerKeyRef.current !== visitOwnerKey) return;

      const requestSequence = ++requestSequenceRef.current;
      const requestOwnerKey = visitOwnerKey;
      const isCurrent = () =>
        requestSequenceRef.current === requestSequence &&
        visitOwnerKeyRef.current === requestOwnerKey;

      dispatch({ type: "start-opening-flow", flowId: normalizedFlowId });
      templates.onOpenChange(false);
      try {
        const currentFlowConfig = nodeData.actionFlowConfig;
        const currentProviderFlowId = resolveWhatsAppFlowProviderId({
          flowConfig: currentFlowConfig,
        });
        if (currentProviderFlowId !== normalizedFlowId) {
          const currentSourceId =
            currentFlowConfig?.providerReference?.sourceId?.trim() ||
            currentFlowConfig?.managedProvisioning?.sourceId?.trim() ||
            null;
          const matchingFlows = flows.options.filter(
            flow => flow.id.trim() === normalizedFlowId
          );
          const sourceBoundFlow = currentSourceId
            ? matchingFlows.find(
                flow => flow.sourceId?.trim() === currentSourceId
              )
            : undefined;
          const selectedFlow =
            sourceBoundFlow ??
            (matchingFlows.length === 1 ? matchingFlows[0] : undefined);
          if (selectedFlow) await flows.select(selectedFlow);
          else flows.openPicker();
        }
        if (isCurrent()) dispatch({ type: "set-flow-open", open: true });
      } catch (error) {
        if (isCurrent()) {
          showScenarioErrorToast(flowExistingLoadFailedMessage, error);
        }
      } finally {
        if (isCurrent()) {
          dispatch({ type: "finish-opening-flow", flowId: normalizedFlowId });
        }
      }
    },
    [
      flowExistingLoadFailedMessage,
      flows,
      nodeData.actionFlowConfig,
      templates,
      visitOwnerKey,
      visitOwnerKeyRef,
    ]
  );

  return {
    selectedTemplateOption,
    selectedTemplateId,
    selectedTemplateLanguage,
    selectedTemplateCategory,
    inlineFlowId,
    inlineFlowConfig,
    flowDrawerOpen:
      isWhatsAppTemplateAction && canEditTemplateFlow && uiState.flowExpanded,
    selectOpen: uiState.selectOpen,
    pendingTemplateValue: uiState.pendingTemplateValue,
    openingFlowId: uiState.openingFlowId,
    setTemplatePickerOpen,
    selectTemplate,
    openInlineFlow,
    closeInlineFlow,
    changeInlineFlowConfig,
  };
}
