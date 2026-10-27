import type { ScenarioContextItem, ScenarioNodeData } from "../../types";
import type { ScenarioNodeEnrichmentContextValue } from "../scenario-node-enrichment-context";
import {
  buildCommonNodeEnrichment,
  buildSourceHandleEnrichment,
  selectCommonEnrichmentView,
  type ScenarioCommonEnrichmentView,
  type ScenarioSourceHandleEnrichmentView,
} from "./common";
import type {
  ScenarioContextEditorNodeData,
  ScenarioPersistedNodeDataOfKind,
} from "./types";

export type ScenarioContextEnrichmentView = ScenarioCommonEnrichmentView &
  ScenarioSourceHandleEnrichmentView &
  Pick<
    ScenarioNodeEnrichmentContextValue,
    | "contextItemsByOptionId"
    | "audienceOptions"
    | "knowledgeDisabledReason"
    | "filteredContextOptions"
    | "isCreatingSnippet"
  >;

export function selectContextEnrichmentView(
  ctx: ScenarioNodeEnrichmentContextValue
): ScenarioContextEnrichmentView {
  return {
    ...selectCommonEnrichmentView(ctx),
    openNodePickerFromHandle: ctx.openNodePickerFromHandle,
    contextItemsByOptionId: ctx.contextItemsByOptionId,
    audienceOptions: ctx.audienceOptions,
    knowledgeDisabledReason: ctx.knowledgeDisabledReason,
    filteredContextOptions: ctx.filteredContextOptions,
    isCreatingSnippet: ctx.isCreatingSnippet,
  };
}

function buildContextItemsByOptionIdForNode(params: {
  contextItems: ScenarioContextItem[];
  contextItemsByOptionId: ScenarioNodeEnrichmentContextValue["contextItemsByOptionId"];
  contextOptionId?: string;
  contextSources: NonNullable<ScenarioNodeData["contextSources"]>;
}): Record<string, ScenarioContextItem[]> {
  const result: Record<string, ScenarioContextItem[]> = {};

  for (const source of params.contextSources) {
    result[source.optionId] =
      params.contextItemsByOptionId[source.optionId] ??
      (source.optionId === params.contextOptionId ? params.contextItems : []);
  }

  return result;
}

export function enrichContextNodeData(
  nodeId: string,
  rawData: ScenarioPersistedNodeDataOfKind<"context">,
  ctx: ScenarioContextEnrichmentView
): ScenarioContextEditorNodeData {
  const contextItems = rawData.contextOptionId
    ? (ctx.contextItemsByOptionId[rawData.contextOptionId] ?? [])
    : [];
  const contextItemsByOptionIdForNode = Array.isArray(rawData.contextSources)
    ? buildContextItemsByOptionIdForNode({
        contextItems,
        contextItemsByOptionId: ctx.contextItemsByOptionId,
        contextOptionId: rawData.contextOptionId,
        contextSources: rawData.contextSources,
      })
    : undefined;

  return {
    ...rawData,
    ...buildCommonNodeEnrichment(nodeId, ctx),
    ...buildSourceHandleEnrichment(nodeId, ctx),
    uiAudienceOptions: ctx.audienceOptions,
    uiKnowledgeDisabledReason: ctx.knowledgeDisabledReason,
    uiContextOptions: ctx.filteredContextOptions,
    uiContextItems: contextItems,
    uiContextItemsByOptionId: contextItemsByOptionIdForNode,
    uiOnContextOptionChange: contextOptionId =>
      ctx.callbacksRef.current.updateNodeContextOptionById(
        nodeId,
        contextOptionId
      ),
    uiOnContextSelectionModeChange: mode =>
      ctx.callbacksRef.current.updateNodeContextSelectionModeById(nodeId, mode),
    uiOnContextItemToggle: itemId =>
      ctx.callbacksRef.current.toggleContextItemSelectionById(nodeId, itemId),
    uiOnContextSelectVisible: itemIds =>
      ctx.callbacksRef.current.selectContextItemsById(nodeId, itemIds),
    uiOnContextClearSelection: () =>
      ctx.callbacksRef.current.clearContextItemSelectionById(nodeId),
    uiOnContextRefresh: () => {
      if (!rawData.contextOptionId) return;
      void ctx.callbacksRef.current.loadContextItems(
        rawData.contextOptionId,
        true
      );
    },
    uiOnContextSourceToggle: (optionId, enabled) =>
      ctx.callbacksRef.current.toggleContextSourceById(
        nodeId,
        optionId,
        enabled
      ),
    uiOnContextSourceSelectionModeChange: (optionId, mode) =>
      ctx.callbacksRef.current.updateContextSourceSelectionModeById(
        nodeId,
        optionId,
        mode
      ),
    uiOnContextSourceItemToggle: (optionId, itemId) =>
      ctx.callbacksRef.current.toggleContextSourceItemById(
        nodeId,
        optionId,
        itemId
      ),
    uiOnContextSourceSelectVisible: (optionId, itemIds) =>
      ctx.callbacksRef.current.selectContextSourceItemsById(
        nodeId,
        optionId,
        itemIds
      ),
    uiOnContextSourceClearSelection: optionId =>
      ctx.callbacksRef.current.clearContextSourceItemSelectionById(
        nodeId,
        optionId
      ),
    uiOnContextSourceRefresh: optionId =>
      void ctx.callbacksRef.current.loadContextItems(optionId, true),
    uiOnContextCreateSnippet: (question, answer) =>
      ctx.callbacksRef.current.createAnswerSnippetFromNode(
        nodeId,
        question,
        answer
      ),
    uiIsCreatingSnippet: ctx.isCreatingSnippet,
  };
}
