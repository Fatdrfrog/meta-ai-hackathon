import path from "node:path";

import { ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID } from "@icecore/scenario-contracts";
import { readId } from "@/lib/scenarios/read-id";

import {
  analyzeDedicatedInteractiveNoReplyAssignment,
  canonicalizeLegacyInteractiveNoReplyAssignmentEdges,
  convertLegacyActionRouting,
  type LegacyActionRoutingGraph,
} from "./legacy-action-routing";
import {
  classifyLegacyRoutingMigrationExternalState,
  hashLegacyRoutingMigrationValue,
  legacyRoutingMigrationCandidatePairKey,
  type LegacyRoutingMigrationCandidatePair,
  type LegacyRoutingMigrationLoadedState,
  type LegacyRoutingMigrationPreimage,
} from "./legacy-routing-migration-preimage";
import type {
  LegacyRoutingConversionInstruction,
  LegacyRoutingConversionTransactionResult,
} from "./legacy-routing-conversion-service";

const MIGRATION_UPDATED_BY = "migration:interactive-no-reply";

export type InteractiveNoReplyMigrationArgs = {
  apply: boolean;
  workspaceId: string;
  scenarioId: string;
  expectedCount?: number;
  expectedRevision?: string;
  expectedBeforeSha256?: string;
  expectedPreimageSha256?: string;
  outputPath?: string;
};

type InteractiveNoReplyMigrationCandidate =
  LegacyRoutingConversionInstruction & {
    assignmentEdgeId: string | null;
    sourceKind: "post_action_condition";
    virtualConditionNodeId: string;
  };

type InteractiveNoReplyMigrationSkip = {
  assignmentEdgeId: string | null;
  sourceActionNodeId: string;
  sourceNodeId: string;
  reason: string;
};

type InteractiveNoReplyMigrationPlan = {
  candidates: InteractiveNoReplyMigrationCandidate[];
  skips: InteractiveNoReplyMigrationSkip[];
  dedicatedAssignmentCount: number;
  convertedGraph: LegacyActionRoutingGraph;
  hashes: {
    beforeSha256: string;
    afterSha256: string;
  };
};

type InteractiveNoReplyMigrationScenarioSnapshot = Record<string, unknown> & {
  _id?: unknown;
  workspaceId?: unknown;
  updatedAt?: unknown;
  nodes?: unknown;
  edges?: unknown;
};

type InteractiveNoReplyPendingConversation = Record<string, unknown> & {
  conversationId: string;
  sourceActionNodeId: string;
  sourceNodeId: string;
};

export type InteractiveNoReplyMigrationPreimage =
  LegacyRoutingMigrationPreimage;

export type InteractiveNoReplyMigrationEvent =
  | {
      type: "migration_plan";
      mode: "dry_run" | "apply";
      workspaceId: string;
      scenarioId: string;
      candidateCount: number;
      skipCount: number;
      dedicatedAssignmentCount: number;
      pendingConversationCount: number;
      linkedConditionCount: number;
      scenarioRevision: string;
      preimageSha256: string;
      hashes: InteractiveNoReplyMigrationPlan["hashes"];
    }
  | ({ type: "migration_candidate" } & InteractiveNoReplyMigrationCandidate)
  | ({ type: "migration_skip" } & InteractiveNoReplyMigrationSkip)
  | ({
      type: "migration_pending_conversation";
    } & InteractiveNoReplyPendingConversation)
  | { type: "migration_preimage_written"; outputPath: string }
  | {
      type: "migration_apply_result";
      beforeRevision: string;
      afterRevision: string;
      convertedConditionNodeIds: string[];
      convertedActionNodeIds: string[];
      remappedConversationIds: string[];
      timerReplanResults: LegacyRoutingConversionTransactionResult["timerReplanResults"];
      postCommitWarnings: LegacyRoutingConversionTransactionResult["postCommitWarnings"];
    }
  | {
      type: "migration_post_commit_wait_verification";
      candidatePairs: LegacyRoutingMigrationCandidatePair[];
      remainingConversationIds: string[];
      remainingLinkedConditionIds: string[];
      passed: boolean;
    }
  | {
      type: "migration_complete";
      mode: "dry_run" | "apply";
      applied: boolean;
      candidateCount: number;
      pendingConversationCount: number;
    }
  | InteractiveNoReplyMigrationErrorEvent;

export type InteractiveNoReplyMigrationErrorEvent = {
  type: "migration_error";
  code: string;
  message: string;
  committed?: true;
  timerReplanFailures?: unknown[];
  postCommitWarnings?: LegacyRoutingConversionTransactionResult["postCommitWarnings"];
  priorCommittedError?: InteractiveNoReplyMigrationPriorCommittedError;
  remainingPendingConversations?: InteractiveNoReplyPendingConversation[];
  remainingLinkedConditionIds?: string[];
};

type InteractiveNoReplyMigrationPriorCommittedError = {
  code: string;
  message: string;
};

type InteractiveNoReplyMigrationOperatorResult = {
  mode: "dry_run" | "apply";
  workspaceId: string;
  scenarioId: string;
  candidateCount: number;
  pendingConversationCount: number;
  applied: boolean;
  plan: InteractiveNoReplyMigrationPlan;
  applyResult?: LegacyRoutingConversionTransactionResult;
};

type InteractiveNoReplyMigrationOperatorDependencies = {
  assertTimerReplanIngressReady: () => Promise<void>;
  loadState: (params: {
    workspaceId: string;
    scenarioId: string;
    candidatePairs: LegacyRoutingMigrationCandidatePair[];
  }) => Promise<LegacyRoutingMigrationLoadedState | null>;
  applyMigration: (params: {
    scenarioId: string;
    workspaceId: string;
    updatedBy: string;
    expectedUpdatedAt: string | Date;
    conversions: LegacyRoutingConversionInstruction[];
    expectedDedicatedAssignmentCount: number;
    expectedPreimageSha256: string;
  }) => Promise<LegacyRoutingConversionTransactionResult>;
  writePreimage: (
    outputPath: string,
    preimage: InteractiveNoReplyMigrationPreimage
  ) => Promise<void>;
  emit?: (event: InteractiveNoReplyMigrationEvent) => void;
};

export class InteractiveNoReplyMigrationError extends Error {
  readonly committed: boolean;
  readonly committedResult: LegacyRoutingConversionTransactionResult | null;
  readonly remainingPendingConversations: InteractiveNoReplyPendingConversation[];
  readonly remainingLinkedConditionIds: string[];
  readonly timerReplanFailures: unknown[];
  readonly priorCommittedError: InteractiveNoReplyMigrationPriorCommittedError | null;

  constructor(
    readonly code: string,
    message: string,
    options?: {
      committedResult?: LegacyRoutingConversionTransactionResult;
      remainingPendingConversations?: InteractiveNoReplyPendingConversation[];
      remainingLinkedConditionIds?: string[];
      timerReplanFailures?: unknown[];
      priorCommittedError?: InteractiveNoReplyMigrationPriorCommittedError;
      cause?: unknown;
    }
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause }
    );
    this.name = "InteractiveNoReplyMigrationError";
    this.committedResult = options?.committedResult ?? null;
    this.committed = this.committedResult !== null;
    this.remainingPendingConversations =
      options?.remainingPendingConversations ?? [];
    this.remainingLinkedConditionIds =
      options?.remainingLinkedConditionIds ?? [];
    this.timerReplanFailures = options?.timerReplanFailures ?? [];
    this.priorCommittedError = options?.priorCommittedError ?? null;
  }
}

function migrationError(code: string, message: string): never {
  throw new InteractiveNoReplyMigrationError(code, message);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assignmentIdentity(params: {
  sourceActionNodeId: string;
  sourceNodeId: string;
  assignmentEdgeId: string | null;
}): string {
  return [
    params.sourceActionNodeId,
    params.sourceNodeId,
    params.assignmentEdgeId ?? "",
  ].join("\u0000");
}

function semanticGraphValue(
  graph: LegacyActionRoutingGraph
): LegacyActionRoutingGraph {
  const sortValues = <T>(values: T[]): T[] =>
    values
      .map(value => ({
        value,
        digest: hashLegacyRoutingMigrationValue(value),
      }))
      .sort((left, right) => compareText(left.digest, right.digest))
      .map(entry => entry.value);

  return {
    nodes: sortValues(graph.nodes),
    edges: sortValues(graph.edges),
  };
}

function semanticGraphHash(graph: LegacyActionRoutingGraph): string {
  return hashLegacyRoutingMigrationValue(semanticGraphValue(graph));
}

function errorReason(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : "legacy_action_routing_not_eligible";
}

export function planInteractiveNoReplyAssignmentMigration(
  graph: LegacyActionRoutingGraph
): InteractiveNoReplyMigrationPlan {
  const assignments = canonicalizeLegacyInteractiveNoReplyAssignmentEdges(graph)
    .filter(
      edge => edge.sourceHandle === ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID
    )
    .map(edge => ({
      edge,
      assignmentEdgeId:
        typeof edge.id === "string" && edge.id.trim() ? edge.id.trim() : null,
      sourceActionNodeId: edge.source.trim(),
      sourceNodeId: edge.target.trim(),
    }))
    .sort((left, right) =>
      compareText(assignmentIdentity(left), assignmentIdentity(right))
    );

  const candidates: InteractiveNoReplyMigrationCandidate[] = [];
  const skips: InteractiveNoReplyMigrationSkip[] = [];
  let convertedGraph = graph;

  for (const assignment of assignments) {
    try {
      const exactAssignment = analyzeDedicatedInteractiveNoReplyAssignment({
        graph: convertedGraph,
        conditionNodeId: assignment.sourceNodeId,
        sourceActionNodeId: assignment.sourceActionNodeId,
      });
      if (!exactAssignment) {
        throw new Error("legacy_action_routing_not_dedicated_assignment");
      }

      const conversion = convertLegacyActionRouting({
        graph: convertedGraph,
        sourceActionNodeId: assignment.sourceActionNodeId,
        conditionNodeId: assignment.sourceNodeId,
      });
      candidates.push({
        assignmentEdgeId: assignment.assignmentEdgeId,
        sourceActionNodeId: conversion.sourceActionNodeId,
        sourceNodeId: conversion.conditionNodeId,
        sourceKind: "post_action_condition",
        virtualConditionNodeId: conversion.virtualConditionNodeId,
      });
      convertedGraph = conversion.graph;
    } catch (error) {
      skips.push({
        assignmentEdgeId: assignment.assignmentEdgeId,
        sourceActionNodeId: assignment.sourceActionNodeId,
        sourceNodeId: assignment.sourceNodeId,
        reason: errorReason(error),
      });
    }
  }

  return {
    candidates,
    skips,
    dedicatedAssignmentCount: assignments.length,
    convertedGraph,
    hashes: {
      beforeSha256: semanticGraphHash(graph),
      afterSha256: semanticGraphHash(convertedGraph),
    },
  };
}

function valuesForPrefix(argv: string[], prefix: string): string[] {
  return argv
    .filter(arg => arg.startsWith(prefix))
    .map(arg => arg.slice(prefix.length).trim());
}

function readSingleValue(argv: string[], prefix: string): string | undefined {
  const values = valuesForPrefix(argv, prefix);
  if (values.length > 1) {
    migrationError(
      "interactive_no_reply_duplicate_argument",
      `${prefix.slice(0, -1)} may be provided only once`
    );
  }
  if (values.length === 0) return undefined;
  if (!values[0]) {
    return migrationError(
      "interactive_no_reply_empty_argument",
      `${prefix.slice(0, -1)} must not be empty`
    );
  }
  return values[0];
}

function isAbsolutePath(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

export function parseInteractiveNoReplyMigrationArgs(
  argv: string[]
): InteractiveNoReplyMigrationArgs {
  const supportedPrefixes = [
    "--workspace-id=",
    "--scenario-id=",
    "--expected-count=",
    "--expected-revision=",
    "--expected-before-sha256=",
    "--expected-preimage-sha256=",
    "--output=",
  ];
  const unknown = argv.find(
    arg =>
      arg !== "--" &&
      arg !== "--apply" &&
      !supportedPrefixes.some(prefix => arg.startsWith(prefix))
  );
  if (unknown) {
    migrationError(
      "interactive_no_reply_unknown_argument",
      `Unknown migration argument: ${unknown}`
    );
  }
  if (argv.filter(arg => arg === "--apply").length > 1) {
    migrationError(
      "interactive_no_reply_duplicate_argument",
      "--apply may be provided only once"
    );
  }

  const workspaceId = readSingleValue(argv, "--workspace-id=");
  const scenarioId = readSingleValue(argv, "--scenario-id=");
  if (!workspaceId || !scenarioId) {
    migrationError(
      "interactive_no_reply_target_required",
      "Exact workspace and scenario IDs are required"
    );
  }

  const expectedCountValue = readSingleValue(argv, "--expected-count=");
  let expectedCount: number | undefined;
  if (expectedCountValue !== undefined) {
    if (!/^(0|[1-9]\d*)$/.test(expectedCountValue)) {
      migrationError(
        "interactive_no_reply_invalid_expected_count",
        "Expected count must be a non-negative integer"
      );
    }
    expectedCount = Number(expectedCountValue);
    if (!Number.isSafeInteger(expectedCount)) {
      migrationError(
        "interactive_no_reply_invalid_expected_count",
        "Expected count must be a safe integer"
      );
    }
  }

  const outputPath = readSingleValue(argv, "--output=");
  if (outputPath && !isAbsolutePath(outputPath)) {
    migrationError(
      "interactive_no_reply_output_must_be_absolute",
      "Migration output path must be absolute"
    );
  }

  const expectedRevisionValue = readSingleValue(argv, "--expected-revision=");
  let expectedRevision: string | undefined;
  if (expectedRevisionValue !== undefined) {
    const parsed = new Date(expectedRevisionValue);
    if (Number.isNaN(parsed.getTime())) {
      migrationError(
        "interactive_no_reply_invalid_expected_revision",
        "Expected revision must be a valid date-time"
      );
    }
    expectedRevision = parsed.toISOString();
  }

  const expectedBeforeSha256 = readSingleValue(
    argv,
    "--expected-before-sha256="
  );
  if (
    expectedBeforeSha256 !== undefined &&
    !/^[a-f0-9]{64}$/.test(expectedBeforeSha256)
  ) {
    migrationError(
      "interactive_no_reply_invalid_expected_before_hash",
      "Expected graph hash must be a lowercase SHA-256 value"
    );
  }

  const expectedPreimageSha256 = readSingleValue(
    argv,
    "--expected-preimage-sha256="
  );
  if (
    expectedPreimageSha256 !== undefined &&
    !/^[a-f0-9]{64}$/.test(expectedPreimageSha256)
  ) {
    migrationError(
      "interactive_no_reply_invalid_expected_preimage_hash",
      "Expected preimage hash must be a lowercase SHA-256 value"
    );
  }

  const apply = argv.includes("--apply");
  if (
    apply &&
    (!outputPath ||
      !expectedRevision ||
      !expectedBeforeSha256 ||
      !expectedPreimageSha256)
  ) {
    migrationError(
      "interactive_no_reply_apply_contract_required",
      "Apply requires an absolute output path, expected revision, expected graph hash, and expected preimage hash"
    );
  }

  return {
    apply,
    workspaceId,
    scenarioId,
    ...(expectedCount === undefined ? {} : { expectedCount }),
    ...(expectedRevision ? { expectedRevision } : {}),
    ...(expectedBeforeSha256 ? { expectedBeforeSha256 } : {}),
    ...(expectedPreimageSha256 ? { expectedPreimageSha256 } : {}),
    ...(outputPath ? { outputPath } : {}),
  };
}

function readExpectedRevision(value: unknown): string {
  const parsed =
    value instanceof Date
      ? value
      : typeof value === "string"
        ? new Date(value)
        : null;
  if (parsed && !Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return migrationError(
    "interactive_no_reply_revision_required",
    "Scenario updatedAt revision is required"
  );
}

function normalizeRequestedRevision(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function assertApplyContract(args: InteractiveNoReplyMigrationArgs): void {
  if (!args.apply) return;
  if (
    !args.outputPath?.trim() ||
    !isAbsolutePath(args.outputPath) ||
    !normalizeRequestedRevision(args.expectedRevision) ||
    !args.expectedBeforeSha256 ||
    !/^[a-f0-9]{64}$/.test(args.expectedBeforeSha256) ||
    !args.expectedPreimageSha256 ||
    !/^[a-f0-9]{64}$/.test(args.expectedPreimageSha256)
  ) {
    migrationError(
      "interactive_no_reply_apply_contract_required",
      "Apply requires an absolute output path, expected revision, expected graph hash, and expected preimage hash"
    );
  }
}

function asGraph(
  scenario: InteractiveNoReplyMigrationScenarioSnapshot
): LegacyActionRoutingGraph {
  if (!Array.isArray(scenario.nodes) || !Array.isArray(scenario.edges)) {
    return migrationError(
      "interactive_no_reply_invalid_graph",
      "Scenario graph must contain node and edge arrays"
    );
  }
  return {
    nodes: scenario.nodes as LegacyActionRoutingGraph["nodes"],
    edges: scenario.edges as LegacyActionRoutingGraph["edges"],
  };
}

function emitPlanEvents(params: {
  emit: (event: InteractiveNoReplyMigrationEvent) => void;
  args: InteractiveNoReplyMigrationArgs;
  mode: "dry_run" | "apply";
  scenarioRevision: string;
  plan: InteractiveNoReplyMigrationPlan;
  preimage: InteractiveNoReplyMigrationPreimage;
  pendingConversations: InteractiveNoReplyPendingConversation[];
}): void {
  params.emit({
    type: "migration_plan",
    mode: params.mode,
    workspaceId: params.args.workspaceId,
    scenarioId: params.args.scenarioId,
    candidateCount: params.plan.candidates.length,
    skipCount: params.plan.skips.length,
    dedicatedAssignmentCount: params.plan.dedicatedAssignmentCount,
    pendingConversationCount: params.pendingConversations.length,
    linkedConditionCount: params.preimage.linkedConditions.length,
    scenarioRevision: params.scenarioRevision,
    preimageSha256: params.preimage.preimageSha256,
    hashes: params.plan.hashes,
  });
  for (const candidate of params.plan.candidates) {
    params.emit({ type: "migration_candidate", ...candidate });
  }
  for (const skip of params.plan.skips) {
    params.emit({ type: "migration_skip", ...skip });
  }
  for (const conversation of params.pendingConversations) {
    params.emit({ type: "migration_pending_conversation", ...conversation });
  }
}

function buildApplyResultEvent(
  result: LegacyRoutingConversionTransactionResult
): Extract<
  InteractiveNoReplyMigrationEvent,
  { type: "migration_apply_result" }
> {
  return {
    type: "migration_apply_result",
    beforeRevision: result.beforeRevision,
    afterRevision: result.afterRevision,
    convertedConditionNodeIds: result.convertedConditionNodeIds,
    convertedActionNodeIds: result.convertedActionNodeIds,
    remappedConversationIds: result.remappedConversationIds,
    timerReplanResults: result.timerReplanResults,
    postCommitWarnings: result.postCommitWarnings,
  };
}

type MigrationErrorRecord = {
  code?: unknown;
  message?: unknown;
  committed?: unknown;
  committedResult?: unknown;
  timerReplanFailures?: unknown;
  priorCommittedError?: unknown;
  remainingPendingConversations?: unknown;
  remainingLinkedConditionIds?: unknown;
};

function asMigrationErrorRecord(error: unknown): MigrationErrorRecord {
  return error !== null && typeof error === "object"
    ? (error as MigrationErrorRecord)
    : {};
}

function readCommittedResult(
  error: unknown
): LegacyRoutingConversionTransactionResult | null {
  const value = asMigrationErrorRecord(error);
  return value.committed === true &&
    value.committedResult !== null &&
    typeof value.committedResult === "object"
    ? (value.committedResult as LegacyRoutingConversionTransactionResult)
    : null;
}

export function buildInteractiveNoReplyMigrationErrorEvent(
  error: unknown
): InteractiveNoReplyMigrationErrorEvent {
  const value = asMigrationErrorRecord(error);
  const committedResult = readCommittedResult(error);
  const committed = value.committed === true || committedResult !== null;
  const remainingPendingConversations = Array.isArray(
    value.remainingPendingConversations
  )
    ? (value.remainingPendingConversations as InteractiveNoReplyPendingConversation[])
    : [];
  const remainingLinkedConditionIds = Array.isArray(
    value.remainingLinkedConditionIds
  )
    ? value.remainingLinkedConditionIds.filter(
        (id): id is string => typeof id === "string"
      )
    : [];
  const priorCommittedError =
    value.priorCommittedError !== null &&
    typeof value.priorCommittedError === "object" &&
    typeof (value.priorCommittedError as { code?: unknown }).code ===
      "string" &&
    typeof (value.priorCommittedError as { message?: unknown }).message ===
      "string"
      ? (value.priorCommittedError as InteractiveNoReplyMigrationPriorCommittedError)
      : null;

  return {
    type: "migration_error",
    code: typeof value.code === "string" ? value.code : "unknown_error",
    message: typeof value.message === "string" ? value.message : String(error),
    ...(committed ? { committed: true as const } : {}),
    ...(Array.isArray(value.timerReplanFailures)
      ? { timerReplanFailures: value.timerReplanFailures }
      : {}),
    ...(committedResult && Array.isArray(committedResult.postCommitWarnings)
      ? { postCommitWarnings: committedResult.postCommitWarnings }
      : {}),
    ...(priorCommittedError ? { priorCommittedError } : {}),
    ...(remainingPendingConversations.length > 0
      ? { remainingPendingConversations }
      : {}),
    ...(remainingLinkedConditionIds.length > 0
      ? { remainingLinkedConditionIds }
      : {}),
  };
}

function readCommittedErrorContext(error: unknown): {
  timerReplanFailures?: unknown[];
  priorCommittedError?: InteractiveNoReplyMigrationPriorCommittedError;
} {
  const value = asMigrationErrorRecord(error);
  if (error === undefined) return {};
  return {
    ...(Array.isArray(value.timerReplanFailures)
      ? { timerReplanFailures: value.timerReplanFailures }
      : {}),
    priorCommittedError: {
      code: typeof value.code === "string" ? value.code : "unknown_error",
      message:
        typeof value.message === "string" ? value.message : String(error),
    },
  };
}

function candidatePairs(
  candidates: InteractiveNoReplyMigrationCandidate[]
): LegacyRoutingMigrationCandidatePair[] {
  return candidates.map(candidate => ({
    sourceActionNodeId: candidate.sourceActionNodeId,
    sourceNodeId: candidate.sourceNodeId,
  }));
}

function pendingConversationsFromPreimage(params: {
  preimage: InteractiveNoReplyMigrationPreimage;
}): InteractiveNoReplyPendingConversation[] {
  return params.preimage.pendingConversations.map(row => {
    const state =
      row.airi_scenario_state !== null &&
      typeof row.airi_scenario_state === "object" &&
      !Array.isArray(row.airi_scenario_state)
        ? (row.airi_scenario_state as Record<string, unknown>)
        : null;
    const sourceActionNodeId = readId(state?.pendingSourceActionNodeId);
    const sourceNodeId = readId(state?.pendingConditionNodeId);
    return {
      conversationId: row._id,
      sourceActionNodeId,
      sourceNodeId,
      airiScenarioState: row.airi_scenario_state,
      updatedAt: row.updatedAt,
      __v: row.__v,
    };
  });
}

function sameCandidatePairs(
  left: LegacyRoutingMigrationCandidatePair[],
  right: LegacyRoutingMigrationCandidatePair[]
): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (candidate, index) =>
      legacyRoutingMigrationCandidatePairKey(candidate) ===
      legacyRoutingMigrationCandidatePairKey(right[index])
  );
}

export async function runInteractiveNoReplyMigrationOperator(
  args: InteractiveNoReplyMigrationArgs,
  dependencies: InteractiveNoReplyMigrationOperatorDependencies
): Promise<InteractiveNoReplyMigrationOperatorResult> {
  assertApplyContract(args);
  await dependencies.assertTimerReplanIngressReady();
  const discoveryState = await dependencies.loadState({
    workspaceId: args.workspaceId,
    scenarioId: args.scenarioId,
    candidatePairs: [],
  });
  const scenario = discoveryState?.semantic.scenario;
  if (!scenario) {
    return migrationError(
      "interactive_no_reply_scenario_not_found",
      "Scenario not found"
    );
  }
  if (
    readId(scenario._id) !== args.scenarioId ||
    readId(scenario.workspaceId) !== args.workspaceId
  ) {
    return migrationError(
      "interactive_no_reply_scenario_identity_mismatch",
      "Loaded scenario does not match the requested target"
    );
  }

  const expectedUpdatedAt = readExpectedRevision(scenario.updatedAt);
  const plan = planInteractiveNoReplyAssignmentMigration(asGraph(scenario));
  if (
    args.apply &&
    normalizeRequestedRevision(args.expectedRevision) !== expectedUpdatedAt
  ) {
    return migrationError(
      "interactive_no_reply_revision_mismatch",
      `Reviewed scenario revision ${args.expectedRevision} does not match ${expectedUpdatedAt}`
    );
  }
  if (args.apply && args.expectedBeforeSha256 !== plan.hashes.beforeSha256) {
    return migrationError(
      "interactive_no_reply_before_hash_mismatch",
      `Reviewed graph hash ${args.expectedBeforeSha256} does not match ${plan.hashes.beforeSha256}`
    );
  }
  if (
    args.expectedCount !== undefined &&
    plan.candidates.length !== args.expectedCount
  ) {
    return migrationError(
      "interactive_no_reply_candidate_count_mismatch",
      `Expected ${args.expectedCount} migration candidates, found ${plan.candidates.length}`
    );
  }
  if (args.apply && plan.skips.length > 0) {
    return migrationError(
      "interactive_no_reply_unsafe_assignments",
      "Unsafe dedicated assignments must be resolved before apply"
    );
  }

  const exactCandidatePairs = candidatePairs(plan.candidates);
  const exactState = await dependencies.loadState({
    workspaceId: args.workspaceId,
    scenarioId: args.scenarioId,
    candidatePairs: exactCandidatePairs,
  });
  if (!exactState) {
    return migrationError(
      "interactive_no_reply_scenario_not_found",
      "Scenario not found"
    );
  }
  const preimage = exactState.preimage;
  const exactScenario = exactState.semantic.scenario;
  const loadedPlan = planInteractiveNoReplyAssignmentMigration(
    asGraph(exactScenario)
  );
  if (
    readId(exactScenario._id) !== args.scenarioId ||
    readId(exactScenario.workspaceId) !== args.workspaceId ||
    readExpectedRevision(exactScenario.updatedAt) !== expectedUpdatedAt ||
    loadedPlan.hashes.beforeSha256 !== plan.hashes.beforeSha256 ||
    !sameCandidatePairs(
      candidatePairs(loadedPlan.candidates),
      exactCandidatePairs
    )
  ) {
    return migrationError(
      "interactive_no_reply_preimage_target_changed",
      "Scenario routing changed while the exact migration preimage was being loaded"
    );
  }
  const pendingConversations = pendingConversationsFromPreimage({
    preimage,
  });
  const externalStateIssues =
    classifyLegacyRoutingMigrationExternalState(preimage);
  if (args.apply && args.expectedPreimageSha256 !== preimage.preimageSha256) {
    return migrationError(
      "interactive_no_reply_preimage_hash_mismatch",
      `Reviewed preimage hash ${args.expectedPreimageSha256} does not match ${preimage.preimageSha256}`
    );
  }
  const mode = args.apply ? "apply" : "dry_run";
  const emit = dependencies.emit ?? (() => undefined);
  emitPlanEvents({
    emit,
    args,
    mode,
    scenarioRevision: expectedUpdatedAt,
    plan,
    preimage,
    pendingConversations,
  });

  if (args.outputPath) {
    await dependencies.writePreimage(args.outputPath, preimage);
    emit({ type: "migration_preimage_written", outputPath: args.outputPath });
  }
  if (externalStateIssues.length > 0) {
    return migrationError(
      "interactive_no_reply_external_state_invalid",
      `Found ${externalStateIssues.length} malformed or wrong-source external routing reference(s) in the reviewed preimage`
    );
  }

  let applyResult: LegacyRoutingConversionTransactionResult | undefined;
  if (args.apply && plan.candidates.length > 0) {
    let committedApplyError: unknown;
    try {
      applyResult = await dependencies.applyMigration({
        scenarioId: args.scenarioId,
        workspaceId: args.workspaceId,
        updatedBy: MIGRATION_UPDATED_BY,
        expectedUpdatedAt,
        conversions: plan.candidates.map(candidate => ({
          sourceActionNodeId: candidate.sourceActionNodeId,
          sourceNodeId: candidate.sourceNodeId,
          sourceKind: candidate.sourceKind,
        })),
        expectedDedicatedAssignmentCount: plan.dedicatedAssignmentCount,
        expectedPreimageSha256: preimage.preimageSha256,
      });
    } catch (error) {
      const committedResult = readCommittedResult(error);
      if (!committedResult) throw error;
      applyResult = committedResult;
      committedApplyError = error;
    }
    emit(buildApplyResultEvent(applyResult));

    const originalCandidatePairs = candidatePairs(plan.candidates);
    let remainingPendingConversations: InteractiveNoReplyPendingConversation[];
    let remainingLinkedConditionIds: string[];
    try {
      const verificationState = await dependencies.loadState({
        workspaceId: args.workspaceId,
        scenarioId: args.scenarioId,
        candidatePairs: originalCandidatePairs,
      });
      if (!verificationState) {
        throw new Error("Scenario disappeared after migration commit");
      }
      const verificationPreimage = verificationState.preimage;
      remainingPendingConversations = pendingConversationsFromPreimage({
        preimage: verificationPreimage,
      });
      remainingLinkedConditionIds = verificationPreimage.linkedConditions.map(
        linkedCondition => linkedCondition._id
      );
    } catch (cause) {
      throw new InteractiveNoReplyMigrationError(
        "interactive_no_reply_post_commit_verification_failed",
        "Migration committed, but the old pending-wait verification failed.",
        {
          committedResult: applyResult,
          cause,
          ...readCommittedErrorContext(committedApplyError),
        }
      );
    }
    emit({
      type: "migration_post_commit_wait_verification",
      candidatePairs: originalCandidatePairs,
      remainingConversationIds: remainingPendingConversations.map(
        conversation => conversation.conversationId
      ),
      remainingLinkedConditionIds,
      passed:
        remainingPendingConversations.length === 0 &&
        remainingLinkedConditionIds.length === 0,
    });
    if (remainingPendingConversations.length > 0) {
      throw new InteractiveNoReplyMigrationError(
        "interactive_no_reply_post_commit_waits_remaining",
        "Migration committed, but at least one old pending wait remains.",
        {
          committedResult: applyResult,
          remainingPendingConversations,
          remainingLinkedConditionIds,
          ...readCommittedErrorContext(committedApplyError),
        }
      );
    }
    if (remainingLinkedConditionIds.length > 0) {
      throw new InteractiveNoReplyMigrationError(
        "interactive_no_reply_post_commit_linked_conditions_remaining",
        "Migration committed, but at least one old linked-condition parent reference remains.",
        {
          committedResult: applyResult,
          remainingLinkedConditionIds,
          ...readCommittedErrorContext(committedApplyError),
        }
      );
    }
    if (committedApplyError !== undefined) throw committedApplyError;
  }

  const applied = Boolean(applyResult);
  emit({
    type: "migration_complete",
    mode,
    applied,
    candidateCount: plan.candidates.length,
    pendingConversationCount: pendingConversations.length,
  });

  return {
    mode,
    workspaceId: args.workspaceId,
    scenarioId: args.scenarioId,
    candidateCount: plan.candidates.length,
    pendingConversationCount: pendingConversations.length,
    applied,
    plan,
    ...(applyResult ? { applyResult } : {}),
  };
}
