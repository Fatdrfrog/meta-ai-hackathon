import type { ScenarioNodeEnrichmentContextValue } from "../scenario-node-enrichment-context";
import {
  selectCommonEnrichmentView,
  selectOwnNodeId,
  type ScenarioCommonEnrichmentView,
  type ScenarioSourceHandleEnrichmentView,
} from "./common";
import { sliceIndexMap, sliceIndexSet } from "./enrichment-view";
import type { ScenarioNodeGraphIndex } from "./scenario-node-graph-index";

type ActionGraphIndexView = Pick<
  ScenarioNodeGraphIndex,
  | "previewProfileByActionId"
  | "scenarioPromptInputsByNodeId"
  | "scenarioPromptInputs"
  | "scenarioFormAnswerSourcesByNodeId"
  | "scenarioPickedOptionSourcesByNodeId"
  | "scenarioFormKeysByNodeId"
  | "scenarioFormKeyStampsByFormKey"
  | "scenarioFormAnswerTokensByFormKey"
  | "connectedTelegramBranchPayloadsByActionId"
  | "connectedSourceHandleIdsByNodeId"
  | "connectedInstagramBranchPayloadsByActionId"
  | "connectedWhatsAppSessionChoicePayloadsByActionId"
  | "connectedFlowBranchIdsByActionId"
  | "connectedWhatsAppTemplateButtonPayloadsByActionId"
  | "destinationsBySourceHandleByNodeId"
  | "instagramReplyActionIdsBlockedByBulkRoot"
  | "bulkPrimaryActionIds"
  | "bulkPrimaryWhatsAppTemplateIds"
  | "bulkRouteRecipientsByActionId"
  | "incomingRouteCountByNodeId"
  | "reachedAfterLongNoReplyNodeIds"
  | "actionNodeCount"
>;

/** What an action step reads from the enrichment context. */
export type ScenarioActionEnrichmentView = ScenarioCommonEnrichmentView &
  ScenarioSourceHandleEnrichmentView &
  Pick<
    ScenarioNodeEnrichmentContextValue,
    | "t"
    | "workspaceId"
    | "activeScenarioId"
    | "audienceOptions"
    | "connectedActionSources"
    | "sourceCapabilities"
    | "whatsAppTemplates"
    | "whatsAppFlows"
    | "selectedNodeId"
    | "handleBranchSyncForNodeRef"
    | "selectExistingFlowForNodeRef"
    | "managedWhatsAppFlowProvisioningSources"
    | "scenarioSessionOwnerKey"
    | "publishingManagedFlowNodeId"
    | "publishManagedWhatsAppFlow"
    | "submittingGeneratedTemplateNodeId"
    | "submitGeneratedTemplateForNode"
    | "loadWhatsAppTemplateForm"
    | "loadingTemplateFormNodeIds"
    | "openingLinkedWhatsAppFlowId"
    | "openingLinkedWhatsAppFlowNodeId"
    | "legacyRoutingByActionId"
  > & {
    graphIndex: ActionGraphIndexView;
    /**
     * Whether the canvas converts legacy routing. The full context leaves it
     * out and the step reads the callback itself.
     */
    legacyRoutingConversionAvailable?: boolean;
  };

function selectActionGraphIndexView(
  nodeId: string,
  index: ScenarioNodeGraphIndex
): ActionGraphIndexView {
  return {
    previewProfileByActionId: sliceIndexMap(
      index.previewProfileByActionId,
      nodeId
    ),
    scenarioPromptInputsByNodeId: sliceIndexMap(
      index.scenarioPromptInputsByNodeId,
      nodeId
    ),
    scenarioPromptInputs: index.scenarioPromptInputs,
    scenarioFormAnswerSourcesByNodeId: sliceIndexMap(
      index.scenarioFormAnswerSourcesByNodeId,
      nodeId
    ),
    scenarioPickedOptionSourcesByNodeId: sliceIndexMap(
      index.scenarioPickedOptionSourcesByNodeId,
      nodeId
    ),
    scenarioFormKeysByNodeId: index.scenarioFormKeysByNodeId,
    scenarioFormKeyStampsByFormKey: index.scenarioFormKeyStampsByFormKey,
    // The tokens of the step's own form only, which its form notice reads.
    scenarioFormAnswerTokensByFormKey: sliceIndexMap(
      index.scenarioFormAnswerTokensByFormKey,
      index.scenarioFormKeysByNodeId?.get(nodeId)
    ),
    connectedTelegramBranchPayloadsByActionId: sliceIndexMap(
      index.connectedTelegramBranchPayloadsByActionId,
      nodeId
    ),
    connectedSourceHandleIdsByNodeId: sliceIndexMap(
      index.connectedSourceHandleIdsByNodeId,
      nodeId
    ),
    connectedInstagramBranchPayloadsByActionId: sliceIndexMap(
      index.connectedInstagramBranchPayloadsByActionId,
      nodeId
    ),
    connectedWhatsAppSessionChoicePayloadsByActionId: sliceIndexMap(
      index.connectedWhatsAppSessionChoicePayloadsByActionId,
      nodeId
    ),
    connectedFlowBranchIdsByActionId: sliceIndexMap(
      index.connectedFlowBranchIdsByActionId,
      nodeId
    ),
    connectedWhatsAppTemplateButtonPayloadsByActionId: sliceIndexMap(
      index.connectedWhatsAppTemplateButtonPayloadsByActionId,
      nodeId
    ),
    destinationsBySourceHandleByNodeId: sliceIndexMap(
      index.destinationsBySourceHandleByNodeId,
      nodeId
    ),
    instagramReplyActionIdsBlockedByBulkRoot: sliceIndexSet(
      index.instagramReplyActionIdsBlockedByBulkRoot,
      nodeId
    ),
    bulkPrimaryActionIds: sliceIndexSet(index.bulkPrimaryActionIds, nodeId),
    bulkPrimaryWhatsAppTemplateIds: sliceIndexSet(
      index.bulkPrimaryWhatsAppTemplateIds,
      nodeId
    ),
    bulkRouteRecipientsByActionId: sliceIndexMap(
      index.bulkRouteRecipientsByActionId,
      nodeId
    ),
    incomingRouteCountByNodeId: sliceIndexMap(
      index.incomingRouteCountByNodeId,
      nodeId
    ),
    reachedAfterLongNoReplyNodeIds: sliceIndexSet(
      index.reachedAfterLongNoReplyNodeIds,
      nodeId
    ),
    actionNodeCount: index.actionNodeCount,
  };
}

/**
 * The action step's view: other steps' selection, submit, publish, form
 * load and preview states read as "not this step", as the step compares them.
 */
export function selectActionEnrichmentView(
  nodeId: string,
  ctx: ScenarioNodeEnrichmentContextValue
): ScenarioActionEnrichmentView {
  const openingThisNode = ctx.openingLinkedWhatsAppFlowNodeId === nodeId;
  return {
    ...selectCommonEnrichmentView(ctx),
    openNodePickerFromHandle: ctx.openNodePickerFromHandle,
    t: ctx.t,
    workspaceId: ctx.workspaceId,
    activeScenarioId: ctx.activeScenarioId,
    audienceOptions: ctx.audienceOptions,
    connectedActionSources: ctx.connectedActionSources,
    sourceCapabilities: ctx.sourceCapabilities,
    whatsAppTemplates: ctx.whatsAppTemplates,
    whatsAppFlows: ctx.whatsAppFlows,
    selectedNodeId: selectOwnNodeId(ctx.selectedNodeId, nodeId),
    handleBranchSyncForNodeRef: ctx.handleBranchSyncForNodeRef,
    selectExistingFlowForNodeRef: ctx.selectExistingFlowForNodeRef,
    managedWhatsAppFlowProvisioningSources:
      ctx.managedWhatsAppFlowProvisioningSources,
    scenarioSessionOwnerKey: ctx.scenarioSessionOwnerKey,
    publishingManagedFlowNodeId: selectOwnNodeId(
      ctx.publishingManagedFlowNodeId,
      nodeId
    ),
    publishManagedWhatsAppFlow: ctx.publishManagedWhatsAppFlow,
    submittingGeneratedTemplateNodeId: selectOwnNodeId(
      ctx.submittingGeneratedTemplateNodeId,
      nodeId
    ),
    submitGeneratedTemplateForNode: ctx.submitGeneratedTemplateForNode,
    loadWhatsAppTemplateForm: ctx.loadWhatsAppTemplateForm,
    loadingTemplateFormNodeIds: sliceIndexSet(
      ctx.loadingTemplateFormNodeIds,
      nodeId
    ),
    openingLinkedWhatsAppFlowNodeId: openingThisNode ? nodeId : null,
    openingLinkedWhatsAppFlowId: openingThisNode
      ? ctx.openingLinkedWhatsAppFlowId
      : null,
    legacyRoutingByActionId: sliceIndexMap(ctx.legacyRoutingByActionId, nodeId),
    legacyRoutingConversionAvailable: Boolean(
      ctx.callbacksRef.current.convertLegacyActionRouting
    ),
    graphIndex: selectActionGraphIndexView(nodeId, ctx.graphIndex),
  };
}
