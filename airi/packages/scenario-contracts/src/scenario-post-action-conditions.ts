import type {
  ScenarioAnswerMatchMode,
  ScenarioAnswerMatchRule,
  ScenarioConditionBranchConfig,
  ScenarioInteractiveNoReplySurface,
  ScenarioLogicType,
  ScenarioPostActionConditionType,
  ScenarioPostActionConditionVariant,
} from "./scenario-triggers";
import type { ScenarioNodeData } from "./scenario-node-data";
import {
  getScenarioActionOutcomeVirtualNodeId,
  normalizeScenarioActionOutcomes,
} from "./scenario-action-routing";
import {
  ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
  parseScenarioActionOutcomeHandleId,
  buildPostActionAnswerMatchHandleId,
  buildPostActionConditionHandleId,
  parsePostActionConditionHandleId,
} from "./scenario-branch-handles";

export const DEFAULT_POST_ACTION_CONDITION_TIMEOUT_MINUTES = 30;

/** The no-reply clock restarts after conversation activity during the wait. */
export function resolvePostActionQuietPeriodDueAt(params: {
  waitStartedAt: Date;
  latestActivityAt?: Date | null;
  timeoutMinutes: number;
}): Date {
  const anchor =
    params.latestActivityAt && params.latestActivityAt > params.waitStartedAt
      ? params.latestActivityAt
      : params.waitStartedAt;
  return new Date(anchor.getTime() + params.timeoutMinutes * 60_000);
}

const MAX_MISSING_TEXT_PHRASES = 20;
const MAX_MISSING_TEXT_PHRASE_LENGTH = 160;
const MAX_ANSWER_MATCH_RULES = 20;
const MAX_ANSWER_MATCH_TEXT_LENGTH = 240;

export const POST_ACTION_CONDITION_TYPES = [
  "user_replied",
  "no_reply_timeout",
] as const satisfies readonly ScenarioPostActionConditionType[];

/**
 * Source handle on interactive actions (WhatsApp Flow with branches, Telegram
 * inline keyboards) for the optional global no-reply timeout path. Kept in lib
 * so runtime graph code can resolve this edge without importing UI modules.
 */
export const SCENARIO_INTERACTIVE_NO_REPLY_SOURCE_HANDLE_ID =
  ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID;

export function getScenarioLogicType(
  nodeData: Partial<ScenarioNodeData> | null | undefined,
): ScenarioLogicType {
  const logicType = nodeData?.logicType;
  switch (logicType) {
    case "post_action_condition":
      return "post_action_condition";
    case "recipient_column_split":
      return "recipient_column_split";
    case "audience_filter":
    case undefined:
      return "audience_filter";
    default: {
      const exhaustive: never = logicType;
      void exhaustive;
      return "audience_filter";
    }
  }
}

export function isPostActionConditionNodeData(
  nodeData: Partial<ScenarioNodeData> | null | undefined,
): boolean {
  return (
    nodeData?.kind === "logic" &&
    getScenarioLogicType(nodeData) === "post_action_condition"
  );
}

export function getPostActionConditionVariant(
  nodeData: Partial<ScenarioNodeData> | null | undefined,
): ScenarioPostActionConditionVariant | null {
  const variant = nodeData?.postActionConditionVariant;
  switch (variant) {
    case "interactive_no_reply":
      return "interactive_no_reply";
    case undefined:
      return null;
    default: {
      const exhaustive: never = variant;
      void exhaustive;
      return null;
    }
  }
}

export function getInteractiveNoReplySurface(
  nodeData: Partial<ScenarioNodeData> | null | undefined,
): ScenarioInteractiveNoReplySurface | null {
  const surface = nodeData?.interactiveNoReplySurface;
  switch (surface) {
    case "telegram_builder":
    case "instagram_reply":
    case "whatsapp_session_choices":
    case "whatsapp_flow":
      return surface;
    case undefined:
      return null;
    default: {
      const exhaustive: never = surface;
      void exhaustive;
      return null;
    }
  }
}

export function isInteractiveNoReplyConditionNodeData(
  nodeData: Partial<ScenarioNodeData> | null | undefined,
): boolean {
  return (
    isPostActionConditionNodeData(nodeData) &&
    getPostActionConditionVariant(nodeData) === "interactive_no_reply"
  );
}

export function getVisiblePostActionConditionTypes(
  nodeData: Partial<ScenarioNodeData> | null | undefined,
): ScenarioPostActionConditionType[] {
  if (isInteractiveNoReplyConditionNodeData(nodeData)) {
    return ["no_reply_timeout"];
  }

  return [...POST_ACTION_CONDITION_TYPES];
}

export function getPostActionConditionHandleId(
  type: ScenarioPostActionConditionType,
): string {
  return buildPostActionConditionHandleId(type);
}

function normalizeAnswerMatchRuleIdValue(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value)
    .normalize("NFKC")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

export function normalizeAnswerMatchRuleId(
  value: unknown,
  fallbackIndex = 0,
): string {
  const normalized = normalizeAnswerMatchRuleIdValue(value);
  if (normalized) return normalized;
  return `answer_${fallbackIndex + 1}`;
}

function normalizeAnswerMatchMode(value: unknown): ScenarioAnswerMatchMode {
  return value === "intent" ? "intent" : "exact";
}

function normalizeAnswerMatchText(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value)
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ANSWER_MATCH_TEXT_LENGTH);
}

export function normalizeAnswerMatchRules(
  value: unknown,
): ScenarioAnswerMatchRule[] {
  const rawRules = Array.isArray(value) ? value : [];
  const rules: ScenarioAnswerMatchRule[] = [];
  const seen = new Set<string>();

  rawRules.forEach((rawRule, index) => {
    if (!rawRule || typeof rawRule !== "object") return;
    const record = rawRule as Partial<ScenarioAnswerMatchRule>;
    const baseId = normalizeAnswerMatchRuleId(record.id, index);
    let id = baseId;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${baseId}_${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    rules.push({
      id,
      mode: normalizeAnswerMatchMode(record.mode),
      text: normalizeAnswerMatchText(record.text),
    });
  });

  return rules.slice(0, MAX_ANSWER_MATCH_RULES);
}

export function getPostActionAnswerMatchHandleId(ruleId: string): string {
  return buildPostActionAnswerMatchHandleId(ruleId);
}

export function resolvePostActionConditionTypeFromHandle(
  handleId: string | null | undefined,
): ScenarioPostActionConditionType | null {
  return parsePostActionConditionHandleId(handleId);
}

function normalizeTimeoutMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_POST_ACTION_CONDITION_TIMEOUT_MINUTES;
  }

  const normalized = Math.floor(value);
  if (normalized < 1) return 1;
  if (normalized > 525600) return 525600;
  return normalized;
}

function normalizeMissingTextPhraseValue(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function normalizeMissingTextSearchText(value: unknown): string {
  return normalizeMissingTextPhraseValue(value).toLocaleLowerCase();
}

export function normalizeMissingTextPhrases(value: unknown): string[] {
  const rawPhrases =
    typeof value === "string"
      ? value.split(/\r?\n/)
      : Array.isArray(value)
        ? value
        : [];
  const phrases: string[] = [];
  const seen = new Set<string>();

  for (const rawPhrase of rawPhrases) {
    const phrase = normalizeMissingTextPhraseValue(rawPhrase).slice(
      0,
      MAX_MISSING_TEXT_PHRASE_LENGTH,
    );
    const key = normalizeMissingTextSearchText(phrase);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    phrases.push(phrase);
    if (phrases.length >= MAX_MISSING_TEXT_PHRASES) break;
  }

  return phrases;
}

export function normalizeConditionBranchConfig(
  type: ScenarioPostActionConditionType,
  value: Partial<ScenarioConditionBranchConfig> | null | undefined,
): ScenarioConditionBranchConfig {
  const missingTextPhrases =
    type === "no_reply_timeout"
      ? normalizeMissingTextPhrases(value?.missingTextPhrases)
      : [];
  const answerMatchRules =
    type === "no_reply_timeout"
      ? normalizeAnswerMatchRules(value?.answerMatchRules)
      : [];

  return {
    id:
      typeof value?.id === "string" && value.id.trim().length > 0
        ? value.id.trim()
        : type,
    type,
    timeoutMinutes:
      type === "no_reply_timeout"
        ? normalizeTimeoutMinutes(value?.timeoutMinutes)
        : undefined,
    missingTextPhrases:
      type === "no_reply_timeout" && missingTextPhrases.length > 0
        ? missingTextPhrases
        : undefined,
    answerMatchRules:
      type === "no_reply_timeout" && answerMatchRules.length > 0
        ? answerMatchRules
        : undefined,
    linkedConditionId:
      typeof value?.linkedConditionId === "string" &&
      value.linkedConditionId.trim().length > 0
        ? value.linkedConditionId.trim()
        : undefined,
  };
}

export function createDefaultPostActionConditionBranches(): ScenarioConditionBranchConfig[] {
  return POST_ACTION_CONDITION_TYPES.map((type) =>
    normalizeConditionBranchConfig(type, { id: type }),
  );
}

export function normalizePostActionConditionBranches(
  value: unknown,
): ScenarioConditionBranchConfig[] {
  const branches = Array.isArray(value) ? value : [];
  const branchesByType = new Map<
    ScenarioPostActionConditionType,
    Partial<ScenarioConditionBranchConfig>
  >();

  for (const branch of branches) {
    if (!branch || typeof branch !== "object") continue;
    const record = branch as Partial<ScenarioConditionBranchConfig>;
    if (record.type !== "user_replied" && record.type !== "no_reply_timeout") {
      continue;
    }
    branchesByType.set(record.type, record);
  }

  return POST_ACTION_CONDITION_TYPES.map((type) =>
    normalizeConditionBranchConfig(type, branchesByType.get(type)),
  );
}

export function getPostActionConditionBranch(
  nodeData: Partial<ScenarioNodeData> | null | undefined,
  type: ScenarioPostActionConditionType,
): ScenarioConditionBranchConfig {
  const branches = normalizePostActionConditionBranches(
    nodeData?.conditionBranches,
  );
  return (
    branches.find((branch) => branch.type === type) ??
    normalizeConditionBranchConfig(type, { id: type })
  );
}

export function getNoReplyMissingTextPhrases(
  nodeData: Partial<ScenarioNodeData> | null | undefined,
): string[] {
  return normalizeMissingTextPhrases(
    getPostActionConditionBranch(nodeData, "no_reply_timeout")
      .missingTextPhrases,
  );
}

export function getNoReplyAnswerMatchRules(
  nodeData: Partial<ScenarioNodeData> | null | undefined,
): ScenarioAnswerMatchRule[] {
  return normalizeAnswerMatchRules(
    getPostActionConditionBranch(nodeData, "no_reply_timeout").answerMatchRules,
  );
}

export function postActionConditionUsesAnswerMatchRules(
  nodeData: Partial<ScenarioNodeData> | null | undefined,
): boolean {
  return getNoReplyAnswerMatchRules(nodeData).some((rule) => rule.text.trim());
}

export function postActionConditionUsesMissingText(
  nodeData: Partial<ScenarioNodeData> | null | undefined,
): boolean {
  return getNoReplyMissingTextPhrases(nodeData).length > 0;
}

export function updatePostActionConditionBranches(params: {
  nodeData: Partial<ScenarioNodeData> | null | undefined;
  branchType: ScenarioPostActionConditionType;
  patch: Partial<ScenarioConditionBranchConfig>;
}): ScenarioConditionBranchConfig[] {
  return normalizePostActionConditionBranches(
    params.nodeData?.conditionBranches,
  ).map((branch) =>
    branch.type === params.branchType
      ? normalizeConditionBranchConfig(params.branchType, {
          ...branch,
          ...params.patch,
          type: params.branchType,
        })
      : branch,
  );
}

export type ScenarioGraphNodeLike = {
  id?: string;
  data?: Partial<ScenarioNodeData>;
};

export type ScenarioGraphEdgeLike = {
  id?: string;
  source?: string;
  target?: string;
  sourceHandle?: string | null;
};

export type ConditionalScenarioLinkRef = {
  conditionNodeId: string;
  sourceActionNodeId: string;
  branchType: ScenarioPostActionConditionType;
  branchConfig: ScenarioConditionBranchConfig;
  scenarioLinkNodeId: string;
  childScenarioId: string;
  sourceEdgeId?: string;
};

export const CONDITIONAL_SCENARIO_LINK_ERROR_CODES = {
  branchRequiresActionSource: "condition_branch_requires_action_source",
  branchAllowsSingleTarget: "condition_branch_allows_single_target",
  branchRequiresScenarioSelection:
    "condition_branch_requires_scenario_selection",
} as const;

export type ConditionalScenarioLinkErrorCode =
  (typeof CONDITIONAL_SCENARIO_LINK_ERROR_CODES)[keyof typeof CONDITIONAL_SCENARIO_LINK_ERROR_CODES];

export function resolveConditionalScenarioLinkRefs(params: {
  nodes: ScenarioGraphNodeLike[];
  edges: ScenarioGraphEdgeLike[];
}): {
  refs: ConditionalScenarioLinkRef[];
  errors: ConditionalScenarioLinkErrorCode[];
} {
  const nodeById = new Map<string, ScenarioGraphNodeLike>();
  for (const node of params.nodes) {
    const nodeId = typeof node.id === "string" ? node.id.trim() : "";
    if (!nodeId) continue;
    nodeById.set(nodeId, node);
  }

  const outgoingBranchTargets = new Map<string, Set<string>>();
  const errors: ConditionalScenarioLinkErrorCode[] = [];
  const refs: ConditionalScenarioLinkRef[] = [];

  for (const edge of params.edges) {
    const sourceId = typeof edge.source === "string" ? edge.source.trim() : "";
    const targetId = typeof edge.target === "string" ? edge.target.trim() : "";
    if (!sourceId || !targetId) continue;

    const sourceNode = nodeById.get(sourceId);
    const targetNode = nodeById.get(targetId);
    if (!sourceNode || !targetNode) continue;

    const sourceData = sourceNode.data || {};
    const legacyCondition = isPostActionConditionNodeData(sourceData);
    const actionOutcome =
      sourceData.kind === "action"
        ? parseScenarioActionOutcomeHandleId(edge.sourceHandle)
        : null;
    const branchType = legacyCondition
      ? resolvePostActionConditionTypeFromHandle(edge.sourceHandle)
      : actionOutcome?.type === "any_reply"
        ? "user_replied"
        : actionOutcome?.type === "no_reply"
          ? "no_reply_timeout"
          : null;
    if (!branchType) continue;

    const outgoingBranchKey = `${sourceId}:${branchType}`;
    const targetIds = outgoingBranchTargets.get(outgoingBranchKey) ?? new Set();
    targetIds.add(targetId);
    outgoingBranchTargets.set(outgoingBranchKey, targetIds);
    if (targetIds.size > 1) {
      errors.push(
        CONDITIONAL_SCENARIO_LINK_ERROR_CODES.branchAllowsSingleTarget,
      );
    }

    const incomingActionIds = legacyCondition
      ? params.edges
          .filter((candidate) => {
            const candidateTarget =
              typeof candidate.target === "string"
                ? candidate.target.trim()
                : "";
            return candidateTarget === sourceId;
          })
          .map((candidate) => {
            const candidateSource =
              typeof candidate.source === "string"
                ? candidate.source.trim()
                : "";
            const candidateNode = nodeById.get(candidateSource);
            if (!candidateSource || candidateNode?.data?.kind !== "action") {
              return "";
            }
            return candidateSource;
          })
          .filter(Boolean)
      : [sourceId];

    const uniqueIncomingActionIds = Array.from(new Set(incomingActionIds));
    if (uniqueIncomingActionIds.length === 0) {
      errors.push(
        CONDITIONAL_SCENARIO_LINK_ERROR_CODES.branchRequiresActionSource,
      );
      continue;
    }
    if (targetNode.data?.kind !== "scenario_link") continue;
    const childScenarioId =
      typeof targetNode.data?.linkedScenarioId === "string"
        ? targetNode.data.linkedScenarioId.trim()
        : "";
    if (!childScenarioId) {
      errors.push(
        CONDITIONAL_SCENARIO_LINK_ERROR_CODES.branchRequiresScenarioSelection,
      );
      continue;
    }

    const normalizedActionOutcomes = normalizeScenarioActionOutcomes(
      sourceData.actionOutcomes,
    );
    const branchConfig = legacyCondition
      ? getPostActionConditionBranch(sourceData, branchType)
      : branchType === "user_replied"
        ? normalizeConditionBranchConfig(branchType, {
            id: branchType,
            linkedConditionId:
              normalizedActionOutcomes.status === "supported"
                ? normalizedActionOutcomes.value.anyReply?.linkedConditionId
                : undefined,
          })
        : normalizeConditionBranchConfig(branchType, {
            id: branchType,
            timeoutMinutes:
              normalizedActionOutcomes.status === "supported"
                ? normalizedActionOutcomes.value.noReply?.timeoutMinutes
                : undefined,
            missingTextPhrases:
              normalizedActionOutcomes.status === "supported"
                ? normalizedActionOutcomes.value.noReply?.cancelIfPhrases
                : undefined,
            linkedConditionId:
              normalizedActionOutcomes.status === "supported"
                ? normalizedActionOutcomes.value.noReply?.linkedConditionId
                : undefined,
          });
    const sourceEdgeId =
      typeof edge.id === "string" && edge.id.trim().length > 0
        ? edge.id.trim()
        : undefined;

    for (const sourceActionNodeId of uniqueIncomingActionIds) {
      refs.push({
        conditionNodeId: legacyCondition
          ? sourceId
          : getScenarioActionOutcomeVirtualNodeId(sourceActionNodeId),
        sourceActionNodeId,
        branchType,
        branchConfig,
        scenarioLinkNodeId: targetId,
        childScenarioId,
        sourceEdgeId,
      });
    }
  }

  return {
    refs,
    errors: Array.from(new Set(errors)),
  };
}
