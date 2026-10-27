import {
  normalizeScenarioActionLocationRoutes,
  type ScenarioActionLocationRoutes,
} from "./scenario-location-routing";
import type {
  ScenarioAnswerMatchRule,
  ScenarioPostActionConditionType,
} from "./scenario-triggers";
import { isRecord } from "./value-guards";

export const SCENARIO_ACTION_ROUTING_VERSION = 1 as const;
/**
 * Outcomes that carry location routes are stored as version 2, so a reader
 * from before location routes treats them as unsupported (read-only, and the
 * graph blocked) instead of dropping the routes.
 */
export const SCENARIO_ACTION_OUTCOMES_LOCATION_VERSION = 2 as const;
export const MAX_SCENARIO_ACTION_RUN_CONDITIONS = 20;
export const MAX_SCENARIO_ACTION_ANSWER_MATCHES = 20;
export const MAX_SCENARIO_ACTION_NO_REPLY_MINUTES = 525_600;
export const MAX_SCENARIO_ACTION_BRANCH_DELAYS = 20;

const MAX_SCENARIO_ACTION_STRING_LENGTH = 240;
const MAX_SCENARIO_ACTION_RULE_ID_LENGTH = 80;
const MAX_SCENARIO_ACTION_PHRASES = 20;

export type ScenarioActionRunCondition =
  | { id: string; type: "classification"; category: string }
  | { id: string; type: "internal_label"; label: string }
  | { id: string; type: "specific_customers"; customerIds: string[] }
  | { id: string; type: "has_purchase_history" }
  | { id: string; type: "funnel_stage"; stage: string }
  | { id: string; type: "last_seen_days"; minimumDays: number };

export type ScenarioActionRunConditions = {
  version: 1;
  match: "all";
  conditions: ScenarioActionRunCondition[];
};

/**
 * A tap on this call-to-action sends nothing at first. It arms a wait whose
 * follow-up is the target of the CTA's edge, sent after `delayMinutes` of
 * quiet. A message containing a stop phrase cancels the follow-up.
 */
export type ScenarioActionBranchDelay = {
  sourceHandle: string;
  delayMinutes: number;
  cancelIfPhrases?: string[];
};

export type ScenarioActionOutcomes = {
  version:
    | typeof SCENARIO_ACTION_ROUTING_VERSION
    | typeof SCENARIO_ACTION_OUTCOMES_LOCATION_VERSION;
  anyReply?: { enabled: boolean; linkedConditionId?: string };
  noReply?: {
    enabled: boolean;
    timeoutMinutes: number;
    cancelIfPhrases?: string[];
    linkedConditionId?: string;
  };
  answerMatches?: ScenarioAnswerMatchRule[];
  paymentDetected?: { enabled: boolean };
  branchDelays?: ScenarioActionBranchDelay[];
  /** Routes for a location the customer shares while the step waits. */
  locationRoutes?: ScenarioActionLocationRoutes;
};

export type ScenarioActionRoutingNormalization<T> =
  | { status: "absent"; value: null }
  | { status: "supported"; value: T }
  | {
      status: "unsupported";
      value: null;
      version: unknown;
      raw: unknown;
    };

export type ScenarioActionOutcomeBranchKey = Exclude<
  keyof ScenarioActionOutcomes,
  "version"
>;

export const SCENARIO_ACTION_OUTCOME_TO_POST_ACTION_CONDITION = {
  anyReply: "user_replied",
  noReply: "no_reply_timeout",
  answerMatches: "no_reply_timeout",
  paymentDetected: "payment_detected",
  branchDelays: "no_reply_timeout",
  // A shared location claims the reply; its routes add no condition branch.
  locationRoutes: "user_replied",
} as const satisfies Record<
  ScenarioActionOutcomeBranchKey,
  ScenarioPostActionConditionType
>;

export function visitScenarioActionOutcomeBranches(visit: {
  [K in ScenarioActionOutcomeBranchKey]: () => void;
}): void {
  (
    Object.keys(
      SCENARIO_ACTION_OUTCOME_TO_POST_ACTION_CONDITION,
    ) as ScenarioActionOutcomeBranchKey[]
  ).forEach((key) => {
    visit[key]();
  });
}

export const SCENARIO_LEGACY_ACTION_ROUTING_SOURCE_KINDS = [
  "post_action_condition",
  "audience_filter",
] as const;

export type ScenarioLegacyActionRoutingSourceKind =
  (typeof SCENARIO_LEGACY_ACTION_ROUTING_SOURCE_KINDS)[number];

export type ScenarioLegacyActionRoutingSource = {
  sourceNodeId: string;
  sourceKind: ScenarioLegacyActionRoutingSourceKind;
};

export type ScenarioLegacyActionRoutingPresentation = {
  actionOutcomes?: ScenarioActionOutcomes;
  actionRunConditions?: ScenarioActionRunConditions;
  actionOutcomesSource?: ScenarioLegacyActionRoutingSource;
  actionRunConditionsSource?: ScenarioLegacyActionRoutingSource;
  readOnlyReason?: "multiple_sources" | "shared_subtree";
};

export type ScenarioActionRoutingPatch = {
  actionOutcomes?: ScenarioActionOutcomes;
  actionRunConditions?: ScenarioActionRunConditions;
};

function normalizeString(
  value: unknown,
  maxLength = MAX_SCENARIO_ACTION_STRING_LENGTH,
): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeOptionalString(value: unknown): string | undefined {
  const normalized = normalizeString(value);
  return normalized || undefined;
}

function normalizeRuleIdValue(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value)
    .normalize("NFKC")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_SCENARIO_ACTION_RULE_ID_LENGTH);
}

export function normalizeScenarioActionRuleId(
  value: unknown,
  fallbackIndex = 0,
): string {
  return normalizeRuleIdValue(value) || `answer_${fallbackIndex + 1}`;
}

function normalizeUniqueStrings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];

  const values: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const normalized = normalizeString(entry);
    if (!normalized || seen.has(normalized)) continue;

    seen.add(normalized);
    values.push(normalized);
    if (values.length === limit) break;
  }

  return values;
}

function normalizeConditionId(value: unknown, fallbackIndex: number): string {
  const normalized = normalizeRuleIdValue(value);
  return normalized || `condition_${fallbackIndex + 1}`;
}

function createUniqueId(baseId: string, seen: Set<string>): string {
  let id = baseId;
  let suffix = 2;
  while (seen.has(id)) {
    id = `${baseId}_${suffix}`;
    suffix += 1;
  }
  seen.add(id);
  return id;
}

function normalizeRunCondition(
  value: unknown,
  index: number,
  seenIds: Set<string>,
): ScenarioActionRunCondition | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;

  const getId = () =>
    createUniqueId(normalizeConditionId(value.id, index), seenIds);
  if (value.type === "classification") {
    const category = normalizeOptionalString(value.category);
    return category ? { id: getId(), type: "classification", category } : null;
  }
  if (value.type === "internal_label") {
    const label = normalizeOptionalString(value.label);
    return label ? { id: getId(), type: "internal_label", label } : null;
  }
  if (value.type === "specific_customers") {
    const customerIds = normalizeUniqueStrings(
      value.customerIds,
      MAX_SCENARIO_ACTION_RUN_CONDITIONS,
    );
    return customerIds.length > 0
      ? { id: getId(), type: "specific_customers", customerIds }
      : null;
  }
  if (value.type === "has_purchase_history") {
    return { id: getId(), type: "has_purchase_history" };
  }
  if (value.type === "funnel_stage") {
    const stage = normalizeOptionalString(value.stage);
    return stage ? { id: getId(), type: "funnel_stage", stage } : null;
  }
  if (value.type === "last_seen_days") {
    const minimumDays = value.minimumDays;
    return typeof minimumDays === "number" &&
      Number.isInteger(minimumDays) &&
      minimumDays >= 1
      ? { id: getId(), type: "last_seen_days", minimumDays }
      : null;
  }

  return null;
}

function getNormalizationState(
  value: unknown,
  supportedVersions: readonly number[],
):
  | { status: "absent"; value: null }
  | { status: "unsupported"; value: null; version: unknown; raw: unknown }
  | { status: "supported"; value: Record<string, unknown> } {
  if (value === null || value === undefined) {
    return { status: "absent", value: null };
  }
  if (!isRecord(value)) {
    return {
      status: "unsupported",
      value: null,
      version: undefined,
      raw: value,
    };
  }
  if (
    typeof value.version !== "number" ||
    !supportedVersions.includes(value.version)
  ) {
    return {
      status: "unsupported",
      value: null,
      version: value.version,
      raw: value,
    };
  }

  return { status: "supported", value };
}

export function normalizeScenarioActionRunConditions(
  value: unknown,
): ScenarioActionRoutingNormalization<ScenarioActionRunConditions> {
  const state = getNormalizationState(value, [SCENARIO_ACTION_ROUTING_VERSION]);
  if (state.status !== "supported") return state;

  const conditions: ScenarioActionRunCondition[] = [];
  const seenIds = new Set<string>();
  const rawConditions = Array.isArray(state.value.conditions)
    ? state.value.conditions
    : [];
  for (const [index, condition] of rawConditions.entries()) {
    const normalized = normalizeRunCondition(condition, index, seenIds);
    if (normalized) conditions.push(normalized);
    if (conditions.length === MAX_SCENARIO_ACTION_RUN_CONDITIONS) break;
  }

  return {
    status: "supported",
    value: {
      version: SCENARIO_ACTION_ROUTING_VERSION,
      match: "all",
      conditions,
    },
  };
}

function normalizeAnswerMatches(value: unknown): ScenarioAnswerMatchRule[] {
  if (!Array.isArray(value)) return [];

  const rules: ScenarioAnswerMatchRule[] = [];
  const seenIds = new Set<string>();
  for (const [index, rawRule] of value.entries()) {
    if (!isRecord(rawRule)) continue;

    const id = createUniqueId(
      normalizeScenarioActionRuleId(rawRule.id, index),
      seenIds,
    );
    rules.push({
      id,
      mode: rawRule.mode === "intent" ? "intent" : "exact",
      text: normalizeString(rawRule.text),
    });
    if (rules.length === MAX_SCENARIO_ACTION_ANSWER_MATCHES) break;
  }

  return rules;
}

function normalizeEnabledOutcome(
  value: unknown,
): { enabled: true; linkedConditionId?: string } | undefined {
  if (!isRecord(value) || value.enabled !== true) return undefined;

  const linkedConditionId = normalizeOptionalString(value.linkedConditionId);
  return linkedConditionId
    ? { enabled: true, linkedConditionId }
    : { enabled: true };
}

function isQuietPeriodMinutes(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_SCENARIO_ACTION_NO_REPLY_MINUTES
  );
}

function normalizeCancelIfPhrases(value: unknown): string[] {
  return normalizeUniqueStrings(value, MAX_SCENARIO_ACTION_PHRASES);
}

function normalizeNoReplyOutcome(
  value: unknown,
): ScenarioActionOutcomes["noReply"] {
  if (!isRecord(value) || value.enabled !== true) return undefined;

  const timeoutMinutes = value.timeoutMinutes;
  if (!isQuietPeriodMinutes(timeoutMinutes)) {
    return undefined;
  }

  const cancelIfPhrases = normalizeCancelIfPhrases(value.cancelIfPhrases);
  const linkedConditionId = normalizeOptionalString(value.linkedConditionId);
  return {
    enabled: true,
    timeoutMinutes,
    ...(cancelIfPhrases.length > 0 ? { cancelIfPhrases } : {}),
    ...(linkedConditionId ? { linkedConditionId } : {}),
  };
}

function normalizeBranchDelaySourceHandle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sourceHandle = value.trim();
  return sourceHandle &&
    sourceHandle.length <= MAX_SCENARIO_ACTION_STRING_LENGTH &&
    !/\s/.test(sourceHandle)
    ? sourceHandle
    : null;
}

function normalizeBranchDelay(
  value: unknown,
): ScenarioActionBranchDelay | null {
  if (!isRecord(value)) return null;

  const sourceHandle = normalizeBranchDelaySourceHandle(value.sourceHandle);
  const delayMinutes = value.delayMinutes;
  if (!sourceHandle || !isQuietPeriodMinutes(delayMinutes)) return null;

  const cancelIfPhrases = normalizeCancelIfPhrases(value.cancelIfPhrases);
  return {
    sourceHandle,
    delayMinutes,
    ...(cancelIfPhrases.length > 0 ? { cancelIfPhrases } : {}),
  };
}

/** Invalid entries are dropped; the first delay for a handle wins. */
function normalizeBranchDelays(value: unknown): ScenarioActionBranchDelay[] {
  if (!Array.isArray(value)) return [];

  const delays: ScenarioActionBranchDelay[] = [];
  const seenHandles = new Set<string>();
  for (const rawDelay of value) {
    const delay = normalizeBranchDelay(rawDelay);
    if (!delay || seenHandles.has(delay.sourceHandle)) continue;

    seenHandles.add(delay.sourceHandle);
    delays.push(delay);
    if (delays.length === MAX_SCENARIO_ACTION_BRANCH_DELAYS) break;
  }

  return delays;
}

export function normalizeScenarioActionOutcomes(
  value: unknown,
): ScenarioActionRoutingNormalization<ScenarioActionOutcomes> {
  const state = getNormalizationState(value, [
    SCENARIO_ACTION_ROUTING_VERSION,
    SCENARIO_ACTION_OUTCOMES_LOCATION_VERSION,
  ]);
  if (state.status !== "supported") return state;

  const outcomes: ScenarioActionOutcomes = {
    version: SCENARIO_ACTION_ROUTING_VERSION,
  };

  visitScenarioActionOutcomeBranches({
    anyReply: () => {
      const anyReply = normalizeEnabledOutcome(state.value.anyReply);
      if (anyReply) outcomes.anyReply = anyReply;
    },
    noReply: () => {
      const noReply = normalizeNoReplyOutcome(state.value.noReply);
      if (noReply) outcomes.noReply = noReply;
    },
    answerMatches: () => {
      const answerMatches = normalizeAnswerMatches(state.value.answerMatches);
      if (answerMatches.length > 0) outcomes.answerMatches = answerMatches;
    },
    paymentDetected: () => {
      const paymentDetected = normalizeEnabledOutcome(
        state.value.paymentDetected,
      );
      if (paymentDetected) outcomes.paymentDetected = { enabled: true };
    },
    branchDelays: () => {
      const branchDelays = normalizeBranchDelays(state.value.branchDelays);
      if (branchDelays.length > 0) outcomes.branchDelays = branchDelays;
    },
    locationRoutes: () => {
      const locationRoutes = normalizeScenarioActionLocationRoutes(
        state.value.locationRoutes,
      );
      if (locationRoutes) outcomes.locationRoutes = locationRoutes;
    },
  });
  // The version follows the content, whatever the stored value said.
  if (outcomes.locationRoutes) {
    outcomes.version = SCENARIO_ACTION_OUTCOMES_LOCATION_VERSION;
  }

  return {
    status: "supported",
    value: outcomes,
  };
}

const ACTION_OUTCOME_VIRTUAL_NODE_ID_PREFIX = "__system:action-outcomes:";

export function getScenarioActionOutcomeVirtualNodeId(
  actionNodeId: string,
): string {
  return `${ACTION_OUTCOME_VIRTUAL_NODE_ID_PREFIX}${encodeURIComponent(
    actionNodeId.trim(),
  )}`;
}

/** The compiled wait that an action's Outcomes arm after it is sent. */
export function isScenarioActionOutcomeVirtualNodeId(
  nodeId: string | null | undefined,
): boolean {
  return (
    typeof nodeId === "string" &&
    nodeId.startsWith(ACTION_OUTCOME_VIRTUAL_NODE_ID_PREFIX)
  );
}

const BRANCH_DELAY_VIRTUAL_NODE_ID_PREFIX = "__system:action-branch-delay:";

/** The compiled wait that a tap on a delayed CTA arms. */
export function getScenarioActionBranchDelayVirtualNodeId(
  actionNodeId: string,
  sourceHandle: string,
): string {
  return `${BRANCH_DELAY_VIRTUAL_NODE_ID_PREFIX}${encodeURIComponent(
    actionNodeId.trim(),
  )}:${encodeURIComponent(sourceHandle.trim())}`;
}

export function parseScenarioActionBranchDelayVirtualNodeId(
  nodeId: string | null | undefined,
): { actionNodeId: string; sourceHandle: string } | null {
  const normalized = typeof nodeId === "string" ? nodeId.trim() : "";
  if (!normalized.startsWith(BRANCH_DELAY_VIRTUAL_NODE_ID_PREFIX)) return null;

  const parts = normalized
    .slice(BRANCH_DELAY_VIRTUAL_NODE_ID_PREFIX.length)
    .split(":");
  const [encodedActionNodeId, encodedSourceHandle] = parts;
  if (parts.length !== 2 || !encodedActionNodeId || !encodedSourceHandle) {
    return null;
  }

  try {
    const actionNodeId = decodeURIComponent(encodedActionNodeId).trim();
    const sourceHandle = decodeURIComponent(encodedSourceHandle).trim();
    if (!actionNodeId || !sourceHandle) return null;
    return getScenarioActionBranchDelayVirtualNodeId(
      actionNodeId,
      sourceHandle,
    ) === normalized
      ? { actionNodeId, sourceHandle }
      : null;
  } catch {
    return null;
  }
}

export function isScenarioActionBranchDelayVirtualNodeId(
  nodeId: string | null | undefined,
): boolean {
  return parseScenarioActionBranchDelayVirtualNodeId(nodeId) !== null;
}

function withBranchDelays(
  outcomes: ScenarioActionOutcomes,
  branchDelays: ScenarioActionBranchDelay[],
): ScenarioActionOutcomes {
  const next: ScenarioActionOutcomes = { ...outcomes };
  if (branchDelays.length > 0) next.branchDelays = branchDelays;
  else delete next.branchDelays;
  return next;
}

export function getScenarioActionBranchDelay(
  outcomes: Pick<ScenarioActionOutcomes, "branchDelays"> | null | undefined,
  sourceHandle: string,
): ScenarioActionBranchDelay | null {
  const handle = normalizeBranchDelaySourceHandle(sourceHandle);
  if (!handle) return null;
  return (
    normalizeBranchDelays(outcomes?.branchDelays).find(
      (delay) => delay.sourceHandle === handle,
    ) ?? null
  );
}

/**
 * Sets or, with `null`, removes the delay of one CTA. The list is normalized
 * like persisted outcomes, so an invalid delay is dropped.
 */
export function withScenarioActionBranchDelay(
  outcomes: ScenarioActionOutcomes,
  sourceHandle: string,
  delay: Omit<ScenarioActionBranchDelay, "sourceHandle"> | null,
): ScenarioActionOutcomes {
  const handle = normalizeBranchDelaySourceHandle(sourceHandle);
  if (!handle) return outcomes;

  const current = normalizeBranchDelays(outcomes.branchDelays);
  const replacement = delay ? { ...delay, sourceHandle: handle } : null;
  const index = current.findIndex((entry) => entry.sourceHandle === handle);
  const next =
    index < 0
      ? [...current, ...(replacement ? [replacement] : [])]
      : current.flatMap((entry, entryIndex) =>
          entryIndex !== index ? [entry] : replacement ? [replacement] : [],
        );
  return withBranchDelays(outcomes, normalizeBranchDelays(next));
}

/** Drops the delays of CTAs the action no longer offers. */
export function retainScenarioActionBranchDelays(
  outcomes: ScenarioActionOutcomes,
  ownedHandles: Iterable<string>,
): ScenarioActionOutcomes {
  if (outcomes.branchDelays === undefined) return outcomes;

  const owned = new Set(Array.from(ownedHandles, (handle) => handle.trim()));
  return withBranchDelays(
    outcomes,
    normalizeBranchDelays(outcomes.branchDelays).filter((delay) =>
      owned.has(delay.sourceHandle),
    ),
  );
}
