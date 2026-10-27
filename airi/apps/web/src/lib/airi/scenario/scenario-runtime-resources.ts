import {
  isScenarioContextOptionId,
  type ScenarioActionType,
  type ScenarioContextOptionId,
} from "@icecore/scenario-contracts";
import type { ContextBinding } from "@/lib/airi/scenario/scenario-runtime-types";
import type { ScenarioRuntimeQuickReply } from "@icecore/airi-runtime/scenario-runtime-types";
import { resolveScenarioEntryPolicy } from "@/lib/airi/scenario/scenario-entry-policy";
import {
  normalizeContextOptionId,
  toStringArray,
} from "@/lib/scenarios/normalization";
import {
  getPrimaryRawScenarioTriggerNode,
  type ScenarioRecord,
  type ScenarioRuntimeNode,
} from "@icecore/airi-runtime/scenario-graph";
import { isMongoObjectIdString } from "@/lib/scenarios/task-utils";
import { QuickReply } from "@/models/quick-reply";
import { Scenario } from "@/models/scenario";
import type { Channel } from "@/types/models";
export async function loadQuickRepliesForScenario(params: {
  workspaceId: string;
  channel: Channel;
  quickReplyIds?: string[];
}): Promise<ScenarioRuntimeQuickReply[]> {
  const normalizedQuickReplyIds = Array.isArray(params.quickReplyIds)
    ? params.quickReplyIds
        .map(item => String(item).trim())
        .filter(id => /^[a-fA-F0-9]{24}$/.test(id))
    : [];
  const hasSpecificIds = normalizedQuickReplyIds.length > 0;

  if (
    Array.isArray(params.quickReplyIds) &&
    params.quickReplyIds.length > 0 &&
    !hasSpecificIds
  ) {
    return [];
  }

  const query: Record<string, unknown> = {
    workspaceId: params.workspaceId,
  };

  if (hasSpecificIds) {
    query._id = { $in: normalizedQuickReplyIds };
  } else {
    query.$or = [
      { channel: params.channel },
      { channel: null },
      { channel: { $exists: false } },
    ];
  }

  const quickReplies = await QuickReply.find(query)
    .sort({ order: 1, updatedAt: -1 })
    .limit(30)
    .select("text category channel")
    .lean();

  return quickReplies
    .map(reply => ({
      text: typeof reply.text === "string" ? reply.text.trim() : "",
      category: typeof reply.category === "string" ? reply.category : undefined,
      channel: typeof reply.channel === "string" ? reply.channel : undefined,
    }))
    .filter(reply => reply.text.length > 0);
}

// ---------------------------------------------------------------------------
// Context bindings
// ---------------------------------------------------------------------------

export function buildContextBindings(
  nodes: ScenarioRuntimeNode[]
): Map<ScenarioContextOptionId, ContextBinding> {
  const bindings = new Map<ScenarioContextOptionId, ContextBinding>();

  nodes
    .filter(node => node.data.kind === "context")
    .forEach(node => {
      const data = node.data;

      if (data.contextSources && data.contextSources.length > 0) {
        data.contextSources.forEach(entry => {
          if (!isScenarioContextOptionId(entry.optionId)) return;
          const optionId = entry.optionId;

          const existing =
            bindings.get(optionId) ||
            ({
              allItems: false,
              itemIds: new Set<string>(),
            } satisfies ContextBinding);

          const itemIds = toStringArray(entry.itemIds);
          const specificMode = entry.selectionMode === "specific";
          if (!specificMode || itemIds.length === 0) {
            existing.allItems = true;
          } else {
            itemIds.forEach(itemId => existing.itemIds.add(itemId));
          }

          bindings.set(optionId, existing);
        });
        return;
      }

      const optionId = normalizeContextOptionId(data);
      if (!optionId) return;

      const existing =
        bindings.get(optionId) ||
        ({
          allItems: false,
          itemIds: new Set<string>(),
        } satisfies ContextBinding);

      const itemIds = toStringArray(data.contextItemIds);
      const specificMode = data.contextSelectionMode === "specific";
      if (!specificMode || itemIds.length === 0) {
        existing.allItems = true;
      } else {
        itemIds.forEach(itemId => existing.itemIds.add(itemId));
      }

      bindings.set(optionId, existing);
    });

  return bindings;
}

/**
 * Extracts an ordered list of context source option IDs from the path nodes,
 * preserving the order defined in the knowledge node's `contextSources` array.
 * This order is the user-defined priority for retrieval.
 */
export function buildContextSourcePriority(
  nodes: ScenarioRuntimeNode[]
): ScenarioContextOptionId[] {
  const seen = new Set<ScenarioContextOptionId>();
  const ordered: ScenarioContextOptionId[] = [];

  nodes
    .filter(node => node.data.kind === "context")
    .forEach(node => {
      const data = node.data;

      if (data.contextSources && data.contextSources.length > 0) {
        data.contextSources.forEach(entry => {
          if (!isScenarioContextOptionId(entry.optionId)) return;
          if (seen.has(entry.optionId)) return;
          seen.add(entry.optionId);
          ordered.push(entry.optionId);
        });
        return;
      }

      const optionId = normalizeContextOptionId(data);
      if (!optionId) return;
      if (seen.has(optionId)) return;
      seen.add(optionId);
      ordered.push(optionId);
    });

  return ordered;
}

export function getBindingSelectionIds(
  bindings: Map<ScenarioContextOptionId, ContextBinding>,
  optionId: ScenarioContextOptionId
): string[] {
  const binding = bindings.get(optionId);
  if (!binding || binding.allItems) return [];
  return Array.from(binding.itemIds);
}

export function shouldIncludeKBArticlesForScenarioRuntime(params: {
  hasContextBinding: boolean;
  hasKBBinding: boolean;
  selectedActionType: ScenarioActionType;
  replyMode?: import("@icecore/scenario-contracts").ScenarioReplyMode;
}): boolean {
  if (!params.hasContextBinding) return true;

  const isAiReplyAction =
    params.selectedActionType === "reply" &&
    (params.replyMode || "ai") !== "fixed";

  // AI reply actions should stay grounded in workspace KB by default,
  // especially for builder/button branches where per-branch KB wiring is
  // limited or unavailable.
  return params.hasKBBinding || isAiReplyAction;
}

// ---------------------------------------------------------------------------
// Scenario data access
// ---------------------------------------------------------------------------

const SCENARIO_RUNTIME_SELECT =
  "_id name priority loopScenario matchingRole entryPolicy nodes edges updatedAt";
const SCENARIO_TRIGGER_SELECT = {
  _id: 1,
  name: 1,
  priority: 1,
  loopScenario: 1,
  matchingRole: 1,
  entryPolicy: 1,
  updatedAt: 1,
  nodes: {
    $filter: {
      input: "$nodes",
      as: "node",
      cond: { $eq: ["$$node.data.kind", "trigger"] },
    },
  },
};

type RawScenarioRuntimeRecord = Omit<ScenarioRecord, "entryPolicy"> & {
  entryPolicy?: unknown;
  loopScenario?: unknown;
};

function toScenarioRecord(raw: RawScenarioRuntimeRecord): ScenarioRecord {
  const scenario = { ...raw };
  delete scenario.loopScenario;
  return {
    ...scenario,
    entryPolicy: resolveScenarioEntryPolicy(raw),
  };
}

function hasPrimaryTriggerLinkedCondition(scenario: ScenarioRecord): boolean {
  const triggerNode = getPrimaryRawScenarioTriggerNode(scenario);
  const linkedConditionId =
    triggerNode?.data.kind === "trigger" &&
    typeof triggerNode.data.linkedConditionId === "string"
      ? triggerNode.data.linkedConditionId.trim()
      : "";
  return Boolean(linkedConditionId);
}

export async function fetchActiveScenariosForWorkspace(params: {
  workspaceId: string;
  limitToPriority?: number | null;
  excludeScenarioIds?: string[];
  triggerProjection?: boolean;
}): Promise<ScenarioRecord[]> {
  const query: Record<string, unknown> = {
    workspaceId: params.workspaceId,
    status: "active",
    mode: { $ne: "bulk_campaign" },
    deletedAt: null,
  };
  if (typeof params.limitToPriority === "number") {
    query.priority = params.limitToPriority;
  }
  const normalizedExcludedIds = (params.excludeScenarioIds || [])
    .map(id => id.trim())
    .filter(isMongoObjectIdString);
  if (normalizedExcludedIds.length > 0) {
    query._id = { $nin: normalizedExcludedIds };
  }

  const scenarios = await Scenario.find(query)
    .select(
      params.triggerProjection
        ? SCENARIO_TRIGGER_SELECT
        : SCENARIO_RUNTIME_SELECT
    )
    .sort({ priority: -1, _id: 1 })
    .lean<RawScenarioRuntimeRecord[]>({ defaults: false });

  return scenarios
    .map(raw =>
      toScenarioRecord({
        ...raw,
        ...(params.triggerProjection && !Object.hasOwn(raw, "edges")
          ? { graphProjection: "triggers" as const }
          : {}),
      })
    )
    .filter(scenario => !hasPrimaryTriggerLinkedCondition(scenario));
}

export async function fetchActiveScenarioById(params: {
  workspaceId: string;
  scenarioId: string;
  expectedUpdatedAt?: unknown;
}): Promise<ScenarioRecord | null> {
  if (!isMongoObjectIdString(params.scenarioId)) return null;

  const scenario = await Scenario.findOne({
    _id: params.scenarioId,
    workspaceId: params.workspaceId,
    status: "active",
    mode: { $ne: "bulk_campaign" },
    deletedAt: null,
    ...(params.expectedUpdatedAt !== undefined
      ? { updatedAt: params.expectedUpdatedAt }
      : {}),
  })
    .select(SCENARIO_RUNTIME_SELECT)
    .lean<RawScenarioRuntimeRecord | null>({ defaults: false });

  return scenario ? toScenarioRecord(scenario) : null;
}
