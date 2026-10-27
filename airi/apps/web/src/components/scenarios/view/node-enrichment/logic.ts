import type {
  ScenarioConditionBranchConfig,
  ScenarioPostActionConditionType,
} from "../../types";
import { buildBulkColumnSplitPreview } from "@/lib/scenarios/bulk-column-split-routing";
import {
  createDefaultPostActionConditionBranches,
  getScenarioLogicType,
  isPostActionConditionNodeData,
  normalizePostActionConditionBranches,
  updatePostActionConditionBranches,
} from "@icecore/scenario-contracts";
import {
  collectRecipientColumnNames,
  collectRecipientColumnValueSuggestions,
} from "@/lib/scenarios/recipient-column-split";
import type { ScenarioNodeEnrichmentContextValue } from "../scenario-node-enrichment-context";
import {
  buildCommonNodeEnrichment,
  buildSourceHandleEnrichment,
  selectCommonEnrichmentView,
  type ScenarioCommonEnrichmentView,
  type ScenarioSourceHandleEnrichmentView,
} from "./common";
import { sliceIndexMap } from "./enrichment-view";
import type { ScenarioNodeGraphIndex } from "./scenario-node-graph-index";
import type {
  ScenarioLogicEditorNodeData,
  ScenarioLogicNodeEnrichment,
  ScenarioPersistedNodeDataOfKind,
} from "./types";

export type ScenarioLogicEnrichmentView = ScenarioCommonEnrichmentView &
  ScenarioSourceHandleEnrichmentView &
  Pick<ScenarioNodeEnrichmentContextValue, "t" | "audienceOptions"> & {
    graphIndex: Pick<
      ScenarioNodeGraphIndex,
      | "bulkRootByColumnSplitNodeId"
      | "bulkColumnSplitRoutingByRootId"
      | "connectedColumnSplitHandlesBySplitNodeId"
      | "postActionConditionScopeByNodeId"
      | "destinationsBySourceHandleByNodeId"
      | "connectedSourceHandleIdsByNodeId"
    >;
  };

export function selectLogicEnrichmentView(
  nodeId: string,
  ctx: ScenarioNodeEnrichmentContextValue
): ScenarioLogicEnrichmentView {
  const index = ctx.graphIndex;
  const bulkRoot = index.bulkRootByColumnSplitNodeId.get(nodeId);
  return {
    ...selectCommonEnrichmentView(ctx),
    openNodePickerFromHandle: ctx.openNodePickerFromHandle,
    t: ctx.t,
    audienceOptions: ctx.audienceOptions,
    graphIndex: {
      bulkRootByColumnSplitNodeId: sliceIndexMap(
        index.bulkRootByColumnSplitNodeId,
        nodeId
      ),
      bulkColumnSplitRoutingByRootId: sliceIndexMap(
        index.bulkColumnSplitRoutingByRootId,
        bulkRoot?.bulkRootId
      ),
      connectedColumnSplitHandlesBySplitNodeId: sliceIndexMap(
        index.connectedColumnSplitHandlesBySplitNodeId,
        nodeId
      ),
      postActionConditionScopeByNodeId: sliceIndexMap(
        index.postActionConditionScopeByNodeId,
        nodeId
      ),
      destinationsBySourceHandleByNodeId: sliceIndexMap(
        index.destinationsBySourceHandleByNodeId,
        nodeId
      ),
      connectedSourceHandleIdsByNodeId: sliceIndexMap(
        index.connectedSourceHandleIdsByNodeId,
        nodeId
      ),
    },
  };
}

function enrichRecipientColumnSplitNodeUi(
  nodeId: string,
  ctx: ScenarioLogicEnrichmentView
): Partial<ScenarioLogicNodeEnrichment> {
  const bulkRoot = ctx.graphIndex.bulkRootByColumnSplitNodeId.get(nodeId);
  const uploadedRecipients = bulkRoot?.uploadedRecipients ?? [];
  const columnOptions = collectRecipientColumnNames(uploadedRecipients);
  const valueSuggestions = Object.fromEntries(
    columnOptions.map(column => [
      column,
      collectRecipientColumnValueSuggestions({
        recipients: uploadedRecipients,
        column,
      }),
    ])
  );
  const birthdayAudience = bulkRoot?.birthdayAudience ?? false;
  const columnSplitRouting = bulkRoot
    ? ctx.graphIndex.bulkColumnSplitRoutingByRootId.get(bulkRoot.bulkRootId)
    : undefined;
  const uiBulkColumnSplitPreview =
    columnSplitRouting && !birthdayAudience
      ? buildBulkColumnSplitPreview({
          recipients: uploadedRecipients,
          routing: columnSplitRouting,
        })
      : null;

  return {
    uiRecipientColumnOptions: columnOptions,
    uiRecipientColumnValueSuggestions: valueSuggestions,
    uiRecipientColumnSplitDisabledReason: birthdayAudience
      ? ctx.t("columnSplitBirthdayDisabled")
      : columnOptions.length === 0
        ? ctx.t("columnSplitUploadRecipientsFirst")
        : null,
    uiConnectedColumnSplitHandleIds:
      ctx.graphIndex.connectedColumnSplitHandlesBySplitNodeId.get(nodeId),
    uiBulkColumnSplitPreview,
  };
}

export function enrichLogicNodeData(
  nodeId: string,
  rawData: ScenarioPersistedNodeDataOfKind<"logic">,
  ctx: ScenarioLogicEnrichmentView
): ScenarioLogicEditorNodeData {
  const normalizedLogicType = getScenarioLogicType(rawData);
  const normalizedConditionBranches:
    | ScenarioConditionBranchConfig[]
    | undefined = isPostActionConditionNodeData(rawData)
    ? normalizePostActionConditionBranches(rawData.conditionBranches)
    : undefined;
  const postActionConditionScopeMeta =
    normalizedLogicType === "post_action_condition"
      ? ctx.graphIndex.postActionConditionScopeByNodeId.get(nodeId)
      : undefined;

  return {
    ...rawData,
    ...buildCommonNodeEnrichment(nodeId, ctx),
    ...buildSourceHandleEnrichment(nodeId, ctx),
    uiDestinationsBySourceHandle:
      ctx.graphIndex.destinationsBySourceHandleByNodeId.get(nodeId),
    uiConnectedHandleIds: new Set(
      ctx.graphIndex.connectedSourceHandleIdsByNodeId.get(nodeId) ?? []
    ),
    logicType: normalizedLogicType,
    conditionBranches:
      normalizedConditionBranches ??
      (normalizedLogicType === "post_action_condition"
        ? createDefaultPostActionConditionBranches()
        : undefined),
    uiAudienceOptions: ctx.audienceOptions,
    uiConditionBranches: normalizedConditionBranches,
    uiOnConditionBranchChange: isPostActionConditionNodeData(rawData)
      ? (
          branchType: ScenarioPostActionConditionType,
          patch: Partial<ScenarioConditionBranchConfig>
        ) =>
          ctx.callbacksRef.current.updateNodeById(nodeId, {
            logicType: "post_action_condition",
            conditionBranches: updatePostActionConditionBranches({
              nodeData: rawData,
              branchType,
              patch,
            }),
          })
      : undefined,
    uiPostActionConditionScope:
      normalizedLogicType === "post_action_condition"
        ? postActionConditionScopeMeta?.scope
        : undefined,
    uiPostActionConditionScopeLabel:
      normalizedLogicType === "post_action_condition"
        ? postActionConditionScopeMeta?.branchLabel
        : undefined,
    ...(normalizedLogicType === "recipient_column_split"
      ? enrichRecipientColumnSplitNodeUi(nodeId, ctx)
      : {}),
  };
}
