import "server-only";

import { createHash, randomUUID } from "node:crypto";

import type {
  EditableWhatsAppFlowConfig,
  ManagedWhatsAppFlowProvisioningProjection,
  ScenarioGraphNode,
  WhatsAppFlowConfig,
} from "@icecore/scenario-contracts";
import { resolveWhatsAppFlowProviderId } from "@icecore/scenario-contracts";
import { serializeCanonicalJson } from "@icecore/shared/lib/canonical-json";

import connectDB from "@/lib/mongoose";
import { mutateScenarioGraphWithCas } from "@/lib/scenarios/scenario-graph-mutation";
import { toEditableWhatsAppFlowConfig } from "@/lib/scenarios/whatsapp-flow-config";
import { getSingleFlowIdFromWhatsAppTemplateComponents } from "@/lib/scenarios/whatsapp-template-flow";
import {
  applyManagedWhatsAppFlowProvisioningProjectionToNode,
  createWhatsAppFlowEditableContentDigest,
  normalizeManagedWhatsAppFlowProvisioningProjection,
} from "@/lib/scenarios/whatsapp-flow-projection";
import { resolveScenarioWhatsAppInteractiveFlowTarget } from "@/lib/scenarios/whatsapp-service-message";
import { WHATSAPP_FLOW_PROVISIONING_PROVIDER_STATUSES } from "@/lib/whatsapp/flows/provisioning-contract";
import { Scenario } from "@/models/scenario";
import {
  WhatsAppFlowProvisioningOperation,
  type WhatsAppFlowProvisioningError,
  type WhatsAppFlowProvisioningOperationRecord,
  type WhatsAppFlowProvisioningProviderResolution,
} from "@/models/whatsapp-flow-provisioning-operation";
import { requireNonEmptyString } from "@icecore/shared/lib/value-utils";

const OPERATION_LEASE_MS = 2 * 60 * 1_000;
const SUPERSEDED_OPERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_ERROR_CODE_LENGTH = 128;
const MAX_ERROR_MESSAGE_LENGTH = 1_024;
const PROVIDER_MARKER_PREFIX = "airi_";
const PROVIDER_NAME_LIMIT = 200;
const PROVIDER_STATUSES = new Set<
  ManagedWhatsAppFlowProvisioningProjection["providerStatus"]
>(WHATSAPP_FLOW_PROVISIONING_PROVIDER_STATUSES);

type ProvisioningStage = WhatsAppFlowProvisioningOperationRecord["stage"];
type ProvisioningStatus = WhatsAppFlowProvisioningOperationRecord["status"];
type ProvisioningReleaseMode =
  WhatsAppFlowProvisioningOperationRecord["releaseMode"];
type ProviderResolutionKind =
  WhatsAppFlowProvisioningProviderResolution["kind"];
type ProviderResolutionOutcome = NonNullable<
  WhatsAppFlowProvisioningProviderResolution["outcome"]
>;
type ProvisioningOperationBinding = Pick<
  WhatsAppFlowProvisioningOperationRecord,
  | "workspaceId"
  | "scenarioId"
  | "nodeId"
  | "targetOwner"
  | "sourceId"
  | "wabaId"
  | "releaseMode"
  | "endpointId"
  | "applicationId"
>;

type ScenarioSnapshot = {
  nodes?: unknown;
  status?: unknown;
  updatedAt?: unknown;
};

export type ValidatedWhatsAppFlowProvisioningTarget = {
  config: EditableWhatsAppFlowConfig;
  contentDigest: string;
  owner: "template" | "service_message";
  releaseMode: ProvisioningReleaseMode;
  managedProjection?: ManagedWhatsAppFlowProvisioningProjection;
};

export type WhatsAppFlowProvisioningLease = {
  operationId: string;
  ownerToken: string;
  fence: number;
  expiresAt: Date;
};

export type ProjectedWhatsAppFlowProvisioningOperation = {
  operation: WhatsAppFlowProvisioningOperationRecord;
  projection: ManagedWhatsAppFlowProvisioningProjection;
  scenarioUpdatedAt: string;
};

export type WhatsAppFlowProviderResolutionClaim =
  | {
      kind: "claimed";
      operation: WhatsAppFlowProvisioningOperationRecord;
      lease: WhatsAppFlowProvisioningLease;
    }
  | {
      kind: "already_resolved";
      operation: WhatsAppFlowProvisioningOperationRecord;
    };

export type WhatsAppFlowProviderArtifact = {
  operationId: string;
  scenarioId: string;
  providerFlowId: string;
  providerFlowName?: string;
  lastKnownProviderStatus?: WhatsAppFlowProvisioningOperationRecord["providerStatus"];
  stage: WhatsAppFlowProvisioningOperationRecord["stage"];
  status: WhatsAppFlowProvisioningOperationRecord["status"];
  resolutionKind?: ProviderResolutionKind;
  resolutionOutcome?: ProviderResolutionOutcome;
  cleanupEligibility:
    | "ELIGIBLE"
    | "NOT_TERMINAL"
    | "REPLACEMENT_PENDING"
    | "BUSY"
    | "RESOLVED";
};

type WhatsAppFlowProvisioningStoreErrorCode =
  | "INVALID_INPUT"
  | "SCENARIO_NOT_FOUND"
  | "TARGET_NOT_FOUND"
  | "SERVER_FIELDS_PRESENT"
  | "CONTENT_DIGEST_MISMATCH"
  | "TEMPLATE_REBIND_REQUIRED"
  | "ACTIVE_SCENARIO_MIGRATION_REQUIRED"
  | "SOURCE_REBIND_REQUIRED"
  | "OPERATION_BUSY"
  | "OPERATION_CONFLICT"
  | "PROJECTED_OPERATION_MISSING"
  | "TARGET_CHANGED"
  | "PROJECTION_CONFLICT"
  | "STORAGE_FAILED";

export class WhatsAppFlowProvisioningStoreError extends Error {
  constructor(
    readonly code: WhatsAppFlowProvisioningStoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = "WhatsAppFlowProvisioningStoreError";
  }
}

function storeError(
  code: WhatsAppFlowProvisioningStoreErrorCode,
  message: string
): WhatsAppFlowProvisioningStoreError {
  return new WhatsAppFlowProvisioningStoreError(code, message);
}

const requiredString = (value: unknown, label: string) =>
  requireNonEmptyString(value, label, message =>
    storeError("INVALID_INPUT", message)
  );

function scenarioRevision(value: unknown): string | null {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function hasServerOwnedFields(config: WhatsAppFlowConfig): boolean {
  return [
    "managedProvisioning",
    "metaFlowId",
    "metaFlowName",
    "metaFlowStatus",
  ].some(field => Object.prototype.hasOwnProperty.call(config, field));
}

function provisioningReleaseMode(
  config: WhatsAppFlowConfig
): ProvisioningReleaseMode {
  const value = (config as { flowNavigationMode?: unknown }).flowNavigationMode;
  if (value === undefined || value === "linear") return "linear";
  if (value === "data_endpoint") return "data_endpoint";
  throw storeError("INVALID_INPUT", "Flow release mode is invalid");
}

function operationIdentityHash(params: {
  workspaceId: string;
  scenarioId: string;
  nodeId: string;
  targetOwner: "template" | "service_message";
  sourceId: string;
  wabaId: string;
  releaseMode: ProvisioningReleaseMode;
  endpointId?: string;
  applicationId?: string;
  replacesOperationId?: string;
  cloneFlowId?: string;
  contentRevision: number;
  contentDigest: string;
}): string {
  return createHash("sha256")
    .update(
      serializeCanonicalJson({
        version: 5,
        workspaceId: params.workspaceId,
        scenarioId: params.scenarioId,
        nodeId: params.nodeId,
        targetOwner: params.targetOwner,
        sourceId: params.sourceId,
        wabaId: params.wabaId,
        releaseMode: params.releaseMode,
        ...(params.endpointId ? { endpointId: params.endpointId } : {}),
        ...(params.applicationId
          ? { applicationId: params.applicationId }
          : {}),
        ...(params.replacesOperationId
          ? { replacesOperationId: params.replacesOperationId }
          : {}),
        ...(params.cloneFlowId ? { cloneFlowId: params.cloneFlowId } : {}),
        contentRevision: params.contentRevision,
        contentDigest: params.contentDigest,
      })
    )
    .digest("hex");
}

function providerMarker(operationId: string): string {
  const uniqueSuffix = createHash("sha256").update(operationId).digest("hex");
  return `${PROVIDER_MARKER_PREFIX}${uniqueSuffix}`;
}

export function buildWhatsAppFlowProviderName(params: {
  displayName: string;
  providerMarker: string;
}): string {
  const suffix = ` [${params.providerMarker}]`;
  const available = Math.max(1, PROVIDER_NAME_LIMIT - suffix.length);
  const base = requiredString(params.displayName, "Flow name").slice(
    0,
    available
  );
  return `${base}${suffix}`;
}

function stripWhatsAppFlowProviderMarker(params: {
  providerFlowName?: string;
  providerMarker: string;
}): string | undefined {
  const name = params.providerFlowName?.trim();
  if (!name) return undefined;
  const suffix = ` [${params.providerMarker}]`;
  return name.endsWith(suffix)
    ? name.slice(0, -suffix.length).trim() || undefined
    : undefined;
}

function operationProjection(
  operation: WhatsAppFlowProvisioningOperationRecord,
  providerStatus: ManagedWhatsAppFlowProvisioningProjection["providerStatus"] = operation.providerStatus as ManagedWhatsAppFlowProvisioningProjection["providerStatus"]
): ManagedWhatsAppFlowProvisioningProjection {
  if (!providerStatus || !PROVIDER_STATUSES.has(providerStatus)) {
    throw storeError(
      "OPERATION_CONFLICT",
      "Provisioning operation has no provider-confirmed status"
    );
  }
  const confirmedProviderFlowName = operation.providerFlowName?.trim();
  const flowName =
    stripWhatsAppFlowProviderMarker(operation) ??
    (confirmedProviderFlowName || undefined);
  return {
    operationId: operation.operationId,
    sourceId: operation.sourceId,
    wabaId: operation.wabaId,
    contentRevision: operation.contentRevision,
    contentDigest: operation.contentDigest,
    ...(operation.providerFlowId ? { flowId: operation.providerFlowId } : {}),
    ...(flowName ? { flowName } : {}),
    providerStatus,
  };
}

function hasExactManagedBinding(
  config: WhatsAppFlowConfig,
  operation: WhatsAppFlowProvisioningOperationRecord
): boolean {
  const current = normalizeManagedWhatsAppFlowProvisioningProjection(
    config.managedProvisioning
  );
  return Boolean(
    current &&
      operation.providerFlowId &&
      current.operationId === operation.operationId &&
      current.sourceId === operation.sourceId &&
      current.contentRevision === operation.contentRevision &&
      current.contentDigest === operation.contentDigest &&
      current.flowId === operation.providerFlowId
  );
}

function hasExactManagedProjection(
  config: WhatsAppFlowConfig,
  projection: ManagedWhatsAppFlowProvisioningProjection
): boolean {
  const current = normalizeManagedWhatsAppFlowProvisioningProjection(
    config.managedProvisioning
  );
  if (!current) return false;
  if (
    ["metaFlowId", "metaFlowName", "metaFlowStatus"].some(field =>
      Object.prototype.hasOwnProperty.call(config, field)
    )
  ) {
    return false;
  }
  return serializeCanonicalJson(current) === serializeCanonicalJson(projection);
}

function scenarioNodeById(
  nodes: readonly unknown[],
  nodeId: string
): ScenarioGraphNode | null {
  const node = nodes.find(
    candidate =>
      candidate !== null &&
      typeof candidate === "object" &&
      String((candidate as { id?: unknown }).id) === nodeId
  );
  return (node as ScenarioGraphNode | undefined) ?? null;
}

async function loadScenarioSnapshot(params: {
  workspaceId: string;
  scenarioId: string;
}): Promise<ScenarioSnapshot | null> {
  await connectDB();
  return Scenario.findOne({
    _id: params.scenarioId,
    workspaceId: params.workspaceId,
    deletedAt: null,
  })
    .select("nodes status updatedAt")
    .lean<ScenarioSnapshot | null>();
}

export async function validateWhatsAppFlowProvisioningTarget(params: {
  workspaceId: string;
  scenarioId: string;
  nodeId: string;
  editableConfig: WhatsAppFlowConfig;
}): Promise<ValidatedWhatsAppFlowProvisioningTarget> {
  const workspaceId = requiredString(params.workspaceId, "Workspace id");
  const scenarioId = requiredString(params.scenarioId, "Scenario id");
  const nodeId = requiredString(params.nodeId, "Node id");
  if (
    !params.editableConfig ||
    typeof params.editableConfig !== "object" ||
    hasServerOwnedFields(params.editableConfig)
  ) {
    throw storeError(
      "SERVER_FIELDS_PRESENT",
      "Editable Flow config cannot contain provider-owned fields"
    );
  }
  const requestReleaseMode = provisioningReleaseMode(params.editableConfig);

  const scenario = await loadScenarioSnapshot({ workspaceId, scenarioId });
  if (!scenario) {
    throw storeError("SCENARIO_NOT_FOUND", "Scenario was not found");
  }
  if (!scenarioRevision(scenario.updatedAt)) {
    throw storeError("STORAGE_FAILED", "Scenario revision is invalid");
  }
  const node = scenarioNodeById(
    Array.isArray(scenario.nodes) ? scenario.nodes : [],
    nodeId
  );
  const target = node
    ? resolveScenarioWhatsAppInteractiveFlowTarget(node.data)
    : null;
  if (!target) {
    throw storeError(
      "TARGET_NOT_FOUND",
      "WhatsApp Flow target was not found in this scenario node"
    );
  }
  const releaseMode = provisioningReleaseMode(target.config);
  const currentManagedProjection =
    normalizeManagedWhatsAppFlowProvisioningProjection(
      target.config.managedProvisioning
    );

  let requestDigest: string;
  let persistedDigest: string;
  try {
    requestDigest = createWhatsAppFlowEditableContentDigest(
      params.editableConfig
    );
    persistedDigest = createWhatsAppFlowEditableContentDigest(target.config);
  } catch {
    throw storeError("INVALID_INPUT", "Flow config is not canonical JSON");
  }
  if (requestDigest !== persistedDigest) {
    throw storeError(
      "CONTENT_DIGEST_MISMATCH",
      "Persisted Flow content differs from this editor revision"
    );
  }
  if (requestReleaseMode !== releaseMode) {
    throw storeError(
      "CONTENT_DIGEST_MISMATCH",
      "Persisted Flow release mode differs from this editor revision"
    );
  }

  if (target.owner === "template") {
    const componentFlowId = getSingleFlowIdFromWhatsAppTemplateComponents(
      node?.data.actionWhatsAppTemplateComponents
    );
    const projectedFlowId = resolveWhatsAppFlowProviderId({
      flowConfig: target.config,
      legacyFlowId: node?.data.actionReplyCtaFlowId,
    });
    if (
      !componentFlowId ||
      (projectedFlowId !== null && projectedFlowId !== componentFlowId)
    ) {
      throw storeError(
        "TEMPLATE_REBIND_REQUIRED",
        "Approved template Flow button binding is missing or does not match this Flow"
      );
    }
    const flowId = projectedFlowId ?? componentFlowId;
    const managedProjection = currentManagedProjection;
    const managedBinding =
      managedProjection?.flowId === flowId ? managedProjection : null;
    if (!managedBinding || managedBinding.contentDigest !== persistedDigest) {
      throw storeError(
        "TEMPLATE_REBIND_REQUIRED",
        "Template Flow binding has no authoritative digest for this content; bind a new Flow revision"
      );
    }
  }

  if (scenario.status === "active") {
    const activeProjection = normalizeManagedWhatsAppFlowProvisioningProjection(
      target.config.managedProvisioning
    );
    const completedOperation = activeProjection?.flowId
      ? await WhatsAppFlowProvisioningOperation.findOne({
          operationId: activeProjection.operationId,
          workspaceId,
          scenarioId,
          nodeId,
          sourceId: activeProjection.sourceId,
          wabaId: activeProjection.wabaId,
          contentDigest: persistedDigest,
          providerFlowId: activeProjection.flowId,
          status: "COMPLETED",
          stage: "COMPLETED",
        }).lean<WhatsAppFlowProvisioningOperationRecord | null>()
      : null;
    if (
      !completedOperation ||
      !hasExactManagedBinding(target.config, completedOperation)
    ) {
      throw storeError(
        "ACTIVE_SCENARIO_MIGRATION_REQUIRED",
        "Deactivate this scenario before replacing its WhatsApp Flow binding"
      );
    }
  }

  return {
    config: toEditableWhatsAppFlowConfig(target.config),
    contentDigest: persistedDigest,
    owner: target.owner,
    releaseMode,
    ...(currentManagedProjection
      ? { managedProjection: currentManagedProjection }
      : {}),
  };
}

export async function isWhatsAppFlowProviderManaged(params: {
  wabaId: string;
  providerFlowId: string;
}): Promise<boolean> {
  await connectDB();
  const operation = await WhatsAppFlowProvisioningOperation.findOne({
    wabaId: requiredString(params.wabaId, "WABA id"),
    providerFlowId: requiredString(params.providerFlowId, "Provider Flow id"),
    status: { $in: ["RUNNING", "FAILED", "COMPLETED", "SUPERSEDED"] },
  })
    .select("operationId")
    .lean<Pick<
      WhatsAppFlowProvisioningOperationRecord,
      "operationId"
    > | null>();
  return Boolean(operation?.operationId);
}

export async function hasWhatsAppFlowProvisioningSourceRebindBlocker(params: {
  workspaceId: string;
  sourceId: string;
  wabaId: string;
}): Promise<boolean> {
  const workspaceId = requiredString(params.workspaceId, "Workspace id");
  const sourceId = requiredString(params.sourceId, "Source id");
  const wabaId = params.wabaId.trim();
  await connectDB();

  const unresolvedArtifact = await WhatsAppFlowProvisioningOperation.exists({
    workspaceId,
    sourceId,
    ...(wabaId ? { wabaId } : {}),
    $or: [
      { status: "RUNNING" },
      {
        status: { $in: ["FAILED", "COMPLETED", "SUPERSEDED"] },
        providerFlowId: { $type: "string" },
      },
    ],
  });

  return Boolean(unresolvedArtifact);
}

async function findLatestOperation(
  params: ProvisioningOperationBinding & {
    replacesOperationId?: string;
    contentDigest?: string;
  }
): Promise<WhatsAppFlowProvisioningOperationRecord | null> {
  return WhatsAppFlowProvisioningOperation.findOne(params)
    .sort({ contentRevision: -1, createdAt: -1, operationId: -1 })
    .lean<WhatsAppFlowProvisioningOperationRecord | null>();
}

type AuthoritativePublishedPredecessor = {
  operationId: string;
  providerFlowId: string;
  contentRevision: number;
};

const CLONE_SOURCE_UNAVAILABLE_CODE =
  "WHATSAPP_FLOW_PROVISIONING_CLONE_SOURCE_UNAVAILABLE";

function authoritativePublishedPredecessor(
  operation: WhatsAppFlowProvisioningOperationRecord | null | undefined
): AuthoritativePublishedPredecessor | null {
  if (
    operation?.providerFlowId?.trim() &&
    operation.providerStatus === "PUBLISHED" &&
    operation.stage === "COMPLETED" &&
    (operation.status === "COMPLETED" || operation.status === "SUPERSEDED")
  ) {
    return {
      operationId: operation.operationId,
      providerFlowId: operation.providerFlowId,
      contentRevision: operation.contentRevision,
    };
  }
  return null;
}

async function findLatestAuthoritativePublishedPredecessor(
  params: Pick<
    ProvisioningOperationBinding,
    | "workspaceId"
    | "scenarioId"
    | "nodeId"
    | "targetOwner"
    | "sourceId"
    | "wabaId"
  > & {
    excludedProviderFlowIds?: readonly string[];
  }
): Promise<AuthoritativePublishedPredecessor | null> {
  const operation = await WhatsAppFlowProvisioningOperation.findOne({
    workspaceId: params.workspaceId,
    scenarioId: params.scenarioId,
    nodeId: params.nodeId,
    targetOwner: params.targetOwner,
    sourceId: params.sourceId,
    wabaId: params.wabaId,
    providerFlowId: {
      $type: "string",
      ...(params.excludedProviderFlowIds?.length
        ? { $nin: params.excludedProviderFlowIds }
        : {}),
    },
    providerStatus: "PUBLISHED",
    stage: "COMPLETED",
    status: { $in: ["COMPLETED", "SUPERSEDED"] },
  })
    .sort({ contentRevision: -1, createdAt: -1, operationId: -1 })
    .lean<WhatsAppFlowProvisioningOperationRecord | null>();
  return authoritativePublishedPredecessor(operation);
}

async function resolvePublishedPredecessor(params: {
  binding: ProvisioningOperationBinding;
  candidates: Array<WhatsAppFlowProvisioningOperationRecord | null>;
  excludedProviderFlowIds?: readonly string[];
}): Promise<AuthoritativePublishedPredecessor | null> {
  const excludedProviderFlowIds = new Set(params.excludedProviderFlowIds);
  for (const candidate of params.candidates) {
    const predecessor = authoritativePublishedPredecessor(candidate);
    if (
      predecessor &&
      !excludedProviderFlowIds.has(predecessor.providerFlowId)
    ) {
      return predecessor;
    }
  }
  const inherited = params.candidates.find(
    candidate =>
      candidate?.replacesOperationId &&
      candidate.cloneFlowId &&
      !excludedProviderFlowIds.has(candidate.cloneFlowId)
  );
  if (inherited?.replacesOperationId && inherited.cloneFlowId) {
    return {
      operationId: inherited.replacesOperationId,
      providerFlowId: inherited.cloneFlowId,
      contentRevision: Math.max(0, inherited.contentRevision - 1),
    };
  }
  return findLatestAuthoritativePublishedPredecessor({
    workspaceId: params.binding.workspaceId,
    scenarioId: params.binding.scenarioId,
    nodeId: params.binding.nodeId,
    targetOwner: params.binding.targetOwner,
    sourceId: params.binding.sourceId,
    wabaId: params.binding.wabaId,
    excludedProviderFlowIds: [...excludedProviderFlowIds],
  });
}

function hasLiveLease(
  operation: WhatsAppFlowProvisioningOperationRecord,
  now: Date
): boolean {
  return Boolean(
    operation.lease?.ownerToken &&
      operation.lease.expiresAt instanceof Date &&
      operation.lease.expiresAt.getTime() > now.getTime()
  );
}

function requestedProviderResolution(
  operation: WhatsAppFlowProvisioningOperationRecord
): WhatsAppFlowProvisioningProviderResolution | null {
  const evidence = operation.providerResolution;
  if (
    !evidence ||
    (evidence.kind !== "published_deprecated" &&
      evidence.kind !== "draft_deleted") ||
    !(evidence.requestedAt instanceof Date) ||
    !Number.isFinite(evidence.requestedAt.getTime()) ||
    !evidence.requestedBy?.trim() ||
    evidence.outcome !== undefined ||
    evidence.confirmedAt !== undefined ||
    evidence.confirmedBy !== undefined
  ) {
    return null;
  }
  return evidence;
}

function confirmedProviderResolution(
  operation: WhatsAppFlowProvisioningOperationRecord
): WhatsAppFlowProvisioningProviderResolution | null {
  const evidence = operation.providerResolution;
  if (
    !evidence ||
    (evidence.kind !== "published_deprecated" &&
      evidence.kind !== "draft_deleted") ||
    (evidence.outcome !== "deprecated" && evidence.outcome !== "missing") ||
    !(evidence.requestedAt instanceof Date) ||
    !(evidence.confirmedAt instanceof Date) ||
    !evidence.requestedBy?.trim() ||
    !evidence.confirmedBy?.trim()
  ) {
    return null;
  }
  return evidence;
}

async function isWhatsAppFlowOperationCurrentlyProjected(
  operation: WhatsAppFlowProvisioningOperationRecord
): Promise<boolean> {
  const scenario = await loadScenarioSnapshot({
    workspaceId: operation.workspaceId,
    scenarioId: operation.scenarioId,
  });
  const node = scenario
    ? scenarioNodeById(
        Array.isArray(scenario.nodes) ? scenario.nodes : [],
        operation.nodeId
      )
    : null;
  const target = node
    ? resolveScenarioWhatsAppInteractiveFlowTarget(node.data)
    : null;
  if (!target || target.owner !== operation.targetOwner) return false;
  return (
    normalizeManagedWhatsAppFlowProvisioningProjection(
      target.config.managedProvisioning
    )?.operationId === operation.operationId
  );
}

async function hasResumableWhatsAppFlowReplacement(
  operation: WhatsAppFlowProvisioningOperationRecord
): Promise<boolean> {
  const dependent = await WhatsAppFlowProvisioningOperation.findOne({
    workspaceId: operation.workspaceId,
    scenarioId: operation.scenarioId,
    nodeId: operation.nodeId,
    targetOwner: operation.targetOwner,
    sourceId: operation.sourceId,
    wabaId: operation.wabaId,
    replacesOperationId: operation.operationId,
    $or: [
      { status: { $in: ["RUNNING", "FAILED"] } },
      {
        status: "MANUALLY_RESOLVED",
        stage: "CREATING_FLOW",
        providerResolution: { $exists: false },
      },
    ],
  })
    .select("operationId")
    .lean<Pick<
      WhatsAppFlowProvisioningOperationRecord,
      "operationId"
    > | null>();
  return Boolean(dependent?.operationId);
}

function providerResolutionLeaseFilter(
  lease: WhatsAppFlowProvisioningLease,
  now: Date
): Record<string, unknown> {
  return {
    operationId: lease.operationId,
    status: "SUPERSEDED",
    "lease.ownerToken": lease.ownerToken,
    "lease.fence": lease.fence,
    "lease.expiresAt": { $gt: now },
  };
}

export async function claimWhatsAppFlowProviderResolution(params: {
  workspaceId: string;
  sourceId: string;
  wabaId: string;
  providerFlowId: string;
  kind: ProviderResolutionKind;
  requestedBy: string;
  ownerToken?: string;
  now?: Date;
}): Promise<WhatsAppFlowProviderResolutionClaim> {
  const workspaceId = requiredString(params.workspaceId, "Workspace id");
  const sourceId = requiredString(params.sourceId, "Source id");
  const wabaId = requiredString(params.wabaId, "WABA id");
  const providerFlowId = requiredString(
    params.providerFlowId,
    "Provider Flow id"
  );
  const requestedBy = requiredString(params.requestedBy, "Requester id");
  if (
    params.kind !== "published_deprecated" &&
    params.kind !== "draft_deleted"
  ) {
    throw storeError("INVALID_INPUT", "Provider resolution kind is invalid");
  }
  const now = params.now ?? new Date();
  await connectDB();
  const current = await WhatsAppFlowProvisioningOperation.findOne({
    workspaceId,
    sourceId,
    wabaId,
    providerFlowId,
  }).lean<WhatsAppFlowProvisioningOperationRecord | null>();
  if (!current) {
    throw storeError(
      "PROJECTED_OPERATION_MISSING",
      "Managed provider Flow artifact was not found"
    );
  }
  const confirmed = confirmedProviderResolution(current);
  if (
    current.status === "MANUALLY_RESOLVED" &&
    confirmed?.kind === params.kind
  ) {
    return { kind: "already_resolved", operation: current };
  }
  if (
    current.status !== "RUNNING" &&
    current.status !== "FAILED" &&
    current.status !== "COMPLETED" &&
    current.status !== "SUPERSEDED"
  ) {
    throw storeError(
      "OPERATION_CONFLICT",
      "Managed provider Flow artifact is not resolvable"
    );
  }
  if (hasLiveLease(current, now)) {
    throw storeError("OPERATION_BUSY", "Managed provider Flow is busy");
  }
  const existingRequest = requestedProviderResolution(current);
  if (current.providerResolution && !existingRequest) {
    throw storeError(
      "OPERATION_CONFLICT",
      "Managed provider Flow resolution evidence is inconsistent"
    );
  }
  if (existingRequest && existingRequest.kind !== params.kind) {
    throw storeError(
      "OPERATION_CONFLICT",
      "A different provider Flow resolution was already requested"
    );
  }
  if (await isWhatsAppFlowOperationCurrentlyProjected(current)) {
    throw storeError(
      "OPERATION_CONFLICT",
      "The current scenario Flow revision cannot be retired"
    );
  }
  if (await hasResumableWhatsAppFlowReplacement(current)) {
    throw storeError(
      "OPERATION_BUSY",
      "A replacement still depends on this published Flow"
    );
  }

  const ownerToken = requiredString(
    params.ownerToken ?? randomUUID(),
    "Resolution owner token"
  );
  const expiresAt = new Date(now.getTime() + OPERATION_LEASE_MS);
  const evidence =
    existingRequest ??
    ({
      kind: params.kind,
      requestedAt: now,
      requestedBy,
    } satisfies WhatsAppFlowProvisioningProviderResolution);
  const ownerFilter = current.lease.ownerToken
    ? {
        "lease.ownerToken": current.lease.ownerToken,
        "lease.expiresAt": { $lte: now },
      }
    : { "lease.ownerToken": { $exists: false } };
  const resolutionFilter = existingRequest
    ? {
        "providerResolution.kind": existingRequest.kind,
        "providerResolution.requestedAt": existingRequest.requestedAt,
        "providerResolution.requestedBy": existingRequest.requestedBy,
        "providerResolution.outcome": { $exists: false },
        "providerResolution.confirmedAt": { $exists: false },
        "providerResolution.confirmedBy": { $exists: false },
      }
    : { providerResolution: { $exists: false } };
  const claimed = await WhatsAppFlowProvisioningOperation.findOneAndUpdate(
    {
      operationId: current.operationId,
      workspaceId,
      sourceId,
      wabaId,
      providerFlowId,
      status: current.status,
      stage: current.stage,
      "lease.fence": current.lease.fence,
      ...ownerFilter,
      ...resolutionFilter,
    },
    {
      $set: {
        status: "SUPERSEDED" satisfies ProvisioningStatus,
        stage: current.stage,
        providerResolution: evidence,
        "lease.ownerToken": ownerToken,
        "lease.expiresAt": expiresAt,
      },
      $unset: { cleanupAt: 1 },
      $inc: { "lease.fence": 1 },
    },
    { new: true, runValidators: true }
  ).lean<WhatsAppFlowProvisioningOperationRecord | null>();
  if (
    !claimed ||
    claimed.lease.ownerToken !== ownerToken ||
    !claimed.lease.expiresAt ||
    claimed.lease.fence <= current.lease.fence
  ) {
    throw storeError("OPERATION_BUSY", "Managed provider Flow is busy");
  }
  return {
    kind: "claimed",
    operation: claimed,
    lease: {
      operationId: claimed.operationId,
      ownerToken,
      fence: claimed.lease.fence,
      expiresAt: claimed.lease.expiresAt,
    },
  };
}

export async function assertWhatsAppFlowProviderResolutionCurrent(params: {
  lease: WhatsAppFlowProvisioningLease;
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  const operation = await WhatsAppFlowProvisioningOperation.findOne(
    providerResolutionLeaseFilter(params.lease, now)
  ).lean<WhatsAppFlowProvisioningOperationRecord | null>();
  if (!operation || !requestedProviderResolution(operation)) {
    throw storeError(
      "OPERATION_CONFLICT",
      "Provider resolution lease was lost"
    );
  }
  if (await isWhatsAppFlowOperationCurrentlyProjected(operation)) {
    throw storeError(
      "OPERATION_CONFLICT",
      "The current scenario Flow revision cannot be retired"
    );
  }
  if (await hasResumableWhatsAppFlowReplacement(operation)) {
    throw storeError(
      "OPERATION_BUSY",
      "A replacement still depends on this published Flow"
    );
  }
}

export async function confirmWhatsAppFlowProviderResolution(params: {
  lease: WhatsAppFlowProvisioningLease;
  kind: ProviderResolutionKind;
  outcome: ProviderResolutionOutcome;
  confirmedBy: string;
  now?: Date;
}): Promise<WhatsAppFlowProvisioningOperationRecord> {
  const confirmedBy = requiredString(params.confirmedBy, "Confirmer id");
  const now = params.now ?? new Date();
  const current = await WhatsAppFlowProvisioningOperation.findOne(
    providerResolutionLeaseFilter(params.lease, now)
  ).lean<WhatsAppFlowProvisioningOperationRecord | null>();
  const requested = current ? requestedProviderResolution(current) : null;
  if (!current || !requested || requested.kind !== params.kind) {
    throw storeError(
      "OPERATION_CONFLICT",
      "Provider resolution lease was lost"
    );
  }
  if (
    (params.kind === "draft_deleted" && params.outcome !== "missing") ||
    (params.outcome !== "missing" && params.outcome !== "deprecated")
  ) {
    throw storeError("INVALID_INPUT", "Provider resolution outcome is invalid");
  }
  const cleanupAt = new Date(now.getTime() + SUPERSEDED_OPERATION_RETENTION_MS);
  const evidence: WhatsAppFlowProvisioningProviderResolution = {
    ...requested,
    outcome: params.outcome,
    confirmedAt: now,
    confirmedBy,
  };
  const resolved = await WhatsAppFlowProvisioningOperation.findOneAndUpdate(
    {
      ...providerResolutionLeaseFilter(params.lease, now),
      "providerResolution.kind": requested.kind,
      "providerResolution.requestedAt": requested.requestedAt,
      "providerResolution.requestedBy": requested.requestedBy,
      "providerResolution.outcome": { $exists: false },
    },
    {
      $set: {
        status: "MANUALLY_RESOLVED" satisfies ProvisioningStatus,
        stage: current.stage,
        cleanupAt,
        providerResolution: evidence,
        ...(params.outcome === "deprecated"
          ? { providerStatus: "DEPRECATED" }
          : {}),
      },
      $unset: {
        ...(params.outcome === "missing" ? { providerStatus: 1 } : {}),
        lastError: 1,
        "lease.ownerToken": 1,
        "lease.expiresAt": 1,
      },
    },
    { new: true, runValidators: true }
  ).lean<WhatsAppFlowProvisioningOperationRecord | null>();
  if (!resolved) {
    throw storeError(
      "OPERATION_CONFLICT",
      "Provider resolution lease was lost"
    );
  }
  return resolved;
}

export async function releaseWhatsAppFlowProviderResolutionClaim(params: {
  lease: WhatsAppFlowProvisioningLease;
  clearRequest: boolean;
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  const current = await WhatsAppFlowProvisioningOperation.findOne(
    providerResolutionLeaseFilter(params.lease, now)
  ).lean<WhatsAppFlowProvisioningOperationRecord | null>();
  if (!current) return;
  const update = params.clearRequest
    ? {
        $set: {
          status: "SUPERSEDED" satisfies ProvisioningStatus,
          stage: current.stage,
        },
        $unset: {
          cleanupAt: 1,
          providerResolution: 1,
          "lease.ownerToken": 1,
          "lease.expiresAt": 1,
        },
      }
    : {
        $unset: {
          "lease.ownerToken": 1,
          "lease.expiresAt": 1,
        },
      };
  await WhatsAppFlowProvisioningOperation.findOneAndUpdate(
    providerResolutionLeaseFilter(params.lease, now),
    update,
    { new: true, runValidators: true }
  ).lean<WhatsAppFlowProvisioningOperationRecord | null>();
}

export async function listWhatsAppFlowProviderArtifacts(params: {
  workspaceId: string;
  sourceId: string;
  wabaId: string;
  limit?: number;
}): Promise<WhatsAppFlowProviderArtifact[]> {
  const workspaceId = requiredString(params.workspaceId, "Workspace id");
  const sourceId = requiredString(params.sourceId, "Source id");
  const wabaId = requiredString(params.wabaId, "WABA id");
  const limit = Math.min(Math.max(params.limit ?? 200, 1), 200);
  await connectDB();
  const operations = await WhatsAppFlowProvisioningOperation.find({
    workspaceId,
    sourceId,
    wabaId,
    providerFlowId: { $type: "string" },
    status: {
      $in: [
        "RUNNING",
        "FAILED",
        "COMPLETED",
        "SUPERSEDED",
        "MANUALLY_RESOLVED",
      ],
    },
  })
    .sort({ createdAt: -1, operationId: -1 })
    .limit(limit)
    .select(
      "operationId scenarioId providerFlowId providerFlowName providerStatus stage status providerResolution lease"
    )
    .lean<WhatsAppFlowProvisioningOperationRecord[]>();
  const dependentOperations = operations.length
    ? await WhatsAppFlowProvisioningOperation.find({
        workspaceId,
        sourceId,
        wabaId,
        replacesOperationId: {
          $in: operations.map(operation => operation.operationId),
        },
        $or: [
          { status: { $in: ["RUNNING", "FAILED"] } },
          {
            status: "MANUALLY_RESOLVED",
            stage: "CREATING_FLOW",
            providerResolution: { $exists: false },
          },
        ],
      })
        .select("replacesOperationId")
        .lean<
          Array<
            Pick<WhatsAppFlowProvisioningOperationRecord, "replacesOperationId">
          >
        >()
    : [];
  const replacementPending = new Set(
    dependentOperations.flatMap(operation =>
      operation.replacesOperationId ? [operation.replacesOperationId] : []
    )
  );
  const now = new Date();
  return operations.map(operation => ({
    operationId: operation.operationId,
    scenarioId: operation.scenarioId,
    providerFlowId: operation.providerFlowId!,
    ...(operation.providerFlowName
      ? { providerFlowName: operation.providerFlowName }
      : {}),
    ...(operation.providerStatus
      ? { lastKnownProviderStatus: operation.providerStatus }
      : {}),
    stage: operation.stage,
    status: operation.status,
    ...(requestedProviderResolution(operation)
      ? { resolutionKind: operation.providerResolution!.kind }
      : {}),
    ...(confirmedProviderResolution(operation)
      ? {
          resolutionKind: operation.providerResolution!.kind,
          resolutionOutcome: operation.providerResolution!.outcome!,
        }
      : {}),
    cleanupEligibility:
      operation.status === "MANUALLY_RESOLVED"
        ? "RESOLVED"
        : operation.status === "RUNNING" || operation.status === "COMPLETED"
          ? "NOT_TERMINAL"
          : hasLiveLease(operation, now)
            ? "BUSY"
            : replacementPending.has(operation.operationId)
              ? "REPLACEMENT_PENDING"
              : "ELIGIBLE",
  }));
}

function assertOperationBinding(
  operation: WhatsAppFlowProvisioningOperationRecord,
  params: ProvisioningOperationBinding
): void {
  for (const key of [
    "workspaceId",
    "scenarioId",
    "nodeId",
    "targetOwner",
    "sourceId",
    "wabaId",
    "releaseMode",
    "endpointId",
    "applicationId",
  ] as const) {
    if (operation[key] !== params[key]) {
      throw storeError(
        "OPERATION_CONFLICT",
        "Provisioning operation binding changed"
      );
    }
  }
}

function hasExactOperationBinding(
  operation: WhatsAppFlowProvisioningOperationRecord,
  binding: ProvisioningOperationBinding
): boolean {
  try {
    assertOperationBinding(operation, binding);
    return true;
  } catch {
    return false;
  }
}

async function createOperation(params: {
  workspaceId: string;
  scenarioId: string;
  nodeId: string;
  targetOwner: "template" | "service_message";
  sourceId: string;
  wabaId: string;
  releaseMode: ProvisioningReleaseMode;
  endpointId?: string;
  applicationId?: string;
  replacesOperationId?: string;
  cloneFlowId?: string;
  contentRevision: number;
  contentDigest: string;
}): Promise<WhatsAppFlowProvisioningOperationRecord> {
  const operationKeyHash = operationIdentityHash(params);
  const operationId = randomUUID();
  const record: Omit<
    WhatsAppFlowProvisioningOperationRecord,
    "createdAt" | "updatedAt"
  > = {
    operationId,
    operationKeyHash,
    workspaceId: params.workspaceId,
    scenarioId: params.scenarioId,
    nodeId: params.nodeId,
    targetOwner: params.targetOwner,
    sourceId: params.sourceId,
    wabaId: params.wabaId,
    releaseMode: params.releaseMode,
    ...(params.releaseMode === "data_endpoint"
      ? {
          endpointId: params.endpointId,
          applicationId: params.applicationId,
        }
      : {}),
    ...(params.replacesOperationId
      ? { replacesOperationId: params.replacesOperationId }
      : {}),
    ...(params.cloneFlowId ? { cloneFlowId: params.cloneFlowId } : {}),
    contentRevision: params.contentRevision,
    contentDigest: params.contentDigest,
    providerMarker: providerMarker(operationId),
    stage: "CREATING_FLOW",
    status: "RUNNING",
    lease: { fence: 0 },
  };
  const created = await WhatsAppFlowProvisioningOperation.findOneAndUpdate(
    { operationKeyHash },
    { $setOnInsert: record },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: false,
      runValidators: true,
    }
  ).lean<WhatsAppFlowProvisioningOperationRecord | null>();
  if (!created) {
    throw storeError(
      "STORAGE_FAILED",
      "Provisioning operation could not be created"
    );
  }
  assertOperationBinding(created, params);
  if (
    created.contentRevision !== params.contentRevision ||
    created.contentDigest !== params.contentDigest ||
    created.replacesOperationId !== params.replacesOperationId ||
    created.cloneFlowId !== params.cloneFlowId
  ) {
    throw storeError(
      "OPERATION_CONFLICT",
      "Provisioning operation identity conflicts with stored content"
    );
  }
  return created;
}

async function resumeOperation(params: {
  operation: WhatsAppFlowProvisioningOperationRecord;
  now: Date;
}): Promise<WhatsAppFlowProvisioningOperationRecord> {
  if (hasLiveLease(params.operation, params.now)) {
    throw storeError("OPERATION_BUSY", "Provisioning operation is busy");
  }
  const resumed = await WhatsAppFlowProvisioningOperation.findOneAndUpdate(
    {
      operationId: params.operation.operationId,
      status: params.operation.status,
      stage: params.operation.stage,
      contentRevision: params.operation.contentRevision,
      contentDigest: params.operation.contentDigest,
      "lease.fence": params.operation.lease.fence,
    },
    {
      $set: {
        status: "RUNNING",
        stage: params.operation.stage,
      },
      $unset: {
        cleanupAt: 1,
        lastError: 1,
        "lease.ownerToken": 1,
        "lease.expiresAt": 1,
      },
    },
    { new: true, runValidators: true }
  ).lean<WhatsAppFlowProvisioningOperationRecord | null>();
  if (!resumed) {
    throw storeError(
      "OPERATION_CONFLICT",
      "Provisioning operation changed concurrently"
    );
  }
  return resumed;
}

async function supersedeInactiveOperation(params: {
  operation: WhatsAppFlowProvisioningOperationRecord;
  now: Date;
}): Promise<void> {
  if (
    params.operation.status !== "RUNNING" &&
    params.operation.status !== "FAILED"
  ) {
    throw storeError(
      "OPERATION_CONFLICT",
      "Only an inactive provisioning operation can be superseded"
    );
  }
  if (hasLiveLease(params.operation, params.now)) {
    throw storeError("OPERATION_BUSY", "Provisioning operation is busy");
  }

  const cleanupAt = new Date(
    params.now.getTime() + SUPERSEDED_OPERATION_RETENTION_MS
  );
  const retainProviderEvidence = Boolean(params.operation.providerFlowId);
  const leaseOwnerFilter = params.operation.lease.ownerToken
    ? { "lease.ownerToken": params.operation.lease.ownerToken }
    : { "lease.ownerToken": { $exists: false } };
  const leaseExpiryFilter = params.operation.lease.expiresAt
    ? { "lease.expiresAt": params.operation.lease.expiresAt }
    : { "lease.expiresAt": { $exists: false } };
  const superseded = await WhatsAppFlowProvisioningOperation.findOneAndUpdate(
    {
      operationId: params.operation.operationId,
      status: params.operation.status,
      stage: params.operation.stage,
      releaseMode: params.operation.releaseMode,
      contentRevision: params.operation.contentRevision,
      contentDigest: params.operation.contentDigest,
      "lease.fence": params.operation.lease.fence,
      ...leaseOwnerFilter,
      ...leaseExpiryFilter,
    },
    {
      $set: {
        status: "SUPERSEDED" satisfies ProvisioningStatus,
        stage: params.operation.stage,
        ...(!retainProviderEvidence ? { cleanupAt } : {}),
      },
      $unset: {
        ...(retainProviderEvidence ? { cleanupAt: 1 } : {}),
        lastError: 1,
        "lease.ownerToken": 1,
        "lease.expiresAt": 1,
      },
    },
    { new: true, runValidators: true }
  ).lean<WhatsAppFlowProvisioningOperationRecord | null>();
  if (!superseded) {
    throw storeError(
      "OPERATION_CONFLICT",
      "Provisioning operation changed concurrently"
    );
  }
}

async function supersedeObsoleteBindingOperations(params: {
  binding: ProvisioningOperationBinding;
  now: Date;
}): Promise<void> {
  const candidates = await WhatsAppFlowProvisioningOperation.find({
    workspaceId: params.binding.workspaceId,
    scenarioId: params.binding.scenarioId,
    nodeId: params.binding.nodeId,
    status: { $in: ["RUNNING", "FAILED"] },
  })
    .sort({ createdAt: -1 })
    .lean<WhatsAppFlowProvisioningOperationRecord[]>();
  const obsoleteCandidates: WhatsAppFlowProvisioningOperationRecord[] = [];
  for (const candidate of candidates) {
    if (hasExactOperationBinding(candidate, params.binding)) continue;
    if (hasLiveLease(candidate, params.now)) {
      throw storeError(
        "OPERATION_BUSY",
        "A previous provisioning binding is still active"
      );
    }
    obsoleteCandidates.push(candidate);
  }
  await Promise.all(
    obsoleteCandidates.map(operation =>
      supersedeInactiveOperation({ operation, now: params.now })
    )
  );
}

async function projectOperation(params: {
  operation: WhatsAppFlowProvisioningOperationRecord;
  providerStatus?: ManagedWhatsAppFlowProvisioningProjection["providerStatus"];
  updatedBy?: string | null;
}): Promise<{
  projection: ManagedWhatsAppFlowProvisioningProjection;
  scenarioUpdatedAt: string;
}> {
  const projection = operationProjection(
    params.operation,
    params.providerStatus
  );
  const result = await mutateScenarioGraphWithCas<{
    applied: boolean;
    reason?: "target_changed";
  }>({
    workspaceId: params.operation.workspaceId,
    scenarioId: params.operation.scenarioId,
    ...(params.updatedBy !== undefined ? { updatedBy: params.updatedBy } : {}),
    project: snapshot => {
      const node = scenarioNodeById(snapshot.nodes, params.operation.nodeId);
      const target = node
        ? resolveScenarioWhatsAppInteractiveFlowTarget(node.data)
        : null;
      if (!node || !target) {
        return {
          changed: false,
          value: { applied: false, reason: "target_changed" },
        };
      }
      const currentProjection =
        normalizeManagedWhatsAppFlowProvisioningProjection(
          target.config.managedProvisioning
        );
      if (
        target.owner !== params.operation.targetOwner ||
        (currentProjection &&
          currentProjection.operationId !== params.operation.operationId &&
          currentProjection.operationId !==
            params.operation.replacesOperationId)
      ) {
        return {
          changed: false,
          value: { applied: false, reason: "target_changed" },
        };
      }
      let digest: string;
      try {
        digest = createWhatsAppFlowEditableContentDigest(target.config);
      } catch {
        return {
          changed: false,
          value: { applied: false, reason: "target_changed" },
        };
      }
      if (digest !== params.operation.contentDigest) {
        return {
          changed: false,
          value: { applied: false, reason: "target_changed" },
        };
      }
      if (hasExactManagedProjection(target.config, projection)) {
        return { changed: false, value: { applied: true } };
      }
      const projected = applyManagedWhatsAppFlowProvisioningProjectionToNode(
        node,
        projection
      );
      if (!projected) {
        return {
          changed: false,
          value: { applied: false, reason: "target_changed" },
        };
      }
      return {
        changed: true,
        nodes: snapshot.nodes.map(candidate =>
          candidate === node ? projected : candidate
        ),
        edges: snapshot.edges,
        value: { applied: true },
      };
    },
  });
  if (result.status === "not_found") {
    throw storeError("SCENARIO_NOT_FOUND", "Scenario was not found");
  }
  if (result.status === "conflict") {
    throw storeError(
      "PROJECTION_CONFLICT",
      "Scenario changed while projecting provider state"
    );
  }
  if (!result.value.applied) {
    throw storeError(
      "TARGET_CHANGED",
      "Flow content changed while provisioning; refresh and retry"
    );
  }
  return { projection, scenarioUpdatedAt: result.scenarioUpdatedAt };
}

export async function prepareWhatsAppFlowProvisioningOperation(params: {
  workspaceId: string;
  scenarioId: string;
  nodeId: string;
  sourceId: string;
  wabaId: string;
  releaseMode: ProvisioningReleaseMode;
  endpointId?: string;
  applicationId?: string;
  target: ValidatedWhatsAppFlowProvisioningTarget;
  now?: Date;
}): Promise<WhatsAppFlowProvisioningOperationRecord> {
  const workspaceId = requiredString(params.workspaceId, "Workspace id");
  const scenarioId = requiredString(params.scenarioId, "Scenario id");
  const nodeId = requiredString(params.nodeId, "Node id");
  const sourceId = requiredString(params.sourceId, "Source id");
  const wabaId = requiredString(params.wabaId, "WABA id");
  if (
    params.releaseMode !== "linear" &&
    params.releaseMode !== "data_endpoint"
  ) {
    throw storeError("INVALID_INPUT", "Flow release mode is invalid");
  }
  const target = params.target;
  if (params.releaseMode !== target.releaseMode) {
    throw storeError(
      "INVALID_INPUT",
      "Flow release mode does not match the persisted target"
    );
  }
  let endpointBinding:
    | { endpointId: string; applicationId: string }
    | undefined;
  if (target.releaseMode === "data_endpoint") {
    endpointBinding = {
      endpointId: requiredString(params.endpointId, "Endpoint id"),
      applicationId: requiredString(params.applicationId, "Application id"),
    };
  } else if (
    params.endpointId !== undefined ||
    params.applicationId !== undefined
  ) {
    throw storeError(
      "INVALID_INPUT",
      "Linear Flow releases cannot carry endpoint bindings"
    );
  }
  const binding: ProvisioningOperationBinding = {
    workspaceId,
    scenarioId,
    nodeId,
    targetOwner: target.owner,
    sourceId,
    wabaId,
    releaseMode: target.releaseMode,
    ...(endpointBinding ?? {}),
  };
  const now = params.now ?? new Date();
  if (
    target.managedProjection &&
    target.managedProjection.sourceId !== sourceId
  ) {
    throw storeError(
      "SOURCE_REBIND_REQUIRED",
      "Managed Flow binding belongs to a different WhatsApp source"
    );
  }
  if (target.managedProjection && target.managedProjection.wabaId !== wabaId) {
    throw storeError(
      "SOURCE_REBIND_REQUIRED",
      "Managed Flow binding belongs to a different WhatsApp Business Account"
    );
  }
  await supersedeObsoleteBindingOperations({ binding, now });
  const exactManagedBinding =
    target.managedProjection?.contentDigest === target.contentDigest
      ? target.managedProjection
      : undefined;
  if (target.owner === "template" && !exactManagedBinding) {
    throw storeError(
      "TEMPLATE_REBIND_REQUIRED",
      "Template Flow binding does not match its current content"
    );
  }
  let latest: WhatsAppFlowProvisioningOperationRecord | null;
  let revisionBase: WhatsAppFlowProvisioningOperationRecord | null;
  let replayingProjectedBinding = false;
  if (exactManagedBinding) {
    const projectedOperation = await WhatsAppFlowProvisioningOperation.findOne({
      workspaceId,
      scenarioId,
      nodeId,
      targetOwner: target.owner,
      sourceId,
      wabaId,
      operationId: exactManagedBinding.operationId,
      providerFlowId: exactManagedBinding.flowId,
      contentDigest: target.contentDigest,
      status: { $in: ["RUNNING", "FAILED", "COMPLETED"] },
    }).lean<WhatsAppFlowProvisioningOperationRecord | null>();
    if (!projectedOperation) {
      throw storeError(
        target.owner === "template"
          ? "TEMPLATE_REBIND_REQUIRED"
          : "PROJECTED_OPERATION_MISSING",
        "Projected Flow binding has no matching managed provisioning operation"
      );
    }
    if (hasExactOperationBinding(projectedOperation, binding)) {
      latest = projectedOperation;
      revisionBase = projectedOperation;
      replayingProjectedBinding = true;
    } else {
      if (target.owner === "template") {
        throw storeError(
          "TEMPLATE_REBIND_REQUIRED",
          "Template Flow provider binding changed; bind a new Flow revision"
        );
      }
      latest = await findLatestOperation({
        ...binding,
        replacesOperationId: projectedOperation.operationId,
        contentDigest: target.contentDigest,
      });
      revisionBase = latest ?? projectedOperation;
    }
  } else {
    latest = await findLatestOperation(binding);
    revisionBase = latest;
  }
  const unavailableCloneFlowIds = [latest, revisionBase].flatMap(candidate =>
    candidate?.status === "FAILED" &&
    candidate.lastError?.code === CLONE_SOURCE_UNAVAILABLE_CODE &&
    candidate.cloneFlowId
      ? [candidate.cloneFlowId]
      : []
  );
  const createNextOperation = async () => {
    const predecessor =
      target.owner === "service_message"
        ? await resolvePublishedPredecessor({
            binding,
            candidates: [latest, revisionBase],
            excludedProviderFlowIds: unavailableCloneFlowIds,
          })
        : null;
    const contentRevision =
      Math.max(
        latest?.contentRevision ?? 0,
        revisionBase?.contentRevision ?? 0,
        predecessor?.contentRevision ?? 0
      ) + 1;
    return createOperation({
      ...binding,
      ...(predecessor
        ? {
            replacesOperationId: predecessor.operationId,
            cloneFlowId: predecessor.providerFlowId,
          }
        : {}),
      contentRevision,
      contentDigest: target.contentDigest,
    });
  };
  let operation: WhatsAppFlowProvisioningOperationRecord;

  if (latest) {
    assertOperationBinding(latest, binding);
    if (
      replayingProjectedBinding &&
      exactManagedBinding &&
      (exactManagedBinding.flowId !== latest.providerFlowId ||
        exactManagedBinding.operationId !== latest.operationId ||
        latest.contentDigest !== target.contentDigest)
    ) {
      throw storeError(
        target.owner === "template"
          ? "TEMPLATE_REBIND_REQUIRED"
          : "PROJECTED_OPERATION_MISSING",
        "Projected Flow binding does not match its managed provisioning operation"
      );
    }
    if (
      latest.status === "COMPLETED" &&
      latest.contentDigest === target.contentDigest
    ) {
      operation = latest;
    } else if (
      latest.status === "FAILED" &&
      latest.contentDigest === target.contentDigest &&
      latest.lastError?.code === CLONE_SOURCE_UNAVAILABLE_CODE &&
      Boolean(latest.cloneFlowId)
    ) {
      await supersedeInactiveOperation({ operation: latest, now });
      operation = await createNextOperation();
    } else if (
      (latest.status === "RUNNING" || latest.status === "FAILED") &&
      latest.contentDigest === target.contentDigest
    ) {
      operation = await resumeOperation({
        operation: latest,
        now,
      });
    } else {
      if (target.owner === "template") {
        throw storeError(
          "TEMPLATE_REBIND_REQUIRED",
          "Template Flow content changed; bind a new provider Flow revision"
        );
      }
      if (latest.status === "RUNNING" || latest.status === "FAILED") {
        await supersedeInactiveOperation({ operation: latest, now });
      }
      operation = await createNextOperation();
    }
  } else {
    operation = await createNextOperation();
  }

  return operation;
}

function liveLeaseFilter(
  lease: WhatsAppFlowProvisioningLease,
  now: Date
): Record<string, unknown> {
  return {
    operationId: lease.operationId,
    status: "RUNNING",
    "lease.ownerToken": lease.ownerToken,
    "lease.fence": lease.fence,
    "lease.expiresAt": { $gt: now },
  };
}

export async function acquireWhatsAppFlowProvisioningLease(params: {
  operationId: string;
  ownerToken?: string;
  now?: Date;
}): Promise<WhatsAppFlowProvisioningLease> {
  await connectDB();
  const operationId = requiredString(params.operationId, "Operation id");
  const ownerToken = requiredString(
    params.ownerToken ?? randomUUID(),
    "Lease owner token"
  );
  const now = params.now ?? new Date();
  const current = await WhatsAppFlowProvisioningOperation.findOne({
    operationId,
  }).lean<WhatsAppFlowProvisioningOperationRecord | null>();
  if (
    !current ||
    (current.status !== "RUNNING" && current.status !== "FAILED")
  ) {
    throw storeError(
      "OPERATION_CONFLICT",
      "Provisioning operation is not resumable"
    );
  }
  if (hasLiveLease(current, now) && current.lease.ownerToken !== ownerToken) {
    throw storeError("OPERATION_BUSY", "Provisioning operation is busy");
  }
  const expiresAt = new Date(now.getTime() + OPERATION_LEASE_MS);
  const ownerFilter = current.lease.ownerToken
    ? current.lease.ownerToken === ownerToken
      ? { "lease.ownerToken": ownerToken }
      : {
          "lease.ownerToken": current.lease.ownerToken,
          "lease.expiresAt": { $lte: now },
        }
    : { "lease.ownerToken": { $exists: false } };
  const acquired = await WhatsAppFlowProvisioningOperation.findOneAndUpdate(
    {
      operationId,
      status: current.status,
      stage: current.stage,
      "lease.fence": current.lease.fence,
      ...ownerFilter,
    },
    {
      $set: {
        status: "RUNNING",
        stage: current.stage,
        "lease.ownerToken": ownerToken,
        "lease.expiresAt": expiresAt,
      },
      $unset: { cleanupAt: 1 },
      $inc: { "lease.fence": 1 },
    },
    { new: true, runValidators: true }
  ).lean<WhatsAppFlowProvisioningOperationRecord | null>();
  if (
    !acquired ||
    acquired.lease.ownerToken !== ownerToken ||
    !acquired.lease.expiresAt ||
    acquired.lease.fence <= current.lease.fence
  ) {
    throw storeError("OPERATION_BUSY", "Provisioning operation is busy");
  }
  return {
    operationId,
    ownerToken,
    fence: acquired.lease.fence,
    expiresAt: acquired.lease.expiresAt,
  };
}

export async function renewWhatsAppFlowProvisioningLease(params: {
  lease: WhatsAppFlowProvisioningLease;
  now?: Date;
}): Promise<WhatsAppFlowProvisioningLease> {
  const now = params.now ?? new Date();
  const expiresAt = new Date(now.getTime() + OPERATION_LEASE_MS);
  const renewed = await WhatsAppFlowProvisioningOperation.findOneAndUpdate(
    liveLeaseFilter(params.lease, now),
    {
      $set: { "lease.expiresAt": expiresAt },
    },
    { new: true, runValidators: true }
  ).lean<WhatsAppFlowProvisioningOperationRecord | null>();
  if (
    !renewed ||
    renewed.lease.ownerToken !== params.lease.ownerToken ||
    renewed.lease.fence !== params.lease.fence ||
    !renewed.lease.expiresAt
  ) {
    throw storeError("OPERATION_CONFLICT", "Provisioning lease was lost");
  }
  return {
    operationId: params.lease.operationId,
    ownerToken: params.lease.ownerToken,
    fence: params.lease.fence,
    expiresAt: renewed.lease.expiresAt,
  };
}

export async function assertWhatsAppFlowProvisioningTargetCurrent(params: {
  operation: WhatsAppFlowProvisioningOperationRecord;
  lease: WhatsAppFlowProvisioningLease;
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  await connectDB();
  const live = await WhatsAppFlowProvisioningOperation.findOne(
    liveLeaseFilter(params.lease, now)
  ).lean<WhatsAppFlowProvisioningOperationRecord | null>();
  if (
    !live ||
    live.releaseMode !== params.operation.releaseMode ||
    live.contentDigest !== params.operation.contentDigest
  ) {
    throw storeError("OPERATION_CONFLICT", "Provisioning lease was lost");
  }
  const scenario = await loadScenarioSnapshot({
    workspaceId: live.workspaceId,
    scenarioId: live.scenarioId,
  });
  const revision = scenarioRevision(scenario?.updatedAt);
  const node = scenario
    ? scenarioNodeById(
        Array.isArray(scenario.nodes) ? scenario.nodes : [],
        live.nodeId
      )
    : null;
  const target = node
    ? resolveScenarioWhatsAppInteractiveFlowTarget(node.data)
    : null;
  let digest: string | null = null;
  try {
    digest = target
      ? createWhatsAppFlowEditableContentDigest(target.config)
      : null;
  } catch {
    digest = null;
  }
  let releaseMode: ProvisioningReleaseMode | null = null;
  try {
    releaseMode = target ? provisioningReleaseMode(target.config) : null;
  } catch {
    releaseMode = null;
  }
  if (
    !revision ||
    !target ||
    target.owner !== live.targetOwner ||
    releaseMode !== live.releaseMode ||
    digest !== live.contentDigest
  ) {
    throw storeError(
      "TARGET_CHANGED",
      "Flow content changed while provisioning; refresh and retry"
    );
  }
}

export async function transitionWhatsAppFlowProvisioningStage(params: {
  lease: WhatsAppFlowProvisioningLease;
  stage: ProvisioningStage;
  now?: Date;
}): Promise<WhatsAppFlowProvisioningOperationRecord> {
  const now = params.now ?? new Date();
  const updated = await WhatsAppFlowProvisioningOperation.findOneAndUpdate(
    liveLeaseFilter(params.lease, now),
    {
      $set: { status: "RUNNING", stage: params.stage },
      $unset: { cleanupAt: 1, lastError: 1 },
    },
    { new: true, runValidators: true }
  ).lean<WhatsAppFlowProvisioningOperationRecord | null>();
  if (!updated) {
    throw storeError("OPERATION_CONFLICT", "Provisioning lease was lost");
  }
  return updated;
}

export async function recordWhatsAppFlowProviderDraft(params: {
  lease: WhatsAppFlowProvisioningLease;
  providerFlowId: string;
  providerFlowName: string;
  providerStatus?: ManagedWhatsAppFlowProvisioningProjection["providerStatus"];
  now?: Date;
}): Promise<WhatsAppFlowProvisioningOperationRecord> {
  if (
    params.providerStatus !== undefined &&
    !PROVIDER_STATUSES.has(params.providerStatus)
  ) {
    throw storeError("INVALID_INPUT", "Provider status is invalid");
  }
  const now = params.now ?? new Date();
  const providerFlowId = requiredString(
    params.providerFlowId,
    "Provider Flow id"
  );
  const providerFlowName = requiredString(
    params.providerFlowName,
    "Provider Flow name"
  );
  const providerMetadata = {
    providerFlowName,
    ...(params.providerStatus ? { providerStatus: params.providerStatus } : {}),
  };
  const firstAcknowledgement =
    await WhatsAppFlowProvisioningOperation.findOneAndUpdate(
      {
        ...liveLeaseFilter(params.lease, now),
        providerFlowId: { $exists: false },
        providerAcknowledgedAt: { $exists: false },
      },
      {
        $set: {
          providerFlowId,
          providerAcknowledgedAt: now,
          ...providerMetadata,
        },
      },
      { new: true, runValidators: true }
    ).lean<WhatsAppFlowProvisioningOperationRecord | null>();
  if (firstAcknowledgement) return firstAcknowledgement;

  const enriched = await WhatsAppFlowProvisioningOperation.findOneAndUpdate(
    {
      ...liveLeaseFilter(params.lease, now),
      providerFlowId,
      providerAcknowledgedAt: { $type: "date" },
    },
    {
      $set: providerMetadata,
    },
    { new: true, runValidators: true }
  ).lean<WhatsAppFlowProvisioningOperationRecord | null>();
  if (!enriched) {
    throw storeError("OPERATION_CONFLICT", "Provisioning lease was lost");
  }
  return enriched;
}

export async function recordWhatsAppFlowProviderStatus(params: {
  lease: WhatsAppFlowProvisioningLease;
  providerStatus: ManagedWhatsAppFlowProvisioningProjection["providerStatus"];
  now?: Date;
}): Promise<WhatsAppFlowProvisioningOperationRecord> {
  if (!PROVIDER_STATUSES.has(params.providerStatus)) {
    throw storeError("INVALID_INPUT", "Provider status is invalid");
  }
  const now = params.now ?? new Date();
  const operation = await WhatsAppFlowProvisioningOperation.findOneAndUpdate(
    liveLeaseFilter(params.lease, now),
    { $set: { providerStatus: params.providerStatus } },
    { new: true, runValidators: true }
  ).lean<WhatsAppFlowProvisioningOperationRecord | null>();
  if (!operation) {
    throw storeError("OPERATION_CONFLICT", "Provisioning lease was lost");
  }
  return operation;
}

export async function resolveMissingWhatsAppFlowProviderDraft(params: {
  lease: WhatsAppFlowProvisioningLease;
  providerFlowId: string;
  error: WhatsAppFlowProvisioningError;
  now?: Date;
}): Promise<WhatsAppFlowProvisioningOperationRecord> {
  if (params.error.stage !== "CREATING_FLOW") {
    throw storeError(
      "INVALID_INPUT",
      "Missing provider draft resolution requires the create stage"
    );
  }
  const now = params.now ?? new Date();
  const cleanupAt = new Date(now.getTime() + SUPERSEDED_OPERATION_RETENTION_MS);
  const resolved = await WhatsAppFlowProvisioningOperation.findOneAndUpdate(
    {
      ...liveLeaseFilter(params.lease, now),
      stage: "CREATING_FLOW",
      providerFlowId: requiredString(params.providerFlowId, "Provider Flow id"),
    },
    {
      $set: {
        status: "MANUALLY_RESOLVED" satisfies ProvisioningStatus,
        stage: "CREATING_FLOW" satisfies ProvisioningStage,
        cleanupAt,
        lastError: params.error,
      },
      $unset: {
        providerStatus: 1,
        "lease.ownerToken": 1,
        "lease.expiresAt": 1,
      },
    },
    { new: true, runValidators: true }
  ).lean<WhatsAppFlowProvisioningOperationRecord | null>();
  if (!resolved) {
    throw storeError("OPERATION_CONFLICT", "Provisioning lease was lost");
  }
  return resolved;
}

export async function reconcileCompletedWhatsAppFlowProviderStatus(params: {
  operation: WhatsAppFlowProvisioningOperationRecord;
  providerStatus: ManagedWhatsAppFlowProvisioningProjection["providerStatus"];
  updatedBy?: string | null;
  now?: Date;
}): Promise<ProjectedWhatsAppFlowProvisioningOperation> {
  if (!PROVIDER_STATUSES.has(params.providerStatus)) {
    throw storeError("INVALID_INPUT", "Provider status is invalid");
  }
  const operation = await WhatsAppFlowProvisioningOperation.findOneAndUpdate(
    {
      operationId: params.operation.operationId,
      operationKeyHash: params.operation.operationKeyHash,
      workspaceId: params.operation.workspaceId,
      scenarioId: params.operation.scenarioId,
      nodeId: params.operation.nodeId,
      sourceId: params.operation.sourceId,
      contentRevision: params.operation.contentRevision,
      contentDigest: params.operation.contentDigest,
      providerFlowId: params.operation.providerFlowId,
      status: "COMPLETED",
      stage: "COMPLETED",
    },
    { $set: { providerStatus: params.providerStatus } },
    { new: true, runValidators: true }
  ).lean<WhatsAppFlowProvisioningOperationRecord | null>();
  if (!operation) {
    throw storeError(
      "OPERATION_CONFLICT",
      "Completed provisioning evidence changed concurrently"
    );
  }
  const projected = await projectOperation({
    operation,
    updatedBy: params.updatedBy,
  });
  try {
    await supersedeOlderCompletedOperations({
      current: operation,
      now: params.now ?? new Date(),
    });
  } catch {
    // The current completed row and scenario projection are authoritative.
    // Retention cleanup is best-effort and can be retried on the next replay.
  }
  return { operation, ...projected };
}

export function normalizeWhatsAppFlowProvisioningError(params: {
  code: unknown;
  message: unknown;
  stage: ProvisioningStage;
  providerCode?: unknown;
  providerSubcode?: unknown;
  retryable: boolean;
  at?: Date;
}): WhatsAppFlowProvisioningError {
  const code =
    typeof params.code === "string" && params.code.trim()
      ? params.code.trim().slice(0, MAX_ERROR_CODE_LENGTH)
      : "WHATSAPP_FLOW_PROVISIONING_FAILED";
  const message =
    typeof params.message === "string" && params.message.trim()
      ? params.message.trim().slice(0, MAX_ERROR_MESSAGE_LENGTH)
      : "WhatsApp Flow provisioning failed";
  return {
    code,
    message,
    stage: params.stage,
    ...(Number.isSafeInteger(params.providerCode)
      ? { providerCode: Number(params.providerCode) }
      : {}),
    ...(Number.isSafeInteger(params.providerSubcode)
      ? { providerSubcode: Number(params.providerSubcode) }
      : {}),
    retryable: params.retryable,
    at: params.at ?? new Date(),
  };
}

export async function failWhatsAppFlowProvisioningOperation(params: {
  lease: WhatsAppFlowProvisioningLease;
  error: WhatsAppFlowProvisioningError;
  now?: Date;
}): Promise<WhatsAppFlowProvisioningOperationRecord> {
  const now = params.now ?? new Date();
  const failed = await WhatsAppFlowProvisioningOperation.findOneAndUpdate(
    liveLeaseFilter(params.lease, now),
    {
      $set: {
        status: "FAILED" satisfies ProvisioningStatus,
        stage: params.error.stage,
        lastError: params.error,
      },
      $unset: {
        cleanupAt: 1,
        "lease.ownerToken": 1,
        "lease.expiresAt": 1,
      },
    },
    { new: true, runValidators: true }
  ).lean<WhatsAppFlowProvisioningOperationRecord | null>();
  if (!failed) {
    throw storeError("OPERATION_CONFLICT", "Provisioning lease was lost");
  }
  return failed;
}

async function supersedeOlderCompletedOperations(params: {
  current: WhatsAppFlowProvisioningOperationRecord;
  now: Date;
}): Promise<void> {
  const cleanupAt = new Date(
    params.now.getTime() + SUPERSEDED_OPERATION_RETENTION_MS
  );
  const olderOperations = await WhatsAppFlowProvisioningOperation.find({
    workspaceId: params.current.workspaceId,
    scenarioId: params.current.scenarioId,
    nodeId: params.current.nodeId,
    operationId: { $ne: params.current.operationId },
    status: "COMPLETED",
    stage: "COMPLETED",
    createdAt: { $lt: params.current.createdAt },
  })
    .sort({ createdAt: -1 })
    .lean<WhatsAppFlowProvisioningOperationRecord[]>();
  await Promise.all(
    olderOperations.map(operation =>
      WhatsAppFlowProvisioningOperation.findOneAndUpdate(
        {
          operationId: operation.operationId,
          status: "COMPLETED",
          stage: "COMPLETED",
          contentRevision: operation.contentRevision,
          contentDigest: operation.contentDigest,
          createdAt: { $lt: params.current.createdAt },
        },
        {
          $set: {
            status: "SUPERSEDED" satisfies ProvisioningStatus,
            stage: "COMPLETED" satisfies ProvisioningStage,
            ...(!operation.providerFlowId ? { cleanupAt } : {}),
          },
          $unset: {
            ...(operation.providerFlowId ? { cleanupAt: 1 } : {}),
            lastError: 1,
            "lease.ownerToken": 1,
            "lease.expiresAt": 1,
          },
        },
        { new: true, runValidators: true }
      ).lean<WhatsAppFlowProvisioningOperationRecord | null>()
    )
  );
}

export async function completeWhatsAppFlowProvisioningOperation(params: {
  lease: WhatsAppFlowProvisioningLease;
  updatedBy?: string | null;
  now?: Date;
}): Promise<ProjectedWhatsAppFlowProvisioningOperation> {
  const now = params.now ?? new Date();
  const current = await WhatsAppFlowProvisioningOperation.findOne(
    liveLeaseFilter(params.lease, now)
  ).lean<WhatsAppFlowProvisioningOperationRecord | null>();
  if (!current?.providerFlowId) {
    throw storeError(
      "OPERATION_CONFLICT",
      "Provisioning operation has no provider Flow"
    );
  }
  const completed = await WhatsAppFlowProvisioningOperation.findOneAndUpdate(
    liveLeaseFilter(params.lease, now),
    {
      $set: {
        status: "COMPLETED" satisfies ProvisioningStatus,
        stage: "COMPLETED" satisfies ProvisioningStage,
        providerStatus: "PUBLISHED",
      },
      $unset: {
        cleanupAt: 1,
        lastError: 1,
        "lease.ownerToken": 1,
        "lease.expiresAt": 1,
      },
    },
    { new: true, runValidators: true }
  ).lean<WhatsAppFlowProvisioningOperationRecord | null>();
  if (!completed) {
    throw storeError("OPERATION_CONFLICT", "Provisioning lease was lost");
  }
  const projected = await projectOperation({
    operation: completed,
    providerStatus: "PUBLISHED",
    updatedBy: params.updatedBy,
  });
  try {
    await supersedeOlderCompletedOperations({ current: completed, now });
  } catch {
    // The current completed row is authoritative. Retention cleanup can be
    // reconciled independently without turning a successful publish into a
    // retry that could mutate the provider twice.
  }
  return { operation: completed, ...projected };
}

export async function releaseWhatsAppFlowProvisioningLease(
  lease: WhatsAppFlowProvisioningLease
): Promise<void> {
  await WhatsAppFlowProvisioningOperation.findOneAndUpdate(
    {
      operationId: lease.operationId,
      "lease.ownerToken": lease.ownerToken,
      "lease.fence": lease.fence,
    },
    {
      $unset: {
        "lease.ownerToken": 1,
        "lease.expiresAt": 1,
      },
    },
    { new: false }
  );
}
