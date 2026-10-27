"use client";

import {
  resolveReplyModeFromNodeData,
  resolveScenarioActionTypeFromNodeData,
} from "@icecore/airi-runtime/scenario-action-semantics";
import { getWhatsAppTemplateOptionValue } from "@/lib/whatsapp/templates/selection";
import { useEffect } from "react";
import type { ScenarioFlowNode } from "../../types";
import type { ScenarioDisplayNodeCallbacks } from "../scenario-node-enrichment-context";
import type { useScenarioResourcesEntity } from "./use-scenario-resources-entity";

type UseScenarioSelectedResourcesParams = Pick<
  ReturnType<typeof useScenarioResourcesEntity>,
  | "loadContextItems"
  | "loadWhatsAppTemplates"
  | "loadWhatsAppFlows"
  | "whatsAppTemplates"
> & {
  selectedNode: ScenarioFlowNode | undefined;
  selectWhatsAppTemplate: ScenarioDisplayNodeCallbacks["updateActionWhatsAppTemplateById"];
};

export function useScenarioSelectedResources({
  selectedNode,
  loadContextItems,
  loadWhatsAppTemplates,
  loadWhatsAppFlows,
  whatsAppTemplates,
  selectWhatsAppTemplate,
}: UseScenarioSelectedResourcesParams) {
  const data = selectedNode?.data;
  const actionType =
    data?.kind === "action"
      ? (resolveScenarioActionTypeFromNodeData(data) ?? "reply")
      : null;
  const contextOptionId =
    data?.kind === "context" ? data.contextOptionId : undefined;
  const needsTemplates =
    data?.kind === "bulk" || actionType === "whatsapp_template";
  const needsFlows =
    actionType === "reply" &&
    data &&
    resolveReplyModeFromNodeData(data) === "fixed";

  useEffect(() => {
    if (contextOptionId) void loadContextItems(contextOptionId);
  }, [contextOptionId, loadContextItems]);

  useEffect(() => {
    if (needsTemplates) void loadWhatsAppTemplates();
  }, [needsTemplates, loadWhatsAppTemplates]);

  useEffect(() => {
    if (needsFlows) void loadWhatsAppFlows();
  }, [needsFlows, loadWhatsAppFlows]);

  const nodeId = selectedNode?.id;
  const templateName = data?.actionWhatsAppTemplateName?.trim();
  const templateId = data?.actionWhatsAppTemplateId?.trim();
  useEffect(() => {
    // An omitted language can intentionally use runtime language fallback.
    // Opening or refreshing the catalog must never replace an explicit choice.
    if (
      !nodeId ||
      actionType !== "whatsapp_template" ||
      templateName ||
      templateId
    )
      return;
    const firstTemplate = whatsAppTemplates[0];
    if (!firstTemplate?.name?.trim() || !firstTemplate.language?.trim()) return;
    selectWhatsAppTemplate(
      nodeId,
      getWhatsAppTemplateOptionValue(firstTemplate)
    );
  }, [
    nodeId,
    actionType,
    templateName,
    templateId,
    whatsAppTemplates,
    selectWhatsAppTemplate,
  ]);
}
