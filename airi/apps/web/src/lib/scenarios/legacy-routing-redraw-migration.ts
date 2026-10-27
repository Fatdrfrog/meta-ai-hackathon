import path from "node:path";
import { readId } from "@/lib/scenarios/read-id";

import {
  collectEligibleLegacyRoutingConversions,
  type EligibleLegacyRoutingConversion,
  type LegacyActionRoutingGraph,
  type LegacyRoutingLeftoverNode,
} from "./legacy-action-routing";
import { hashLegacyRoutingMigrationValue } from "./legacy-routing-migration-preimage";
import type {
  LegacyRoutingConversionInstruction,
  LegacyRoutingConversionTransactionResult,
} from "./legacy-routing-conversion-service";

export const LEGACY_ROUTING_REDRAW_MIGRATION_UPDATED_BY =
  "migration:legacy-routing-redraw";

export type LegacyRoutingRedrawMigrationArgs = {
  apply: boolean;
  relayout: boolean;
  allWorkspaces: boolean;
  workspaceId?: string;
  scenarioId?: string;
  expectedCount?: number;
  expectedScenarioCount?: number;
  expectedInventorySha256?: string;
  outputPath?: string;
};

export type LegacyRoutingRedrawScenarioSnapshot = Record<string, unknown> & {
  _id?: unknown;
  workspaceId?: unknown;
  name?: unknown;
  status?: unknown;
  updatedAt?: unknown;
  nodes?: unknown;
  edges?: unknown;
};

export type LegacyRoutingRedrawScenarioPlan = {
  workspaceId: string;
  scenarioId: string;
  name: string;
  status: string;
  scenarioRevision: string;
  candidateCount: number;
  leftoverCount: number;
  conversions: EligibleLegacyRoutingConversion[];
  leftovers: LegacyRoutingLeftoverNode[];
  hashes: {
    beforeSha256: string;
    afterSha256: string;
  };
};

export type LegacyRoutingRedrawInventory = {
  version: 1;
  relayout: boolean;
  target: {
    allWorkspaces: boolean;
    workspaceId: string | null;
    scenarioId: string | null;
  };
  scenarioCount: number;
  convertibleScenarioCount: number;
  candidateCount: number;
  leftoverCount: number;
  scenarios: LegacyRoutingRedrawScenarioPlan[];
  inventorySha256: string;
};

export type LegacyRoutingRedrawMigrationEvent =
  | {
      type: "migration_inventory";
      mode: "dry_run" | "apply";
      relayout: boolean;
      scenarioCount: number;
      convertibleScenarioCount: number;
      candidateCount: number;
      leftoverCount: number;
      inventorySha256: string;
    }
  | ({ type: "migration_scenario_plan" } & LegacyRoutingRedrawScenarioPlan)
  | {
      type: "migration_leftover";
      workspaceId: string;
      scenarioId: string;
      leftover: LegacyRoutingLeftoverNode;
    }
  | { type: "migration_preimage_written"; outputPath: string }
  | {
      type: "migration_apply_result";
      workspaceId: string;
      scenarioId: string;
      beforeRevision: string;
      afterRevision: string;
      convertedConditionNodeIds: string[];
      convertedActionNodeIds: string[];
      remappedConversationIds: string[];
      timerReplanResults: LegacyRoutingConversionTransactionResult["timerReplanResults"];
      postCommitWarnings: LegacyRoutingConversionTransactionResult["postCommitWarnings"];
    }
  | {
      type: "migration_complete";
      mode: "dry_run" | "apply";
      applied: boolean;
      appliedScenarioCount: number;
      candidateCount: number;
      leftoverCount: number;
    }
  | LegacyRoutingRedrawMigrationErrorEvent;

export type LegacyRoutingRedrawMigrationErrorEvent = {
  type: "migration_error";
  code: string;
  message: string;
  committed?: true;
};

class LegacyRoutingRedrawMigrationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LegacyRoutingRedrawMigrationError";
    this.code = code;
  }
}

function migrationError(code: string, message: string): never {
  throw new LegacyRoutingRedrawMigrationError(code, message);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
    "legacy_routing_redraw_revision_required",
    "Scenario updatedAt revision is required"
  );
}

function semanticGraphValue(graph: LegacyActionRoutingGraph): unknown {
  return {
    nodes: graph.nodes.map(node => ({
      id: node.id,
      data: node.data,
    })),
    edges: graph.edges.map(edge => ({
      id: typeof edge.id === "string" ? edge.id : null,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? null,
      targetHandle: edge.targetHandle ?? null,
    })),
  };
}

function semanticGraphHash(graph: LegacyActionRoutingGraph): string {
  return hashLegacyRoutingMigrationValue(semanticGraphValue(graph));
}

function asGraph(
  scenario: LegacyRoutingRedrawScenarioSnapshot
): LegacyActionRoutingGraph {
  if (!Array.isArray(scenario.nodes) || !Array.isArray(scenario.edges)) {
    return migrationError(
      "legacy_routing_redraw_invalid_graph",
      "Scenario graph must contain node and edge arrays"
    );
  }
  return {
    nodes: scenario.nodes as LegacyActionRoutingGraph["nodes"],
    edges: scenario.edges as LegacyActionRoutingGraph["edges"],
  };
}

export function planLegacyRoutingRedraw(
  graph: LegacyActionRoutingGraph
): ReturnType<typeof collectEligibleLegacyRoutingConversions> & {
  hashes: { beforeSha256: string; afterSha256: string };
} {
  const plan = collectEligibleLegacyRoutingConversions(graph);
  return {
    ...plan,
    hashes: {
      beforeSha256: semanticGraphHash(graph),
      afterSha256: semanticGraphHash(plan.convertedGraph),
    },
  };
}

export function planLegacyRoutingRedrawScenario(
  scenario: LegacyRoutingRedrawScenarioSnapshot
): LegacyRoutingRedrawScenarioPlan {
  const workspaceId = readId(scenario.workspaceId);
  const scenarioId = readId(scenario._id);
  if (!workspaceId || !scenarioId) {
    return migrationError(
      "legacy_routing_redraw_target_required",
      "Scenario workspace and identifier are required"
    );
  }
  const graphPlan = planLegacyRoutingRedraw(asGraph(scenario));
  return {
    workspaceId,
    scenarioId,
    name: typeof scenario.name === "string" ? scenario.name : "",
    status: typeof scenario.status === "string" ? scenario.status : "",
    scenarioRevision: readExpectedRevision(scenario.updatedAt),
    candidateCount: graphPlan.conversions.length,
    leftoverCount: graphPlan.leftovers.length,
    conversions: graphPlan.conversions,
    leftovers: graphPlan.leftovers,
    hashes: graphPlan.hashes,
  };
}

export function buildLegacyRoutingRedrawInventory(params: {
  args: LegacyRoutingRedrawMigrationArgs;
  scenarios: LegacyRoutingRedrawScenarioSnapshot[];
}): LegacyRoutingRedrawInventory {
  const scenarios = params.scenarios
    .map(planLegacyRoutingRedrawScenario)
    .sort((left, right) => {
      const workspaceOrder = compareText(left.workspaceId, right.workspaceId);
      return workspaceOrder !== 0
        ? workspaceOrder
        : compareText(left.scenarioId, right.scenarioId);
    });
  const payload = {
    version: 1 as const,
    relayout: params.args.relayout,
    target: {
      allWorkspaces: params.args.allWorkspaces,
      workspaceId: params.args.workspaceId ?? null,
      scenarioId: params.args.scenarioId ?? null,
    },
    scenarioCount: scenarios.length,
    convertibleScenarioCount: scenarios.filter(
      scenario => scenario.candidateCount > 0
    ).length,
    candidateCount: scenarios.reduce(
      (total, scenario) => total + scenario.candidateCount,
      0
    ),
    leftoverCount: scenarios.reduce(
      (total, scenario) => total + scenario.leftoverCount,
      0
    ),
    scenarios,
  };
  return {
    ...payload,
    inventorySha256: hashLegacyRoutingMigrationValue(payload),
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
      "legacy_routing_redraw_duplicate_argument",
      `${prefix.slice(0, -1)} may be provided only once`
    );
  }
  if (values.length === 0) return undefined;
  if (!values[0]) {
    return migrationError(
      "legacy_routing_redraw_empty_argument",
      `${prefix.slice(0, -1)} must not be empty`
    );
  }
  return values[0];
}

function isAbsolutePath(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function readNonNegativeInteger(
  value: string,
  code: string,
  message: string
): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    migrationError(code, message);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    migrationError(code, message);
  }
  return parsed;
}

export function parseLegacyRoutingRedrawMigrationArgs(
  argv: string[]
): LegacyRoutingRedrawMigrationArgs {
  const supportedPrefixes = [
    "--workspace-id=",
    "--scenario-id=",
    "--expected-count=",
    "--expected-scenario-count=",
    "--expected-inventory-sha256=",
    "--output=",
  ];
  const flags = new Set([
    "--",
    "--apply",
    "--relayout",
    "--all-workspaces",
    "--confirm-all-workspaces",
  ]);
  const unknown = argv.find(
    arg =>
      !flags.has(arg) &&
      !supportedPrefixes.some(prefix => arg.startsWith(prefix))
  );
  if (unknown) {
    migrationError(
      "legacy_routing_redraw_unknown_argument",
      `Unknown migration argument: ${unknown}`
    );
  }
  for (const flag of flags) {
    if (argv.filter(arg => arg === flag).length > 1) {
      migrationError(
        "legacy_routing_redraw_duplicate_argument",
        `${flag} may be provided only once`
      );
    }
  }

  const allWorkspaces = argv.includes("--all-workspaces");
  const confirmAllWorkspaces = argv.includes("--confirm-all-workspaces");
  const workspaceId = readSingleValue(argv, "--workspace-id=");
  const scenarioId = readSingleValue(argv, "--scenario-id=");
  if (allWorkspaces && !confirmAllWorkspaces) {
    migrationError(
      "legacy_routing_redraw_confirm_all_workspaces_required",
      "--all-workspaces requires --confirm-all-workspaces"
    );
  }
  if (allWorkspaces && (workspaceId || scenarioId)) {
    migrationError(
      "legacy_routing_redraw_conflicting_target",
      "--all-workspaces cannot be combined with a workspace or scenario filter"
    );
  }
  if (!allWorkspaces && !workspaceId) {
    migrationError(
      "legacy_routing_redraw_target_required",
      "A workspace ID is required unless --all-workspaces is confirmed"
    );
  }

  const expectedCountValue = readSingleValue(argv, "--expected-count=");
  const expectedCount =
    expectedCountValue === undefined
      ? undefined
      : readNonNegativeInteger(
          expectedCountValue,
          "legacy_routing_redraw_invalid_expected_count",
          "Expected count must be a non-negative integer"
        );
  const expectedScenarioCountValue = readSingleValue(
    argv,
    "--expected-scenario-count="
  );
  const expectedScenarioCount =
    expectedScenarioCountValue === undefined
      ? undefined
      : readNonNegativeInteger(
          expectedScenarioCountValue,
          "legacy_routing_redraw_invalid_expected_scenario_count",
          "Expected scenario count must be a non-negative integer"
        );
  const outputPath = readSingleValue(argv, "--output=");
  if (outputPath && !isAbsolutePath(outputPath)) {
    migrationError(
      "legacy_routing_redraw_output_must_be_absolute",
      "Migration output path must be absolute"
    );
  }
  const expectedInventorySha256 = readSingleValue(
    argv,
    "--expected-inventory-sha256="
  );
  if (
    expectedInventorySha256 !== undefined &&
    !/^[a-f0-9]{64}$/.test(expectedInventorySha256)
  ) {
    migrationError(
      "legacy_routing_redraw_invalid_expected_inventory_hash",
      "Expected inventory hash must be a lowercase SHA-256 value"
    );
  }

  const apply = argv.includes("--apply");
  if (
    apply &&
    (!outputPath ||
      expectedCount === undefined ||
      expectedScenarioCount === undefined ||
      !expectedInventorySha256)
  ) {
    migrationError(
      "legacy_routing_redraw_apply_contract_required",
      "Apply requires an absolute output path, expected conversion count, expected convertible scenario count, and expected inventory hash"
    );
  }

  return {
    apply,
    relayout: argv.includes("--relayout"),
    allWorkspaces,
    ...(workspaceId ? { workspaceId } : {}),
    ...(scenarioId ? { scenarioId } : {}),
    ...(expectedCount === undefined ? {} : { expectedCount }),
    ...(expectedScenarioCount === undefined ? {} : { expectedScenarioCount }),
    ...(expectedInventorySha256 ? { expectedInventorySha256 } : {}),
    ...(outputPath ? { outputPath } : {}),
  };
}

export function buildLegacyRoutingRedrawMigrationErrorEvent(
  error: unknown
): LegacyRoutingRedrawMigrationErrorEvent {
  if (error instanceof LegacyRoutingRedrawMigrationError) {
    return {
      type: "migration_error",
      code: error.code,
      message: error.message,
    };
  }
  const record =
    error !== null && typeof error === "object"
      ? (error as {
          code?: unknown;
          message?: unknown;
          committed?: unknown;
        })
      : {};
  return {
    type: "migration_error",
    code:
      typeof record.code === "string" && record.code.trim()
        ? record.code
        : "legacy_routing_redraw_failed",
    message:
      error instanceof Error && error.message.trim()
        ? error.message
        : "Legacy routing redraw migration failed",
    ...(record.committed === true ? { committed: true } : {}),
  };
}

function emitInventoryEvents(params: {
  emit: (event: LegacyRoutingRedrawMigrationEvent) => void;
  mode: "dry_run" | "apply";
  inventory: LegacyRoutingRedrawInventory;
}): void {
  params.emit({
    type: "migration_inventory",
    mode: params.mode,
    relayout: params.inventory.relayout,
    scenarioCount: params.inventory.scenarioCount,
    convertibleScenarioCount: params.inventory.convertibleScenarioCount,
    candidateCount: params.inventory.candidateCount,
    leftoverCount: params.inventory.leftoverCount,
    inventorySha256: params.inventory.inventorySha256,
  });
  for (const scenario of params.inventory.scenarios) {
    params.emit({ type: "migration_scenario_plan", ...scenario });
    for (const leftover of scenario.leftovers) {
      params.emit({
        type: "migration_leftover",
        workspaceId: scenario.workspaceId,
        scenarioId: scenario.scenarioId,
        leftover,
      });
    }
  }
}

function assertInventoryContract(params: {
  args: LegacyRoutingRedrawMigrationArgs;
  inventory: LegacyRoutingRedrawInventory;
}): void {
  if (
    params.args.expectedCount !== undefined &&
    params.args.expectedCount !== params.inventory.candidateCount
  ) {
    migrationError(
      "legacy_routing_redraw_expected_count_mismatch",
      `Expected ${params.args.expectedCount} conversions but inventoried ${params.inventory.candidateCount}`
    );
  }
  if (
    params.args.expectedScenarioCount !== undefined &&
    params.args.expectedScenarioCount !==
      params.inventory.convertibleScenarioCount
  ) {
    migrationError(
      "legacy_routing_redraw_expected_scenario_count_mismatch",
      `Expected ${params.args.expectedScenarioCount} convertible scenarios but inventoried ${params.inventory.convertibleScenarioCount}`
    );
  }
  if (
    params.args.expectedInventorySha256 &&
    params.args.expectedInventorySha256 !== params.inventory.inventorySha256
  ) {
    migrationError(
      "legacy_routing_redraw_inventory_mismatch",
      "The inventoried scenarios changed after review."
    );
  }
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value
  );
}

async function loadListedScenarios(
  listScenarios: (
    args: LegacyRoutingRedrawMigrationArgs
  ) =>
    | Promise<LegacyRoutingRedrawScenarioSnapshot[]>
    | AsyncIterable<LegacyRoutingRedrawScenarioSnapshot>,
  args: LegacyRoutingRedrawMigrationArgs
): Promise<LegacyRoutingRedrawScenarioSnapshot[]> {
  const listed = listScenarios(args);
  if (isAsyncIterable<LegacyRoutingRedrawScenarioSnapshot>(listed)) {
    const scenarios: LegacyRoutingRedrawScenarioSnapshot[] = [];
    for await (const scenario of listed) {
      scenarios.push(scenario);
    }
    return scenarios;
  }
  return listed;
}

function readCommittedApplyResult(
  error: unknown
): LegacyRoutingConversionTransactionResult | null {
  if (!error || typeof error !== "object") return null;
  const value = error as {
    committed?: unknown;
    committedResult?: unknown;
  };
  return value.committed === true &&
    value.committedResult !== null &&
    typeof value.committedResult === "object"
    ? (value.committedResult as LegacyRoutingConversionTransactionResult)
    : null;
}

export async function runLegacyRoutingRedrawMigrationOperator(
  args: LegacyRoutingRedrawMigrationArgs,
  ports: {
    listScenarios: (
      args: LegacyRoutingRedrawMigrationArgs
    ) =>
      | Promise<LegacyRoutingRedrawScenarioSnapshot[]>
      | AsyncIterable<LegacyRoutingRedrawScenarioSnapshot>;
    applyMigration: (params: {
      scenarioId: string;
      workspaceId: string;
      updatedBy: string;
      expectedUpdatedAt: string;
      conversions: LegacyRoutingConversionInstruction[];
      relayout?: boolean;
    }) => Promise<LegacyRoutingConversionTransactionResult>;
    writePreimage: (
      outputPath: string,
      inventory: LegacyRoutingRedrawInventory
    ) => Promise<void>;
    emit: (event: LegacyRoutingRedrawMigrationEvent) => void;
  }
): Promise<{
  mode: "dry_run" | "apply";
  applied: boolean;
  inventory: LegacyRoutingRedrawInventory;
}> {
  const scenarios = await loadListedScenarios(ports.listScenarios, args);
  const inventory = buildLegacyRoutingRedrawInventory({ args, scenarios });
  const mode = args.apply ? "apply" : "dry_run";
  emitInventoryEvents({ emit: ports.emit, mode, inventory });
  assertInventoryContract({ args, inventory });

  if (args.outputPath) {
    await ports.writePreimage(args.outputPath, inventory);
    ports.emit({
      type: "migration_preimage_written",
      outputPath: args.outputPath,
    });
  }

  if (!args.apply) {
    ports.emit({
      type: "migration_complete",
      mode,
      applied: false,
      appliedScenarioCount: 0,
      candidateCount: inventory.candidateCount,
      leftoverCount: inventory.leftoverCount,
    });
    return { mode, applied: false, inventory };
  }

  const candidates = inventory.scenarios.filter(
    scenario => scenario.candidateCount > 0
  );
  type ApplyAttempt = {
    scenario: LegacyRoutingRedrawScenarioPlan;
    result?: LegacyRoutingConversionTransactionResult;
    error?: unknown;
  };
  const attempts: ApplyAttempt[] = await Promise.all(
    candidates.map(async scenario => {
      try {
        return {
          scenario,
          result: await ports.applyMigration({
            scenarioId: scenario.scenarioId,
            workspaceId: scenario.workspaceId,
            updatedBy: LEGACY_ROUTING_REDRAW_MIGRATION_UPDATED_BY,
            expectedUpdatedAt: scenario.scenarioRevision,
            conversions: scenario.conversions,
            relayout: args.relayout,
          }),
        };
      } catch (error) {
        const committedResult = readCommittedApplyResult(error);
        if (committedResult) {
          return { scenario, result: committedResult, error };
        }
        return { scenario, error };
      }
    })
  );

  let appliedScenarioCount = 0;
  for (const attempt of attempts) {
    if (!attempt.result) continue;
    appliedScenarioCount += 1;
    ports.emit({
      type: "migration_apply_result",
      workspaceId: attempt.scenario.workspaceId,
      scenarioId: attempt.scenario.scenarioId,
      beforeRevision: attempt.result.beforeRevision,
      afterRevision: attempt.result.afterRevision,
      convertedConditionNodeIds: attempt.result.convertedConditionNodeIds,
      convertedActionNodeIds: attempt.result.convertedActionNodeIds,
      remappedConversationIds: attempt.result.remappedConversationIds,
      timerReplanResults: attempt.result.timerReplanResults,
      postCommitWarnings: attempt.result.postCommitWarnings,
    });
  }

  const firstError = attempts.find(attempt => attempt.error)?.error;
  if (firstError) throw firstError;

  ports.emit({
    type: "migration_complete",
    mode,
    applied: true,
    appliedScenarioCount,
    candidateCount: inventory.candidateCount,
    leftoverCount: inventory.leftoverCount,
  });
  return { mode, applied: true, inventory };
}
