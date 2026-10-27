import "server-only";

import type { ClientSession } from "mongoose";
import connectDB from "@/lib/mongoose";
import {
  WhatsAppQrCode,
  WHATSAPP_QR_MANAGEABLE_HISTORY_LIMIT,
  type WhatsAppQrCodeRecord,
} from "@/models/whatsapp-qr-code";
import {
  WhatsAppQrEntryPoint,
  type WhatsAppQrEntryPointRecord,
} from "@/models/whatsapp-qr-entry-point";
import {
  WhatsAppQrOperation,
  type WhatsAppQrOperationRecord,
} from "@/models/whatsapp-qr-operation";
import { requireNonEmptyString as requiredString } from "@icecore/shared/lib/value-utils";
import type {
  WhatsAppQrCodeDetail,
  WhatsAppQrEntryPointDetail,
  WhatsAppQrScenarioSummary,
} from "./dto";
import { loadWhatsAppQrAssignmentSummaries } from "./assignment-summary";
import { normalizeWhatsAppQrEntryPointUuid } from "./normalization";
import { isWhatsAppQrOperationLeaseLive } from "./operation-store";
import {
  isReadyActiveWhatsAppQrEntryPoint,
  resolveWhatsAppQrReadiness,
} from "./readiness";

export type {
  WhatsAppQrCodeDetail,
  WhatsAppQrEntryPointDetail,
  WhatsAppQrScenarioSummary,
} from "./dto";

type ScenarioSummaryCodeProjection = {
  codeId: string;
  workspaceId: string;
  entryPointId: string;
  sourceId: string;
  wabaId: string;
  phoneNumberId: string;
  providerCode?: string;
  deepLink?: string;
  placementBindingState: string;
  routingState: string;
  providerState: string;
};

type ScenarioSummaryOperationProjection = {
  workspaceId: string;
  entryPointId: string;
};

function toWhatsAppQrCodeDetail(
  code: WhatsAppQrCodeRecord
): WhatsAppQrCodeDetail {
  return {
    codeId: code.codeId,
    referenceCode: code.referenceCode,
    ...(code.providerCode ? { providerCode: code.providerCode } : {}),
    ...(code.deepLink ? { deepLink: code.deepLink } : {}),
    ...(code.prefilledMessage !== undefined
      ? { prefilledMessage: code.prefilledMessage }
      : {}),
    placementBindingState: code.placementBindingState,
    routingState: code.routingState,
    providerState: code.providerState,
    version: code.version,
  };
}

function isoDate(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error("Persisted date is invalid");
  }
  return date.toISOString();
}

export async function findWhatsAppQrCodeByReference(params: {
  workspaceId: string;
  sourceId: string;
  referenceCode: string;
}): Promise<WhatsAppQrCodeRecord | null> {
  await connectDB();
  const workspaceId = requiredString(params.workspaceId, "Workspace id");
  const sourceId = requiredString(params.sourceId, "Source id");
  const referenceCode = requiredString(
    params.referenceCode,
    "Reference code"
  ).toUpperCase();
  return WhatsAppQrCode.findOne({
    workspaceId,
    sourceId,
    referenceCode,
  }).lean<WhatsAppQrCodeRecord | null>();
}

export async function listWhatsAppQrScenarioSummaries(params: {
  workspaceId: string;
  scenarioId: string;
}): Promise<Record<string, WhatsAppQrScenarioSummary>> {
  await connectDB();
  const workspaceId = requiredString(params.workspaceId, "Workspace id");
  const scenarioId = requiredString(params.scenarioId, "Scenario id");
  const entryPoints = await WhatsAppQrEntryPoint.find({
    workspaceId,
    scenarioId,
  }).lean<WhatsAppQrEntryPointRecord[]>();

  const entryPointIds = entryPoints.map(entryPoint => entryPoint.entryPointId);
  const currentCodeIds = Array.from(
    new Set(
      entryPoints
        .map(entryPoint => entryPoint.currentCodeId)
        .filter((codeId): codeId is string => Boolean(codeId))
    )
  );
  const [codes, operations] = await Promise.all([
    currentCodeIds.length
      ? WhatsAppQrCode.find({
          workspaceId,
          codeId: { $in: currentCodeIds },
        })
          .select({
            _id: 0,
            codeId: 1,
            workspaceId: 1,
            entryPointId: 1,
            sourceId: 1,
            wabaId: 1,
            phoneNumberId: 1,
            providerCode: 1,
            deepLink: 1,
            placementBindingState: 1,
            routingState: 1,
            providerState: 1,
          })
          .lean<ScenarioSummaryCodeProjection[]>()
      : Promise.resolve([]),
    entryPointIds.length
      ? WhatsAppQrOperation.find({
          workspaceId,
          entryPointId: { $in: entryPointIds },
          status: { $in: ["RUNNING", "RECONCILE_REQUIRED"] },
        })
          .select({ _id: 0, workspaceId: 1, entryPointId: 1 })
          .lean<ScenarioSummaryOperationProjection[]>()
      : Promise.resolve([]),
  ]);
  const codeById = new Map(
    codes
      .filter(code => code.workspaceId === workspaceId)
      .map(code => [code.codeId, code])
  );
  const reconcilePendingEntryPointIds = new Set(
    operations
      .filter(operation => operation.workspaceId === workspaceId)
      .map(operation => operation.entryPointId)
  );

  const summaries: Record<string, WhatsAppQrScenarioSummary> = {};
  for (const entryPoint of entryPoints) {
    if (!entryPoint.nodeId) continue;
    const candidateCode = entryPoint.currentCodeId
      ? codeById.get(entryPoint.currentCodeId)
      : undefined;
    const currentCode =
      candidateCode?.entryPointId === entryPoint.entryPointId
        ? candidateCode
        : undefined;
    const reconcilePending = reconcilePendingEntryPointIds.has(
      entryPoint.entryPointId
    );
    summaries[entryPoint.nodeId] = {
      entryPointId: entryPoint.entryPointId,
      placementName: entryPoint.placementName,
      status: entryPoint.status,
      ...(entryPoint.sourceId ? { sourceId: entryPoint.sourceId } : {}),
      hasCurrentCode: Boolean(entryPoint.currentCodeId),
      readiness: resolveWhatsAppQrReadiness({
        entryPoint,
        currentCode,
        reconcilePending,
      }),
      reconcilePending,
      version: entryPoint.version,
    };
  }
  return summaries;
}

/**
 * Tuple lookup retained only for the named runtime fallback. New assignment
 * paths use stable entryPointId.
 */
export async function findWhatsAppQrEntryPointByNode(params: {
  workspaceId: string;
  scenarioId?: string;
  nodeId?: string;
}): Promise<WhatsAppQrEntryPointRecord | null> {
  await connectDB();
  return WhatsAppQrEntryPoint.findOne({
    workspaceId: requiredString(params.workspaceId, "Workspace id"),
    scenarioId: requiredString(params.scenarioId, "Scenario id"),
    nodeId: requiredString(params.nodeId, "Node id"),
  }).lean<WhatsAppQrEntryPointRecord | null>();
}

export async function getWhatsAppQrEntryPointDetail(params: {
  workspaceId: string;
  entryPointId: string;
}): Promise<WhatsAppQrEntryPointDetail | null> {
  await connectDB();
  const workspaceId = requiredString(params.workspaceId, "Workspace id");
  const entryPointId = requiredString(params.entryPointId, "Entry point id");
  const entryPoint = await WhatsAppQrEntryPoint.findOne({
    workspaceId,
    entryPointId,
  }).lean<WhatsAppQrEntryPointRecord | null>();
  if (!entryPoint) return null;

  const detail: WhatsAppQrEntryPointDetail = {
    entryPoint: {
      entryPointId: entryPoint.entryPointId,
      workspaceId: entryPoint.workspaceId,
      ...(entryPoint.scenarioId ? { scenarioId: entryPoint.scenarioId } : {}),
      ...(entryPoint.nodeId ? { nodeId: entryPoint.nodeId } : {}),
      placementName: entryPoint.placementName,
      ...(entryPoint.desiredMessage !== undefined
        ? { desiredMessage: entryPoint.desiredMessage }
        : {}),
      ...(entryPoint.sourceId ? { sourceId: entryPoint.sourceId } : {}),
      ...(entryPoint.wabaId ? { wabaId: entryPoint.wabaId } : {}),
      ...(entryPoint.phoneNumberId
        ? { phoneNumberId: entryPoint.phoneNumberId }
        : {}),
      ...(entryPoint.currentCodeId
        ? { currentCodeId: entryPoint.currentCodeId }
        : {}),
      status: entryPoint.status,
      version: entryPoint.version,
      updatedAt: isoDate(entryPoint.updatedAt),
    },
    assignment: null,
    historicalCodes: [],
    historicalCodesHasMore: false,
    canCreateReplacement: true,
    operationPending: false,
  };

  const [
    currentCode,
    historicalCodeWindow,
    activeOperation,
    assignmentsByEntryPointId,
  ] = await Promise.all([
    entryPoint.currentCodeId
      ? WhatsAppQrCode.findOne({
          workspaceId,
          entryPointId,
          codeId: entryPoint.currentCodeId,
        }).lean<WhatsAppQrCodeRecord | null>()
      : Promise.resolve(null),
    WhatsAppQrCode.find({
      workspaceId,
      entryPointId,
      placementBindingState: "HISTORICAL",
      providerState: { $in: ["ACTIVE", "RECONCILING"] },
    })
      .sort({ createdAt: -1 })
      .limit(WHATSAPP_QR_MANAGEABLE_HISTORY_LIMIT + 1)
      .lean<WhatsAppQrCodeRecord[]>(),
    WhatsAppQrOperation.findOne({
      workspaceId,
      entryPointId,
      status: { $in: ["RUNNING", "RECONCILE_REQUIRED"] },
    }).lean<WhatsAppQrOperationRecord | null>(),
    loadWhatsAppQrAssignmentSummaries({
      workspaceId,
      assignments: [entryPoint],
    }),
  ]);

  if (currentCode) {
    detail.currentCode = toWhatsAppQrCodeDetail(currentCode);
  }
  detail.historicalCodes = historicalCodeWindow
    .slice(0, WHATSAPP_QR_MANAGEABLE_HISTORY_LIMIT)
    .map(toWhatsAppQrCodeDetail);
  detail.historicalCodesHasMore =
    historicalCodeWindow.length > WHATSAPP_QR_MANAGEABLE_HISTORY_LIMIT;
  detail.canCreateReplacement =
    historicalCodeWindow.length < WHATSAPP_QR_MANAGEABLE_HISTORY_LIMIT;
  detail.assignment =
    assignmentsByEntryPointId.get(entryPoint.entryPointId) ?? null;
  detail.operationPending = Boolean(activeOperation);
  const reconcileOperation =
    activeOperation?.status === "RECONCILE_REQUIRED" ||
    (activeOperation?.status === "RUNNING" &&
      activeOperation.kind === "DELETE" &&
      entryPoint.lastDeletionFenceToken === activeOperation.operationId &&
      !isWhatsAppQrOperationLeaseLive(activeOperation))
      ? activeOperation
      : null;
  if (reconcileOperation) {
    detail.reconcileOperation = {
      operationId: reconcileOperation.operationId,
      sourceId: reconcileOperation.sourceId,
      kind: reconcileOperation.kind,
      ...(reconcileOperation.codeId
        ? { codeId: reconcileOperation.codeId }
        : {}),
    };
  }
  return detail;
}

export type WhatsAppQrEntryPointBinding = {
  nodeId: string;
  entryPointId?: string | null;
};

export type WhatsAppQrEntryPointReadinessEvidence = {
  entryPointId: string;
  ready: boolean;
  currentCodeId?: string;
  currentCodeVersion?: number;
};

export const WHATSAPP_QR_BLOCKING_DELETE_OPERATION_STATUSES = [
  "RUNNING",
  "RECONCILE_REQUIRED",
] as const;

/**
 * Load activation evidence by the stable graph pointer. A binding without a
 * pointer has no evidence.
 */
export async function loadWhatsAppQrEntryPointReadinessByBindings(params: {
  workspaceId: string;
  scenarioId: string;
  bindings: readonly WhatsAppQrEntryPointBinding[];
  session?: ClientSession;
}): Promise<Record<string, WhatsAppQrEntryPointReadinessEvidence>> {
  await connectDB();
  const workspaceId = requiredString(params.workspaceId, "Workspace id");
  const scenarioId = requiredString(params.scenarioId, "Scenario id");
  const bindings = params.bindings.flatMap(binding => {
    const nodeId =
      typeof binding.nodeId === "string" ? binding.nodeId.trim() : "";
    if (!nodeId) return [];
    const rawEntryPointId =
      typeof binding.entryPointId === "string"
        ? binding.entryPointId.trim()
        : "";
    return [
      {
        nodeId,
        rawEntryPointId,
        entryPointId: normalizeWhatsAppQrEntryPointUuid(rawEntryPointId),
      },
    ];
  });
  if (bindings.length === 0) return {};

  const selectedEntryPointIds = Array.from(
    new Set(
      bindings.flatMap(binding =>
        binding.entryPointId ? [binding.entryPointId] : []
      )
    )
  );
  const selectedQuery = WhatsAppQrEntryPoint.find({
    workspaceId,
    entryPointId: { $in: selectedEntryPointIds },
  });
  if (params.session) selectedQuery.session(params.session);
  const selectedEntryPoints =
    selectedEntryPointIds.length === 0
      ? []
      : await selectedQuery.lean<WhatsAppQrEntryPointRecord[]>();
  const selectedById = new Map(
    selectedEntryPoints.map(entryPoint => [entryPoint.entryPointId, entryPoint])
  );

  const candidates = bindings.flatMap(binding => {
    const entryPoint = binding.entryPointId
      ? selectedById.get(binding.entryPointId)
      : undefined;
    return entryPoint ? [{ binding, entryPoint }] : [];
  });

  const codeIds = Array.from(
    new Set(
      candidates
        .map(candidate => candidate.entryPoint)
        .map(entryPoint => entryPoint.currentCodeId)
        .filter((codeId): codeId is string => Boolean(codeId))
    )
  );

  const codesQuery = WhatsAppQrCode.find({
    workspaceId,
    codeId: { $in: codeIds },
  });
  if (params.session) codesQuery.session(params.session);
  const codes =
    codeIds.length === 0 ? [] : await codesQuery.lean<WhatsAppQrCodeRecord[]>();

  const codesById = new Map(codes.map(code => [code.codeId, code]));
  const candidateEntryPointIds = Array.from(
    new Set(candidates.map(candidate => candidate.entryPoint.entryPointId))
  );
  const operationQuery = WhatsAppQrOperation.find({
    workspaceId,
    entryPointId: { $in: candidateEntryPointIds },
    kind: "DELETE",
    status: { $in: [...WHATSAPP_QR_BLOCKING_DELETE_OPERATION_STATUSES] },
  }).select({ entryPointId: 1 });
  if (params.session) operationQuery.session(params.session);
  const blockingOperations =
    candidateEntryPointIds.length === 0
      ? []
      : await operationQuery.lean<WhatsAppQrOperationRecord[]>();
  const deleteBlockedEntryPointIds = new Set(
    blockingOperations.map(operation => operation.entryPointId)
  );

  const readiness: Record<string, WhatsAppQrEntryPointReadinessEvidence> = {};
  for (const binding of bindings) {
    if (binding.entryPointId) {
      readiness[binding.nodeId] = {
        entryPointId: binding.entryPointId,
        ready: false,
      };
    }
  }
  for (const { binding, entryPoint } of candidates) {
    const currentCode = entryPoint.currentCodeId
      ? (codesById.get(entryPoint.currentCodeId) ?? null)
      : null;
    const exactProjection =
      entryPoint.scenarioId === scenarioId &&
      entryPoint.nodeId === binding.nodeId &&
      entryPoint.assignmentState === "assigned";
    readiness[binding.nodeId] = {
      entryPointId: entryPoint.entryPointId,
      ready:
        exactProjection &&
        !deleteBlockedEntryPointIds.has(entryPoint.entryPointId) &&
        isReadyActiveWhatsAppQrEntryPoint(entryPoint, currentCode),
      ...(currentCode
        ? {
            currentCodeId: currentCode.codeId,
            currentCodeVersion: currentCode.version,
          }
        : {}),
    };
  }

  return readiness;
}
