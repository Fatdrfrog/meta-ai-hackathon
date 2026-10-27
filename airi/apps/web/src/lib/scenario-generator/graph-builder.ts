import {
  createClientMessageTriggerData,
  createDefaultScenarioWhatsAppServiceMessage,
} from "@icecore/scenario-contracts";
import type {
  ScenarioCanvasNode,
  ScenarioGeneratedAsset,
  ScenarioGeneratorChannel,
  ScenarioGeneratorPresetSeed,
  ScenarioGeneratorSendMode,
  ScenarioGeneratorWorkflowKind,
  ScenarioGraphEdge,
  ScenarioNodeData,
  ScenarioTriggerConfig,
} from "@icecore/scenario-contracts";
import type { ScenarioGeneratedRecipientCohort } from "@icecore/scenario-contracts";
import { normalizeScenarioGraphLayout } from "@/lib/scenarios/graph-layout";
import {
  createDefaultPostActionConditionBranches,
  getPostActionConditionHandleId,
  normalizeConditionBranchConfig,
} from "@icecore/scenario-contracts";
import { buildWhatsAppServiceMessagePatch } from "@/lib/scenarios/whatsapp-service-message";
import {
  findStaticFunnelTemplate,
  type StaticFunnelTemplateDefinition,
} from "./templates/funnel";

type BuildScenarioGeneratorGraphInput = {
  prompt: string;
  workflowKind: ScenarioGeneratorWorkflowKind;
  sendMode: ScenarioGeneratorSendMode;
  channels: ScenarioGeneratorChannel[];
  campaignName: string;
  recipientSourceSummary: string;
  cohorts: Array<
    Pick<ScenarioGeneratedRecipientCohort, "id" | "label" | "count">
  >;
  generatedBranches?: ScenarioGeneratorGraphBranchPlan[];
  assets?: ScenarioGeneratedAsset[];
  presetSeed?: ScenarioGeneratorPresetSeed | null;
};

export type ScenarioGeneratorGraphActionPlan = {
  id?: string;
  label?: string;
  text?: string;
  cta?: {
    type?: "none" | "quick_reply" | "link" | "flow";
    label?: string;
    url?: string;
    flowId?: string;
    flowName?: string;
  };
  media?: {
    assetUrls?: string[];
    assetIds?: string[];
  };
};

export type ScenarioGeneratorGraphBranchPlan = {
  cohortId?: string;
  id?: string;
  label?: string;
  actions?: ScenarioGeneratorGraphActionPlan[];
};

function buildIncomingMessageTriggerData(
  channels: ScenarioGeneratorChannel[],
  config: Partial<ScenarioTriggerConfig> = {}
): ScenarioNodeData {
  return createClientMessageTriggerData({
    triggerConfig: {
      enabled: true,
      messageMatchMode: "any",
      channelFilter: [...channels],
      ...config,
    },
  });
}

const HUMAN_ESCALATION_MESSAGE_PATTERN =
  "\\b(?:human|agent|representative|manager|supervisor|complaint|objection|negative\\s+feedback)\\b";

const LAYER_GAP_X = 420;
const ROW_GAP_Y = 180;
const ORIGIN_X = 80;
const ORIGIN_Y = 120;
const MAX_BRANCHES = 10;

function slugPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function nodeId(parts: string[]): string {
  return ["node", ...parts.map(part => slugPart(part)).filter(Boolean)].join(
    "-"
  );
}

function edgeId(source: string, target: string): string {
  return `edge-${source}-${target}`;
}

function createNode(
  id: string,
  type: ScenarioCanvasNode["type"],
  position: { x: number; y: number },
  data: ScenarioNodeData
): ScenarioCanvasNode {
  return {
    id,
    type,
    position,
    data,
  };
}

function createEdge(source: string, target: string): ScenarioGraphEdge {
  return {
    id: edgeId(source, target),
    source,
    target,
    sourceHandle: "right-source",
    targetHandle: "left-target",
  };
}

function createEdgeFromHandle(
  source: string,
  target: string,
  sourceHandle: string
): ScenarioGraphEdge {
  return {
    id:
      sourceHandle === "right-source"
        ? edgeId(source, target)
        : `edge-${source}-${slugPart(sourceHandle)}-${target}`,
    source,
    target,
    sourceHandle,
    targetHandle: "left-target",
  };
}

function normalizeCohorts(
  cohorts: BuildScenarioGeneratorGraphInput["cohorts"]
): Array<Pick<ScenarioGeneratedRecipientCohort, "id" | "label" | "count">> {
  const normalized = cohorts
    .map((cohort, index) => ({
      id: slugPart(cohort.id) || `branch-${index + 1}`,
      label: cohort.label.trim() || `Audience ${index + 1}`,
      count: Math.max(0, Math.floor(cohort.count || 0)),
    }))
    .slice(0, MAX_BRANCHES);

  return normalized.length > 0
    ? normalized
    : [{ id: "default", label: "Default audience", count: 0 }];
}

function normalizeActionPlans(params: {
  cohort: Pick<ScenarioGeneratedRecipientCohort, "id" | "label" | "count">;
  prompt: string;
  plan?: ScenarioGeneratorGraphBranchPlan;
}): Array<ScenarioGeneratorGraphActionPlan & { id: string; text: string }> {
  const actions = Array.isArray(params.plan?.actions)
    ? params.plan.actions
    : [];
  const normalized = actions
    .map((action, index) => {
      const text = String(action.text || "").trim();
      if (!text) return null;
      return {
        ...action,
        id: slugPart(action.id || action.label || `action-${index + 1}`),
        text,
      };
    })
    .filter(
      (
        action
      ): action is ScenarioGeneratorGraphActionPlan & {
        id: string;
        text: string;
      } => Boolean(action)
    )
    .slice(0, 6);

  return normalized.length > 0
    ? normalized
    : [
        {
          id: "generated-action",
          label: "Generated action",
          text: `Draft for ${params.cohort.label}: ${params.prompt}`,
        },
      ];
}

function findBranchPlan(
  plans: ScenarioGeneratorGraphBranchPlan[] | undefined,
  cohort: Pick<ScenarioGeneratedRecipientCohort, "id" | "label" | "count">
): ScenarioGeneratorGraphBranchPlan | undefined {
  if (!Array.isArray(plans)) return undefined;
  return plans.find(plan => {
    const planId = slugPart(plan.cohortId || plan.id || "");
    return planId === cohort.id || planId === slugPart(cohort.label);
  });
}

function plannedTemplateAction(params: {
  plan?: ScenarioGeneratorGraphBranchPlan;
  index: number;
  fallbackId: string;
  fallbackLabel: string;
  fallbackText: string;
}): ScenarioGeneratorGraphActionPlan & { id: string; text: string } {
  const rawAction = Array.isArray(params.plan?.actions)
    ? params.plan.actions[params.index]
    : undefined;
  const rawText =
    typeof rawAction?.text === "string" ? rawAction.text.trim() : "";
  const rawId = slugPart(
    rawAction?.id || rawAction?.label || params.fallbackId
  );

  return {
    ...rawAction,
    id: rawId || params.fallbackId,
    label: rawAction?.label?.trim() || params.fallbackLabel,
    text: rawText || params.fallbackText,
  };
}

function selectReplyChannel(
  channels: ScenarioGeneratorChannel[]
): ScenarioNodeData["actionReplyChannel"] {
  if (channels.includes("whatsapp")) return "whatsapp";
  if (channels.includes("telegram")) return "telegram";
  if (channels.includes("email")) return "email";
  return "whatsapp";
}

function selectActionAssets(params: {
  action: ScenarioGeneratorGraphActionPlan;
  assets: ScenarioGeneratedAsset[];
}): ScenarioGeneratedAsset[] {
  const media = params.action.media || {};
  const selectedIds = new Set(
    (media.assetIds || [])
      .map(assetId => String(assetId).trim())
      .filter(Boolean)
  );
  const selectedUrls = new Set(
    (media.assetUrls || []).map(url => String(url).trim()).filter(Boolean)
  );
  if (selectedIds.size === 0 && selectedUrls.size === 0) return [];

  return params.assets.filter(
    asset =>
      selectedIds.has(asset.id) ||
      (asset.url ? selectedUrls.has(asset.url) : false)
  );
}

function buildActionNodeData(params: {
  action: ScenarioGeneratorGraphActionPlan & { id: string; text: string };
  branchId: string;
  cohort: Pick<ScenarioGeneratedRecipientCohort, "id" | "label" | "count">;
  isBulk: boolean;
  assets: ScenarioGeneratedAsset[];
}): ScenarioNodeData {
  const selectedAssets = selectActionAssets({
    action: params.action,
    assets: params.assets,
  });
  const selectedAssetUrls = selectedAssets
    .map(asset => asset.url)
    .filter(Boolean);
  const cta = params.action.cta || {};
  const ctaType =
    cta.type === "link" || cta.type === "flow" ? cta.type : "none";
  const ctaLabel =
    cta.type === "none" ? undefined : cta.label?.trim() || undefined;
  const ctaUrl = ctaType === "link" && cta.url ? cta.url.trim() : "";

  return {
    kind: "action",
    actionType: "reply",
    actionReplyMode: "fixed",
    actionReplyText: params.action.text,
    actionReplyCtaType: ctaType,
    actionReplyCtaLabel: ctaLabel,
    actionReplyCtaFlowId:
      ctaType === "flow" ? cta.flowId?.trim() || undefined : undefined,
    actionReplyCtaFlowName:
      ctaType === "flow" ? cta.flowName?.trim() || undefined : undefined,
    actionLinkUrls: ctaUrl ? [ctaUrl] : [],
    actionImageUrls: selectedAssetUrls,
    actionMediaAssets: selectedAssets,
    bulkRecipientBranchId: params.branchId,
    bulkRecipientCount: params.isBulk ? params.cohort.count : undefined,
  } as ScenarioNodeData;
}

function buildTemplateReplyNodeData(params: {
  action: ScenarioGeneratorGraphActionPlan & { id: string; text: string };
  branchId: string;
  cohort: Pick<ScenarioGeneratedRecipientCohort, "id" | "label" | "count">;
  assets: ScenarioGeneratedAsset[];
  channels: ScenarioGeneratorChannel[];
  instruction: string;
}): ScenarioNodeData {
  const actionData: ScenarioNodeData = {
    ...buildActionNodeData({
      action: params.action,
      branchId: params.branchId,
      cohort: params.cohort,
      isBulk: false,
      assets: params.assets,
    }),
    actionReplyChannel: selectReplyChannel(params.channels),
    actionReplyInstruction: params.instruction,
  };
  if (actionData.actionReplyChannel !== "whatsapp") {
    return actionData;
  }

  const serviceMessage = createDefaultScenarioWhatsAppServiceMessage("text");
  if (serviceMessage.message.kind !== "text") {
    throw new Error("Expected the default WhatsApp service message to be text");
  }
  serviceMessage.message.body = { mode: "fixed", text: params.action.text };
  return {
    ...actionData,
    ...buildWhatsAppServiceMessagePatch(serviceMessage),
  };
}

function buildTemplateConditionBranches(
  timeoutMinutes: number
): NonNullable<ScenarioNodeData["conditionBranches"]> {
  return createDefaultPostActionConditionBranches().map(branch =>
    branch.type === "no_reply_timeout"
      ? normalizeConditionBranchConfig("no_reply_timeout", {
          id: branch.id,
          timeoutMinutes,
        })
      : branch
  );
}

function resolveTemplateCopy(params: {
  input: BuildScenarioGeneratorGraphInput;
  template: StaticFunnelTemplateDefinition;
}) {
  const { input, template } = params;
  const fallbackLabel = template.segmentKey
    .split("_")
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

  return {
    title: input.presetSeed?.title?.trim() || fallbackLabel,
    description: input.presetSeed?.description?.trim() || input.prompt.trim(),
    segmentLabel: input.presetSeed?.segmentLabel?.trim() || fallbackLabel,
    segmentKey: template.segmentKey,
  };
}

function buildTemplateCohort(params: {
  input: BuildScenarioGeneratorGraphInput;
  template: StaticFunnelTemplateDefinition;
  segmentLabel: string;
}): Pick<ScenarioGeneratedRecipientCohort, "id" | "label" | "count"> {
  const cohorts = normalizeCohorts(params.input.cohorts);
  const targetId = slugPart(params.template.segmentKey);
  const matchingCohort = cohorts.find(
    cohort =>
      cohort.id === targetId ||
      cohort.id === slugPart(params.segmentLabel) ||
      cohort.id === slugPart(params.input.presetSeed?.id || "")
  );

  return (
    matchingCohort || {
      id: targetId || "template-audience",
      label: params.segmentLabel,
      count: 0,
    }
  );
}

function buildLifecycleTemplateGraph(params: {
  input: BuildScenarioGeneratorGraphInput;
  template: StaticFunnelTemplateDefinition;
}): { nodes: ScenarioCanvasNode[]; edges: ScenarioGraphEdge[] } {
  const { input, template } = params;
  const copy = resolveTemplateCopy({ input, template });
  const cohort = buildTemplateCohort({
    input,
    template,
    segmentLabel: copy.segmentLabel,
  });
  const branchPlan = findBranchPlan(input.generatedBranches, cohort);
  const branchId = cohort.id;
  const instruction = [
    `Run the ${copy.title} workflow for ${copy.segmentLabel}.`,
    copy.description,
    "Use the conversation timeline, customer profile, knowledge base, and connected source context before replying.",
  ]
    .filter(Boolean)
    .join(" ");
  const primaryAction = plannedTemplateAction({
    plan: branchPlan,
    index: 0,
    fallbackId: "primary-reply",
    fallbackLabel: "Primary reply",
    fallbackText: `Hi {{name}}, I am following up with the next best step for ${copy.segmentLabel}.`,
  });
  const replyAction = plannedTemplateAction({
    plan: branchPlan,
    index: 1,
    fallbackId: "continue-after-reply",
    fallbackLabel: "Continue after reply",
    fallbackText: `Thanks for replying. I will use your context to continue the best next step for ${copy.segmentLabel}.`,
  });
  const recoveryAction = plannedTemplateAction({
    plan: branchPlan,
    index: 2,
    fallbackId: "no-reply-follow-up",
    fallbackLabel: "No-reply follow-up",
    fallbackText: `Following up in case this is still relevant. I can still help with ${copy.segmentLabel}.`,
  });

  const segmentId = slugPart(copy.segmentKey) || "template";
  const triggerId = nodeId([segmentId, "trigger"]);
  const audienceId = nodeId([segmentId, "audience"]);
  const contextId = nodeId([segmentId, "context"]);
  const primaryActionId = nodeId([segmentId, primaryAction.id]);
  const conditionId = nodeId([segmentId, "reply-gate"]);
  const replyActionId = nodeId([segmentId, replyAction.id]);
  const recoveryActionId = nodeId([segmentId, recoveryAction.id]);

  const nodes: ScenarioCanvasNode[] = [
    createNode(
      triggerId,
      "triggerNode",
      { x: ORIGIN_X, y: ORIGIN_Y },
      buildIncomingMessageTriggerData(input.channels)
    ),
    createNode(
      audienceId,
      "logicNode",
      { x: ORIGIN_X + LAYER_GAP_X, y: ORIGIN_Y },
      {
        kind: "logic",
        logicType: "audience_filter",
        audienceMode: "funnel_stage",
        audienceFunnelStage: copy.segmentKey,
      } as ScenarioNodeData
    ),
    createNode(
      contextId,
      "scenarioNode",
      { x: ORIGIN_X + LAYER_GAP_X * 2, y: ORIGIN_Y },
      {
        kind: "context",
        contextSources: [
          {
            optionId: "conversation_timeline",
            selectionMode: "all",
            itemIds: [],
          },
          { optionId: "customer_profile", selectionMode: "all", itemIds: [] },
          {
            optionId: "knowledge_base_articles",
            selectionMode: "all",
            itemIds: [],
          },
          { optionId: "answer_snippets", selectionMode: "all", itemIds: [] },
        ],
      } as ScenarioNodeData
    ),
    createNode(
      primaryActionId,
      "actionNode",
      { x: ORIGIN_X + LAYER_GAP_X * 3, y: ORIGIN_Y },
      buildTemplateReplyNodeData({
        action: primaryAction,
        branchId,
        cohort,
        assets: input.assets || [],
        channels: input.channels,
        instruction,
      })
    ),
    createNode(
      conditionId,
      "logicNode",
      { x: ORIGIN_X + LAYER_GAP_X * 4, y: ORIGIN_Y },
      {
        kind: "logic",
        logicType: "post_action_condition",
        conditionBranches: buildTemplateConditionBranches(
          template.noReplyTimeoutMinutes
        ),
      } as ScenarioNodeData
    ),
    createNode(
      replyActionId,
      "actionNode",
      { x: ORIGIN_X + LAYER_GAP_X * 5, y: ORIGIN_Y - ROW_GAP_Y / 2 },
      buildTemplateReplyNodeData({
        action: replyAction,
        branchId,
        cohort,
        assets: input.assets || [],
        channels: input.channels,
        instruction,
      })
    ),
    createNode(
      recoveryActionId,
      "actionNode",
      { x: ORIGIN_X + LAYER_GAP_X * 5, y: ORIGIN_Y + ROW_GAP_Y / 2 },
      buildTemplateReplyNodeData({
        action: recoveryAction,
        branchId,
        cohort,
        assets: input.assets || [],
        channels: input.channels,
        instruction: `${instruction} This is the no-reply recovery path.`,
      })
    ),
  ];

  const edges: ScenarioGraphEdge[] = [
    createEdge(triggerId, audienceId),
    createEdge(audienceId, contextId),
    createEdge(contextId, primaryActionId),
    createEdge(primaryActionId, conditionId),
    createEdgeFromHandle(
      conditionId,
      replyActionId,
      getPostActionConditionHandleId("user_replied")
    ),
    createEdgeFromHandle(
      conditionId,
      recoveryActionId,
      getPostActionConditionHandleId("no_reply_timeout")
    ),
  ];

  return normalizeScenarioGraphLayout({ nodes, edges });
}

function buildHandoffTemplateGraph(params: {
  input: BuildScenarioGeneratorGraphInput;
  template: StaticFunnelTemplateDefinition;
}): { nodes: ScenarioCanvasNode[]; edges: ScenarioGraphEdge[] } {
  const { input, template } = params;
  const copy = resolveTemplateCopy({ input, template });
  const triggerId = nodeId(["human-escalation", "trigger"]);
  const contextId = nodeId(["human-escalation", "context"]);
  const handoffId = nodeId(["human-escalation", "handoff"]);

  const nodes: ScenarioCanvasNode[] = [
    createNode(
      triggerId,
      "triggerNode",
      { x: ORIGIN_X, y: ORIGIN_Y },
      buildIncomingMessageTriggerData(input.channels, {
        messageMatchMode: "contains",
        keywordPattern: HUMAN_ESCALATION_MESSAGE_PATTERN,
        keywordMatchMode: "regex",
      })
    ),
    createNode(
      contextId,
      "scenarioNode",
      { x: ORIGIN_X + LAYER_GAP_X, y: ORIGIN_Y },
      {
        kind: "context",
        contextSources: [
          {
            optionId: "conversation_timeline",
            selectionMode: "all",
            itemIds: [],
          },
          { optionId: "customer_profile", selectionMode: "all", itemIds: [] },
        ],
      } as ScenarioNodeData
    ),
    createNode(
      handoffId,
      "actionNode",
      { x: ORIGIN_X + LAYER_GAP_X * 2, y: ORIGIN_Y },
      {
        kind: "action",
        actionType: "assign_human",
        actionInstruction: [
          `Escalate conversations matching ${copy.title}.`,
          copy.description,
          "Summarize the customer need and keep all connected context available for the teammate.",
        ]
          .filter(Boolean)
          .join(" "),
      } as ScenarioNodeData
    ),
  ];

  return normalizeScenarioGraphLayout({
    nodes,
    edges: [createEdge(triggerId, contextId), createEdge(contextId, handoffId)],
  });
}

function maybeBuildFunnelTemplateGraph(
  input: BuildScenarioGeneratorGraphInput
): { nodes: ScenarioCanvasNode[]; edges: ScenarioGraphEdge[] } | null {
  if (
    input.workflowKind !== "follow_up_workflow" ||
    input.sendMode !== "trigger"
  ) {
    return null;
  }

  const template = findStaticFunnelTemplate({
    id: input.presetSeed?.id,
    segmentKey: input.presetSeed?.segmentKey,
  });
  if (!template) return null;

  return template.kind === "handoff"
    ? buildHandoffTemplateGraph({ input, template })
    : buildLifecycleTemplateGraph({ input, template });
}

function rootNodeForInput(
  input: BuildScenarioGeneratorGraphInput
): ScenarioCanvasNode {
  if (
    input.workflowKind === "bulk_campaign" &&
    input.sendMode === "immediate"
  ) {
    return createNode(
      "node-bulk-root",
      "bulkNode",
      { x: ORIGIN_X, y: ORIGIN_Y },
      {
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: input.channels,
          campaignName: input.campaignName,
          recipientSourceSummary: input.recipientSourceSummary,
          generationStatus: "queued",
          cohorts: normalizeCohorts(input.cohorts).map(cohort => ({
            ...cohort,
            branchId: cohort.id,
          })),
        },
      } as ScenarioNodeData
    );
  }

  return createNode(
    "node-trigger-root",
    "triggerNode",
    { x: ORIGIN_X, y: ORIGIN_Y },
    buildIncomingMessageTriggerData(input.channels)
  );
}

function buildBranchNodes(params: {
  prompt: string;
  rootId: string;
  cohort: Pick<ScenarioGeneratedRecipientCohort, "id" | "label" | "count">;
  index: number;
  isBulk: boolean;
  plan?: ScenarioGeneratorGraphBranchPlan;
  assets: ScenarioGeneratedAsset[];
}): { nodes: ScenarioCanvasNode[]; edges: ScenarioGraphEdge[] } {
  const { cohort, index, rootId, prompt, isBulk } = params;
  const y = ORIGIN_Y + index * ROW_GAP_Y;
  const branchId = cohort.id;
  const actions = normalizeActionPlans({
    cohort,
    prompt,
    plan: params.plan,
  });

  const actionNodes: ScenarioCanvasNode[] = [];
  const nodes: ScenarioCanvasNode[] = [];
  const edges: ScenarioGraphEdge[] = [];
  let previousNodeId = rootId;
  let layer = 1;

  actions.forEach((action, actionIndex) => {
    if (isBulk && actionIndex > 0) {
      const conditionId = nodeId([
        branchId,
        actions[actionIndex - 1]?.id || "previous",
        "follow-up-gate",
      ]);
      nodes.push(
        createNode(
          conditionId,
          "logicNode",
          { x: ORIGIN_X + LAYER_GAP_X * layer, y },
          {
            kind: "logic",
            logicType: "post_action_condition",
            conditionBranches: buildTemplateConditionBranches(1440),
          } as ScenarioNodeData
        )
      );
      edges.push(createEdge(previousNodeId, conditionId));
      previousNodeId = conditionId;
      layer += 1;
    }

    const actionNode = createNode(
      nodeId([branchId, action.id]),
      "actionNode",
      { x: ORIGIN_X + LAYER_GAP_X * layer, y },
      buildActionNodeData({
        action,
        branchId,
        cohort,
        isBulk,
        assets: params.assets,
      })
    );
    nodes.push(actionNode);
    actionNodes.push(actionNode);
    edges.push(
      isBulk && actionIndex > 0
        ? createEdgeFromHandle(
            previousNodeId,
            actionNode.id,
            getPostActionConditionHandleId("no_reply_timeout")
          )
        : createEdge(previousNodeId, actionNode.id)
    );
    previousNodeId = actionNode.id;
    layer += 1;
  });
  const firstActionNode = actionNodes[0];
  if (!firstActionNode) {
    return { nodes: [], edges: [] };
  }

  return {
    nodes,
    edges,
  };
}

export function buildScenarioGeneratorGraph(
  input: BuildScenarioGeneratorGraphInput
): { nodes: ScenarioCanvasNode[]; edges: ScenarioGraphEdge[] } {
  const templateGraph = maybeBuildFunnelTemplateGraph(input);
  if (templateGraph) return templateGraph;

  const root = rootNodeForInput(input);
  const isBulk = root.data.kind === "bulk";
  const cohorts = normalizeCohorts(input.cohorts);
  const branches = cohorts.map((cohort, index) =>
    buildBranchNodes({
      prompt: input.prompt,
      rootId: root.id,
      cohort,
      index,
      isBulk,
      plan: findBranchPlan(input.generatedBranches, cohort),
      assets: input.assets || [],
    })
  );

  return normalizeScenarioGraphLayout({
    nodes: [root, ...branches.flatMap(branch => branch.nodes)],
    edges: branches.flatMap(branch => branch.edges),
  });
}
