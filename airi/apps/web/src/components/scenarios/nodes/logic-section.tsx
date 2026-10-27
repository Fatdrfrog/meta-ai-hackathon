"use client";

import type {
  ScenarioPostActionConditionType,
  TranslateFn,
} from "@/components/scenarios/types";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createDefaultPostActionConditionBranches,
  getNoReplyAnswerMatchRules,
  getPostActionAnswerMatchHandleId,
  getPostActionConditionHandleId,
  getPostActionConditionBranch,
  getScenarioLogicType,
  getVisiblePostActionConditionTypes,
  isInteractiveNoReplyConditionNodeData,
  isPostActionConditionNodeData,
} from "@icecore/scenario-contracts";
import { useMemo } from "react";
import type { ScenarioNodeData } from "../types";
import type { ScenarioLogicEditorNodeData } from "../view/node-enrichment/types";
import {
  AnswerMatchRulesEditor,
  MissingTextPhrasesEditor,
} from "./action-routing-controls";
import { ScenarioCustomerMultiSelect } from "./customer-multi-select";
import { ScenarioIntegerInput } from "./integer-input";
import { SCENARIO_HANDLE_RULES } from "../graph/config";
import { ScenarioRouteRow, bindSourceHandleCreate } from "../scenario-route";
import { RecipientColumnSplitEditor } from "./recipient-column-split-editor";
import { ScenarioSingleOptionSelect } from "./single-option-select";
import {
  resolveSafeScenarioOptionValue,
  resolveScenarioSingleSelectValue,
} from "./utils";

type ScenarioNodeLogicSectionProps = {
  nodeData: ScenarioLogicEditorNodeData;
  t: TranslateFn;
  patchNode: (patch: Partial<ScenarioNodeData>) => void;
  reuseCanvasSourceHandles?: boolean;
};

function PostActionBranchCard({
  branchType,
  nodeData,
  t,
  reuseCanvasSourceHandles,
}: {
  branchType: ScenarioPostActionConditionType;
  nodeData: ScenarioLogicEditorNodeData;
  t: TranslateFn;
  reuseCanvasSourceHandles: boolean;
}) {
  const postActionConditionBranches = isPostActionConditionNodeData(nodeData)
    ? nodeData.uiConditionBranches && nodeData.uiConditionBranches.length > 0
      ? nodeData.uiConditionBranches
      : createDefaultPostActionConditionBranches()
    : [];
  const connectedHandleIds = nodeData.uiConnectedHandleIds ?? new Set<string>();
  const branch = getPostActionConditionBranch(
    { conditionBranches: postActionConditionBranches },
    branchType
  );
  const isNoReplyBranch = branchType === "no_reply_timeout";
  const supportsMissingText =
    isNoReplyBranch && !isInteractiveNoReplyConditionNodeData(nodeData);
  const title = isNoReplyBranch
    ? t("postActionConditionNoReply")
    : t("postActionConditionUserReplied");

  return (
    <div className="relative overflow-visible rounded-md border bg-muted/20 p-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <ScenarioRouteRow
            handleId={getPostActionConditionHandleId(branchType)}
            sourceLabel={title}
            connected={connectedHandleIds.has(
              getPostActionConditionHandleId(branchType)
            )}
            externalAnchor={reuseCanvasSourceHandles}
            onCreateNode={bindSourceHandleCreate(
              nodeData.uiOnCreateNodeFromSourceHandle,
              getPostActionConditionHandleId(branchType)
            )}
          />
        </div>
        {branch.linkedConditionId ? (
          <Badge variant="outline" className="mt-2 text-[9px] uppercase">
            {t("linkedConditionBadge")}
          </Badge>
        ) : null}
      </div>
      {isNoReplyBranch ? (
        <div className="mt-2 space-y-2">
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              {t("triggerTimeoutMinutes")}
            </label>
            <ScenarioIntegerInput
              min={1}
              value={branch.timeoutMinutes ?? 30}
              defaultValue={30}
              onValueCommit={value =>
                nodeData.uiOnConditionBranchChange?.(branchType, {
                  timeoutMinutes: value,
                })
              }
              className="nodrag h-8"
              onPointerDown={e => e.stopPropagation()}
            />
          </div>
          {supportsMissingText ? (
            <MissingTextPhrasesEditor
              phrases={branch.missingTextPhrases}
              t={t}
              onCommit={phrases =>
                nodeData.uiOnConditionBranchChange?.(branchType, {
                  missingTextPhrases: phrases,
                })
              }
            />
          ) : null}
          <AnswerMatchRulesEditor
            rules={getNoReplyAnswerMatchRules({
              conditionBranches: [branch],
            })}
            t={t}
            connectedHandleIds={connectedHandleIds}
            getHandleId={getPostActionAnswerMatchHandleId}
            onCreateNodeFromSourceHandle={
              nodeData.uiOnCreateNodeFromSourceHandle
            }
            onRulesChange={answerMatchRules =>
              nodeData.uiOnConditionBranchChange?.(branchType, {
                answerMatchRules,
              })
            }
          />
        </div>
      ) : null}
    </div>
  );
}

function PostActionConditionSection({
  nodeData,
  t,
  reuseCanvasSourceHandles,
}: {
  nodeData: ScenarioLogicEditorNodeData;
  t: TranslateFn;
  reuseCanvasSourceHandles: boolean;
}) {
  const visiblePostActionBranchTypes = useMemo(
    () => getVisiblePostActionConditionTypes(nodeData),
    [nodeData]
  );
  return (
    <div className="space-y-2">
      {visiblePostActionBranchTypes.map(branchType => (
        <PostActionBranchCard
          key={branchType}
          branchType={branchType}
          nodeData={nodeData}
          t={t}
          reuseCanvasSourceHandles={reuseCanvasSourceHandles}
        />
      ))}
    </div>
  );
}

function AudienceFilterSection({
  nodeData,
  t,
  patchNode,
  reuseCanvasSourceHandles,
}: ScenarioNodeLogicSectionProps) {
  const audienceOptions = nodeData.uiAudienceOptions;
  const selectedCustomerIds = nodeData.customerIds || [];
  const connectedHandleIds = nodeData.uiConnectedHandleIds ?? new Set<string>();
  const continueHandleId = SCENARIO_HANDLE_RULES.logic.outputHandleId;
  const safeClassificationValue = useMemo(
    () =>
      resolveSafeScenarioOptionValue(
        nodeData.classificationCategory,
        audienceOptions?.classificationCategories || []
      ),
    [audienceOptions?.classificationCategories, nodeData.classificationCategory]
  );
  const safeInternalLabelValue = useMemo(
    () =>
      resolveSafeScenarioOptionValue(
        nodeData.internalLabel,
        audienceOptions?.internalLabels || []
      ),
    [audienceOptions?.internalLabels, nodeData.internalLabel]
  );
  const safeFunnelStageValue = useMemo(
    () =>
      resolveSafeScenarioOptionValue(
        nodeData.audienceFunnelStage,
        audienceOptions?.funnelStages || []
      ),
    [audienceOptions?.funnelStages, nodeData.audienceFunnelStage]
  );

  return (
    <div className="space-y-1.5">
      <Select
        value={nodeData.audienceMode || "all"}
        onValueChange={value =>
          patchNode({
            audienceMode: value as NonNullable<
              ScenarioNodeData["audienceMode"]
            >,
            classificationCategory: undefined,
            internalLabel: undefined,
            audienceFunnelStage: undefined,
            audienceLastSeenDays: undefined,
            customerIds:
              value === "specificCustomers"
                ? nodeData.customerIds || []
                : undefined,
          })
        }
      >
        <SelectTrigger className="nodrag h-8">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("allCustomers")}</SelectItem>
          <SelectItem value="classification">
            {t("byClassification")}
          </SelectItem>
          <SelectItem value="internalLabel">{t("byInternalLabel")}</SelectItem>
          <SelectItem value="specificCustomers">
            {t("specificCustomers")}
          </SelectItem>
          <SelectItem value="has_purchase_history">
            {t("hasPurchaseHistory")}
          </SelectItem>
          <SelectItem value="funnel_stage">{t("byFunnelStage")}</SelectItem>
          <SelectItem value="last_seen_greater_than_x_days">
            {t("lastSeenGreaterThanXDays")}
          </SelectItem>
        </SelectContent>
      </Select>
      <div className="space-y-1.5 rounded-md border bg-muted/20 p-2">
        {nodeData.audienceMode === "classification" ? (
          <ScenarioSingleOptionSelect
            label={t("classification")}
            value={safeClassificationValue}
            placeholder={t("chooseClassification")}
            emptyLabel={t("anyClassification")}
            options={audienceOptions?.classificationCategories || []}
            onValueChange={value =>
              patchNode({
                classificationCategory: resolveScenarioSingleSelectValue(value),
              })
            }
          />
        ) : null}

        {nodeData.audienceMode === "internalLabel" ? (
          <ScenarioSingleOptionSelect
            label={t("internalLabel")}
            value={safeInternalLabelValue}
            placeholder={t("chooseInternalLabel")}
            emptyLabel={t("anyInternalLabel")}
            options={audienceOptions?.internalLabels || []}
            onValueChange={value =>
              patchNode({
                internalLabel: resolveScenarioSingleSelectValue(value),
              })
            }
          />
        ) : null}

        {nodeData.audienceMode === "specificCustomers" ? (
          <ScenarioCustomerMultiSelect
            customers={audienceOptions?.customers || []}
            selectedCustomerIds={selectedCustomerIds}
            t={t}
            onToggle={customerId => {
              const currentIds = nodeData.customerIds || [];
              const nextIds = currentIds.includes(customerId)
                ? currentIds.filter(id => id !== customerId)
                : [...currentIds, customerId];
              patchNode({
                audienceMode: "specificCustomers",
                customerIds: nextIds,
              });
            }}
          />
        ) : null}

        {nodeData.audienceMode === "funnel_stage" ? (
          <ScenarioSingleOptionSelect
            label={t("triggerFunnelStage")}
            value={safeFunnelStageValue}
            placeholder={t("chooseFunnelStage")}
            emptyLabel={t("anyFunnelStage")}
            options={audienceOptions?.funnelStages || []}
            onValueChange={value =>
              patchNode({
                audienceFunnelStage: resolveScenarioSingleSelectValue(value),
              })
            }
          />
        ) : null}

        {nodeData.audienceMode === "last_seen_greater_than_x_days" ||
        nodeData.audienceMode === "last_seen_days" ? (
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              {t("minimumInactiveDays")}
            </label>
            <Input
              type="number"
              min={1}
              value={String(nodeData.audienceLastSeenDays ?? 30)}
              onChange={event =>
                patchNode({
                  audienceLastSeenDays: Number.parseInt(event.target.value, 10),
                })
              }
              className="nodrag h-8"
              onPointerDown={e => e.stopPropagation()}
            />
          </div>
        ) : null}
      </div>
      {continueHandleId ? (
        <ScenarioRouteRow
          handleId={continueHandleId}
          sourceLabel={t("routeChooseNextStep")}
          connected={connectedHandleIds.has(continueHandleId)}
          externalAnchor={reuseCanvasSourceHandles ?? false}
          onCreateNode={bindSourceHandleCreate(
            nodeData.uiOnCreateNodeFromSourceHandle,
            continueHandleId
          )}
        />
      ) : null}
    </div>
  );
}

export function ScenarioNodeLogicSection({
  nodeData,
  t,
  patchNode,
  reuseCanvasSourceHandles = false,
}: ScenarioNodeLogicSectionProps) {
  const logicType = getScenarioLogicType(nodeData);
  switch (logicType) {
    case "post_action_condition":
      return (
        <PostActionConditionSection
          nodeData={nodeData}
          t={t}
          reuseCanvasSourceHandles={reuseCanvasSourceHandles}
        />
      );
    case "recipient_column_split":
      return (
        <RecipientColumnSplitEditor
          nodeData={nodeData}
          t={t}
          patchNode={patchNode}
        />
      );
    case "audience_filter":
      return (
        <AudienceFilterSection
          nodeData={nodeData}
          t={t}
          patchNode={patchNode}
          reuseCanvasSourceHandles={reuseCanvasSourceHandles}
        />
      );
    default: {
      const exhaustive: never = logicType;
      return exhaustive;
    }
  }
}
