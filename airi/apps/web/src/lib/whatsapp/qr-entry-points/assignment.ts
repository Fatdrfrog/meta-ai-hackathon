import "server-only";

import { randomUUID } from "node:crypto";

import { type ScenarioGraphNode } from "@icecore/scenario-contracts";
import type { ClientSession } from "mongoose";

import { Scenario } from "@/models/scenario";
import {
  WhatsAppQrCode,
  type WhatsAppQrCodeRecord,
} from "@/models/whatsapp-qr-code";
import {
  WhatsAppQrEntryPoint,
  type WhatsAppQrEntryPointRecord,
} from "@/models/whatsapp-qr-entry-point";

import type { WhatsAppQrAssignmentSummary } from "./dto";
import { assertWhatsAppQrUnassignedWritesEnabled } from "./indexes";
import { hasActiveWhatsAppQrDeleteOperation } from "./operation-store";
import { normalizeWhatsAppQrEntryPointUuid } from "./normalization";
import {
  clearWhatsAppQrGraphBinding,
  collectWhatsAppQrGraphBindings,
  setWhatsAppQrGraphBinding,
} from "./scenario-binding";
import { isReadyActiveWhatsAppQrEntryPoint } from "./readiness";

export type AssignWhatsAppQrEntryPointInput = {
  workspaceId: string;
  entryPointId: string;
  expectedEntryPointVersion: number;
  target: {
    scenarioId: string;
    nodeId: string;
    expectedUpdatedAt: string;
    expectedCurrentEntryPointId: string | null;
    expectedCurrentEntryPointVersion?: number;
  };
  acknowledgeMove: boolean;
  acknowledgeReplacement: boolean;
  sourceExpectedUpdatedAt?: string;
};

export type UnassignWhatsAppQrEntryPointInput = {
  workspaceId: string;
  entryPointId: string;
  expectedEntryPointVersion: number;
  sourceExpectedUpdatedAt: string;
};

export type RecoverDetachedWhatsAppQrEntryPointInput = {
  workspaceId: string;
  entryPointId: string;
  expectedEntryPointVersion: number;
};

export type WhatsAppQrAssignmentResult = {
  entryPointId: string;
  entryPointVersion: number;
  assignment: WhatsAppQrAssignmentSummary | null;
  targetScenario?: {
    scenarioId: string;
    updatedAt: string;
    nodeId: string;
    previousEntryPointId: string | null;
  };
  sourceScenario?: {
    scenarioId: string;
    updatedAt: string;
    nodeId: string;
  };
  displacedEntryPoint?: {
    entryPointId: string;
    version: number;
  };
};

export type WhatsAppQrAssignmentErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "ASSIGNMENT_CONFLICT"
  | "MOVE_ACKNOWLEDGEMENT_REQUIRED"
  | "SOURCE_REVISION_REQUIRED"
  | "REPLACEMENT_ACKNOWLEDGEMENT_REQUIRED"
  | "ACTIVE_SCENARIO_ASSIGNMENT"
  | "ENTRY_POINT_NOT_READY"
  | "DETACHED_STATE_INVALID"
  | "STORAGE_FAILED";

export class WhatsAppQrAssignmentError extends Error {
  constructor(
    readonly code: WhatsAppQrAssignmentErrorCode,
    message = "WhatsApp QR assignment failed",
    readonly currentAssignment?: WhatsAppQrAssignmentSummary | null
  ) {
    super(message);
    this.name = "WhatsAppQrAssignmentError";
  }
}

type ScenarioAssignmentRecord = {
  _id: unknown;
  workspaceId: string;
  name: string;
  status: "draft" | "active";
  nodes?: ScenarioGraphNode[];
  updatedAt: Date;
  deletedAt?: Date | null;
};

function assignmentError(
  code: WhatsAppQrAssignmentErrorCode,
  message?: string,
  currentAssignment?: WhatsAppQrAssignmentSummary | null
): WhatsAppQrAssignmentError {
  return new WhatsAppQrAssignmentError(code, message, currentAssignment);
}

function requiredString(value: unknown, label: string, max = 256): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > max) {
    throw assignmentError("INVALID_INPUT", `${label} is invalid`);
  }
  return normalized;
}

function requiredVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw assignmentError("INVALID_INPUT", `${label} is invalid`);
  }
  return value as number;
}

function requiredRevision(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw assignmentError("INVALID_INPUT", `${label} is invalid`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw assignmentError("INVALID_INPUT", `${label} is invalid`);
  }
  return value;
}

function isCanonicalString(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.trim() === value
  );
}

function scenarioId(scenario: ScenarioAssignmentRecord): string {
  return String(scenario._id);
}

function scenarioNodes(
  scenario: ScenarioAssignmentRecord
): ScenarioGraphNode[] {
  return Array.isArray(scenario.nodes) ? scenario.nodes : [];
}

function isoDate(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function revisionsMatch(actual: Date, expected: string): boolean {
  return actual.getTime() === new Date(expected).getTime();
}

function assignmentSummary(
  scenario: ScenarioAssignmentRecord,
  nodeId: string
): WhatsAppQrAssignmentSummary {
  return {
    scenarioId: scenarioId(scenario),
    nodeId,
    scenarioName: scenario.name,
    scenarioStatus: scenario.status,
    scenarioUpdatedAt: isoDate(scenario.updatedAt),
  };
}

function currentBinding(
  scenario: ScenarioAssignmentRecord,
  nodeId: string
): string | null {
  const bindings = collectWhatsAppQrGraphBindings(scenarioNodes(scenario));
  const boundEntryPointIds = new Set<string>();
  for (const candidate of bindings) {
    if (!candidate.entryPointId) continue;
    if (boundEntryPointIds.has(candidate.entryPointId)) {
      throw assignmentError(
        "STORAGE_FAILED",
        "Scenario contains duplicate WhatsApp QR bindings"
      );
    }
    boundEntryPointIds.add(candidate.entryPointId);
  }
  const binding = bindings.find(candidate => candidate.nodeId === nodeId);
  if (!binding) {
    throw assignmentError("NOT_FOUND", "WhatsApp QR trigger node not found");
  }
  return binding.entryPointId;
}

async function loadScenario(
  session: ClientSession,
  workspaceId: string,
  id: string
): Promise<ScenarioAssignmentRecord> {
  const found = await Scenario.findOne({
    _id: id,
    workspaceId,
    deletedAt: null,
  })
    .session(session)
    .lean<ScenarioAssignmentRecord | null>({ defaults: false });
  if (!found) throw assignmentError("NOT_FOUND", "Scenario not found");
  return found;
}

async function loadEntryPoint(
  session: ClientSession,
  workspaceId: string,
  entryPointId: string
): Promise<WhatsAppQrEntryPointRecord> {
  const found = await WhatsAppQrEntryPoint.findOne({
    workspaceId,
    entryPointId,
  })
    .session(session)
    .lean<WhatsAppQrEntryPointRecord | null>();
  if (!found) throw assignmentError("NOT_FOUND", "Entry point not found");
  return found;
}

async function loadCurrentCode(
  session: ClientSession,
  entryPoint: WhatsAppQrEntryPointRecord
): Promise<WhatsAppQrCodeRecord | null> {
  if (!entryPoint.currentCodeId) return null;
  return WhatsAppQrCode.findOne({
    workspaceId: entryPoint.workspaceId,
    entryPointId: entryPoint.entryPointId,
    codeId: entryPoint.currentCodeId,
  })
    .session(session)
    .lean<WhatsAppQrCodeRecord | null>();
}

async function assertNoActiveDeleteOperationInSession(params: {
  session: ClientSession;
  workspaceId: string;
  entryPointId: string;
  currentAssignment: WhatsAppQrAssignmentSummary | null;
}): Promise<void> {
  const deleteOperation = await hasActiveWhatsAppQrDeleteOperation({
    session: params.session,
    workspaceId: params.workspaceId,
    entryPointId: params.entryPointId,
  });
  if (deleteOperation) {
    throw assignmentError(
      "ENTRY_POINT_NOT_READY",
      "Entry point deletion is in progress",
      params.currentAssignment
    );
  }
}

async function fenceCurrentCodeForAssignmentInSession(params: {
  session: ClientSession;
  entryPoint: WhatsAppQrEntryPointRecord;
  code: WhatsAppQrCodeRecord;
  fenceToken: string;
  currentAssignment: WhatsAppQrAssignmentSummary | null;
}): Promise<void> {
  const fenced = await WhatsAppQrCode.findOneAndUpdate(
    {
      codeId: params.code.codeId,
      workspaceId: params.code.workspaceId,
      entryPointId: params.entryPoint.entryPointId,
      version: params.code.version,
      sourceId: params.entryPoint.sourceId,
      wabaId: params.entryPoint.wabaId,
      phoneNumberId: params.entryPoint.phoneNumberId,
      providerCode: params.code.providerCode,
      deepLink: params.code.deepLink,
      placementBindingState: "CURRENT",
      routingState: "ENABLED",
      providerState: "ACTIVE",
    },
    {
      $set: { lastAssignmentFenceToken: params.fenceToken },
      $inc: { version: 1 },
    },
    { session: params.session, new: true, runValidators: true }
  ).lean<WhatsAppQrCodeRecord | null>();
  if (!fenced) {
    throw assignmentError(
      "VERSION_CONFLICT",
      "Entry point code changed during assignment",
      params.currentAssignment
    );
  }
}

function entryPointAssignmentFilter(entryPoint: WhatsAppQrEntryPointRecord) {
  if (entryPoint.scenarioId && entryPoint.nodeId) {
    return {
      scenarioId: entryPoint.scenarioId,
      nodeId: entryPoint.nodeId,
      assignmentState: "assigned",
    };
  }
  return {
    scenarioId: { $exists: false },
    nodeId: { $exists: false },
    assignmentState: "unassigned",
  };
}

async function writeScenarioWithCas(params: {
  session: ClientSession;
  scenario: ScenarioAssignmentRecord;
  expectedUpdatedAt: string;
  nodes: ScenarioGraphNode[];
  currentAssignment: WhatsAppQrAssignmentSummary | null;
}): Promise<ScenarioAssignmentRecord> {
  const nextUpdatedAt = new Date(
    Math.max(Date.now(), params.scenario.updatedAt.getTime() + 1)
  );
  const updated = await Scenario.findOneAndUpdate(
    {
      _id: params.scenario._id,
      workspaceId: params.scenario.workspaceId,
      deletedAt: null,
      status: "draft",
      updatedAt: new Date(params.expectedUpdatedAt),
    },
    { $set: { nodes: params.nodes, updatedAt: nextUpdatedAt } },
    { session: params.session, new: true, runValidators: true }
  ).lean<ScenarioAssignmentRecord | null>({ defaults: false });
  if (!updated) {
    throw assignmentError(
      "VERSION_CONFLICT",
      "Scenario revision changed",
      params.currentAssignment
    );
  }
  return updated;
}

async function assignProjectionWithCas(params: {
  session: ClientSession;
  entryPoint: WhatsAppQrEntryPointRecord;
  scenarioId: string;
  nodeId: string;
  currentAssignment: WhatsAppQrAssignmentSummary | null;
}): Promise<WhatsAppQrEntryPointRecord> {
  const updated = await WhatsAppQrEntryPoint.findOneAndUpdate(
    {
      workspaceId: params.entryPoint.workspaceId,
      entryPointId: params.entryPoint.entryPointId,
      version: params.entryPoint.version,
      ...entryPointAssignmentFilter(params.entryPoint),
    },
    {
      $set: {
        scenarioId: params.scenarioId,
        nodeId: params.nodeId,
        assignmentState: "assigned",
      },
      $inc: { version: 1 },
    },
    { session: params.session, new: true, runValidators: true }
  ).lean<WhatsAppQrEntryPointRecord | null>();
  if (!updated) {
    throw assignmentError(
      "VERSION_CONFLICT",
      "Entry point version changed",
      params.currentAssignment
    );
  }
  return updated;
}

async function commitTargetAssignmentInSession(params: {
  session: ClientSession;
  targetScenario: ScenarioAssignmentRecord;
  targetNodeId: string;
  expectedUpdatedAt: string;
  nodesBeforeTargetSet: ScenarioGraphNode[];
  entryPoint: WhatsAppQrEntryPointRecord;
  projection: "created-assigned" | "cas";
  currentAssignment: WhatsAppQrAssignmentSummary | null;
}): Promise<{
  targetScenario: ScenarioAssignmentRecord;
  entryPoint: WhatsAppQrEntryPointRecord;
}> {
  if (
    params.projection === "created-assigned" &&
    (params.entryPoint.scenarioId !== scenarioId(params.targetScenario) ||
      params.entryPoint.nodeId !== params.targetNodeId ||
      params.entryPoint.assignmentState !== "assigned")
  ) {
    throw assignmentError(
      "STORAGE_FAILED",
      "Created QR assignment projection is contradictory"
    );
  }
  const targetScenario = await writeScenarioWithCas({
    session: params.session,
    scenario: params.targetScenario,
    expectedUpdatedAt: params.expectedUpdatedAt,
    currentAssignment: params.currentAssignment,
    nodes: setWhatsAppQrGraphBinding(
      params.nodesBeforeTargetSet,
      params.targetNodeId,
      params.entryPoint.entryPointId
    ),
  });
  const entryPoint =
    params.projection === "cas"
      ? await assignProjectionWithCas({
          session: params.session,
          entryPoint: params.entryPoint,
          scenarioId: scenarioId(params.targetScenario),
          nodeId: params.targetNodeId,
          currentAssignment: params.currentAssignment,
        })
      : params.entryPoint;
  return { targetScenario, entryPoint };
}

async function unassignProjectionWithCas(params: {
  session: ClientSession;
  entryPoint: WhatsAppQrEntryPointRecord;
  currentAssignment: WhatsAppQrAssignmentSummary | null;
}): Promise<WhatsAppQrEntryPointRecord> {
  const clearsAssignment = Boolean(
    params.entryPoint.scenarioId && params.entryPoint.nodeId
  );
  if (!clearsAssignment) {
    throw assignmentError(
      "STORAGE_FAILED",
      "Entry point is already unassigned"
    );
  }
  const updated = await WhatsAppQrEntryPoint.findOneAndUpdate(
    {
      workspaceId: params.entryPoint.workspaceId,
      entryPointId: params.entryPoint.entryPointId,
      version: params.entryPoint.version,
      ...entryPointAssignmentFilter(params.entryPoint),
    },
    {
      $set: { assignmentState: "unassigned" },
      $unset: { scenarioId: 1, nodeId: 1 },
      $inc: { version: 1 },
    },
    { session: params.session, new: true, runValidators: true }
  ).lean<WhatsAppQrEntryPointRecord | null>();
  if (!updated) {
    throw assignmentError(
      "VERSION_CONFLICT",
      "Entry point version changed",
      params.currentAssignment
    );
  }
  return updated;
}

async function reviveDetachedStatusWithCas(params: {
  session: ClientSession;
  entryPoint: WhatsAppQrEntryPointRecord;
  status: "DRAFT" | "ACTIVE";
  currentAssignment: WhatsAppQrAssignmentSummary | null;
}): Promise<WhatsAppQrEntryPointRecord> {
  const providerBindingFilter =
    params.status === "ACTIVE"
      ? {
          sourceId: params.entryPoint.sourceId,
          wabaId: params.entryPoint.wabaId,
          phoneNumberId: params.entryPoint.phoneNumberId,
          currentCodeId: params.entryPoint.currentCodeId,
        }
      : {
          sourceId: { $exists: false },
          wabaId: { $exists: false },
          phoneNumberId: { $exists: false },
          currentCodeId: { $exists: false },
        };
  const updated = await WhatsAppQrEntryPoint.findOneAndUpdate(
    {
      workspaceId: params.entryPoint.workspaceId,
      entryPointId: params.entryPoint.entryPointId,
      version: params.entryPoint.version,
      status: "DETACHED",
      scenarioId: { $exists: false },
      nodeId: { $exists: false },
      assignmentState: "unassigned",
      ...providerBindingFilter,
    },
    { $set: { status: params.status }, $inc: { version: 1 } },
    { session: params.session, new: true, runValidators: true }
  ).lean<WhatsAppQrEntryPointRecord | null>();
  if (!updated) {
    throw assignmentError(
      "VERSION_CONFLICT",
      "Entry point version changed",
      params.currentAssignment
    );
  }
  return updated;
}

async function withAssignmentTransaction<T>(
  operation: (session: ClientSession) => Promise<T>
): Promise<T> {
  const session = await Scenario.startSession();
  let result: T | undefined;
  try {
    await session.withTransaction(async () => {
      result = await operation(session);
    });
  } finally {
    await session.endSession();
  }
  if (result === undefined) {
    throw assignmentError("STORAGE_FAILED", "Transaction produced no result");
  }
  return result;
}

export async function assignWhatsAppQrEntryPoint(
  params: AssignWhatsAppQrEntryPointInput
): Promise<WhatsAppQrAssignmentResult> {
  await assertWhatsAppQrUnassignedWritesEnabled();
  const workspaceId = requiredString(params.workspaceId, "Workspace id");
  const entryPointId = normalizeWhatsAppQrEntryPointUuid(params.entryPointId);
  if (!entryPointId) {
    throw assignmentError("INVALID_INPUT", "Entry point id is invalid");
  }
  const expectedEntryPointVersion = requiredVersion(
    params.expectedEntryPointVersion,
    "Expected entry-point version"
  );
  const targetScenarioId = requiredString(
    params.target?.scenarioId,
    "Target Scenario id"
  );
  const targetNodeId = requiredString(params.target?.nodeId, "Target node id");
  const targetExpectedUpdatedAt = requiredRevision(
    params.target?.expectedUpdatedAt,
    "Expected target Scenario revision"
  );
  const expectedCurrentEntryPointId =
    params.target?.expectedCurrentEntryPointId === null
      ? null
      : normalizeWhatsAppQrEntryPointUuid(
          params.target?.expectedCurrentEntryPointId
        );
  if (
    params.target?.expectedCurrentEntryPointId !== null &&
    !expectedCurrentEntryPointId
  ) {
    throw assignmentError(
      "INVALID_INPUT",
      "Expected current entry point id is invalid"
    );
  }

  const assignmentFenceToken = randomUUID();
  return withAssignmentTransaction(async session => {
    const entryPoint = await loadEntryPoint(session, workspaceId, entryPointId);
    const targetScenario = await loadScenario(
      session,
      workspaceId,
      targetScenarioId
    );
    const targetBinding = currentBinding(targetScenario, targetNodeId);

    if (
      targetBinding === entryPointId &&
      entryPoint.scenarioId === targetScenarioId &&
      entryPoint.nodeId === targetNodeId &&
      entryPoint.assignmentState === "assigned"
    ) {
      return {
        entryPointId,
        entryPointVersion: entryPoint.version,
        assignment: assignmentSummary(targetScenario, targetNodeId),
        targetScenario: {
          scenarioId: targetScenarioId,
          updatedAt: isoDate(targetScenario.updatedAt),
          nodeId: targetNodeId,
          previousEntryPointId: entryPointId,
        },
      };
    }

    const hasSource = Boolean(entryPoint.scenarioId && entryPoint.nodeId);
    if (Boolean(entryPoint.scenarioId) !== Boolean(entryPoint.nodeId)) {
      throw assignmentError(
        "STORAGE_FAILED",
        "Entry point assignment projection is contradictory"
      );
    }
    const isSameScenarioMove =
      hasSource && entryPoint.scenarioId === targetScenarioId;
    const sourceScenario = hasSource
      ? isSameScenarioMove
        ? targetScenario
        : await loadScenario(session, workspaceId, entryPoint.scenarioId!)
      : null;
    if (
      sourceScenario &&
      currentBinding(sourceScenario, entryPoint.nodeId!) !== entryPointId
    ) {
      throw assignmentError(
        "STORAGE_FAILED",
        "Scenario graph and QR assignment projection disagree"
      );
    }
    const currentAssignment = sourceScenario
      ? assignmentSummary(sourceScenario, entryPoint.nodeId!)
      : null;

    if (entryPoint.version !== expectedEntryPointVersion) {
      throw assignmentError(
        "VERSION_CONFLICT",
        "Entry point version changed",
        currentAssignment
      );
    }
    if (!revisionsMatch(targetScenario.updatedAt, targetExpectedUpdatedAt)) {
      throw assignmentError(
        "VERSION_CONFLICT",
        "Target Scenario changed",
        currentAssignment
      );
    }
    if (targetScenario.status !== "draft") {
      throw assignmentError(
        "ACTIVE_SCENARIO_ASSIGNMENT",
        "Deactivate the target Scenario before changing its QR assignment",
        currentAssignment
      );
    }
    if (targetBinding !== expectedCurrentEntryPointId) {
      throw assignmentError(
        "VERSION_CONFLICT",
        "Target QR binding changed",
        currentAssignment
      );
    }
    if (hasSource) {
      if (!isSameScenarioMove && params.acknowledgeMove !== true) {
        throw assignmentError(
          "MOVE_ACKNOWLEDGEMENT_REQUIRED",
          "Moving this QR requires acknowledgement",
          currentAssignment
        );
      }
      if (!isSameScenarioMove && params.sourceExpectedUpdatedAt === undefined) {
        throw assignmentError(
          "SOURCE_REVISION_REQUIRED",
          "Source Scenario revision is required",
          currentAssignment
        );
      }
      if (sourceScenario!.status !== "draft") {
        throw assignmentError(
          "ACTIVE_SCENARIO_ASSIGNMENT",
          "Deactivate the source Scenario before moving this QR",
          currentAssignment
        );
      }
      if (!isSameScenarioMove) {
        const expectedSourceRevision = requiredRevision(
          params.sourceExpectedUpdatedAt,
          "Expected source Scenario revision"
        );
        if (
          !revisionsMatch(sourceScenario!.updatedAt, expectedSourceRevision)
        ) {
          throw assignmentError(
            "VERSION_CONFLICT",
            "Source Scenario changed",
            currentAssignment
          );
        }
      }
    }

    await assertNoActiveDeleteOperationInSession({
      session,
      workspaceId,
      entryPointId,
      currentAssignment,
    });
    const code = await loadCurrentCode(session, entryPoint);
    if (!code || !isReadyActiveWhatsAppQrEntryPoint(entryPoint, code)) {
      throw assignmentError(
        "ENTRY_POINT_NOT_READY",
        "Entry point is not ready for assignment",
        currentAssignment
      );
    }
    await fenceCurrentCodeForAssignmentInSession({
      session,
      entryPoint,
      code,
      fenceToken: assignmentFenceToken,
      currentAssignment,
    });

    let displaced: WhatsAppQrEntryPointRecord | null = null;
    if (targetBinding && targetBinding !== entryPointId) {
      if (params.acknowledgeReplacement !== true) {
        throw assignmentError(
          "REPLACEMENT_ACKNOWLEDGEMENT_REQUIRED",
          "Replacing this QR requires acknowledgement",
          currentAssignment
        );
      }
      const expectedDisplacedVersion = requiredVersion(
        params.target.expectedCurrentEntryPointVersion,
        "Expected current entry-point version"
      );
      displaced = await loadEntryPoint(session, workspaceId, targetBinding);
      if (
        displaced.version !== expectedDisplacedVersion ||
        displaced.scenarioId !== targetScenarioId ||
        displaced.nodeId !== targetNodeId ||
        displaced.assignmentState !== "assigned"
      ) {
        throw assignmentError(
          "VERSION_CONFLICT",
          "Displaced entry point changed",
          currentAssignment
        );
      }
      await assertNoActiveDeleteOperationInSession({
        session,
        workspaceId,
        entryPointId: displaced.entryPointId,
        currentAssignment: assignmentSummary(targetScenario, targetNodeId),
      });
    }

    let updatedSource: ScenarioAssignmentRecord | null = null;
    let nodesBeforeTargetSet: ScenarioGraphNode[];
    if (sourceScenario && isSameScenarioMove) {
      nodesBeforeTargetSet = clearWhatsAppQrGraphBinding(
        scenarioNodes(sourceScenario),
        entryPoint.nodeId!
      );
    } else {
      if (sourceScenario) {
        updatedSource = await writeScenarioWithCas({
          session,
          scenario: sourceScenario,
          currentAssignment,
          expectedUpdatedAt: requiredRevision(
            params.sourceExpectedUpdatedAt,
            "Expected source Scenario revision"
          ),
          nodes: clearWhatsAppQrGraphBinding(
            scenarioNodes(sourceScenario),
            entryPoint.nodeId!
          ),
        });
      }
      nodesBeforeTargetSet = scenarioNodes(targetScenario);
    }

    const updatedDisplaced = displaced
      ? await unassignProjectionWithCas({
          session,
          entryPoint: displaced,
          currentAssignment,
        })
      : null;
    const committed = await commitTargetAssignmentInSession({
      session,
      targetScenario,
      targetNodeId,
      expectedUpdatedAt: targetExpectedUpdatedAt,
      nodesBeforeTargetSet,
      entryPoint,
      projection: "cas",
      currentAssignment,
    });
    const updatedTarget = committed.targetScenario;
    const updatedEntryPoint = committed.entryPoint;
    if (sourceScenario && isSameScenarioMove) updatedSource = updatedTarget;
    return {
      entryPointId,
      entryPointVersion: updatedEntryPoint.version,
      assignment: assignmentSummary(updatedTarget, targetNodeId),
      targetScenario: {
        scenarioId: targetScenarioId,
        updatedAt: isoDate(updatedTarget.updatedAt),
        nodeId: targetNodeId,
        previousEntryPointId: targetBinding,
      },
      ...(updatedSource && entryPoint.nodeId
        ? {
            sourceScenario: {
              scenarioId: scenarioId(updatedSource),
              updatedAt: isoDate(updatedSource.updatedAt),
              nodeId: entryPoint.nodeId,
            },
          }
        : {}),
      ...(updatedDisplaced
        ? {
            displacedEntryPoint: {
              entryPointId: updatedDisplaced.entryPointId,
              version: updatedDisplaced.version,
            },
          }
        : {}),
    };
  });
}

export async function unassignWhatsAppQrEntryPoint(
  params: UnassignWhatsAppQrEntryPointInput
): Promise<WhatsAppQrAssignmentResult> {
  await assertWhatsAppQrUnassignedWritesEnabled();
  const workspaceId = requiredString(params.workspaceId, "Workspace id");
  const entryPointId = normalizeWhatsAppQrEntryPointUuid(params.entryPointId);
  if (!entryPointId) {
    throw assignmentError("INVALID_INPUT", "Entry point id is invalid");
  }
  const expectedEntryPointVersion = requiredVersion(
    params.expectedEntryPointVersion,
    "Expected entry-point version"
  );
  const sourceExpectedUpdatedAt = requiredRevision(
    params.sourceExpectedUpdatedAt,
    "Expected source Scenario revision"
  );
  return withAssignmentTransaction(async session => {
    const entryPoint = await loadEntryPoint(session, workspaceId, entryPointId);
    if (
      !entryPoint.scenarioId &&
      !entryPoint.nodeId &&
      entryPoint.assignmentState === "unassigned"
    ) {
      return {
        entryPointId,
        entryPointVersion: entryPoint.version,
        assignment: null,
      };
    }
    if (!entryPoint.scenarioId || !entryPoint.nodeId) {
      throw assignmentError(
        "STORAGE_FAILED",
        "Entry point assignment projection is contradictory"
      );
    }
    const source = await loadScenario(
      session,
      workspaceId,
      entryPoint.scenarioId
    );
    if (currentBinding(source, entryPoint.nodeId) !== entryPointId) {
      throw assignmentError(
        "STORAGE_FAILED",
        "Scenario graph and QR assignment projection disagree"
      );
    }
    const currentAssignment = assignmentSummary(source, entryPoint.nodeId);
    if (entryPoint.version !== expectedEntryPointVersion) {
      throw assignmentError(
        "VERSION_CONFLICT",
        "Entry point version changed",
        currentAssignment
      );
    }
    await assertNoActiveDeleteOperationInSession({
      session,
      workspaceId,
      entryPointId,
      currentAssignment,
    });
    if (source.status !== "draft") {
      throw assignmentError(
        "ACTIVE_SCENARIO_ASSIGNMENT",
        "Deactivate the Scenario before unassigning this QR",
        currentAssignment
      );
    }
    if (!revisionsMatch(source.updatedAt, sourceExpectedUpdatedAt)) {
      throw assignmentError(
        "VERSION_CONFLICT",
        "Source Scenario changed",
        currentAssignment
      );
    }
    const updatedSource = await writeScenarioWithCas({
      session,
      scenario: source,
      expectedUpdatedAt: sourceExpectedUpdatedAt,
      currentAssignment,
      nodes: clearWhatsAppQrGraphBinding(
        scenarioNodes(source),
        entryPoint.nodeId
      ),
    });
    const updatedEntryPoint = await unassignProjectionWithCas({
      session,
      entryPoint,
      currentAssignment,
    });
    return {
      entryPointId,
      entryPointVersion: updatedEntryPoint.version,
      assignment: null,
      sourceScenario: {
        scenarioId: scenarioId(updatedSource),
        updatedAt: isoDate(updatedSource.updatedAt),
        nodeId: entryPoint.nodeId,
      },
    };
  });
}

export async function recoverDetachedWhatsAppQrEntryPoint(
  params: RecoverDetachedWhatsAppQrEntryPointInput
): Promise<WhatsAppQrAssignmentResult> {
  await assertWhatsAppQrUnassignedWritesEnabled();
  const workspaceId = requiredString(params.workspaceId, "Workspace id");
  const entryPointId = normalizeWhatsAppQrEntryPointUuid(params.entryPointId);
  if (!entryPointId) {
    throw assignmentError("INVALID_INPUT", "Entry point id is invalid");
  }
  const expectedEntryPointVersion = requiredVersion(
    params.expectedEntryPointVersion,
    "Expected entry-point version"
  );
  return withAssignmentTransaction(async session => {
    const entryPoint = await loadEntryPoint(session, workspaceId, entryPointId);
    if (
      entryPoint.status !== "DETACHED" &&
      !entryPoint.scenarioId &&
      !entryPoint.nodeId &&
      entryPoint.assignmentState === "unassigned" &&
      (entryPoint.status === "DRAFT" || entryPoint.status === "ACTIVE")
    ) {
      return {
        entryPointId,
        entryPointVersion: entryPoint.version,
        assignment: null,
      };
    }
    if (Boolean(entryPoint.scenarioId) !== Boolean(entryPoint.nodeId)) {
      throw assignmentError(
        "DETACHED_STATE_INVALID",
        "Detached assignment state is contradictory",
        null
      );
    }
    const source =
      entryPoint.scenarioId && entryPoint.nodeId
        ? await loadScenario(session, workspaceId, entryPoint.scenarioId)
        : null;
    const currentAssignment = source
      ? assignmentSummary(source, entryPoint.nodeId!)
      : null;
    if (source && currentBinding(source, entryPoint.nodeId!) !== entryPointId) {
      throw assignmentError(
        "DETACHED_STATE_INVALID",
        "Detached graph binding is contradictory",
        currentAssignment
      );
    }
    if (
      entryPoint.status !== "DETACHED" ||
      entryPoint.version !== expectedEntryPointVersion
    ) {
      throw assignmentError(
        "VERSION_CONFLICT",
        "Entry point changed",
        currentAssignment
      );
    }
    await assertNoActiveDeleteOperationInSession({
      session,
      workspaceId,
      entryPointId,
      currentAssignment,
    });
    const providerTuple = [
      entryPoint.sourceId,
      entryPoint.wabaId,
      entryPoint.phoneNumberId,
      entryPoint.currentCodeId,
    ];
    const absent = providerTuple.every(value => value === undefined);
    const complete = providerTuple.every(isCanonicalString);
    if (!absent && !complete) {
      throw assignmentError(
        "DETACHED_STATE_INVALID",
        "Detached provider binding is incomplete",
        currentAssignment
      );
    }
    if (complete) {
      const code = await loadCurrentCode(session, entryPoint);
      if (
        !isReadyActiveWhatsAppQrEntryPoint(
          { ...entryPoint, status: "ACTIVE" },
          code
        )
      ) {
        throw assignmentError(
          "DETACHED_STATE_INVALID",
          "Detached current code is not healthy",
          currentAssignment
        );
      }
    }

    let updatedSource: ScenarioAssignmentRecord | null = null;
    if (source && entryPoint.nodeId) {
      if (source.status !== "draft") {
        throw assignmentError(
          "ACTIVE_SCENARIO_ASSIGNMENT",
          "Deactivate the Scenario before recovering this QR",
          currentAssignment
        );
      }
      updatedSource = await writeScenarioWithCas({
        session,
        scenario: source,
        expectedUpdatedAt: isoDate(source.updatedAt),
        currentAssignment,
        nodes: clearWhatsAppQrGraphBinding(
          scenarioNodes(source),
          entryPoint.nodeId
        ),
      });
    }

    const unassignedEntryPoint =
      entryPoint.scenarioId && entryPoint.nodeId
        ? await unassignProjectionWithCas({
            session,
            entryPoint,
            currentAssignment,
          })
        : entryPoint;
    const recovered = await reviveDetachedStatusWithCas({
      session,
      entryPoint: unassignedEntryPoint,
      status: complete ? "ACTIVE" : "DRAFT",
      currentAssignment,
    });
    return {
      entryPointId,
      entryPointVersion: recovered.version,
      assignment: null,
      ...(updatedSource && entryPoint.nodeId
        ? {
            sourceScenario: {
              scenarioId: scenarioId(updatedSource),
              updatedAt: isoDate(updatedSource.updatedAt),
              nodeId: entryPoint.nodeId,
            },
          }
        : {}),
    };
  });
}
