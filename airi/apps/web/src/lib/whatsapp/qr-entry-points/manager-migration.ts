import { createHash, randomUUID } from "node:crypto";

import type { ScenarioGraphNode } from "@icecore/scenario-contracts";
import { Types } from "mongoose";

import { normalizeScenarioNodesForPersistence } from "@/lib/scenarios/scenario-graph-persistence";
import { resolveScenarioTrigger } from "@/lib/scenarios/trigger-utils";
import type { WhatsAppQrEntryPointRecord } from "@/models/whatsapp-qr-entry-point";
import {
  asNullableRecord,
  asRecord,
  hasExactKeys,
} from "@icecore/shared/lib/value-utils";

import {
  normalizeWhatsAppQrEntryPointUuid,
  normalizeWhatsAppQrPlacementNameSearch,
} from "./normalization";
import { setWhatsAppQrGraphBinding } from "./scenario-binding";

const CURSOR_VERSION = 1 as const;
const WRITER_EVIDENCE_SCHEMA_VERSION = 1 as const;

type MigrationDatabaseRuntime = {
  connectDB: typeof import("@/lib/mongoose").default;
  assertWritesEnabled: typeof import("./indexes").assertWhatsAppQrUnassignedWritesEnabled;
  Scenario: typeof import("@/models/scenario").Scenario;
  WhatsAppQrEntryPoint: typeof import("@/models/whatsapp-qr-entry-point").WhatsAppQrEntryPoint;
  entryPointScanHint: string;
  scenarioScanHint: string;
};

let databaseRuntimePromise: Promise<MigrationDatabaseRuntime> | undefined;

async function loadDatabaseRuntime(): Promise<MigrationDatabaseRuntime> {
  databaseRuntimePromise ??= Promise.all([
    import("@/lib/mongoose"),
    import("./indexes"),
    import("@/models/scenario"),
    import("@/models/whatsapp-qr-entry-point"),
  ]).then(
    ([
      mongooseNamespace,
      indexesNamespace,
      scenarioNamespace,
      entryPointNamespace,
    ]) => {
      const mongooseRuntime = importedModuleRecord(mongooseNamespace);
      const indexes = importedModuleRecord(indexesNamespace);
      const scenarioModel = importedModuleRecord(scenarioNamespace);
      const entryPointModel = importedModuleRecord(entryPointNamespace);
      const connect =
        typeof mongooseRuntime.connectDB === "function"
          ? mongooseRuntime.connectDB
          : mongooseRuntime.default;
      if (
        typeof connect !== "function" ||
        typeof indexes.assertWhatsAppQrUnassignedWritesEnabled !== "function" ||
        !scenarioModel.Scenario ||
        !entryPointModel.WhatsAppQrEntryPoint ||
        !Array.isArray(entryPointModel.WHATSAPP_QR_ENTRY_POINT_INDEXES) ||
        !scenarioModel.WHATSAPP_QR_SCENARIO_MIGRATION_SCAN_INDEX
      ) {
        throw new Error("WhatsApp QR migration database runtime is invalid");
      }
      const entryPointScanIndex =
        entryPointModel.WHATSAPP_QR_ENTRY_POINT_INDEXES.find(
          (candidate: {
            key: Record<string, unknown>;
            options: { name: string };
          }) =>
            candidate.key.workspaceId === 1 &&
            "_id" in candidate.key &&
            candidate.key._id === 1
        );
      if (!entryPointScanIndex) {
        throw new Error(
          "WhatsApp QR entry-point migration scan index is missing"
        );
      }
      return {
        connectDB: connect as MigrationDatabaseRuntime["connectDB"],
        assertWritesEnabled:
          indexes.assertWhatsAppQrUnassignedWritesEnabled as MigrationDatabaseRuntime["assertWritesEnabled"],
        Scenario:
          scenarioModel.Scenario as MigrationDatabaseRuntime["Scenario"],
        WhatsAppQrEntryPoint:
          entryPointModel.WhatsAppQrEntryPoint as MigrationDatabaseRuntime["WhatsAppQrEntryPoint"],
        entryPointScanHint: entryPointScanIndex.options.name,
        scenarioScanHint: (
          scenarioModel.WHATSAPP_QR_SCENARIO_MIGRATION_SCAN_INDEX as {
            options: { name: string };
          }
        ).options.name,
      };
    }
  );
  return databaseRuntimePromise;
}

export type WhatsAppQrManagerMigrationScope =
  | { kind: "all" }
  | { kind: "workspace"; workspaceId: string };

export type WhatsAppQrManagerMigrationArgs = {
  apply: boolean;
  workspaceId?: string;
  batchSize: number;
  cursor?: string;
  maxPages?: number;
};

export type WhatsAppQrManagerMigrationSummary = {
  inventoryRunId: string;
  inventoryStartedAt: string;
  inventoryCompletedAt: string | null;
  scope: WhatsAppQrManagerMigrationScope;
  startedAtBeginning: boolean;
  pagesProcessed: number;
  scannedEntryPoints: number;
  searchKeysMissing: number;
  assignmentStatesMissing: number;
  scannedScenarios: number;
  pointersMissing: number;
  ambiguous: number;
  mismatched: number;
  casConflicts: number;
  writesApplied: number;
  nextCursor: string | null;
  inventoryComplete: boolean;
  dataReady: boolean;
};

export type WhatsAppQrManagerRolloutAttestationSummary = {
  inventoryRunId: string;
  inventoryReportSha256: string;
  writerDrainEvidence: {
    compatReleaseId: string;
    verifiedAt: string;
    coverageStartedAt: string;
    coverageCompletedAt: string;
    provider: string;
    evidenceId: string;
    deploymentFenceId: string;
    sha256: string;
  };
  rolloutReady: boolean;
};

type MigrationPhase = "entry_points" | "scenarios";

export type WhatsAppQrManagerMigrationIssueCode =
  | "entry_point_identity_invalid"
  | "entry_point_version_invalid"
  | "placement_name_invalid"
  | "placement_name_search_missing"
  | "placement_name_search_mismatch"
  | "assignment_state_missing"
  | "assignment_state_mismatch"
  | "assignment_projection_partial"
  | "assignment_scenario_id_invalid"
  | "assignment_scenario_missing"
  | "assignment_scenario_wrong_workspace"
  | "assignment_scenario_deleted"
  | "assignment_node_missing"
  | "assignment_node_wrong_kind"
  | "assignment_graph_pointer_missing"
  | "assignment_graph_pointer_mismatch"
  | "assignment_graph_pointer_duplicate"
  | "scenario_graph_invalid"
  | "scenario_revision_invalid"
  | "scenario_node_invalid"
  | "scenario_node_id_invalid"
  | "scenario_pointer_malformed"
  | "scenario_pointer_duplicate"
  | "scenario_pointer_entry_point_missing"
  | "scenario_pointer_wrong_workspace"
  | "scenario_pointer_projection_partial"
  | "scenario_pointer_projection_mismatch"
  | "scenario_pointer_projection_state_mismatch"
  | "scenario_pointer_entry_point_id_invalid"
  | "scenario_pointer_missing_projection"
  | "scenario_pointer_ambiguous_projection"
  | "scenario_deleted"
  | "entry_point_cas_conflict"
  | "scenario_cas_conflict";

export type WhatsAppQrManagerMigrationIssue = {
  phase: MigrationPhase;
  code: WhatsAppQrManagerMigrationIssueCode;
  workspaceId?: string;
  entryPointId?: string;
  scenarioId?: string;
  nodeId?: string;
};

type MigrationCounts = Pick<
  WhatsAppQrManagerMigrationSummary,
  | "scannedEntryPoints"
  | "searchKeysMissing"
  | "assignmentStatesMissing"
  | "scannedScenarios"
  | "pointersMissing"
  | "ambiguous"
  | "mismatched"
  | "casConflicts"
  | "writesApplied"
>;

export type WhatsAppQrManagerMigrationPage = MigrationCounts & {
  phase: MigrationPhase;
  issues: WhatsAppQrManagerMigrationIssue[];
  nextCursor: string | null;
};

export type WhatsAppQrManagerMigrationEvent =
  | ({
      type: "whatsapp_qr_manager_migration_issue";
    } & WhatsAppQrManagerMigrationIssue)
  | ({
      type: "whatsapp_qr_manager_migration_checkpoint";
      inventoryRunId: string;
      page: number;
      apply: boolean;
      scope: WhatsAppQrManagerMigrationScope;
    } & Omit<WhatsAppQrManagerMigrationPage, "issues">)
  | ({
      type: "whatsapp_qr_manager_migration_report";
    } & WhatsAppQrManagerMigrationSummary)
  | ({
      type: "whatsapp_qr_manager_rollout_attestation";
    } & WhatsAppQrManagerRolloutAttestationSummary);

type MigrationCursor = {
  v: typeof CURSOR_VERSION;
  scope: WhatsAppQrManagerMigrationScope;
  phase: MigrationPhase;
  afterId: string | null;
};

type EntryPointRow = WhatsAppQrEntryPointRecord & { _id: unknown };
type ScenarioRow = {
  _id: unknown;
  workspaceId?: unknown;
  nodes?: unknown;
  deletedAt?: unknown;
  updatedAt?: unknown;
};

type ParsedScenarioNode = {
  node: ScenarioGraphNode;
  nodeId: string;
  entryPointId: string | null;
  hasMalformedPointer: boolean;
};

type WriterDrainEvidence = {
  schemaVersion: typeof WRITER_EVIDENCE_SCHEMA_VERSION;
  compatReleaseId: string;
  inventoryReportSha256: string;
  verifiedAt: string;
  coverageStartedAt: string;
  coverageCompletedAt: string;
  provider: string;
  evidenceId: string;
  deploymentFenceId: string;
  soleWriter: true;
  deploymentFenceActive: true;
};

function emptyCounts(): MigrationCounts {
  return {
    scannedEntryPoints: 0,
    searchKeysMissing: 0,
    assignmentStatesMissing: 0,
    scannedScenarios: 0,
    pointersMissing: 0,
    ambiguous: 0,
    mismatched: 0,
    casConflicts: 0,
    writesApplied: 0,
  };
}

function addCounts(target: MigrationCounts, source: MigrationCounts): void {
  for (const key of Object.keys(target) as Array<keyof MigrationCounts>) {
    target[key] += source[key];
  }
}

function importedModuleRecord(value: unknown): Record<string, unknown> {
  const namespace = asRecord(value);
  const defaultValue = asRecord(namespace.default);
  const moduleExports = asRecord(namespace["module.exports"]);
  return { ...defaultValue, ...moduleExports, ...namespace };
}

function canonicalString(value: unknown, maxLength = 256): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > 0 && value.length <= maxLength && value.trim() === value
    ? value
    : undefined;
}

function objectIdHex(value: unknown): string {
  const hex =
    value instanceof Types.ObjectId
      ? value.toHexString()
      : asNullableRecord(value) &&
          typeof asNullableRecord(value)?.toHexString === "function"
        ? String(
            (asNullableRecord(value)?.toHexString as () => unknown).call(value)
          )
        : String(value ?? "");
  if (!/^[0-9a-f]{24}$/.test(hex)) {
    throw new Error("WhatsApp QR migration encountered a non-ObjectId row");
  }
  return hex;
}

function canonicalIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    return undefined;
  }
  return value;
}

function rowDate(value: unknown): Date | undefined {
  const parsed =
    value instanceof Date
      ? value
      : typeof value === "string"
        ? new Date(value)
        : undefined;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : undefined;
}

function migrationScope(
  workspaceId: string | undefined
): WhatsAppQrManagerMigrationScope {
  if (workspaceId === undefined) return { kind: "all" };
  const canonicalWorkspaceId = canonicalString(workspaceId);
  if (!canonicalWorkspaceId) {
    throw new Error("Workspace id must be a canonical nonempty string");
  }
  return { kind: "workspace", workspaceId: canonicalWorkspaceId };
}

function sameScope(
  left: WhatsAppQrManagerMigrationScope,
  right: WhatsAppQrManagerMigrationScope
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "all" ||
      (right.kind === "workspace" && left.workspaceId === right.workspaceId))
  );
}

function validateMigrationArgs(args: WhatsAppQrManagerMigrationArgs): void {
  migrationScope(args.workspaceId);
  if (
    !Number.isSafeInteger(args.batchSize) ||
    args.batchSize < 1 ||
    args.batchSize > 500
  ) {
    throw new Error("Batch size must be an integer from 1 through 500");
  }
  if (
    args.maxPages !== undefined &&
    (!Number.isSafeInteger(args.maxPages) || args.maxPages < 1)
  ) {
    throw new Error("Max pages must be a positive safe integer");
  }
  if (args.cursor !== undefined && !args.cursor.trim()) {
    throw new Error("Migration cursor must not be empty");
  }
}

function encodeCursor(cursor: MigrationCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function parseScope(value: unknown): WhatsAppQrManagerMigrationScope {
  const record = asNullableRecord(value);
  if (!record || typeof record.kind !== "string") {
    throw new Error("Migration cursor scope is invalid");
  }
  if (record.kind === "all" && hasExactKeys(record, ["kind"])) {
    return { kind: "all" };
  }
  if (
    record.kind === "workspace" &&
    hasExactKeys(record, ["kind", "workspaceId"])
  ) {
    const workspaceId = canonicalString(record.workspaceId);
    if (workspaceId) return { kind: "workspace", workspaceId };
  }
  throw new Error("Migration cursor scope is invalid");
}

function decodeCursor(
  encoded: string,
  expectedScope: WhatsAppQrManagerMigrationScope
): MigrationCursor {
  let bytes: Buffer;
  let raw: unknown;
  try {
    bytes = Buffer.from(encoded, "base64url");
    if (!bytes.length || bytes.toString("base64url") !== encoded) {
      throw new Error("noncanonical cursor");
    }
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Migration cursor is malformed");
  }
  const record = asNullableRecord(raw);
  if (
    !record ||
    !hasExactKeys(record, ["v", "scope", "phase", "afterId"]) ||
    record.v !== CURSOR_VERSION ||
    (record.phase !== "entry_points" && record.phase !== "scenarios") ||
    !(
      record.afterId === null ||
      (typeof record.afterId === "string" &&
        /^[0-9a-f]{24}$/.test(record.afterId) &&
        Types.ObjectId.isValid(record.afterId))
    )
  ) {
    throw new Error("Migration cursor is invalid");
  }
  const scope = parseScope(record.scope);
  if (!sameScope(scope, expectedScope)) {
    throw new Error("Migration cursor cannot be replayed under this scope");
  }
  if (record.phase === "entry_points" && record.afterId === null) {
    throw new Error("Migration cursor replays the beginning of the inventory");
  }
  return {
    v: CURSOR_VERSION,
    scope,
    phase: record.phase,
    afterId: record.afterId,
  };
}

function queryFilter(
  scope: WhatsAppQrManagerMigrationScope,
  afterId: string | null
): Record<string, unknown> {
  return {
    ...(scope.kind === "workspace" ? { workspaceId: scope.workspaceId } : {}),
    ...(afterId ? { _id: { $gt: new Types.ObjectId(afterId) } } : {}),
  };
}

function fieldPreimage(value: unknown): unknown {
  return value === undefined ? { $exists: false } : value;
}

function issue(
  phase: MigrationPhase,
  code: WhatsAppQrManagerMigrationIssueCode,
  ids: Omit<WhatsAppQrManagerMigrationIssue, "phase" | "code">
): WhatsAppQrManagerMigrationIssue {
  return { phase, code, ...ids };
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readStrictMigrationReport(
  bytes: Buffer
): WhatsAppQrManagerMigrationSummary {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Inventory report must contain exactly one JSON object");
  }
  const record = asNullableRecord(raw);
  const expectedKeys = [
    "inventoryRunId",
    "inventoryStartedAt",
    "inventoryCompletedAt",
    "scope",
    "startedAtBeginning",
    "pagesProcessed",
    "scannedEntryPoints",
    "searchKeysMissing",
    "assignmentStatesMissing",
    "scannedScenarios",
    "pointersMissing",
    "ambiguous",
    "mismatched",
    "casConflicts",
    "writesApplied",
    "nextCursor",
    "inventoryComplete",
    "dataReady",
  ];
  if (!record || !hasExactKeys(record, expectedKeys)) {
    throw new Error("Inventory report schema is invalid");
  }
  const scope = parseScope(record.scope);
  const startedAt = canonicalIsoDate(record.inventoryStartedAt);
  const completedAt =
    record.inventoryCompletedAt === null
      ? null
      : canonicalIsoDate(record.inventoryCompletedAt);
  const numericKeys = [
    "pagesProcessed",
    "scannedEntryPoints",
    "searchKeysMissing",
    "assignmentStatesMissing",
    "scannedScenarios",
    "pointersMissing",
    "ambiguous",
    "mismatched",
    "casConflicts",
    "writesApplied",
  ] as const;
  if (
    !canonicalString(record.inventoryRunId) ||
    !startedAt ||
    completedAt === undefined ||
    (completedAt !== null && completedAt < startedAt) ||
    typeof record.startedAtBeginning !== "boolean" ||
    typeof record.inventoryComplete !== "boolean" ||
    typeof record.dataReady !== "boolean" ||
    !numericKeys.every(
      key => Number.isSafeInteger(record[key]) && Number(record[key]) >= 0
    ) ||
    !(
      record.nextCursor === null ||
      (typeof record.nextCursor === "string" && record.nextCursor.length > 0)
    )
  ) {
    throw new Error("Inventory report values are invalid");
  }
  const issueCount = numericKeys
    .filter(key =>
      [
        "searchKeysMissing",
        "assignmentStatesMissing",
        "pointersMissing",
        "ambiguous",
        "mismatched",
        "casConflicts",
      ].includes(key)
    )
    .reduce((total, key) => total + Number(record[key]), 0);
  const inventoryCompleteExpected =
    record.startedAtBeginning === true &&
    record.nextCursor === null &&
    completedAt !== null;
  const dataReadyExpected =
    record.inventoryComplete === true &&
    scope.kind === "all" &&
    issueCount === 0;
  if (
    (record.inventoryComplete === true &&
      (!inventoryCompleteExpected || Number(record.pagesProcessed) < 2)) ||
    (record.dataReady === true && !dataReadyExpected)
  ) {
    throw new Error("Inventory readiness claims are inconsistent");
  }
  return raw as WhatsAppQrManagerMigrationSummary;
}

function readStrictWriterEvidence(bytes: Buffer): WriterDrainEvidence {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Writer continuity evidence must be one JSON object");
  }
  const record = asNullableRecord(raw);
  const keys = [
    "schemaVersion",
    "compatReleaseId",
    "inventoryReportSha256",
    "verifiedAt",
    "coverageStartedAt",
    "coverageCompletedAt",
    "provider",
    "evidenceId",
    "deploymentFenceId",
    "soleWriter",
    "deploymentFenceActive",
  ];
  if (!record || !hasExactKeys(record, keys)) {
    throw new Error("Writer continuity evidence schema is invalid");
  }
  if (
    record.schemaVersion !== WRITER_EVIDENCE_SCHEMA_VERSION ||
    !canonicalString(record.compatReleaseId) ||
    typeof record.inventoryReportSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.inventoryReportSha256) ||
    !canonicalIsoDate(record.verifiedAt) ||
    !canonicalIsoDate(record.coverageStartedAt) ||
    !canonicalIsoDate(record.coverageCompletedAt) ||
    !canonicalString(record.provider) ||
    !canonicalString(record.evidenceId) ||
    !canonicalString(record.deploymentFenceId) ||
    record.soleWriter !== true ||
    record.deploymentFenceActive !== true
  ) {
    throw new Error("Writer continuity evidence values are invalid");
  }
  return raw as WriterDrainEvidence;
}

export function attestWhatsAppQrManagerRollout(params: {
  inventoryReportBytes: Buffer;
  writerDrainEvidenceBytes: Buffer;
  compatReleaseId: string;
  now?: Date;
}): WhatsAppQrManagerRolloutAttestationSummary {
  const report = readStrictMigrationReport(params.inventoryReportBytes);
  const evidence = readStrictWriterEvidence(params.writerDrainEvidenceBytes);
  const compatReleaseId = canonicalString(params.compatReleaseId);
  if (!compatReleaseId) throw new Error("Compatibility release id is invalid");
  const reportDigest = sha256(params.inventoryReportBytes);
  const evidenceDigest = sha256(params.writerDrainEvidenceBytes);
  const now = params.now ?? new Date();
  const startedAt = report.inventoryStartedAt;
  const completedAt = report.inventoryCompletedAt;
  const orderedEvidence =
    evidence.coverageStartedAt <= evidence.coverageCompletedAt &&
    evidence.coverageCompletedAt <= evidence.verifiedAt &&
    new Date(evidence.verifiedAt).getTime() <= now.getTime();
  const validBoundWriterContinuityEvidence =
    evidence.compatReleaseId === compatReleaseId &&
    evidence.inventoryReportSha256 === reportDigest &&
    orderedEvidence &&
    completedAt !== null &&
    evidence.coverageStartedAt <= startedAt &&
    evidence.coverageCompletedAt >= completedAt;
  return {
    inventoryRunId: report.inventoryRunId,
    inventoryReportSha256: reportDigest,
    writerDrainEvidence: {
      compatReleaseId: evidence.compatReleaseId,
      verifiedAt: evidence.verifiedAt,
      coverageStartedAt: evidence.coverageStartedAt,
      coverageCompletedAt: evidence.coverageCompletedAt,
      provider: evidence.provider,
      evidenceId: evidence.evidenceId,
      deploymentFenceId: evidence.deploymentFenceId,
      sha256: evidenceDigest,
    },
    rolloutReady:
      report.dataReady === true && validBoundWriterContinuityEvidence,
  };
}

function parseScenarioNodes(rawNodes: unknown): {
  graphValid: boolean;
  invalidQrShape: boolean;
  nodes: ParsedScenarioNode[];
  allNodes: ScenarioGraphNode[];
} {
  if (!Array.isArray(rawNodes)) {
    return {
      graphValid: false,
      invalidQrShape: false,
      nodes: [],
      allNodes: [],
    };
  }
  const parsed: ParsedScenarioNode[] = [];
  const allNodes: ScenarioGraphNode[] = [];
  let graphValid = true;
  let invalidQrShape = false;
  for (const rawNode of rawNodes) {
    const nodeRecord = asNullableRecord(rawNode);
    const data = asNullableRecord(nodeRecord?.data);
    if (!nodeRecord || !data) {
      graphValid = false;
      continue;
    }
    let trigger: ReturnType<typeof resolveScenarioTrigger>;
    try {
      trigger = resolveScenarioTrigger(data);
    } catch {
      graphValid = false;
      invalidQrShape ||=
        data.kind === "trigger" &&
        asNullableRecord(data.triggerConfig)?.entryPointType === "whatsapp_qr";
      continue;
    }
    const isQrTrigger =
      data.kind === "trigger" && trigger.entryPointType === "whatsapp_qr";
    const nodeId = canonicalString(nodeRecord.id);
    if (!nodeId) {
      graphValid = false;
      invalidQrShape ||= isQrTrigger;
      continue;
    }
    const node = rawNode as ScenarioGraphNode;
    allNodes.push(node);
    if (!isQrTrigger) {
      continue;
    }
    const triggerConfig = asNullableRecord(data.triggerConfig);
    const hasRawPointer = Boolean(
      triggerConfig &&
        Object.prototype.hasOwnProperty.call(triggerConfig, "entryPointId")
    );
    const entryPointId = trigger.entryPointId ?? null;
    parsed.push({
      node,
      nodeId,
      entryPointId,
      hasMalformedPointer:
        hasRawPointer && triggerConfig?.entryPointId !== entryPointId,
    });
  }
  return { graphValid, invalidQrShape, nodes: parsed, allNodes };
}

function scenarioIdFromRow(row: ScenarioRow): string {
  return objectIdHex(row._id);
}

function isDeletedScenario(row: ScenarioRow): boolean {
  return row.deletedAt !== undefined && row.deletedAt !== null;
}

function pushIssue(
  page: WhatsAppQrManagerMigrationPage,
  value: WhatsAppQrManagerMigrationIssue,
  counter?: "ambiguous" | "mismatched" | "casConflicts"
): void {
  page.issues.push(value);
  if (counter) page[counter] += 1;
}

function pageResult(phase: MigrationPhase): WhatsAppQrManagerMigrationPage {
  return {
    phase,
    ...emptyCounts(),
    issues: [],
    nextCursor: null,
  };
}

async function loadScenariosForAssignedEntryPoints(
  rows: readonly EntryPointRow[]
): Promise<Map<string, ScenarioRow>> {
  const { Scenario } = await loadDatabaseRuntime();
  const scenarioIds = Array.from(
    new Set(
      rows
        .map(row =>
          typeof row.scenarioId === "string" &&
          /^[0-9a-f]{24}$/.test(row.scenarioId)
            ? row.scenarioId
            : undefined
        )
        .filter((value): value is string => Boolean(value))
    )
  );
  if (!scenarioIds.length) return new Map();
  const scenarios = await Scenario.find({
    _id: { $in: scenarioIds.map(id => new Types.ObjectId(id)) },
  })
    .select({ _id: 1, workspaceId: 1, nodes: 1, deletedAt: 1, updatedAt: 1 })
    .lean<ScenarioRow[]>({ defaults: false });
  return new Map(scenarios.map(row => [scenarioIdFromRow(row), row]));
}

function entryPointIssueIds(row: EntryPointRow) {
  const workspaceId = canonicalString(row.workspaceId);
  const entryPointId = canonicalString(row.entryPointId);
  const scenarioId = canonicalString(row.scenarioId);
  const nodeId = canonicalString(row.nodeId);
  return {
    ...(workspaceId ? { workspaceId } : {}),
    ...(entryPointId ? { entryPointId } : {}),
    ...(scenarioId ? { scenarioId } : {}),
    ...(nodeId ? { nodeId } : {}),
  };
}

async function applyEntryPointProjectionCorrections(params: {
  row: EntryPointRow;
  placementNameSearch?: string;
  assignmentState?: "assigned" | "unassigned";
}): Promise<boolean> {
  const { WhatsAppQrEntryPoint } = await loadDatabaseRuntime();
  const row = params.row;
  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};
  if (params.placementNameSearch !== undefined) {
    set.placementName = row.placementName;
    set.placementNameSearch = params.placementNameSearch;
  }
  if (params.assignmentState === "assigned") {
    set.scenarioId = row.scenarioId;
    set.nodeId = row.nodeId;
    set.assignmentState = "assigned";
  } else if (params.assignmentState === "unassigned") {
    set.assignmentState = "unassigned";
    unset.scenarioId = 1;
    unset.nodeId = 1;
  }
  if (!Object.keys(set).length && !Object.keys(unset).length) return false;
  const result = await WhatsAppQrEntryPoint.updateOne(
    {
      workspaceId: row.workspaceId,
      entryPointId: row.entryPointId,
      version: row.version,
      placementName: fieldPreimage(row.placementName),
      placementNameSearch: fieldPreimage(row.placementNameSearch),
      scenarioId: fieldPreimage(row.scenarioId),
      nodeId: fieldPreimage(row.nodeId),
      assignmentState: fieldPreimage(row.assignmentState),
    },
    {
      ...(Object.keys(set).length ? { $set: set } : {}),
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
      $inc: { version: 1 },
    },
    { runValidators: true }
  );
  return result.matchedCount === 1 && result.modifiedCount === 1;
}

async function scanEntryPointPage(params: {
  args: WhatsAppQrManagerMigrationArgs;
  scope: WhatsAppQrManagerMigrationScope;
  afterId: string | null;
}): Promise<WhatsAppQrManagerMigrationPage> {
  const runtime = await loadDatabaseRuntime();
  const page = pageResult("entry_points");
  const window = await runtime.WhatsAppQrEntryPoint.find(
    queryFilter(params.scope, params.afterId)
  )
    .sort({ _id: 1 })
    .hint(
      params.scope.kind === "workspace" ? runtime.entryPointScanHint : "_id_"
    )
    .limit(params.args.batchSize + 1)
    .lean<EntryPointRow[]>();
  const rows = window.slice(0, params.args.batchSize);
  const scenarios = await loadScenariosForAssignedEntryPoints(rows);
  page.scannedEntryPoints = rows.length;

  for (const row of rows) {
    const ids = entryPointIssueIds(row);
    const normalizedEntryPointId = normalizeWhatsAppQrEntryPointUuid(
      row.entryPointId
    );
    const identitySafe = Boolean(
      canonicalString(row.workspaceId) &&
        normalizedEntryPointId &&
        normalizedEntryPointId === row.entryPointId
    );
    const versionSafe = Number.isSafeInteger(row.version) && row.version >= 0;
    if (!identitySafe) {
      pushIssue(
        page,
        issue("entry_points", "entry_point_identity_invalid", ids),
        "mismatched"
      );
    }
    if (!versionSafe) {
      pushIssue(
        page,
        issue("entry_points", "entry_point_version_invalid", ids),
        "mismatched"
      );
    }
    let normalizedSearch: string | undefined;
    let correctSearch = false;
    try {
      if (!canonicalString(row.placementName, 120)) {
        throw new Error("invalid placement name");
      }
      normalizedSearch = normalizeWhatsAppQrPlacementNameSearch(
        row.placementName
      );
      if (row.placementNameSearch === undefined) {
        page.searchKeysMissing += 1;
        page.issues.push(
          issue("entry_points", "placement_name_search_missing", ids)
        );
        correctSearch = true;
      } else if (row.placementNameSearch !== normalizedSearch) {
        pushIssue(
          page,
          issue("entry_points", "placement_name_search_mismatch", ids),
          "mismatched"
        );
        correctSearch = true;
      }
    } catch {
      pushIssue(
        page,
        issue("entry_points", "placement_name_invalid", ids),
        "mismatched"
      );
    }

    const scenarioId = canonicalString(row.scenarioId);
    const nodeId = canonicalString(row.nodeId);
    const scenarioAbsent = row.scenarioId === undefined;
    const nodeAbsent = row.nodeId === undefined;
    const assignedTuple = Boolean(scenarioId && nodeId);
    const unassignedTuple = scenarioAbsent && nodeAbsent;
    const expectedAssignment = assignedTuple
      ? "assigned"
      : unassignedTuple
        ? "unassigned"
        : undefined;
    let correctAssignment = false;
    if (!expectedAssignment) {
      pushIssue(
        page,
        issue("entry_points", "assignment_projection_partial", ids),
        "mismatched"
      );
    } else if (row.assignmentState === undefined) {
      page.assignmentStatesMissing += 1;
      page.issues.push(issue("entry_points", "assignment_state_missing", ids));
      correctAssignment = true;
    } else if (row.assignmentState !== expectedAssignment) {
      pushIssue(
        page,
        issue("entry_points", "assignment_state_mismatch", ids),
        "mismatched"
      );
      correctAssignment = true;
    }

    let assignmentProjectionSafe = true;
    if (assignedTuple) {
      if (!scenarioId || !/^[0-9a-f]{24}$/.test(scenarioId)) {
        assignmentProjectionSafe = false;
        pushIssue(
          page,
          issue("entry_points", "assignment_scenario_id_invalid", ids),
          "mismatched"
        );
      } else {
        const scenario = scenarios.get(scenarioId);
        if (!scenario) {
          assignmentProjectionSafe = false;
          pushIssue(
            page,
            issue("entry_points", "assignment_scenario_missing", ids),
            "mismatched"
          );
        } else if (scenario.workspaceId !== row.workspaceId) {
          assignmentProjectionSafe = false;
          pushIssue(
            page,
            issue("entry_points", "assignment_scenario_wrong_workspace", ids),
            "mismatched"
          );
        } else if (isDeletedScenario(scenario)) {
          assignmentProjectionSafe = false;
          pushIssue(
            page,
            issue("entry_points", "assignment_scenario_deleted", ids),
            "mismatched"
          );
        } else {
          const graph = parseScenarioNodes(scenario.nodes);
          const target = graph.nodes.find(
            candidate => candidate.nodeId === nodeId
          );
          const rawTarget = graph.allNodes.find(
            candidate => candidate.id === nodeId
          );
          if (!rawTarget) {
            assignmentProjectionSafe = false;
            pushIssue(
              page,
              issue("entry_points", "assignment_node_missing", ids),
              "mismatched"
            );
          } else if (!target) {
            assignmentProjectionSafe = false;
            pushIssue(
              page,
              issue("entry_points", "assignment_node_wrong_kind", ids),
              "mismatched"
            );
          } else {
            const duplicates = graph.nodes.filter(
              candidate => candidate.entryPointId === row.entryPointId
            );
            if (duplicates.length > 1) {
              assignmentProjectionSafe = false;
              pushIssue(
                page,
                issue(
                  "entry_points",
                  "assignment_graph_pointer_duplicate",
                  ids
                ),
                "ambiguous"
              );
            } else if (target.hasMalformedPointer) {
              assignmentProjectionSafe = false;
              pushIssue(
                page,
                issue("entry_points", "assignment_graph_pointer_mismatch", ids),
                "mismatched"
              );
            } else if (target.entryPointId === null) {
              page.issues.push(
                issue("entry_points", "assignment_graph_pointer_missing", ids)
              );
            } else if (target.entryPointId !== row.entryPointId) {
              assignmentProjectionSafe = false;
              pushIssue(
                page,
                issue("entry_points", "assignment_graph_pointer_mismatch", ids),
                "mismatched"
              );
            }
          }
        }
      }
    }

    const canWrite = params.args.apply && versionSafe && identitySafe;
    if (
      canWrite &&
      (correctSearch || (correctAssignment && assignmentProjectionSafe))
    ) {
      const applied = await applyEntryPointProjectionCorrections({
        row,
        ...(correctSearch && normalizedSearch
          ? { placementNameSearch: normalizedSearch }
          : {}),
        ...(correctAssignment && expectedAssignment && assignmentProjectionSafe
          ? { assignmentState: expectedAssignment }
          : {}),
      });
      if (applied) {
        page.writesApplied += 1;
      } else {
        pushIssue(
          page,
          issue("entry_points", "entry_point_cas_conflict", ids),
          "casConflicts"
        );
      }
    }
  }

  if (window.length > params.args.batchSize) {
    page.nextCursor = encodeCursor({
      v: CURSOR_VERSION,
      scope: params.scope,
      phase: "entry_points",
      afterId: objectIdHex(rows.at(-1)?._id),
    });
  } else {
    page.nextCursor = encodeCursor({
      v: CURSOR_VERSION,
      scope: params.scope,
      phase: "scenarios",
      afterId: null,
    });
  }
  return page;
}

function scenarioIssueIds(params: {
  row: ScenarioRow;
  nodeId?: string;
  entryPointId?: string;
}) {
  const workspaceId = canonicalString(params.row.workspaceId);
  return {
    ...(workspaceId ? { workspaceId } : {}),
    scenarioId: scenarioIdFromRow(params.row),
    ...(params.nodeId ? { nodeId: params.nodeId } : {}),
    ...(params.entryPointId ? { entryPointId: params.entryPointId } : {}),
  };
}

function assignmentKey(
  workspaceId: string,
  scenarioId: string,
  nodeId: string
): string {
  return [workspaceId, scenarioId, nodeId].join("\u0000");
}

async function loadEntryPointsForScenarioPage(params: {
  rows: readonly ScenarioRow[];
  graphByScenarioId: ReadonlyMap<string, ReturnType<typeof parseScenarioNodes>>;
}): Promise<{
  byEntryPointId: Map<string, EntryPointRow>;
  byAssignment: Map<string, EntryPointRow[]>;
}> {
  const { WhatsAppQrEntryPoint } = await loadDatabaseRuntime();
  const entryPointIds = Array.from(
    new Set(
      params.rows.flatMap(row =>
        (params.graphByScenarioId.get(scenarioIdFromRow(row))?.nodes ?? [])
          .map(node => node.entryPointId)
          .filter((value): value is string => Boolean(value))
      )
    )
  );
  const assignmentClauses = params.rows.flatMap(row => {
    const workspaceId = canonicalString(row.workspaceId);
    const scenarioId = scenarioIdFromRow(row);
    if (!workspaceId) return [];
    return (params.graphByScenarioId.get(scenarioId)?.nodes ?? []).flatMap(
      node =>
        node.entryPointId === null
          ? [{ workspaceId, scenarioId, nodeId: node.nodeId }]
          : []
    );
  });
  const [pointerRows, projectionRows] = await Promise.all([
    entryPointIds.length
      ? WhatsAppQrEntryPoint.find({ entryPointId: { $in: entryPointIds } })
          .select({
            _id: 1,
            entryPointId: 1,
            workspaceId: 1,
            scenarioId: 1,
            nodeId: 1,
            assignmentState: 1,
            version: 1,
          })
          .lean<EntryPointRow[]>()
      : Promise.resolve([]),
    assignmentClauses.length
      ? WhatsAppQrEntryPoint.find({ $or: assignmentClauses })
          .select({
            _id: 1,
            entryPointId: 1,
            workspaceId: 1,
            scenarioId: 1,
            nodeId: 1,
            assignmentState: 1,
            version: 1,
          })
          .lean<EntryPointRow[]>()
      : Promise.resolve([]),
  ]);
  const byEntryPointId = new Map<string, EntryPointRow>();
  for (const row of pointerRows) {
    if (canonicalString(row.entryPointId)) {
      byEntryPointId.set(row.entryPointId, row);
    }
  }
  const byAssignment = new Map<string, EntryPointRow[]>();
  for (const row of projectionRows) {
    const workspaceId = canonicalString(row.workspaceId);
    const scenarioId = canonicalString(row.scenarioId);
    const nodeId = canonicalString(row.nodeId);
    if (!workspaceId || !scenarioId || !nodeId) continue;
    const key = assignmentKey(workspaceId, scenarioId, nodeId);
    const candidates = byAssignment.get(key) ?? [];
    candidates.push(row);
    byAssignment.set(key, candidates);
  }
  return { byEntryPointId, byAssignment };
}

async function applyScenarioPointerCorrections(params: {
  row: ScenarioRow;
  nodes: readonly ScenarioGraphNode[];
  corrections: readonly { nodeId: string; entryPointId: string }[];
}): Promise<boolean> {
  const { Scenario } = await loadDatabaseRuntime();
  const workspaceId = canonicalString(params.row.workspaceId);
  const updatedAt = rowDate(params.row.updatedAt);
  if (!workspaceId || !updatedAt || !params.corrections.length) return false;
  let nextNodes = [...params.nodes];
  for (const correction of params.corrections) {
    nextNodes = setWhatsAppQrGraphBinding(
      nextNodes,
      correction.nodeId,
      correction.entryPointId
    );
  }
  const normalizedNodes = normalizeScenarioNodesForPersistence(nextNodes);
  const result = await Scenario.updateOne(
    {
      _id: params.row._id,
      workspaceId,
      deletedAt: null,
      updatedAt,
    },
    { $set: { nodes: normalizedNodes } },
    { runValidators: true }
  );
  return result.matchedCount === 1 && result.modifiedCount === 1;
}

async function scanScenarioPage(params: {
  args: WhatsAppQrManagerMigrationArgs;
  scope: WhatsAppQrManagerMigrationScope;
  afterId: string | null;
}): Promise<WhatsAppQrManagerMigrationPage> {
  const runtime = await loadDatabaseRuntime();
  const page = pageResult("scenarios");
  const window = await runtime.Scenario.find(
    queryFilter(params.scope, params.afterId)
  )
    .sort({ _id: 1 })
    .hint(params.scope.kind === "workspace" ? runtime.scenarioScanHint : "_id_")
    .limit(params.args.batchSize + 1)
    .select({ _id: 1, workspaceId: 1, nodes: 1, deletedAt: 1, updatedAt: 1 })
    .lean<ScenarioRow[]>({ defaults: false });
  const rows = window.slice(0, params.args.batchSize);
  page.scannedScenarios = rows.length;
  const graphByScenarioId = new Map(
    rows.map(row => [scenarioIdFromRow(row), parseScenarioNodes(row.nodes)])
  );
  const entryPoints = await loadEntryPointsForScenarioPage({
    rows,
    graphByScenarioId,
  });

  for (const row of rows) {
    const scenarioId = scenarioIdFromRow(row);
    const workspaceId = canonicalString(row.workspaceId);
    const graph = graphByScenarioId.get(scenarioId)!;
    const baseIds = scenarioIssueIds({ row });
    const relevantScenario = graph.nodes.length > 0 || graph.invalidQrShape;
    if (isDeletedScenario(row)) {
      if (relevantScenario) {
        page.issues.push(issue("scenarios", "scenario_deleted", baseIds));
      }
      continue;
    }
    if (graph.invalidQrShape || (relevantScenario && !workspaceId)) {
      pushIssue(
        page,
        issue("scenarios", "scenario_node_invalid", baseIds),
        "mismatched"
      );
    }
    if (relevantScenario && !rowDate(row.updatedAt)) {
      pushIssue(
        page,
        issue("scenarios", "scenario_revision_invalid", baseIds),
        "mismatched"
      );
    }

    const duplicatePointerIds = new Set<string>();
    const pointerCounts = new Map<string, number>();
    for (const node of graph.nodes) {
      if (!node.entryPointId) continue;
      pointerCounts.set(
        node.entryPointId,
        (pointerCounts.get(node.entryPointId) ?? 0) + 1
      );
    }
    for (const [entryPointId, count] of pointerCounts) {
      if (count <= 1) continue;
      duplicatePointerIds.add(entryPointId);
      pushIssue(
        page,
        issue(
          "scenarios",
          "scenario_pointer_duplicate",
          scenarioIssueIds({ row, entryPointId })
        ),
        "ambiguous"
      );
    }

    const corrections: Array<{ nodeId: string; entryPointId: string }> = [];
    const plannedEntryPointIds = new Set(
      graph.nodes
        .map(node => node.entryPointId)
        .filter((value): value is string => Boolean(value))
    );
    for (const node of graph.nodes) {
      const ids = scenarioIssueIds({
        row,
        nodeId: node.nodeId,
        ...(node.entryPointId ? { entryPointId: node.entryPointId } : {}),
      });
      if (node.hasMalformedPointer) {
        pushIssue(
          page,
          issue("scenarios", "scenario_pointer_malformed", ids),
          "mismatched"
        );
        continue;
      }
      if (node.entryPointId) {
        if (duplicatePointerIds.has(node.entryPointId)) continue;
        const entryPoint = entryPoints.byEntryPointId.get(node.entryPointId);
        if (!entryPoint) {
          pushIssue(
            page,
            issue("scenarios", "scenario_pointer_entry_point_missing", ids),
            "mismatched"
          );
          continue;
        }
        if (entryPoint.workspaceId !== workspaceId) {
          pushIssue(
            page,
            issue("scenarios", "scenario_pointer_wrong_workspace", ids),
            "mismatched"
          );
          continue;
        }
        const projectedScenarioId = canonicalString(entryPoint.scenarioId);
        const projectedNodeId = canonicalString(entryPoint.nodeId);
        if (!projectedScenarioId || !projectedNodeId) {
          pushIssue(
            page,
            issue("scenarios", "scenario_pointer_projection_partial", ids),
            "mismatched"
          );
        } else if (
          projectedScenarioId !== scenarioId ||
          projectedNodeId !== node.nodeId
        ) {
          pushIssue(
            page,
            issue("scenarios", "scenario_pointer_projection_mismatch", ids),
            "mismatched"
          );
        } else if (
          entryPoint.assignmentState !== undefined &&
          entryPoint.assignmentState !== "assigned"
        ) {
          pushIssue(
            page,
            issue(
              "scenarios",
              "scenario_pointer_projection_state_mismatch",
              ids
            ),
            "mismatched"
          );
        }
        continue;
      }

      page.pointersMissing += 1;
      const missingIds = scenarioIssueIds({ row, nodeId: node.nodeId });
      if (!workspaceId) {
        page.issues.push(
          issue("scenarios", "scenario_pointer_missing_projection", missingIds)
        );
        continue;
      }
      const candidates =
        entryPoints.byAssignment.get(
          assignmentKey(workspaceId, scenarioId, node.nodeId)
        ) ?? [];
      if (candidates.length === 0) {
        page.issues.push(
          issue("scenarios", "scenario_pointer_missing_projection", missingIds)
        );
        continue;
      }
      if (candidates.length > 1) {
        pushIssue(
          page,
          issue(
            "scenarios",
            "scenario_pointer_ambiguous_projection",
            missingIds
          ),
          "ambiguous"
        );
        continue;
      }
      const candidate = candidates[0];
      const normalizedCandidateEntryPointId = normalizeWhatsAppQrEntryPointUuid(
        candidate.entryPointId
      );
      const candidateEntryPointId =
        normalizedCandidateEntryPointId === candidate.entryPointId
          ? normalizedCandidateEntryPointId
          : undefined;
      if (!candidateEntryPointId) {
        pushIssue(
          page,
          issue(
            "scenarios",
            "scenario_pointer_entry_point_id_invalid",
            missingIds
          ),
          "mismatched"
        );
        continue;
      }
      if (
        candidate.assignmentState !== undefined &&
        candidate.assignmentState !== "assigned"
      ) {
        pushIssue(
          page,
          issue(
            "scenarios",
            "scenario_pointer_projection_state_mismatch",
            missingIds
          ),
          "mismatched"
        );
        continue;
      }
      if (!graph.graphValid) {
        page.issues.push(
          issue("scenarios", "scenario_graph_invalid", missingIds)
        );
        continue;
      }
      if (plannedEntryPointIds.has(candidateEntryPointId)) {
        pushIssue(
          page,
          issue("scenarios", "scenario_pointer_ambiguous_projection", {
            ...missingIds,
            entryPointId: candidateEntryPointId,
          }),
          "ambiguous"
        );
        continue;
      }
      plannedEntryPointIds.add(candidateEntryPointId);
      corrections.push({
        nodeId: node.nodeId,
        entryPointId: candidateEntryPointId,
      });
    }

    if (params.args.apply && corrections.length) {
      const applied = await applyScenarioPointerCorrections({
        row,
        nodes: graph.allNodes,
        corrections,
      });
      if (applied) {
        page.writesApplied += 1;
      } else {
        pushIssue(
          page,
          issue("scenarios", "scenario_cas_conflict", baseIds),
          "casConflicts"
        );
      }
    }
  }

  page.nextCursor =
    window.length > params.args.batchSize
      ? encodeCursor({
          v: CURSOR_VERSION,
          scope: params.scope,
          phase: "scenarios",
          afterId: objectIdHex(rows.at(-1)?._id),
        })
      : null;
  return page;
}

async function scanMigrationPage(params: {
  args: WhatsAppQrManagerMigrationArgs;
  scope: WhatsAppQrManagerMigrationScope;
  cursor?: string;
}): Promise<WhatsAppQrManagerMigrationPage> {
  const decoded = params.cursor
    ? decodeCursor(params.cursor, params.scope)
    : {
        v: CURSOR_VERSION,
        scope: params.scope,
        phase: "entry_points" as const,
        afterId: null,
      };
  return decoded.phase === "entry_points"
    ? scanEntryPointPage({
        args: params.args,
        scope: params.scope,
        afterId: decoded.afterId,
      })
    : scanScenarioPage({
        args: params.args,
        scope: params.scope,
        afterId: decoded.afterId,
      });
}

export async function runWhatsAppQrManagerMigration(
  args: WhatsAppQrManagerMigrationArgs,
  options: {
    emit?: (event: WhatsAppQrManagerMigrationEvent) => void;
    now?: () => Date;
    inventoryRunId?: string;
  } = {}
): Promise<WhatsAppQrManagerMigrationSummary> {
  validateMigrationArgs(args);
  const runtime = await loadDatabaseRuntime();
  await runtime.connectDB();
  await runtime.assertWritesEnabled();
  const scope = migrationScope(args.workspaceId);
  const now = options.now ?? (() => new Date());
  const inventoryRunId = options.inventoryRunId ?? randomUUID();
  if (!canonicalString(inventoryRunId)) {
    throw new Error("Inventory run id is invalid");
  }
  const inventoryStartedAt = now().toISOString();
  const startedAtBeginning = args.cursor === undefined;
  const totals = emptyCounts();
  const seenCursors = new Set<string>();
  let cursor = args.cursor;
  if (cursor) seenCursors.add(cursor);
  let pagesProcessed = 0;

  while (true) {
    const page = await scanMigrationPage({ args, scope, cursor });
    pagesProcessed += 1;
    addCounts(totals, page);
    for (const foundIssue of page.issues) {
      options.emit?.({
        type: "whatsapp_qr_manager_migration_issue",
        ...foundIssue,
      });
    }
    options.emit?.({
      type: "whatsapp_qr_manager_migration_checkpoint",
      inventoryRunId,
      page: pagesProcessed,
      apply: args.apply,
      scope,
      phase: page.phase,
      scannedEntryPoints: page.scannedEntryPoints,
      searchKeysMissing: page.searchKeysMissing,
      assignmentStatesMissing: page.assignmentStatesMissing,
      scannedScenarios: page.scannedScenarios,
      pointersMissing: page.pointersMissing,
      ambiguous: page.ambiguous,
      mismatched: page.mismatched,
      casConflicts: page.casConflicts,
      writesApplied: page.writesApplied,
      nextCursor: page.nextCursor,
    });
    cursor = page.nextCursor ?? undefined;
    if (!page.nextCursor) break;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error("Migration cursor replay or cycle detected");
    }
    seenCursors.add(page.nextCursor);
    if (args.maxPages !== undefined && pagesProcessed >= args.maxPages) break;
  }

  const exhausted = cursor === undefined;
  const inventoryCompletedAt = exhausted ? now().toISOString() : null;
  const inventoryComplete =
    startedAtBeginning && args.maxPages === undefined && exhausted;
  const issueCount =
    totals.searchKeysMissing +
    totals.assignmentStatesMissing +
    totals.pointersMissing +
    totals.ambiguous +
    totals.mismatched +
    totals.casConflicts;
  const dataReady =
    !args.apply &&
    inventoryComplete &&
    scope.kind === "all" &&
    issueCount === 0;
  const summary: WhatsAppQrManagerMigrationSummary = {
    inventoryRunId,
    inventoryStartedAt,
    inventoryCompletedAt,
    scope,
    startedAtBeginning,
    pagesProcessed,
    ...totals,
    nextCursor: cursor ?? null,
    inventoryComplete,
    dataReady,
  };
  options.emit?.({
    type: "whatsapp_qr_manager_migration_report",
    ...summary,
  });
  return summary;
}
