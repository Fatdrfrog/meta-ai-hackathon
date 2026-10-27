import "server-only";

import { randomUUID } from "node:crypto";

import {
  allocateWhatsAppQrReferenceCode,
  extractWhatsAppQrReference,
  formatWhatsAppQrReferenceMessage,
  WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH,
} from "@icecore/scenario-contracts";
import type { WhatsAppGraphClient } from "@icecore/shared/lib/meta/api";
import type { ClientSession } from "mongoose";

import connectDB from "@/lib/mongoose";
import { Scenario } from "@/models/scenario";
import {
  WhatsAppQrCode,
  WHATSAPP_QR_MANAGEABLE_HISTORY_LIMIT,
  type WhatsAppQrCodeRecord,
} from "@/models/whatsapp-qr-code";
import {
  WhatsAppQrEntryPoint,
  type WhatsAppQrEntryPointRecord,
} from "@/models/whatsapp-qr-entry-point";
import type { WhatsAppQrOperationRecord } from "@/models/whatsapp-qr-operation";
import { requireNonEmptyString } from "@icecore/shared/lib/value-utils";

import {
  WhatsAppQrStoreError,
  type WhatsAppQrOperationLease,
  type WhatsAppQrTerminalResult,
} from "./contract";
import {
  acquireWhatsAppQrReconciliationOperation,
  completeWhatsAppQrOperation,
  failWhatsAppQrOperation,
  hashWhatsAppQrRequestDigest,
  lookupWhatsAppQrOperation,
  markWhatsAppQrProviderRequestSent,
  markWhatsAppQrReconcileRequired,
  recoverWhatsAppQrDeleteOperation,
  releaseWhatsAppQrOperationLease,
  reserveWhatsAppQrOperation,
} from "./operation-store";
import {
  createWhatsAppChatQr,
  deleteWhatsAppChatQr,
  getWhatsAppChatQr,
  listWhatsAppChatQrs,
  updateWhatsAppChatQrMessage,
  WhatsAppChatQrProviderError,
  type WhatsAppChatQr,
  type WhatsAppChatQrProviderErrorEvidence,
} from "./provider";
import {
  getWhatsAppQrEntryPointDetail,
  listWhatsAppQrScenarioSummaries,
} from "./queries";

export { getWhatsAppQrEntryPointDetail, listWhatsAppQrScenarioSummaries };

export type WhatsAppQrServiceErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "ACTIVE_SCENARIO_ASSIGNMENT"
  | "OPERATION_BUSY"
  | "OPERATION_CONFLICT"
  | "PROVIDER_FAILED"
  | "RECONCILE_REQUIRED"
  | "STORAGE_FAILED";

export class WhatsAppQrServiceError extends Error {
  constructor(
    readonly code: WhatsAppQrServiceErrorCode,
    message = "WhatsApp QR command failed",
    readonly providerEvidence?: WhatsAppChatQrProviderErrorEvidence
  ) {
    super(message);
    this.name = "WhatsAppQrServiceError";
  }
}

export type WhatsAppQrCommandResult =
  | {
      status: "applied";
      entryPointId: string;
      codeId: string;
      entryPointVersion: number;
      codeVersion: number;
    }
  | {
      status: "replay";
      entryPointId: string;
      result: WhatsAppQrTerminalResult;
    }
  | {
      status: "reconcile_required";
      entryPointId: string;
      operationId: string;
    }
  | {
      status: "busy";
      entryPointId: string;
      operationId: string;
    };

type ProviderDeps = {
  createWhatsAppChatQr: typeof createWhatsAppChatQr;
  getWhatsAppChatQr: typeof getWhatsAppChatQr;
  listWhatsAppChatQrs: typeof listWhatsAppChatQrs;
  updateWhatsAppChatQrMessage: typeof updateWhatsAppChatQrMessage;
  deleteWhatsAppChatQr: typeof deleteWhatsAppChatQr;
};

type StoreDeps = {
  lookupWhatsAppQrOperation: typeof lookupWhatsAppQrOperation;
  reserveWhatsAppQrOperation: typeof reserveWhatsAppQrOperation;
  acquireWhatsAppQrReconciliationOperation: typeof acquireWhatsAppQrReconciliationOperation;
  markWhatsAppQrProviderRequestSent: typeof markWhatsAppQrProviderRequestSent;
  markWhatsAppQrReconcileRequired: typeof markWhatsAppQrReconcileRequired;
  recoverWhatsAppQrDeleteOperation: typeof recoverWhatsAppQrDeleteOperation;
  completeWhatsAppQrOperation: typeof completeWhatsAppQrOperation;
  failWhatsAppQrOperation: typeof failWhatsAppQrOperation;
  releaseWhatsAppQrOperationLease: typeof releaseWhatsAppQrOperationLease;
};

const defaultProvider: ProviderDeps = {
  createWhatsAppChatQr,
  getWhatsAppChatQr,
  listWhatsAppChatQrs,
  updateWhatsAppChatQrMessage,
  deleteWhatsAppChatQr,
};

const defaultStore: StoreDeps = {
  lookupWhatsAppQrOperation,
  reserveWhatsAppQrOperation,
  acquireWhatsAppQrReconciliationOperation,
  markWhatsAppQrProviderRequestSent,
  markWhatsAppQrReconcileRequired,
  recoverWhatsAppQrDeleteOperation,
  completeWhatsAppQrOperation,
  failWhatsAppQrOperation,
  releaseWhatsAppQrOperationLease,
};

function serviceError(
  code: WhatsAppQrServiceErrorCode,
  message?: string,
  providerEvidence?: WhatsAppChatQrProviderErrorEvidence
): WhatsAppQrServiceError {
  return new WhatsAppQrServiceError(code, message, providerEvidence);
}

const requiredString = (value: unknown, label: string) =>
  requireNonEmptyString(value, label, message =>
    serviceError("INVALID_INPUT", message)
  );

function isCanonicalNonemptyString(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.trim() === value
  );
}

function requiredVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw serviceError("INVALID_INPUT", `${label} is invalid`);
  }
  return value as number;
}

function requiredDesiredMessage(value: unknown): string {
  const message = typeof value === "string" ? value : "";
  if (
    message.length === 0 ||
    message.trim() !== message ||
    message.length > WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH
  ) {
    throw serviceError("INVALID_INPUT", "Desired message is invalid");
  }
  return message;
}

/** Every QR command validates its scope first, in this order. */
function readQrCommandScope(params: {
  workspaceId: unknown;
  entryPointId: unknown;
  sourceId: unknown;
}) {
  return {
    workspaceId: requiredString(params.workspaceId, "Workspace id"),
    entryPointId: requiredString(params.entryPointId, "Entry point id"),
    sourceId: requiredString(params.sourceId, "Source id"),
  };
}

type QrCommandGuardParams = {
  expectedEntryPointVersion: unknown;
  expectedCodeVersion?: unknown;
  idempotencyKey: unknown;
};
type QrCommandGuards = {
  expectedEntryPointVersion: number;
  idempotencyKey: string;
};

/** The version and idempotency guards that close each command's validation. */
function readQrCommandGuards(params: QrCommandGuardParams): QrCommandGuards;
function readQrCommandGuards(
  params: QrCommandGuardParams,
  withCodeVersion: true
): QrCommandGuards & { expectedCodeVersion: number };
function readQrCommandGuards(
  params: QrCommandGuardParams,
  withCodeVersion = false
) {
  const expectedEntryPointVersion = requiredVersion(
    params.expectedEntryPointVersion,
    "Expected entry-point version"
  );
  const expectedCodeVersion = withCodeVersion
    ? requiredVersion(params.expectedCodeVersion, "Expected code version")
    : undefined;
  const idempotencyKey = requiredString(
    params.idempotencyKey,
    "Idempotency key"
  );
  return { expectedEntryPointVersion, expectedCodeVersion, idempotencyKey };
}

function mapStoreError(error: unknown): never {
  if (error instanceof WhatsAppQrServiceError) throw error;
  if (error instanceof WhatsAppQrStoreError) {
    switch (error.code) {
      case "OPERATION_BUSY":
        throw serviceError("OPERATION_BUSY");
      case "OPERATION_CONFLICT":
        throw serviceError("OPERATION_CONFLICT");
      case "ENTRY_POINT_VERSION_CONFLICT":
      case "CODE_VERSION_CONFLICT":
        throw serviceError("VERSION_CONFLICT");
      case "NOT_FOUND":
        throw serviceError("NOT_FOUND");
      case "INVALID_INPUT":
        throw serviceError("INVALID_INPUT", error.message);
      default:
        throw serviceError("STORAGE_FAILED");
    }
  }
  throw error;
}

function sanitizedProviderError(error: WhatsAppChatQrProviderError): {
  code: string;
  retryable: boolean;
} {
  return {
    code: `PROVIDER_${error.evidence.category}`.slice(0, 128),
    retryable: error.outcome === "ambiguous",
  };
}

async function loadEntryPoint(params: {
  workspaceId: string;
  entryPointId: string;
}): Promise<WhatsAppQrEntryPointRecord> {
  const entryPoint = await WhatsAppQrEntryPoint.findOne({
    workspaceId: params.workspaceId,
    entryPointId: params.entryPointId,
  }).lean<WhatsAppQrEntryPointRecord | null>();
  if (!entryPoint) throw serviceError("NOT_FOUND", "Entry point not found");
  return entryPoint;
}

async function assertDeleteScenarioAssignmentInactive(params: {
  entryPoint: WhatsAppQrEntryPointRecord;
  session?: ClientSession;
}): Promise<void> {
  const { entryPoint } = params;
  const hasScenario = isCanonicalNonemptyString(entryPoint.scenarioId);
  const hasNode = isCanonicalNonemptyString(entryPoint.nodeId);
  if (!hasScenario && !hasNode) {
    if (
      entryPoint.assignmentState !== undefined &&
      entryPoint.assignmentState !== "unassigned"
    ) {
      throw serviceError(
        "STORAGE_FAILED",
        "WhatsApp QR assignment projection is contradictory"
      );
    }
    return;
  }
  if (!hasScenario || !hasNode) {
    throw serviceError(
      "STORAGE_FAILED",
      "WhatsApp QR assignment projection is contradictory"
    );
  }
  if (
    entryPoint.assignmentState !== undefined &&
    entryPoint.assignmentState !== "assigned"
  ) {
    throw serviceError(
      "STORAGE_FAILED",
      "WhatsApp QR assignment projection is contradictory"
    );
  }
  const query = Scenario.findOne({
    _id: entryPoint.scenarioId,
    workspaceId: entryPoint.workspaceId,
    deletedAt: null,
  });
  if (params.session) query.session(params.session);
  const scenario = await query.lean<{ status?: "draft" | "active" } | null>({
    defaults: false,
  });
  if (!scenario) {
    throw serviceError(
      "OPERATION_CONFLICT",
      "WhatsApp QR assigned Scenario could not be verified"
    );
  }
  if (scenario.status === "active") {
    throw serviceError(
      "ACTIVE_SCENARIO_ASSIGNMENT",
      "Deactivate the assigned Scenario before deleting this QR from Meta"
    );
  }
  if (scenario.status !== "draft") {
    throw serviceError(
      "STORAGE_FAILED",
      "WhatsApp QR assigned Scenario state could not be verified"
    );
  }
}

export async function loadCurrentActiveCode(params: {
  workspaceId: string;
  entryPointId: string;
}): Promise<WhatsAppQrCodeRecord> {
  const code = await WhatsAppQrCode.findOne({
    workspaceId: params.workspaceId,
    entryPointId: params.entryPointId,
    placementBindingState: "CURRENT",
    providerState: "ACTIVE",
    providerCode: { $type: "string" },
    deepLink: { $type: "string" },
  }).lean<WhatsAppQrCodeRecord | null>();
  if (!code?.providerCode?.trim() || !code.deepLink?.trim()) {
    throw serviceError("NOT_FOUND", "Current active code not found");
  }
  return code;
}

async function allocateReference(workspaceId: string): Promise<string> {
  return allocateWhatsAppQrReferenceCode({
    isAvailable: async referenceCode => {
      const existing = await WhatsAppQrCode.exists({
        workspaceId,
        referenceCode,
      });
      return !existing;
    },
  });
}

async function createPendingCode(params: {
  workspaceId: string;
  entryPointId: string;
  sourceId: string;
  wabaId: string;
  phoneNumberId: string;
  referenceCode: string;
  prefilledMessage: string;
  placementBindingState?: WhatsAppQrCodeRecord["placementBindingState"];
}): Promise<WhatsAppQrCodeRecord> {
  const code = new WhatsAppQrCode({
    codeId: randomUUID(),
    workspaceId: params.workspaceId,
    entryPointId: params.entryPointId,
    sourceId: params.sourceId,
    wabaId: params.wabaId,
    phoneNumberId: params.phoneNumberId,
    referenceCode: params.referenceCode,
    prefilledMessage: params.prefilledMessage,
    placementBindingState: params.placementBindingState ?? "CURRENT",
    routingState: "ENABLED",
    providerState: "PENDING",
    version: 0,
  });
  await code.save();
  return code.toObject();
}

async function detachPendingCode(
  code: WhatsAppQrCodeRecord
): Promise<WhatsAppQrCodeRecord> {
  let current = code;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (
      current.providerState === "PENDING" &&
      current.placementBindingState === "DETACHED" &&
      current.routingState === "DISABLED" &&
      !current.providerCode &&
      !current.deepLink
    ) {
      return current;
    }
    if (
      current.providerState !== "PENDING" ||
      current.providerCode ||
      current.deepLink
    ) {
      throw serviceError("OPERATION_CONFLICT");
    }

    const detached = await WhatsAppQrCode.findOneAndUpdate(
      {
        codeId: current.codeId,
        workspaceId: current.workspaceId,
        version: current.version,
        providerState: "PENDING",
        placementBindingState: current.placementBindingState,
        providerCode: { $exists: false },
        deepLink: { $exists: false },
      },
      {
        $set: {
          placementBindingState: "DETACHED",
          routingState: "DISABLED",
        },
        $inc: { version: 1 },
      },
      { new: true, runValidators: true }
    ).lean<WhatsAppQrCodeRecord | null>();
    if (detached) return detached;

    const reloaded = await WhatsAppQrCode.findOne({
      codeId: current.codeId,
      workspaceId: current.workspaceId,
    }).lean<WhatsAppQrCodeRecord | null>();
    if (!reloaded) throw serviceError("NOT_FOUND", "Pending code not found");
    current = reloaded;
  }
  throw serviceError("VERSION_CONFLICT");
}

async function stageExistingCodeForReconciliation(params: {
  code: WhatsAppQrCodeRecord;
  prefilledMessage?: string;
  session?: ClientSession;
}): Promise<WhatsAppQrCodeRecord> {
  if (params.code.providerState === "RECONCILING") return params.code;
  if (params.code.providerState !== "ACTIVE") {
    throw serviceError("OPERATION_CONFLICT");
  }
  const staged = await WhatsAppQrCode.findOneAndUpdate(
    {
      codeId: params.code.codeId,
      workspaceId: params.code.workspaceId,
      version: params.code.version,
      providerState: "ACTIVE",
      providerCode: params.code.providerCode,
      deepLink: params.code.deepLink,
    },
    {
      $set: {
        providerState: "RECONCILING",
        ...(params.prefilledMessage !== undefined
          ? { prefilledMessage: params.prefilledMessage }
          : {}),
      },
      $inc: { version: 1 },
    },
    {
      new: true,
      runValidators: true,
      ...(params.session ? { session: params.session } : {}),
    }
  ).lean<WhatsAppQrCodeRecord | null>();
  if (!staged) throw serviceError("VERSION_CONFLICT");
  return staged;
}

async function restoreReconciledCode(params: {
  code: WhatsAppQrCodeRecord;
  prefilledMessage?: string;
}): Promise<WhatsAppQrCodeRecord> {
  let current = params.code;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (
      current.providerState === "ACTIVE" &&
      (params.prefilledMessage === undefined ||
        current.prefilledMessage === params.prefilledMessage)
    ) {
      return current;
    }
    if (
      current.providerState !== "RECONCILING" ||
      !current.providerCode ||
      !current.deepLink
    ) {
      throw serviceError("OPERATION_CONFLICT");
    }

    const restored = await WhatsAppQrCode.findOneAndUpdate(
      {
        codeId: current.codeId,
        workspaceId: current.workspaceId,
        version: current.version,
        providerState: "RECONCILING",
        providerCode: current.providerCode,
        deepLink: current.deepLink,
      },
      {
        $set: {
          providerState: "ACTIVE",
          ...(params.prefilledMessage !== undefined
            ? { prefilledMessage: params.prefilledMessage }
            : {}),
        },
        $inc: { version: 1 },
      },
      { new: true, runValidators: true }
    ).lean<WhatsAppQrCodeRecord | null>();
    if (restored) return restored;

    const reloaded = await WhatsAppQrCode.findOne({
      codeId: current.codeId,
      workspaceId: current.workspaceId,
    }).lean<WhatsAppQrCodeRecord | null>();
    if (!reloaded) throw serviceError("NOT_FOUND", "QR code not found");
    current = reloaded;
  }
  throw serviceError("VERSION_CONFLICT");
}

async function observeProviderIdentity(params: {
  code: WhatsAppQrCodeRecord;
  provider: WhatsAppChatQr;
}): Promise<WhatsAppQrCodeRecord> {
  const updated = await WhatsAppQrCode.findOneAndUpdate(
    {
      codeId: params.code.codeId,
      workspaceId: params.code.workspaceId,
      version: params.code.version,
      providerCode: { $exists: false },
      deepLink: { $exists: false },
    },
    {
      $set: {
        providerCode: params.provider.code,
        deepLink: params.provider.deepLink,
        prefilledMessage: params.provider.prefilledMessage,
        providerState: "ACTIVE",
      },
      $inc: { version: 1 },
    },
    { new: true, runValidators: true }
  ).lean<WhatsAppQrCodeRecord | null>();
  if (!updated) throw serviceError("VERSION_CONFLICT");
  return updated;
}

async function ensureObservedProviderIdentity(params: {
  code: WhatsAppQrCodeRecord;
  provider: WhatsAppChatQr;
}): Promise<WhatsAppQrCodeRecord> {
  if (params.code.providerState === "PENDING") {
    return observeProviderIdentity(params);
  }
  if (
    (params.code.providerState === "ACTIVE" ||
      params.code.providerState === "RECONCILING") &&
    params.code.providerCode === params.provider.code &&
    params.code.deepLink === params.provider.deepLink &&
    params.code.prefilledMessage === params.provider.prefilledMessage
  ) {
    return params.code;
  }
  throw serviceError("OPERATION_CONFLICT");
}

async function activateEntryPoint(params: {
  entryPoint: WhatsAppQrEntryPointRecord;
  sourceId: string;
  wabaId: string;
  phoneNumberId: string;
  codeId: string;
  desiredMessage?: string;
}): Promise<WhatsAppQrEntryPointRecord> {
  if (params.entryPoint.status === "ACTIVE") {
    if (
      params.entryPoint.sourceId !== params.sourceId ||
      params.entryPoint.wabaId !== params.wabaId ||
      params.entryPoint.phoneNumberId !== params.phoneNumberId
    ) {
      throw serviceError("OPERATION_CONFLICT");
    }
    const updated = await WhatsAppQrEntryPoint.findOneAndUpdate(
      {
        entryPointId: params.entryPoint.entryPointId,
        workspaceId: params.entryPoint.workspaceId,
        version: params.entryPoint.version,
        status: "ACTIVE",
        sourceId: params.sourceId,
        wabaId: params.wabaId,
        phoneNumberId: params.phoneNumberId,
        currentCodeId: params.entryPoint.currentCodeId,
      },
      {
        $set: {
          currentCodeId: params.codeId,
          ...(params.desiredMessage !== undefined
            ? { desiredMessage: params.desiredMessage }
            : {}),
        },
        $inc: { version: 1 },
      },
      { new: true, runValidators: true }
    ).lean<WhatsAppQrEntryPointRecord | null>();
    if (!updated) throw serviceError("VERSION_CONFLICT");
    return updated;
  }

  if (params.entryPoint.status !== "DRAFT") {
    throw serviceError("OPERATION_CONFLICT");
  }

  const updated = await WhatsAppQrEntryPoint.findOneAndUpdate(
    {
      entryPointId: params.entryPoint.entryPointId,
      workspaceId: params.entryPoint.workspaceId,
      version: params.entryPoint.version,
      sourceId: { $exists: false },
      wabaId: { $exists: false },
      phoneNumberId: { $exists: false },
      currentCodeId: { $exists: false },
    },
    {
      $set: {
        sourceId: params.sourceId,
        wabaId: params.wabaId,
        phoneNumberId: params.phoneNumberId,
        currentCodeId: params.codeId,
        status: "ACTIVE",
        ...(params.desiredMessage !== undefined
          ? { desiredMessage: params.desiredMessage }
          : {}),
      },
      $inc: { version: 1 },
    },
    { new: true, runValidators: true }
  ).lean<WhatsAppQrEntryPointRecord | null>();
  if (!updated) throw serviceError("VERSION_CONFLICT");
  return updated;
}

async function resetEntryPointToDraft(
  entryPoint: WhatsAppQrEntryPointRecord
): Promise<WhatsAppQrEntryPointRecord> {
  if (entryPoint.status === "DRAFT") return entryPoint;
  requireActiveProviderBinding(entryPoint);
  const updated = await WhatsAppQrEntryPoint.findOneAndUpdate(
    {
      entryPointId: entryPoint.entryPointId,
      workspaceId: entryPoint.workspaceId,
      version: entryPoint.version,
      status: "ACTIVE",
      sourceId: entryPoint.sourceId,
      wabaId: entryPoint.wabaId,
      phoneNumberId: entryPoint.phoneNumberId,
      currentCodeId: entryPoint.currentCodeId,
    },
    {
      $set: { status: "DRAFT" },
      $unset: {
        sourceId: 1,
        wabaId: 1,
        phoneNumberId: 1,
        currentCodeId: 1,
      },
      $inc: { version: 1 },
    },
    { new: true, runValidators: true }
  ).lean<WhatsAppQrEntryPointRecord | null>();
  if (!updated) throw serviceError("VERSION_CONFLICT");
  return updated;
}

async function ensureCodePlacement(params: {
  code: WhatsAppQrCodeRecord;
  placementBindingState: WhatsAppQrCodeRecord["placementBindingState"];
}): Promise<WhatsAppQrCodeRecord> {
  if (params.code.placementBindingState === params.placementBindingState) {
    return params.code;
  }
  const updated = await WhatsAppQrCode.findOneAndUpdate(
    {
      codeId: params.code.codeId,
      workspaceId: params.code.workspaceId,
      version: params.code.version,
      placementBindingState: params.code.placementBindingState,
    },
    {
      $set: { placementBindingState: params.placementBindingState },
      $inc: { version: 1 },
    },
    { new: true, runValidators: true }
  ).lean<WhatsAppQrCodeRecord | null>();
  if (!updated) throw serviceError("VERSION_CONFLICT");
  return updated;
}

async function finalizeSuccess(params: {
  store: StoreDeps;
  lease: WhatsAppQrOperationLease;
  entryPoint: WhatsAppQrEntryPointRecord;
  code: WhatsAppQrCodeRecord;
  provider: WhatsAppChatQr;
  sourceId: string;
  wabaId: string;
  phoneNumberId: string;
  desiredMessage?: string;
}): Promise<WhatsAppQrCommandResult> {
  let observed = await ensureObservedProviderIdentity({
    code: params.code,
    provider: params.provider,
  });
  if (observed.providerState === "RECONCILING") {
    observed = await restoreReconciledCode({
      code: observed,
      prefilledMessage: params.provider.prefilledMessage,
    });
  }
  const activated = await activateEntryPoint({
    entryPoint: params.entryPoint,
    sourceId: params.sourceId,
    wabaId: params.wabaId,
    phoneNumberId: params.phoneNumberId,
    codeId: observed.codeId,
    desiredMessage: params.desiredMessage,
  });
  await params.store.completeWhatsAppQrOperation({
    lease: params.lease,
    result: {
      outcome: "applied",
      status: "COMPLETED",
      codeId: observed.codeId,
      entryPointVersion: activated.version,
      codeVersion: observed.version,
    },
  });
  return {
    status: "applied",
    entryPointId: activated.entryPointId,
    codeId: observed.codeId,
    entryPointVersion: activated.version,
    codeVersion: observed.version,
  };
}

async function finalizeMessageUpdate(params: {
  store: StoreDeps;
  lease: WhatsAppQrOperationLease;
  entryPoint: WhatsAppQrEntryPointRecord;
  code: WhatsAppQrCodeRecord;
  provider: WhatsAppChatQr;
  desiredMessage: string;
}): Promise<WhatsAppQrCommandResult> {
  if (
    params.code.providerCode !== params.provider.code ||
    params.code.deepLink !== params.provider.deepLink
  ) {
    throw serviceError("OPERATION_CONFLICT");
  }
  const activeCode = await restoreReconciledCode({
    code: params.code,
    prefilledMessage: params.provider.prefilledMessage,
  });
  const updatedEntryPoint = await WhatsAppQrEntryPoint.findOneAndUpdate(
    {
      entryPointId: params.entryPoint.entryPointId,
      workspaceId: params.entryPoint.workspaceId,
      version: params.entryPoint.version,
      status: "ACTIVE",
      sourceId: params.entryPoint.sourceId,
      wabaId: params.entryPoint.wabaId,
      phoneNumberId: params.entryPoint.phoneNumberId,
      currentCodeId: params.entryPoint.currentCodeId,
    },
    {
      $set: { desiredMessage: params.desiredMessage },
      $inc: { version: 1 },
    },
    { new: true, runValidators: true }
  ).lean<WhatsAppQrEntryPointRecord | null>();
  if (!updatedEntryPoint) throw serviceError("VERSION_CONFLICT");
  await params.store.completeWhatsAppQrOperation({
    lease: params.lease,
    result: {
      outcome: "applied",
      status: "COMPLETED",
      codeId: activeCode.codeId,
      entryPointVersion: updatedEntryPoint.version,
      codeVersion: activeCode.version,
    },
  });
  return {
    status: "applied",
    entryPointId: updatedEntryPoint.entryPointId,
    codeId: activeCode.codeId,
    entryPointVersion: updatedEntryPoint.version,
    codeVersion: activeCode.version,
  };
}

async function finalizeDeletion(params: {
  store: StoreDeps;
  lease: WhatsAppQrOperationLease;
  entryPoint: WhatsAppQrEntryPointRecord;
  code: WhatsAppQrCodeRecord;
}): Promise<WhatsAppQrCommandResult> {
  const deletesCurrentBinding =
    params.entryPoint.currentCodeId === params.code.codeId &&
    (params.code.placementBindingState === "CURRENT" ||
      (params.code.placementBindingState === "DETACHED" &&
        params.code.providerState === "DELETED"));
  let tombstoned = params.code;
  if (tombstoned.providerState !== "DELETED") {
    if (tombstoned.providerState === "ACTIVE") {
      tombstoned = await stageExistingCodeForReconciliation({
        code: tombstoned,
      });
    }
    if (tombstoned.providerState !== "RECONCILING") {
      throw serviceError("OPERATION_CONFLICT");
    }
    const updated = await WhatsAppQrCode.findOneAndUpdate(
      {
        codeId: tombstoned.codeId,
        workspaceId: tombstoned.workspaceId,
        version: tombstoned.version,
        providerState: "RECONCILING",
        providerCode: tombstoned.providerCode,
        deepLink: tombstoned.deepLink,
      },
      {
        $set: {
          providerState: "DELETED",
          placementBindingState: "DETACHED",
          routingState: "DISABLED",
        },
        $inc: { version: 1 },
      },
      { new: true, runValidators: true }
    ).lean<WhatsAppQrCodeRecord | null>();
    if (!updated) throw serviceError("VERSION_CONFLICT");
    tombstoned = updated;
  }
  const resultingEntryPoint = deletesCurrentBinding
    ? await resetEntryPointToDraft(params.entryPoint)
    : params.entryPoint;
  await params.store.completeWhatsAppQrOperation({
    lease: params.lease,
    result: {
      outcome: "applied",
      status: "COMPLETED",
      codeId: tombstoned.codeId,
      entryPointVersion: resultingEntryPoint.version,
      codeVersion: tombstoned.version,
    },
  });
  return {
    status: "applied",
    entryPointId: resultingEntryPoint.entryPointId,
    codeId: tombstoned.codeId,
    entryPointVersion: resultingEntryPoint.version,
    codeVersion: tombstoned.version,
  };
}

async function finalizeReplacement(params: {
  store: StoreDeps;
  lease: WhatsAppQrOperationLease;
  entryPoint: WhatsAppQrEntryPointRecord;
  oldCode: WhatsAppQrCodeRecord;
  pendingCode: WhatsAppQrCodeRecord;
  provider: WhatsAppChatQr;
  desiredMessage: string;
}): Promise<WhatsAppQrCommandResult> {
  let observed = await ensureObservedProviderIdentity({
    code: params.pendingCode,
    provider: params.provider,
  });
  if (observed.providerState === "RECONCILING") {
    observed = await restoreReconciledCode({
      code: observed,
      prefilledMessage: params.provider.prefilledMessage,
    });
  }
  const demoted = await ensureCodePlacement({
    code: params.oldCode,
    placementBindingState: "HISTORICAL",
  });
  void demoted;
  const promoted = await ensureCodePlacement({
    code: observed,
    placementBindingState: "CURRENT",
  });
  const activated = await activateEntryPoint({
    entryPoint: params.entryPoint,
    sourceId: params.entryPoint.sourceId!,
    wabaId: params.entryPoint.wabaId!,
    phoneNumberId: params.entryPoint.phoneNumberId!,
    codeId: promoted.codeId,
    desiredMessage: params.desiredMessage,
  });
  await params.store.completeWhatsAppQrOperation({
    lease: params.lease,
    result: {
      outcome: "applied",
      status: "COMPLETED",
      codeId: promoted.codeId,
      entryPointVersion: activated.version,
      codeVersion: promoted.version,
    },
  });
  return {
    status: "applied",
    entryPointId: activated.entryPointId,
    codeId: promoted.codeId,
    entryPointVersion: activated.version,
    codeVersion: promoted.version,
  };
}

async function markLocalFinalizationReconcileRequired(params: {
  store: StoreDeps;
  lease: WhatsAppQrOperationLease;
  entryPointId: string;
  providerCodeEvidence?: string;
}): Promise<WhatsAppQrCommandResult> {
  const operation = await params.store.markWhatsAppQrReconcileRequired({
    lease: params.lease,
    sanitizedError: {
      code: "LOCAL_FINALIZATION_FAILED",
      retryable: true,
    },
    ...(params.providerCodeEvidence
      ? { providerCodeEvidence: params.providerCodeEvidence }
      : {}),
  });
  return {
    status: "reconcile_required",
    entryPointId: params.entryPointId,
    operationId: operation.operationId,
  };
}

async function handleProviderFailure(params: {
  store: StoreDeps;
  lease: WhatsAppQrOperationLease;
  entryPointId: string;
  error: WhatsAppChatQrProviderError;
  entryPointVersion: number;
  providerCodeEvidence?: string;
  allowReconcile?: boolean;
  onDefiniteFailure?: () => Promise<void>;
}): Promise<WhatsAppQrCommandResult> {
  const sanitizedError = sanitizedProviderError(params.error);
  if (params.error.outcome === "ambiguous" && params.allowReconcile !== false) {
    const operation = await params.store.markWhatsAppQrReconcileRequired({
      lease: params.lease,
      sanitizedError,
      ...(params.providerCodeEvidence
        ? { providerCodeEvidence: params.providerCodeEvidence }
        : {}),
    });
    return {
      status: "reconcile_required",
      entryPointId: params.entryPointId,
      operationId: operation.operationId,
    };
  }

  if (params.onDefiniteFailure) {
    try {
      await params.onDefiniteFailure();
    } catch {
      const operation = await params.store.markWhatsAppQrReconcileRequired({
        lease: params.lease,
        sanitizedError: {
          code: "LOCAL_CLEANUP_FAILED",
          retryable: true,
        },
        ...(params.providerCodeEvidence
          ? { providerCodeEvidence: params.providerCodeEvidence }
          : {}),
      });
      return {
        status: "reconcile_required",
        entryPointId: params.entryPointId,
        operationId: operation.operationId,
      };
    }
  }
  await params.store.failWhatsAppQrOperation({
    lease: params.lease,
    sanitizedError,
    result: {
      outcome: "failed",
      status: "FAILED",
      entryPointVersion: params.entryPointVersion,
    },
  });
  throw serviceError("PROVIDER_FAILED");
}

function assertEntryPointVersion(
  entryPoint: WhatsAppQrEntryPointRecord,
  expected: number
): void {
  if (entryPoint.version !== expected) {
    throw serviceError("VERSION_CONFLICT");
  }
}

function assertCodeVersion(code: WhatsAppQrCodeRecord, expected: number): void {
  if (code.version !== expected) {
    throw serviceError("VERSION_CONFLICT");
  }
}

function requireActiveProviderBinding(
  entryPoint: WhatsAppQrEntryPointRecord
): asserts entryPoint is WhatsAppQrEntryPointRecord & {
  sourceId: string;
  wabaId: string;
  phoneNumberId: string;
  currentCodeId: string;
  status: "ACTIVE";
} {
  if (
    entryPoint.status !== "ACTIVE" ||
    !entryPoint.sourceId ||
    !entryPoint.wabaId ||
    !entryPoint.phoneNumberId ||
    !entryPoint.currentCodeId
  ) {
    throw serviceError("OPERATION_CONFLICT");
  }
}

function isCurrentOrHistoricalPlacementBinding(params: {
  entryPoint: WhatsAppQrEntryPointRecord & { currentCodeId: string };
  code: WhatsAppQrCodeRecord;
}): boolean {
  if (params.code.placementBindingState === "CURRENT") {
    return params.entryPoint.currentCodeId === params.code.codeId;
  }
  if (params.code.placementBindingState === "HISTORICAL") {
    return params.entryPoint.currentCodeId !== params.code.codeId;
  }
  return false;
}

function manageableHistoricalCodeFilter(params: {
  workspaceId: string;
  entryPointId: string;
}) {
  return {
    workspaceId: params.workspaceId,
    entryPointId: params.entryPointId,
    placementBindingState: "HISTORICAL" as const,
    providerState: { $in: ["ACTIVE", "RECONCILING"] as const },
  };
}

async function requireHistoricalCodeCapacity(params: {
  workspaceId: string;
  entryPointId: string;
}): Promise<void> {
  const count = await WhatsAppQrCode.countDocuments(
    manageableHistoricalCodeFilter(params),
    { limit: WHATSAPP_QR_MANAGEABLE_HISTORY_LIMIT }
  );
  if (count >= WHATSAPP_QR_MANAGEABLE_HISTORY_LIMIT) {
    throw serviceError(
      "OPERATION_CONFLICT",
      "Delete a previous QR code before creating another replacement"
    );
  }
}

async function requireNoManageableHistoricalCodes(params: {
  workspaceId: string;
  entryPointId: string;
  session?: ClientSession;
}): Promise<void> {
  const query = WhatsAppQrCode.exists(manageableHistoricalCodeFilter(params));
  if (params.session) query.session(params.session);
  const historicalCode = await query;
  if (historicalCode) {
    throw serviceError(
      "OPERATION_CONFLICT",
      "Delete previous QR codes before deleting the current code"
    );
  }
}

function requireDraftBinding(entryPoint: WhatsAppQrEntryPointRecord): void {
  if (
    entryPoint.status !== "DRAFT" ||
    entryPoint.sourceId ||
    entryPoint.wabaId ||
    entryPoint.phoneNumberId ||
    entryPoint.currentCodeId
  ) {
    throw serviceError("OPERATION_CONFLICT");
  }
}

function requireReconciliationBinding(params: {
  entryPoint: WhatsAppQrEntryPointRecord;
  code: WhatsAppQrCodeRecord;
  sourceId: string;
  phoneNumberId: string;
}): void {
  const { entryPoint, code, sourceId, phoneNumberId } = params;
  if (
    code.sourceId !== sourceId ||
    code.phoneNumberId !== phoneNumberId ||
    code.placementBindingState !== "CURRENT"
  ) {
    throw serviceError("OPERATION_CONFLICT");
  }
  if (entryPoint.status === "DRAFT") {
    requireDraftBinding(entryPoint);
    return;
  }
  requireActiveProviderBinding(entryPoint);
  if (
    entryPoint.currentCodeId !== code.codeId ||
    entryPoint.sourceId !== code.sourceId ||
    entryPoint.wabaId !== code.wabaId ||
    entryPoint.phoneNumberId !== code.phoneNumberId
  ) {
    throw serviceError("OPERATION_CONFLICT");
  }
}

/** Digests the canonical request, then replays or rejects a known key. */
async function preflightCommand(
  context: {
    store: StoreDeps;
    workspaceId: string;
    entryPointId: string;
    idempotencyKey: string;
  },
  canonicalRequest: { kind: WhatsAppQrOperationRecord["kind"] } & Record<
    string,
    unknown
  >
) {
  const requestDigest = hashWhatsAppQrRequestDigest(canonicalRequest);
  const preflight = await preflightReplayOrBusy({
    store: context.store,
    workspaceId: context.workspaceId,
    entryPointId: context.entryPointId,
    kind: canonicalRequest.kind,
    idempotencyKey: context.idempotencyKey,
    requestDigest,
  });
  return { requestDigest, preflight };
}

async function preflightReplayOrBusy(params: {
  store: StoreDeps;
  workspaceId: string;
  entryPointId: string;
  kind: WhatsAppQrOperationRecord["kind"];
  idempotencyKey: string;
  requestDigest: string;
}): Promise<WhatsAppQrCommandResult | null> {
  const existing = await params.store.lookupWhatsAppQrOperation({
    workspaceId: params.workspaceId,
    entryPointId: params.entryPointId,
    kind: params.kind,
    idempotencyKey: params.idempotencyKey,
    requestDigest: params.requestDigest,
  });
  if (existing.kind === "replay") {
    return {
      status: "replay",
      entryPointId: params.entryPointId,
      result: existing.result,
    };
  }
  if (existing.kind === "busy") {
    if (existing.operation.status === "RECONCILE_REQUIRED") {
      return {
        status: "reconcile_required",
        entryPointId: params.entryPointId,
        operationId: existing.operation.operationId,
      };
    }
    return {
      status: "busy",
      entryPointId: params.entryPointId,
      operationId: existing.operation.operationId,
    };
  }
  return null;
}

async function reserveOrReplay(params: {
  store: StoreDeps;
  workspaceId: string;
  entryPoint: WhatsAppQrEntryPointRecord;
  sourceId: string;
  kind: WhatsAppQrOperationRecord["kind"];
  idempotencyKey: string;
  requestDigest: string;
  expectedEntryPointVersion: number;
  codeId?: string;
  currentCodeId?: string;
  expectedCodeVersion?: number;
  session?: ClientSession;
}): Promise<
  | {
      kind: "continue";
      lease: WhatsAppQrOperationLease;
      operation: WhatsAppQrOperationRecord;
    }
  | WhatsAppQrCommandResult
> {
  const reserved = await params.store.reserveWhatsAppQrOperation({
    workspaceId: params.workspaceId,
    entryPointId: params.entryPoint.entryPointId,
    sourceId: params.sourceId,
    kind: params.kind,
    idempotencyKey: params.idempotencyKey,
    requestDigest: params.requestDigest,
    expectedEntryPointVersion: params.expectedEntryPointVersion,
    ...(params.codeId !== undefined ? { codeId: params.codeId } : {}),
    ...(params.currentCodeId !== undefined
      ? { currentCodeId: params.currentCodeId }
      : {}),
    ...(params.expectedCodeVersion !== undefined
      ? { expectedCodeVersion: params.expectedCodeVersion }
      : {}),
    ...(params.session ? { session: params.session } : {}),
  });
  if (reserved.kind === "replay") {
    return {
      status: "replay",
      entryPointId: params.entryPoint.entryPointId,
      result: reserved.result,
    };
  }
  if (reserved.kind === "busy") {
    return {
      status: "busy",
      entryPointId: params.entryPoint.entryPointId,
      operationId: reserved.operation.operationId,
    };
  }
  return {
    kind: "continue",
    lease: reserved.lease,
    operation: reserved.operation,
  };
}

function exactEntryPointAssignmentFilter(
  entryPoint: WhatsAppQrEntryPointRecord
): Record<string, unknown> {
  const assignmentState =
    entryPoint.assignmentState === undefined
      ? { $exists: false }
      : entryPoint.assignmentState;
  if (entryPoint.scenarioId && entryPoint.nodeId) {
    return {
      scenarioId: entryPoint.scenarioId,
      nodeId: entryPoint.nodeId,
      assignmentState,
    };
  }
  return {
    scenarioId: { $exists: false },
    nodeId: { $exists: false },
    assignmentState,
  };
}

async function fenceEntryPointForDeletionInSession(params: {
  session: ClientSession;
  fenceToken: string;
  entryPoint: WhatsAppQrEntryPointRecord & {
    sourceId: string;
    wabaId: string;
    phoneNumberId: string;
    currentCodeId: string;
    status: "ACTIVE";
  };
}): Promise<WhatsAppQrEntryPointRecord | null> {
  return WhatsAppQrEntryPoint.findOneAndUpdate(
    {
      entryPointId: params.entryPoint.entryPointId,
      workspaceId: params.entryPoint.workspaceId,
      version: params.entryPoint.version,
      status: "ACTIVE",
      sourceId: params.entryPoint.sourceId,
      wabaId: params.entryPoint.wabaId,
      phoneNumberId: params.entryPoint.phoneNumberId,
      currentCodeId: params.entryPoint.currentCodeId,
      ...exactEntryPointAssignmentFilter(params.entryPoint),
    },
    {
      $set: { lastDeletionFenceToken: params.fenceToken },
      $inc: { version: 1 },
    },
    { session: params.session, new: true, runValidators: true }
  ).lean<WhatsAppQrEntryPointRecord | null>();
}

async function failDeletePreparationInSession(params: {
  store: StoreDeps;
  session: ClientSession;
  lease: WhatsAppQrOperationLease;
  sanitizedCode: string;
  entryPointVersion: number;
  code: WhatsAppQrCodeRecord;
}): Promise<void> {
  await params.store.failWhatsAppQrOperation({
    lease: params.lease,
    sanitizedError: { code: params.sanitizedCode, retryable: false },
    result: {
      outcome: "failed",
      status: "FAILED",
      codeId: params.code.codeId,
      entryPointVersion: params.entryPointVersion,
      codeVersion: params.code.version,
    },
    session: params.session,
  });
}

type DeletePreparationResult =
  | { kind: "command"; result: WhatsAppQrCommandResult }
  | {
      kind: "failed";
      code: WhatsAppQrServiceErrorCode;
      message: string;
    }
  | {
      kind: "staged";
      lease: WhatsAppQrOperationLease;
      entryPoint: WhatsAppQrEntryPointRecord;
      code: WhatsAppQrCodeRecord;
    };

async function prepareDeleteForProvider(params: {
  store: StoreDeps;
  workspaceId: string;
  entryPoint: WhatsAppQrEntryPointRecord & {
    sourceId: string;
    wabaId: string;
    phoneNumberId: string;
    currentCodeId: string;
    status: "ACTIVE";
  };
  code: WhatsAppQrCodeRecord;
  sourceId: string;
  idempotencyKey: string;
  requestDigest: string;
  expectedEntryPointVersion: number;
  expectedCodeVersion: number;
}): Promise<DeletePreparationResult> {
  const session = await Scenario.startSession();
  let result: DeletePreparationResult | undefined;
  try {
    await session.withTransaction(async () => {
      result = undefined;
      const reserved = await reserveOrReplay({
        store: params.store,
        workspaceId: params.workspaceId,
        entryPoint: params.entryPoint,
        sourceId: params.sourceId,
        kind: "DELETE",
        idempotencyKey: params.idempotencyKey,
        requestDigest: params.requestDigest,
        expectedEntryPointVersion: params.expectedEntryPointVersion,
        codeId: params.code.codeId,
        currentCodeId: params.entryPoint.currentCodeId,
        expectedCodeVersion: params.expectedCodeVersion,
        session,
      });
      if (!("kind" in reserved)) {
        result = { kind: "command", result: reserved };
        return;
      }

      const fencedEntryPoint = await fenceEntryPointForDeletionInSession({
        session,
        fenceToken: reserved.operation.operationId,
        entryPoint: params.entryPoint,
      });
      if (!fencedEntryPoint) {
        await failDeletePreparationInSession({
          store: params.store,
          session,
          lease: reserved.lease,
          sanitizedCode: "DELETE_ENTRY_POINT_VERSION_CONFLICT",
          entryPointVersion: params.entryPoint.version,
          code: params.code,
        });
        result = {
          kind: "failed",
          code: "VERSION_CONFLICT",
          message: "Entry point changed during deletion",
        };
        return;
      }

      try {
        await assertDeleteScenarioAssignmentInactive({
          entryPoint: fencedEntryPoint,
          session,
        });
        if (params.code.placementBindingState === "CURRENT") {
          await requireNoManageableHistoricalCodes({
            workspaceId: params.workspaceId,
            entryPointId: params.entryPoint.entryPointId,
            session,
          });
        }
      } catch (error) {
        if (!(error instanceof WhatsAppQrServiceError)) throw error;
        await failDeletePreparationInSession({
          store: params.store,
          session,
          lease: reserved.lease,
          sanitizedCode: `DELETE_${error.code}`,
          entryPointVersion: fencedEntryPoint.version,
          code: params.code,
        });
        result = {
          kind: "failed",
          code: error.code,
          message: error.message,
        };
        return;
      }

      if (params.code.providerState !== "ACTIVE") {
        await failDeletePreparationInSession({
          store: params.store,
          session,
          lease: reserved.lease,
          sanitizedCode: "DELETE_CODE_NOT_ACTIVE",
          entryPointVersion: fencedEntryPoint.version,
          code: params.code,
        });
        result = {
          kind: "failed",
          code: "OPERATION_CONFLICT",
          message: "QR code requires reconciliation before deletion",
        };
        return;
      }

      try {
        const staged = await stageExistingCodeForReconciliation({
          code: params.code,
          session,
        });
        result = {
          kind: "staged",
          lease: reserved.lease,
          entryPoint: fencedEntryPoint,
          code: staged,
        };
      } catch (error) {
        if (!(error instanceof WhatsAppQrServiceError)) throw error;
        await failDeletePreparationInSession({
          store: params.store,
          session,
          lease: reserved.lease,
          sanitizedCode: `DELETE_STAGING_${error.code}`,
          entryPointVersion: fencedEntryPoint.version,
          code: params.code,
        });
        result = {
          kind: "failed",
          code: error.code,
          message: error.message,
        };
      }
    });
  } finally {
    await session.endSession();
  }
  if (!result) {
    throw serviceError(
      "STORAGE_FAILED",
      "Delete transaction produced no result"
    );
  }
  return result;
}

function hasDeleteOperationFenceIdentity(params: {
  operation: WhatsAppQrOperationRecord;
  entryPoint: WhatsAppQrEntryPointRecord;
  code: WhatsAppQrCodeRecord;
  phoneNumberId: string;
}): boolean {
  const { operation, entryPoint, code } = params;
  if (
    operation.kind !== "DELETE" ||
    operation.codeId !== code.codeId ||
    operation.currentCodeId === undefined ||
    operation.expectedCodeVersion === undefined ||
    entryPoint.entryPointId !== operation.entryPointId ||
    entryPoint.workspaceId !== operation.workspaceId ||
    entryPoint.lastDeletionFenceToken !== operation.operationId ||
    entryPoint.version < operation.expectedEntryPointVersion + 1 ||
    code.workspaceId !== operation.workspaceId ||
    code.entryPointId !== operation.entryPointId ||
    code.sourceId !== operation.sourceId ||
    code.phoneNumberId !== params.phoneNumberId ||
    code.version < operation.expectedCodeVersion + 1
  ) {
    return false;
  }
  if (entryPoint.status === "ACTIVE") {
    return Boolean(
      entryPoint.sourceId === operation.sourceId &&
        entryPoint.wabaId &&
        entryPoint.phoneNumberId === params.phoneNumberId &&
        entryPoint.currentCodeId &&
        entryPoint.currentCodeId === operation.currentCodeId &&
        code.wabaId === entryPoint.wabaId
    );
  }
  return entryPoint.status === "DRAFT" && code.providerState === "DELETED";
}

function isExactPreparedDeleteState(params: {
  operation: WhatsAppQrOperationRecord;
  entryPoint: WhatsAppQrEntryPointRecord;
  code: WhatsAppQrCodeRecord;
  phoneNumberId: string;
}): boolean {
  const { operation, entryPoint, code } = params;
  return Boolean(
    hasDeleteOperationFenceIdentity(params) &&
      operation.providerStage === "NOT_STARTED" &&
      !operation.attemptedAt &&
      !operation.providerCodeEvidence &&
      entryPoint.status === "ACTIVE" &&
      entryPoint.version === operation.expectedEntryPointVersion + 1 &&
      entryPoint.currentCodeId === operation.currentCodeId &&
      code.version === (operation.expectedCodeVersion ?? -2) + 1 &&
      code.providerState === "RECONCILING" &&
      code.providerCode?.trim() &&
      code.deepLink?.trim() &&
      isCurrentOrHistoricalPlacementBinding({
        entryPoint: entryPoint as WhatsAppQrEntryPointRecord & {
          currentCodeId: string;
        },
        code,
      })
  );
}

async function loadDeleteOperationResources(params: {
  operation: WhatsAppQrOperationRecord;
}): Promise<{
  entryPoint: WhatsAppQrEntryPointRecord | null;
  code: WhatsAppQrCodeRecord | null;
}> {
  const codeId = params.operation.codeId;
  if (!codeId) return { entryPoint: null, code: null };
  const [entryPoint, code] = await Promise.all([
    WhatsAppQrEntryPoint.findOne({
      workspaceId: params.operation.workspaceId,
      entryPointId: params.operation.entryPointId,
    }).lean<WhatsAppQrEntryPointRecord | null>(),
    WhatsAppQrCode.findOne({
      workspaceId: params.operation.workspaceId,
      entryPointId: params.operation.entryPointId,
      codeId,
    }).lean<WhatsAppQrCodeRecord | null>(),
  ]);
  return { entryPoint, code };
}

async function recoverDeletePreparation(params: {
  store: StoreDeps;
  workspaceId: string;
  entryPointId: string;
  sourceId: string;
  phoneNumberId: string;
  codeId: string;
  requestDigest: string;
  expectedEntryPointVersion: number;
  expectedCodeVersion: number;
}): Promise<DeletePreparationResult | null> {
  const recovered = await params.store.recoverWhatsAppQrDeleteOperation({
    workspaceId: params.workspaceId,
    entryPointId: params.entryPointId,
    sourceId: params.sourceId,
    codeId: params.codeId,
    requestDigest: params.requestDigest,
    expectedEntryPointVersion: params.expectedEntryPointVersion,
    expectedCodeVersion: params.expectedCodeVersion,
  });
  if (recovered.kind === "miss") return null;
  if (recovered.kind === "busy") {
    return {
      kind: "command",
      result: {
        status: "busy",
        entryPointId: params.entryPointId,
        operationId: recovered.operation.operationId,
      },
    };
  }
  if (recovered.kind === "reconcile_required") {
    return {
      kind: "command",
      result: {
        status: "reconcile_required",
        entryPointId: params.entryPointId,
        operationId: recovered.operation.operationId,
      },
    };
  }

  const { operation, lease } = recovered;
  const sendToReconciliation = async (
    code: string,
    providerCodeEvidence = operation.providerCodeEvidence
  ): Promise<DeletePreparationResult> => ({
    kind: "command",
    result: await keepOriginalOperationReconcileRequired({
      store: params.store,
      lease,
      entryPointId: params.entryPointId,
      ...(providerCodeEvidence ? { providerCodeEvidence } : {}),
      code,
    }),
  });

  const releaseLeaseAsBusy = async (): Promise<DeletePreparationResult> => {
    try {
      await params.store.releaseWhatsAppQrOperationLease({ lease });
    } catch {
      // The lease is bounded; never weaken the failed operation-owned proof
      // or dispatch from an unproven prepared state.
    }
    return {
      kind: "command",
      result: {
        status: "busy",
        entryPointId: params.entryPointId,
        operationId: operation.operationId,
      },
    };
  };

  const { entryPoint, code } = await loadDeleteOperationResources({
    operation,
  });
  if (
    !entryPoint ||
    !code ||
    !hasDeleteOperationFenceIdentity({
      operation,
      entryPoint,
      code,
      phoneNumberId: params.phoneNumberId,
    })
  ) {
    return releaseLeaseAsBusy();
  }

  if (operation.providerStage !== "NOT_STARTED") {
    return sendToReconciliation(
      "DELETE_PROVIDER_ATTEMPT_AMBIGUOUS",
      code.providerCode
    );
  }
  if (
    !isExactPreparedDeleteState({
      operation,
      entryPoint,
      code,
      phoneNumberId: params.phoneNumberId,
    })
  ) {
    return releaseLeaseAsBusy();
  }
  requireActiveProviderBinding(entryPoint);

  try {
    await assertDeleteScenarioAssignmentInactive({ entryPoint });
  } catch (error) {
    if (!(error instanceof WhatsAppQrServiceError)) throw error;
    return sendToReconciliation(`DELETE_${error.code}`, code.providerCode);
  }

  return {
    kind: "staged",
    lease,
    entryPoint,
    code,
  };
}

export type CreateWhatsAppQrParams = {
  workspaceId: string;
  entryPointId: string;
  sourceId: string;
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
  desiredMessage: string;
  expectedEntryPointVersion: number;
  idempotencyKey: string;
  client?: WhatsAppGraphClient;
  provider?: Partial<ProviderDeps>;
  store?: Partial<StoreDeps>;
};

export async function createWhatsAppQrEntryPointCode(
  params: CreateWhatsAppQrParams
): Promise<WhatsAppQrCommandResult> {
  try {
    await connectDB();
    const { workspaceId, entryPointId, sourceId } = readQrCommandScope(params);
    const wabaId = requiredString(params.wabaId, "WABA id");
    const phoneNumberId = requiredString(
      params.phoneNumberId,
      "Phone number id"
    );
    const accessToken = requiredString(params.accessToken, "Access token");
    const desiredMessage = requiredDesiredMessage(params.desiredMessage);
    const { expectedEntryPointVersion, idempotencyKey } =
      readQrCommandGuards(params);
    const provider = { ...defaultProvider, ...params.provider };
    const store = { ...defaultStore, ...params.store };

    const { requestDigest, preflight } = await preflightCommand(
      { store, workspaceId, entryPointId, idempotencyKey },
      {
        kind: "CREATE",
        entryPointId,
        sourceId,
        phoneNumberId,
        desiredMessage,
        expectedEntryPointVersion,
      }
    );
    if (preflight) return preflight;

    const entryPoint = await loadEntryPoint({ workspaceId, entryPointId });
    assertEntryPointVersion(entryPoint, expectedEntryPointVersion);
    requireDraftBinding(entryPoint);
    const reserved = await reserveOrReplay({
      store,
      workspaceId,
      entryPoint,
      sourceId,
      kind: "CREATE",
      idempotencyKey,
      requestDigest,
      expectedEntryPointVersion,
    });
    if (!("kind" in reserved)) return reserved;

    const referenceCode = await allocateReference(workspaceId);
    const prefilledMessage = formatWhatsAppQrReferenceMessage(
      desiredMessage,
      referenceCode
    );
    const pending = await createPendingCode({
      workspaceId,
      entryPointId,
      sourceId,
      wabaId,
      phoneNumberId,
      referenceCode,
      prefilledMessage,
    });
    await store.markWhatsAppQrProviderRequestSent({
      lease: reserved.lease,
      providerCodeEvidence: pending.codeId,
    });

    let created: WhatsAppChatQr;
    try {
      created = await provider.createWhatsAppChatQr({
        phoneNumberId,
        accessToken,
        prefilledMessage,
        ...(params.client ? { client: params.client } : {}),
      });
    } catch (error) {
      if (error instanceof WhatsAppChatQrProviderError) {
        return handleProviderFailure({
          store,
          lease: reserved.lease,
          entryPointId,
          error,
          entryPointVersion: entryPoint.version,
          providerCodeEvidence: pending.codeId,
          onDefiniteFailure: () =>
            detachPendingCode(pending).then(() => undefined),
        });
      }
      throw error;
    }

    try {
      return await finalizeSuccess({
        store,
        lease: reserved.lease,
        entryPoint,
        code: pending,
        provider: created,
        sourceId,
        wabaId,
        phoneNumberId,
        desiredMessage,
      });
    } catch {
      return markLocalFinalizationReconcileRequired({
        store,
        lease: reserved.lease,
        entryPointId,
        providerCodeEvidence: pending.codeId,
      });
    }
  } catch (error) {
    mapStoreError(error);
  }
}

export type ConnectWhatsAppQrParams = {
  workspaceId: string;
  entryPointId: string;
  sourceId: string;
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
  providerCode: string;
  desiredMessage: string;
  expectedEntryPointVersion: number;
  idempotencyKey: string;
  client?: WhatsAppGraphClient;
  provider?: Partial<ProviderDeps>;
  store?: Partial<StoreDeps>;
};

export async function connectWhatsAppQrEntryPointCode(
  params: ConnectWhatsAppQrParams
): Promise<WhatsAppQrCommandResult> {
  try {
    await connectDB();
    const { workspaceId, entryPointId, sourceId } = readQrCommandScope(params);
    const wabaId = requiredString(params.wabaId, "WABA id");
    const phoneNumberId = requiredString(
      params.phoneNumberId,
      "Phone number id"
    );
    const accessToken = requiredString(params.accessToken, "Access token");
    const providerCode = requiredString(params.providerCode, "Provider code");
    const desiredMessage = requiredDesiredMessage(params.desiredMessage);
    const { expectedEntryPointVersion, idempotencyKey } =
      readQrCommandGuards(params);
    const provider = { ...defaultProvider, ...params.provider };
    const store = { ...defaultStore, ...params.store };

    const { requestDigest, preflight } = await preflightCommand(
      { store, workspaceId, entryPointId, idempotencyKey },
      {
        kind: "CONNECT",
        entryPointId,
        sourceId,
        phoneNumberId,
        providerCode,
        desiredMessage,
        expectedEntryPointVersion,
      }
    );
    if (preflight) return preflight;

    const entryPoint = await loadEntryPoint({ workspaceId, entryPointId });
    assertEntryPointVersion(entryPoint, expectedEntryPointVersion);
    requireDraftBinding(entryPoint);
    const reserved = await reserveOrReplay({
      store,
      workspaceId,
      entryPoint,
      sourceId,
      kind: "CONNECT",
      idempotencyKey,
      requestDigest,
      expectedEntryPointVersion,
    });
    if (!("kind" in reserved)) return reserved;

    let existing: WhatsAppChatQr;
    try {
      existing = await provider.getWhatsAppChatQr({
        phoneNumberId,
        accessToken,
        code: providerCode,
        ...(params.client ? { client: params.client } : {}),
      });
    } catch (error) {
      if (error instanceof WhatsAppChatQrProviderError) {
        return handleProviderFailure({
          store,
          lease: reserved.lease,
          entryPointId,
          error,
          entryPointVersion: entryPoint.version,
          providerCodeEvidence: providerCode,
          allowReconcile: false,
        });
      }
      throw error;
    }

    const referenceCode = await allocateReference(workspaceId);
    const prefilledMessage = formatWhatsAppQrReferenceMessage(
      desiredMessage,
      referenceCode
    );
    const pending = await createPendingCode({
      workspaceId,
      entryPointId,
      sourceId,
      wabaId,
      phoneNumberId,
      referenceCode,
      prefilledMessage,
    });
    await store.markWhatsAppQrProviderRequestSent({
      lease: reserved.lease,
      providerCodeEvidence: providerCode,
    });

    let updated: WhatsAppChatQr;
    try {
      updated = await provider.updateWhatsAppChatQrMessage({
        phoneNumberId,
        accessToken,
        current: existing,
        prefilledMessage,
        ...(params.client ? { client: params.client } : {}),
      });
      if (
        updated.code !== existing.code ||
        updated.deepLink !== existing.deepLink
      ) {
        throw new WhatsAppChatQrProviderError("definite", {
          category: "identity_changed",
        });
      }
    } catch (error) {
      if (error instanceof WhatsAppChatQrProviderError) {
        return handleProviderFailure({
          store,
          lease: reserved.lease,
          entryPointId,
          error,
          entryPointVersion: entryPoint.version,
          providerCodeEvidence: providerCode,
          onDefiniteFailure: () =>
            detachPendingCode(pending).then(() => undefined),
        });
      }
      throw error;
    }

    try {
      return await finalizeSuccess({
        store,
        lease: reserved.lease,
        entryPoint,
        code: pending,
        provider: updated,
        sourceId,
        wabaId,
        phoneNumberId,
        desiredMessage,
      });
    } catch {
      return markLocalFinalizationReconcileRequired({
        store,
        lease: reserved.lease,
        entryPointId,
        providerCodeEvidence: providerCode,
      });
    }
  } catch (error) {
    mapStoreError(error);
  }
}

function providerIdentityFromCode(
  code: WhatsAppQrCodeRecord
): WhatsAppChatQr | null {
  if (
    !code.providerCode?.trim() ||
    !code.deepLink?.trim() ||
    !code.prefilledMessage
  ) {
    return null;
  }
  return {
    code: code.providerCode,
    deepLink: code.deepLink,
    prefilledMessage: code.prefilledMessage,
  };
}

async function keepOriginalOperationReconcileRequired(params: {
  store: StoreDeps;
  lease: WhatsAppQrOperationLease;
  entryPointId: string;
  providerCodeEvidence?: string;
  error?: WhatsAppChatQrProviderError;
  code?: string;
}): Promise<WhatsAppQrCommandResult> {
  const operation = await params.store.markWhatsAppQrReconcileRequired({
    lease: params.lease,
    sanitizedError: params.error
      ? sanitizedProviderError(params.error)
      : {
          code: params.code ?? "PROVIDER_RECONCILE_PENDING",
          retryable: true,
        },
    ...(params.providerCodeEvidence
      ? { providerCodeEvidence: params.providerCodeEvidence }
      : {}),
  });
  return {
    status: "reconcile_required",
    entryPointId: params.entryPointId,
    operationId: operation.operationId,
  };
}

async function failAfterRecoveredCleanup(params: {
  store: StoreDeps;
  lease: WhatsAppQrOperationLease;
  entryPointId: string;
  entryPointVersion: number;
  code?: WhatsAppQrCodeRecord;
}): Promise<never> {
  await params.store.failWhatsAppQrOperation({
    lease: params.lease,
    sanitizedError: { code: "PROVIDER_FAILED", retryable: false },
    result: {
      outcome: "failed",
      status: "FAILED",
      entryPointVersion: params.entryPointVersion,
      ...(params.code
        ? { codeId: params.code.codeId, codeVersion: params.code.version }
        : {}),
    },
  });
  throw serviceError("PROVIDER_FAILED");
}

export type ReconcileWhatsAppQrParams = {
  workspaceId: string;
  entryPointId: string;
  sourceId: string;
  operationId: string;
  accessToken: string;
  phoneNumberId: string;
  client?: WhatsAppGraphClient;
  provider?: Partial<ProviderDeps>;
  store?: Partial<StoreDeps>;
};

export async function reconcileWhatsAppQrOperation(
  params: ReconcileWhatsAppQrParams
): Promise<WhatsAppQrCommandResult> {
  try {
    await connectDB();
    const { workspaceId, entryPointId, sourceId } = readQrCommandScope(params);
    const operationId = requiredString(params.operationId, "Operation id");
    const accessToken = requiredString(params.accessToken, "Access token");
    const phoneNumberId = requiredString(
      params.phoneNumberId,
      "Phone number id"
    );
    const provider = { ...defaultProvider, ...params.provider };
    const store = { ...defaultStore, ...params.store };

    const acquired = await store.acquireWhatsAppQrReconciliationOperation({
      operationId,
      workspaceId,
      entryPointId,
    });
    if (acquired.kind === "busy") {
      return {
        status: "busy",
        entryPointId,
        operationId: acquired.operation.operationId,
      };
    }
    const { operation, lease } = acquired;
    if (operation.sourceId !== sourceId) {
      throw serviceError("OPERATION_CONFLICT");
    }

    const entryPoint = await loadEntryPoint({ workspaceId, entryPointId });
    const client = params.client ? { client: params.client } : {};

    try {
      switch (operation.kind) {
        case "CREATE": {
          const evidenceCodeId = operation.providerCodeEvidence;
          const code = await WhatsAppQrCode.findOne({
            workspaceId,
            entryPointId,
            ...(evidenceCodeId ? { codeId: evidenceCodeId } : {}),
            providerState: { $in: ["PENDING", "ACTIVE", "RECONCILING"] },
          }).lean<WhatsAppQrCodeRecord | null>();
          if (
            !code?.prefilledMessage ||
            code.sourceId !== sourceId ||
            code.phoneNumberId !== phoneNumberId
          ) {
            throw serviceError("OPERATION_CONFLICT");
          }
          requireReconciliationBinding({
            entryPoint,
            code,
            sourceId,
            phoneNumberId,
          });
          let providerQr = providerIdentityFromCode(code);
          if (!providerQr) {
            const listed = await provider.listWhatsAppChatQrs({
              phoneNumberId,
              accessToken,
              ...client,
            });
            const matches = listed.filter(
              item => item.prefilledMessage === code.prefilledMessage
            );
            if (matches.length !== 1) {
              if (
                matches.length === 0 &&
                operation.sanitizedError?.code === "LOCAL_CLEANUP_FAILED"
              ) {
                const detached = await detachPendingCode(code);
                return failAfterRecoveredCleanup({
                  store,
                  lease,
                  entryPointId,
                  entryPointVersion: entryPoint.version,
                  code: detached,
                });
              }
              return keepOriginalOperationReconcileRequired({
                store,
                lease,
                entryPointId,
                providerCodeEvidence: code.codeId,
                code: "PROVIDER_RECONCILE_CREATE_PENDING",
              });
            }
            providerQr = matches[0]!;
          }
          return finalizeSuccess({
            store,
            lease,
            entryPoint,
            code,
            provider: providerQr,
            sourceId,
            wabaId: code.wabaId,
            phoneNumberId,
            desiredMessage: extractWhatsAppQrReference(code.prefilledMessage)
              .effectiveText,
          });
        }
        case "CONNECT": {
          const providerCode = requiredString(
            operation.providerCodeEvidence,
            "Provider code evidence"
          );
          const code = await WhatsAppQrCode.findOne({
            workspaceId,
            entryPointId,
            sourceId,
            phoneNumberId,
            placementBindingState: "CURRENT",
            providerState: { $in: ["PENDING", "ACTIVE", "RECONCILING"] },
          }).lean<WhatsAppQrCodeRecord | null>();
          if (!code?.prefilledMessage) {
            throw serviceError("OPERATION_CONFLICT");
          }
          requireReconciliationBinding({
            entryPoint,
            code,
            sourceId,
            phoneNumberId,
          });
          let providerQr = await provider.getWhatsAppChatQr({
            phoneNumberId,
            accessToken,
            code: providerCode,
            ...client,
          });
          if (providerQr.prefilledMessage !== code.prefilledMessage) {
            providerQr = await provider.updateWhatsAppChatQrMessage({
              phoneNumberId,
              accessToken,
              current: providerQr,
              prefilledMessage: code.prefilledMessage,
              ...client,
            });
          }
          return finalizeSuccess({
            store,
            lease,
            entryPoint,
            code,
            provider: providerQr,
            sourceId,
            wabaId: code.wabaId,
            phoneNumberId,
            desiredMessage: extractWhatsAppQrReference(code.prefilledMessage)
              .effectiveText,
          });
        }
        case "REPLACE": {
          requireActiveProviderBinding(entryPoint);
          if (
            entryPoint.sourceId !== sourceId ||
            entryPoint.phoneNumberId !== phoneNumberId
          ) {
            throw serviceError("OPERATION_CONFLICT");
          }
          const pendingCodeId = requiredString(
            operation.providerCodeEvidence,
            "Pending code evidence"
          );
          const oldCodeId = requiredString(
            operation.currentCodeId ?? operation.codeId,
            "Current code id"
          );
          const pendingCode = await WhatsAppQrCode.findOne({
            workspaceId,
            entryPointId,
            codeId: pendingCodeId,
          }).lean<WhatsAppQrCodeRecord | null>();
          const oldCode = await WhatsAppQrCode.findOne({
            workspaceId,
            entryPointId,
            codeId: oldCodeId,
          }).lean<WhatsAppQrCodeRecord | null>();
          if (
            !pendingCode?.prefilledMessage ||
            !oldCode ||
            pendingCode.sourceId !== sourceId ||
            pendingCode.phoneNumberId !== phoneNumberId ||
            oldCode.sourceId !== sourceId ||
            oldCode.phoneNumberId !== phoneNumberId ||
            ![oldCode.codeId, pendingCode.codeId].includes(
              entryPoint.currentCodeId
            ) ||
            !["CURRENT", "HISTORICAL"].includes(
              pendingCode.placementBindingState
            ) ||
            !["CURRENT", "HISTORICAL"].includes(oldCode.placementBindingState)
          ) {
            throw serviceError("OPERATION_CONFLICT");
          }
          let providerQr = providerIdentityFromCode(pendingCode);
          if (!providerQr) {
            const listed = await provider.listWhatsAppChatQrs({
              phoneNumberId,
              accessToken,
              ...client,
            });
            const matches = listed.filter(
              item => item.prefilledMessage === pendingCode.prefilledMessage
            );
            if (matches.length !== 1) {
              if (
                matches.length === 0 &&
                operation.sanitizedError?.code === "LOCAL_CLEANUP_FAILED"
              ) {
                const detached = await detachPendingCode(pendingCode);
                return failAfterRecoveredCleanup({
                  store,
                  lease,
                  entryPointId,
                  entryPointVersion: entryPoint.version,
                  code: detached,
                });
              }
              return keepOriginalOperationReconcileRequired({
                store,
                lease,
                entryPointId,
                providerCodeEvidence: pendingCode.codeId,
                code: "PROVIDER_RECONCILE_REPLACE_PENDING",
              });
            }
            providerQr = matches[0]!;
          }
          return finalizeReplacement({
            store,
            lease,
            entryPoint,
            oldCode,
            pendingCode,
            provider: providerQr,
            desiredMessage: extractWhatsAppQrReference(
              pendingCode.prefilledMessage
            ).effectiveText,
          });
        }
        case "APPLY_MESSAGE": {
          requireActiveProviderBinding(entryPoint);
          if (
            entryPoint.sourceId !== sourceId ||
            entryPoint.phoneNumberId !== phoneNumberId
          ) {
            throw serviceError("OPERATION_CONFLICT");
          }
          const codeId = requiredString(operation.codeId, "Code id");
          const code = await WhatsAppQrCode.findOne({
            workspaceId,
            entryPointId,
            codeId,
          }).lean<WhatsAppQrCodeRecord | null>();
          if (
            !code?.providerCode ||
            !code.deepLink ||
            !code.prefilledMessage ||
            code.sourceId !== sourceId ||
            code.phoneNumberId !== phoneNumberId ||
            entryPoint.currentCodeId !== code.codeId ||
            code.placementBindingState !== "CURRENT" ||
            (code.providerState !== "RECONCILING" &&
              code.providerState !== "ACTIVE")
          ) {
            throw serviceError("OPERATION_CONFLICT");
          }
          let providerQr = await provider.getWhatsAppChatQr({
            phoneNumberId,
            accessToken,
            code: code.providerCode,
            ...client,
          });
          if (providerQr.prefilledMessage !== code.prefilledMessage) {
            providerQr = await provider.updateWhatsAppChatQrMessage({
              phoneNumberId,
              accessToken,
              current: providerQr,
              prefilledMessage: code.prefilledMessage,
              ...client,
            });
          }
          return finalizeMessageUpdate({
            store,
            lease,
            entryPoint,
            code,
            provider: providerQr,
            desiredMessage: extractWhatsAppQrReference(code.prefilledMessage)
              .effectiveText,
          });
        }
        case "SYNC_PROVIDER": {
          const codeId = requiredString(operation.codeId, "Code id");
          const expectedCodeVersion = requiredVersion(
            operation.expectedCodeVersion,
            "Expected code version"
          );
          if (operation.currentCodeId !== codeId) {
            throw serviceError("OPERATION_CONFLICT");
          }
          const hasOriginalEntryPointBinding =
            entryPoint.status === "ACTIVE" &&
            entryPoint.version === operation.expectedEntryPointVersion &&
            entryPoint.sourceId === sourceId &&
            entryPoint.phoneNumberId === phoneNumberId &&
            entryPoint.currentCodeId === codeId;
          const hasFinalizedMissingEntryPointBinding =
            entryPoint.status === "DRAFT" &&
            entryPoint.version === operation.expectedEntryPointVersion + 1 &&
            entryPoint.sourceId === undefined &&
            entryPoint.wabaId === undefined &&
            entryPoint.phoneNumberId === undefined &&
            entryPoint.currentCodeId === undefined;
          if (
            !hasOriginalEntryPointBinding &&
            !hasFinalizedMissingEntryPointBinding
          ) {
            throw serviceError("OPERATION_CONFLICT");
          }
          const code = await WhatsAppQrCode.findOne({
            workspaceId,
            entryPointId,
            codeId,
          }).lean<WhatsAppQrCodeRecord | null>();
          const codeIsStaged =
            code?.version === expectedCodeVersion + 1 &&
            code.placementBindingState === "CURRENT" &&
            code.providerState === "RECONCILING";
          const codeIsRestored =
            code?.version === expectedCodeVersion + 2 &&
            code.placementBindingState === "CURRENT" &&
            code.providerState === "ACTIVE";
          const codeIsTombstoned =
            code?.version === expectedCodeVersion + 2 &&
            code.placementBindingState === "DETACHED" &&
            code.providerState === "DELETED" &&
            code.routingState === "DISABLED";
          if (
            !code?.providerCode ||
            !code.deepLink ||
            !code.prefilledMessage ||
            code.sourceId !== sourceId ||
            (hasOriginalEntryPointBinding &&
              code.wabaId !== entryPoint.wabaId) ||
            code.phoneNumberId !== phoneNumberId ||
            operation.providerCodeEvidence !== code.providerCode ||
            (!codeIsStaged && !codeIsRestored && !codeIsTombstoned) ||
            (hasFinalizedMissingEntryPointBinding && !codeIsTombstoned)
          ) {
            throw serviceError("OPERATION_CONFLICT");
          }

          if (codeIsTombstoned) {
            return finalizeDeletion({ store, lease, entryPoint, code });
          }
          if (codeIsRestored) {
            await store.completeWhatsAppQrOperation({
              lease,
              result: {
                outcome: "applied",
                status: "COMPLETED",
                codeId: code.codeId,
                entryPointVersion: entryPoint.version,
                codeVersion: code.version,
              },
            });
            return {
              status: "applied",
              entryPointId,
              codeId: code.codeId,
              entryPointVersion: entryPoint.version,
              codeVersion: code.version,
            };
          }

          let providerQr: WhatsAppChatQr;
          try {
            providerQr = await provider.getWhatsAppChatQr({
              phoneNumberId,
              accessToken,
              code: code.providerCode,
              ...client,
            });
          } catch (error) {
            if (
              error instanceof WhatsAppChatQrProviderError &&
              error.evidence.category === "not_found"
            ) {
              return finalizeDeletion({ store, lease, entryPoint, code });
            }
            throw error;
          }
          if (
            providerQr.code !== code.providerCode ||
            providerQr.deepLink !== code.deepLink
          ) {
            throw new WhatsAppChatQrProviderError("definite", {
              category: "identity_changed",
            });
          }
          if (providerQr.prefilledMessage !== code.prefilledMessage) {
            await store.markWhatsAppQrProviderRequestSent({
              lease,
              providerCodeEvidence: code.providerCode,
            });
            providerQr = await provider.updateWhatsAppChatQrMessage({
              phoneNumberId,
              accessToken,
              current: providerQr,
              prefilledMessage: code.prefilledMessage,
              ...client,
            });
          }
          if (
            providerQr.code !== code.providerCode ||
            providerQr.deepLink !== code.deepLink ||
            providerQr.prefilledMessage !== code.prefilledMessage
          ) {
            throw new WhatsAppChatQrProviderError("definite", {
              category: "identity_changed",
            });
          }
          const restored = await restoreReconciledCode({ code });
          await store.completeWhatsAppQrOperation({
            lease,
            result: {
              outcome: "applied",
              status: "COMPLETED",
              codeId: restored.codeId,
              entryPointVersion: entryPoint.version,
              codeVersion: restored.version,
            },
          });
          return {
            status: "applied",
            entryPointId,
            codeId: restored.codeId,
            entryPointVersion: entryPoint.version,
            codeVersion: restored.version,
          };
        }
        case "DELETE": {
          const codeId = requiredString(operation.codeId, "Code id");
          let code = await WhatsAppQrCode.findOne({
            workspaceId,
            entryPointId,
            codeId,
          }).lean<WhatsAppQrCodeRecord | null>();
          if (
            !code ||
            code.sourceId !== sourceId ||
            code.phoneNumberId !== phoneNumberId
          ) {
            throw serviceError("OPERATION_CONFLICT");
          }
          if (
            operation.status === "RUNNING" &&
            (!hasDeleteOperationFenceIdentity({
              operation,
              entryPoint,
              code,
              phoneNumberId,
            }) ||
              (operation.providerStage === "NOT_STARTED" &&
                !isExactPreparedDeleteState({
                  operation,
                  entryPoint,
                  code,
                  phoneNumberId,
                })))
          ) {
            throw serviceError(
              "OPERATION_CONFLICT",
              "Prepared QR deletion state could not be verified"
            );
          }
          const providerDeletionFinalized =
            code.providerState === "DELETED" &&
            code.placementBindingState === "DETACHED";
          if (entryPoint.status === "ACTIVE") {
            requireActiveProviderBinding(entryPoint);
            if (
              entryPoint.sourceId !== sourceId ||
              entryPoint.phoneNumberId !== phoneNumberId ||
              entryPoint.wabaId !== code.wabaId ||
              (!providerDeletionFinalized &&
                !isCurrentOrHistoricalPlacementBinding({ entryPoint, code }))
            ) {
              throw serviceError("OPERATION_CONFLICT");
            }
          } else if (
            entryPoint.status !== "DRAFT" ||
            code.providerState !== "DELETED"
          ) {
            throw serviceError("OPERATION_CONFLICT");
          }
          await assertDeleteScenarioAssignmentInactive({ entryPoint });
          if (
            operation.status === "RUNNING" &&
            operation.providerStage === "NOT_STARTED"
          ) {
            await store.markWhatsAppQrProviderRequestSent({
              lease,
              providerCodeEvidence: code.providerCode,
            });
          }
          if (code.providerState !== "DELETED") {
            if (!code.providerCode || !code.deepLink) {
              throw serviceError("OPERATION_CONFLICT");
            }
            const providerCode = code.providerCode;
            if (code.providerState === "ACTIVE") {
              code = await stageExistingCodeForReconciliation({ code });
            }
            if (code.providerState !== "RECONCILING") {
              throw serviceError("OPERATION_CONFLICT");
            }
            const listed = await provider.listWhatsAppChatQrs({
              phoneNumberId,
              accessToken,
              ...client,
            });
            if (listed.some(item => item.code === providerCode)) {
              await provider.deleteWhatsAppChatQr({
                phoneNumberId,
                accessToken,
                code: providerCode,
                ...client,
              });
            }
          }
          return finalizeDeletion({
            store,
            lease,
            entryPoint,
            code,
          });
        }
        case "MOVE":
        case "SET_ROUTING":
        case "RECONCILE":
          throw serviceError("OPERATION_CONFLICT");
        default: {
          const _exhaustive: never = operation.kind;
          return _exhaustive;
        }
      }
    } catch (error) {
      if (error instanceof WhatsAppChatQrProviderError) {
        return keepOriginalOperationReconcileRequired({
          store,
          lease,
          entryPointId,
          providerCodeEvidence: operation.providerCodeEvidence,
          error,
        });
      }
      try {
        await store.releaseWhatsAppQrOperationLease({ lease });
      } catch {
        // The original conflict remains authoritative; the lease is bounded.
      }
      throw error;
    }
  } catch (error) {
    mapStoreError(error);
  }
}

export type CheckWhatsAppQrProviderStateParams = {
  workspaceId: string;
  entryPointId: string;
  sourceId: string;
  accessToken: string;
  phoneNumberId: string;
  expectedEntryPointVersion: number;
  expectedCodeVersion: number;
  idempotencyKey: string;
  client?: WhatsAppGraphClient;
  provider?: Partial<ProviderDeps>;
  store?: Partial<StoreDeps>;
};

type WhatsAppQrProviderDriftCode =
  | "PROVIDER_IDENTITY_DRIFT"
  | "PROVIDER_MESSAGE_DRIFT"
  | "PROVIDER_MISSING";

export async function checkWhatsAppQrProviderState(
  params: CheckWhatsAppQrProviderStateParams
): Promise<WhatsAppQrCommandResult> {
  try {
    await connectDB();
    const { workspaceId, entryPointId, sourceId } = readQrCommandScope(params);
    const accessToken = requiredString(params.accessToken, "Access token");
    const phoneNumberId = requiredString(
      params.phoneNumberId,
      "Phone number id"
    );
    const { expectedEntryPointVersion, expectedCodeVersion, idempotencyKey } =
      readQrCommandGuards(params, true);
    const provider = { ...defaultProvider, ...params.provider };
    const store = { ...defaultStore, ...params.store };

    const { requestDigest, preflight } = await preflightCommand(
      { store, workspaceId, entryPointId, idempotencyKey },
      {
        kind: "SYNC_PROVIDER",
        entryPointId,
        sourceId,
        expectedEntryPointVersion,
        expectedCodeVersion,
      }
    );
    if (preflight) return preflight;

    const entryPoint = await loadEntryPoint({ workspaceId, entryPointId });
    assertEntryPointVersion(entryPoint, expectedEntryPointVersion);
    requireActiveProviderBinding(entryPoint);
    if (
      entryPoint.sourceId !== sourceId ||
      entryPoint.phoneNumberId !== phoneNumberId
    ) {
      throw serviceError("OPERATION_CONFLICT");
    }

    const currentCode = await loadCurrentActiveCode({
      workspaceId,
      entryPointId,
    });
    assertCodeVersion(currentCode, expectedCodeVersion);
    if (
      currentCode.codeId !== entryPoint.currentCodeId ||
      currentCode.sourceId !== sourceId ||
      currentCode.wabaId !== entryPoint.wabaId ||
      currentCode.phoneNumberId !== phoneNumberId ||
      !currentCode.providerCode ||
      !currentCode.deepLink ||
      !currentCode.prefilledMessage
    ) {
      throw serviceError("OPERATION_CONFLICT");
    }

    let providerQr: WhatsAppChatQr | null = null;
    let driftCode: WhatsAppQrProviderDriftCode | null = null;
    try {
      providerQr = await provider.getWhatsAppChatQr({
        phoneNumberId,
        accessToken,
        code: currentCode.providerCode,
        ...(params.client ? { client: params.client } : {}),
      });
    } catch (error) {
      if (
        error instanceof WhatsAppChatQrProviderError &&
        error.evidence.category === "not_found"
      ) {
        driftCode = "PROVIDER_MISSING";
      } else if (
        error instanceof WhatsAppChatQrProviderError &&
        error.evidence.category === "identity_changed"
      ) {
        driftCode = "PROVIDER_IDENTITY_DRIFT";
      } else if (error instanceof WhatsAppChatQrProviderError) {
        throw serviceError("PROVIDER_FAILED", undefined, error.evidence);
      } else {
        throw error;
      }
    }
    if (providerQr) {
      if (
        providerQr.code !== currentCode.providerCode ||
        providerQr.deepLink !== currentCode.deepLink
      ) {
        driftCode = "PROVIDER_IDENTITY_DRIFT";
      } else if (providerQr.prefilledMessage !== currentCode.prefilledMessage) {
        driftCode = "PROVIDER_MESSAGE_DRIFT";
      }
    }

    const session = await Scenario.startSession();
    let result: WhatsAppQrCommandResult | null = null;
    try {
      await session.withTransaction(async () => {
        const entryPointQuery = WhatsAppQrEntryPoint.findOne({
          entryPointId,
          workspaceId,
          version: expectedEntryPointVersion,
          status: "ACTIVE",
          sourceId,
          wabaId: entryPoint.wabaId,
          phoneNumberId,
          currentCodeId: currentCode.codeId,
        });
        entryPointQuery.session(session);
        const currentEntryPoint =
          await entryPointQuery.lean<WhatsAppQrEntryPointRecord | null>();
        if (!currentEntryPoint) throw serviceError("VERSION_CONFLICT");

        const codeQuery = WhatsAppQrCode.findOne({
          codeId: currentCode.codeId,
          workspaceId,
          entryPointId,
          sourceId,
          wabaId: entryPoint.wabaId,
          phoneNumberId,
          version: expectedCodeVersion,
          placementBindingState: "CURRENT",
          providerState: "ACTIVE",
          providerCode: currentCode.providerCode,
          deepLink: currentCode.deepLink,
          prefilledMessage: currentCode.prefilledMessage,
        });
        codeQuery.session(session);
        const current = await codeQuery.lean<WhatsAppQrCodeRecord | null>();
        if (!current) throw serviceError("VERSION_CONFLICT");

        const reserved = await reserveOrReplay({
          store,
          workspaceId,
          entryPoint: currentEntryPoint,
          sourceId,
          kind: "SYNC_PROVIDER",
          idempotencyKey,
          requestDigest,
          expectedEntryPointVersion,
          codeId: current.codeId,
          currentCodeId: current.codeId,
          expectedCodeVersion,
          session,
        });
        if (!("kind" in reserved)) {
          result = reserved;
          return;
        }

        if (!driftCode) {
          await store.completeWhatsAppQrOperation({
            lease: reserved.lease,
            session,
            result: {
              outcome: "applied",
              status: "COMPLETED",
              codeId: current.codeId,
              entryPointVersion: currentEntryPoint.version,
              codeVersion: current.version,
            },
          });
          result = {
            status: "applied",
            entryPointId,
            codeId: current.codeId,
            entryPointVersion: currentEntryPoint.version,
            codeVersion: current.version,
          };
          return;
        }

        await stageExistingCodeForReconciliation({ code: current, session });
        const operation = await store.markWhatsAppQrReconcileRequired({
          lease: reserved.lease,
          session,
          providerCodeEvidence: current.providerCode,
          sanitizedError: { code: driftCode, retryable: true },
        });
        result = {
          status: "reconcile_required",
          entryPointId,
          operationId: operation.operationId,
        };
      });
    } finally {
      await session.endSession();
    }
    if (!result) throw serviceError("STORAGE_FAILED");
    return result;
  } catch (error) {
    mapStoreError(error);
  }
}

export type ApplyWhatsAppQrMessageParams = {
  workspaceId: string;
  entryPointId: string;
  sourceId: string;
  accessToken: string;
  desiredMessage: string;
  expectedEntryPointVersion: number;
  expectedCodeVersion: number;
  idempotencyKey: string;
  client?: WhatsAppGraphClient;
  provider?: Partial<ProviderDeps>;
  store?: Partial<StoreDeps>;
};

export async function applyWhatsAppQrMessage(
  params: ApplyWhatsAppQrMessageParams
): Promise<WhatsAppQrCommandResult> {
  try {
    await connectDB();
    const { workspaceId, entryPointId, sourceId } = readQrCommandScope(params);
    const accessToken = requiredString(params.accessToken, "Access token");
    const desiredMessage = requiredDesiredMessage(params.desiredMessage);
    const { expectedEntryPointVersion, expectedCodeVersion, idempotencyKey } =
      readQrCommandGuards(params, true);
    const provider = { ...defaultProvider, ...params.provider };
    const store = { ...defaultStore, ...params.store };

    const { requestDigest, preflight } = await preflightCommand(
      { store, workspaceId, entryPointId, idempotencyKey },
      {
        kind: "APPLY_MESSAGE",
        entryPointId,
        sourceId,
        desiredMessage,
        expectedEntryPointVersion,
        expectedCodeVersion,
      }
    );
    if (preflight) return preflight;

    const entryPoint = await loadEntryPoint({ workspaceId, entryPointId });
    assertEntryPointVersion(entryPoint, expectedEntryPointVersion);
    requireActiveProviderBinding(entryPoint);
    if (entryPoint.sourceId !== sourceId) {
      throw serviceError("OPERATION_CONFLICT");
    }

    const currentCode = await loadCurrentActiveCode({
      workspaceId,
      entryPointId,
    });
    if (
      currentCode.codeId !== entryPoint.currentCodeId ||
      currentCode.sourceId !== sourceId
    ) {
      throw serviceError("OPERATION_CONFLICT");
    }
    assertCodeVersion(currentCode, expectedCodeVersion);
    const reserved = await reserveOrReplay({
      store,
      workspaceId,
      entryPoint,
      sourceId,
      kind: "APPLY_MESSAGE",
      idempotencyKey,
      requestDigest,
      expectedEntryPointVersion,
      codeId: currentCode.codeId,
      expectedCodeVersion,
    });
    if (!("kind" in reserved)) return reserved;

    const prefilledMessage = formatWhatsAppQrReferenceMessage(
      desiredMessage,
      currentCode.referenceCode
    );
    const staged = await stageExistingCodeForReconciliation({
      code: currentCode,
      prefilledMessage,
    });
    await store.markWhatsAppQrProviderRequestSent({
      lease: reserved.lease,
      providerCodeEvidence: currentCode.providerCode,
    });

    let updated: WhatsAppChatQr;
    try {
      updated = await provider.updateWhatsAppChatQrMessage({
        phoneNumberId: staged.phoneNumberId,
        accessToken,
        current: {
          code: staged.providerCode!,
          deepLink: staged.deepLink!,
          prefilledMessage: currentCode.prefilledMessage ?? "",
        },
        prefilledMessage,
        ...(params.client ? { client: params.client } : {}),
      });
      if (
        updated.code !== staged.providerCode ||
        updated.deepLink !== staged.deepLink
      ) {
        throw new WhatsAppChatQrProviderError("definite", {
          category: "identity_changed",
        });
      }
    } catch (error) {
      if (error instanceof WhatsAppChatQrProviderError) {
        return handleProviderFailure({
          store,
          lease: reserved.lease,
          entryPointId,
          error,
          entryPointVersion: entryPoint.version,
          providerCodeEvidence: currentCode.providerCode,
          onDefiniteFailure: () =>
            restoreReconciledCode({
              code: staged,
              prefilledMessage: currentCode.prefilledMessage,
            }).then(() => undefined),
        });
      }
      throw error;
    }

    try {
      return await finalizeMessageUpdate({
        store,
        lease: reserved.lease,
        entryPoint,
        code: staged,
        provider: updated,
        desiredMessage,
      });
    } catch {
      return markLocalFinalizationReconcileRequired({
        store,
        lease: reserved.lease,
        entryPointId,
        providerCodeEvidence: currentCode.providerCode,
      });
    }
  } catch (error) {
    mapStoreError(error);
  }
}

export type ReplaceWhatsAppQrCodeParams = {
  workspaceId: string;
  entryPointId: string;
  sourceId: string;
  accessToken: string;
  desiredMessage: string;
  expectedEntryPointVersion: number;
  expectedCodeVersion: number;
  idempotencyKey: string;
  client?: WhatsAppGraphClient;
  provider?: Partial<ProviderDeps>;
  store?: Partial<StoreDeps>;
};

export async function replaceWhatsAppQrCode(
  params: ReplaceWhatsAppQrCodeParams
): Promise<WhatsAppQrCommandResult> {
  try {
    await connectDB();
    const { workspaceId, entryPointId, sourceId } = readQrCommandScope(params);
    const accessToken = requiredString(params.accessToken, "Access token");
    const desiredMessage = requiredDesiredMessage(params.desiredMessage);
    const { expectedEntryPointVersion, expectedCodeVersion, idempotencyKey } =
      readQrCommandGuards(params, true);
    const provider = { ...defaultProvider, ...params.provider };
    const store = { ...defaultStore, ...params.store };

    const { requestDigest, preflight } = await preflightCommand(
      { store, workspaceId, entryPointId, idempotencyKey },
      {
        kind: "REPLACE",
        entryPointId,
        sourceId,
        desiredMessage,
        expectedEntryPointVersion,
        expectedCodeVersion,
      }
    );
    if (preflight) return preflight;

    const entryPoint = await loadEntryPoint({ workspaceId, entryPointId });
    assertEntryPointVersion(entryPoint, expectedEntryPointVersion);
    requireActiveProviderBinding(entryPoint);
    if (entryPoint.sourceId !== sourceId) {
      throw serviceError("OPERATION_CONFLICT");
    }

    const oldCode = await loadCurrentActiveCode({ workspaceId, entryPointId });
    if (
      oldCode.codeId !== entryPoint.currentCodeId ||
      oldCode.sourceId !== sourceId
    ) {
      throw serviceError("OPERATION_CONFLICT");
    }
    assertCodeVersion(oldCode, expectedCodeVersion);
    await requireHistoricalCodeCapacity({ workspaceId, entryPointId });
    const reserved = await reserveOrReplay({
      store,
      workspaceId,
      entryPoint,
      sourceId,
      kind: "REPLACE",
      idempotencyKey,
      requestDigest,
      expectedEntryPointVersion,
      codeId: oldCode.codeId,
      currentCodeId: oldCode.codeId,
      expectedCodeVersion,
    });
    if (!("kind" in reserved)) return reserved;

    const referenceCode = await allocateReference(workspaceId);
    const prefilledMessage = formatWhatsAppQrReferenceMessage(
      desiredMessage,
      referenceCode
    );
    const pending = await createPendingCode({
      workspaceId,
      entryPointId,
      sourceId,
      wabaId: entryPoint.wabaId,
      phoneNumberId: entryPoint.phoneNumberId,
      referenceCode,
      prefilledMessage,
      // Keep unique CURRENT binding on the prior code until Meta succeeds.
      placementBindingState: "HISTORICAL",
    });
    await store.markWhatsAppQrProviderRequestSent({
      lease: reserved.lease,
      providerCodeEvidence: pending.codeId,
    });

    let created: WhatsAppChatQr;
    try {
      created = await provider.createWhatsAppChatQr({
        phoneNumberId: entryPoint.phoneNumberId,
        accessToken,
        prefilledMessage,
        ...(params.client ? { client: params.client } : {}),
      });
    } catch (error) {
      if (error instanceof WhatsAppChatQrProviderError) {
        return handleProviderFailure({
          store,
          lease: reserved.lease,
          entryPointId,
          error,
          entryPointVersion: entryPoint.version,
          providerCodeEvidence: pending.codeId,
          onDefiniteFailure: () =>
            detachPendingCode(pending).then(() => undefined),
        });
      }
      throw error;
    }

    try {
      return await finalizeReplacement({
        store,
        lease: reserved.lease,
        entryPoint,
        oldCode,
        pendingCode: pending,
        provider: created,
        desiredMessage,
      });
    } catch {
      return markLocalFinalizationReconcileRequired({
        store,
        lease: reserved.lease,
        entryPointId,
        providerCodeEvidence: pending.codeId,
      });
    }
  } catch (error) {
    mapStoreError(error);
  }
}

export type SetWhatsAppQrCodeRoutingParams = {
  workspaceId: string;
  entryPointId: string;
  sourceId: string;
  codeId: string;
  routingState: "ENABLED" | "DISABLED";
  expectedEntryPointVersion: number;
  expectedCodeVersion: number;
  idempotencyKey: string;
  store?: Partial<StoreDeps>;
};

export async function setWhatsAppQrCodeRouting(
  params: SetWhatsAppQrCodeRoutingParams
): Promise<WhatsAppQrCommandResult> {
  try {
    await connectDB();
    const { workspaceId, entryPointId, sourceId } = readQrCommandScope(params);
    const codeId = requiredString(params.codeId, "Code id");
    if (
      params.routingState !== "ENABLED" &&
      params.routingState !== "DISABLED"
    ) {
      throw serviceError("INVALID_INPUT", "Routing state is invalid");
    }
    const { expectedEntryPointVersion, expectedCodeVersion, idempotencyKey } =
      readQrCommandGuards(params, true);
    const store = { ...defaultStore, ...params.store };

    const { requestDigest, preflight } = await preflightCommand(
      { store, workspaceId, entryPointId, idempotencyKey },
      {
        kind: "SET_ROUTING",
        entryPointId,
        sourceId,
        codeId,
        routingState: params.routingState,
        expectedEntryPointVersion,
        expectedCodeVersion,
      }
    );
    if (preflight) return preflight;

    const entryPoint = await loadEntryPoint({ workspaceId, entryPointId });
    assertEntryPointVersion(entryPoint, expectedEntryPointVersion);
    requireActiveProviderBinding(entryPoint);
    if (entryPoint.sourceId !== sourceId) {
      throw serviceError("OPERATION_CONFLICT");
    }

    const code = await WhatsAppQrCode.findOne({
      workspaceId,
      entryPointId,
      codeId,
    }).lean<WhatsAppQrCodeRecord | null>();
    if (!code) throw serviceError("NOT_FOUND", "Code not found");
    if (
      code.sourceId !== sourceId ||
      code.wabaId !== entryPoint.wabaId ||
      code.phoneNumberId !== entryPoint.phoneNumberId ||
      !isCurrentOrHistoricalPlacementBinding({ entryPoint, code }) ||
      code.providerState !== "ACTIVE" ||
      !code.providerCode?.trim() ||
      !code.deepLink?.trim()
    ) {
      throw serviceError("OPERATION_CONFLICT");
    }
    assertCodeVersion(code, expectedCodeVersion);
    const reserved = await reserveOrReplay({
      store,
      workspaceId,
      entryPoint,
      sourceId,
      kind: "SET_ROUTING",
      idempotencyKey,
      requestDigest,
      expectedEntryPointVersion,
      codeId,
      expectedCodeVersion,
    });
    if (!("kind" in reserved)) return reserved;

    const updated = await WhatsAppQrCode.findOneAndUpdate(
      {
        codeId,
        workspaceId,
        version: code.version,
        sourceId,
        wabaId: entryPoint.wabaId,
        phoneNumberId: entryPoint.phoneNumberId,
        placementBindingState: code.placementBindingState,
        providerState: "ACTIVE",
        providerCode: code.providerCode,
        deepLink: code.deepLink,
      },
      {
        $set: { routingState: params.routingState },
        $inc: { version: 1 },
      },
      { new: true, runValidators: true }
    ).lean<WhatsAppQrCodeRecord | null>();
    if (!updated) throw serviceError("VERSION_CONFLICT");

    await store.completeWhatsAppQrOperation({
      lease: reserved.lease,
      result: {
        outcome: "applied",
        status: "COMPLETED",
        codeId: updated.codeId,
        entryPointVersion: entryPoint.version,
        codeVersion: updated.version,
      },
    });
    return {
      status: "applied",
      entryPointId,
      codeId: updated.codeId,
      entryPointVersion: entryPoint.version,
      codeVersion: updated.version,
    };
  } catch (error) {
    mapStoreError(error);
  }
}

export type DeleteWhatsAppQrCodeFromProviderParams = {
  workspaceId: string;
  entryPointId: string;
  sourceId: string;
  phoneNumberId: string;
  codeId: string;
  accessToken: string;
  expectedEntryPointVersion: number;
  expectedCodeVersion: number;
  confirmed: boolean;
  idempotencyKey: string;
  client?: WhatsAppGraphClient;
  provider?: Partial<ProviderDeps>;
  store?: Partial<StoreDeps>;
};

export async function deleteWhatsAppQrCodeFromProvider(
  params: DeleteWhatsAppQrCodeFromProviderParams
): Promise<WhatsAppQrCommandResult> {
  try {
    await connectDB();
    if (params.confirmed !== true) {
      throw serviceError("INVALID_INPUT", "Delete confirmation is required");
    }
    const { workspaceId, entryPointId, sourceId } = readQrCommandScope(params);
    const phoneNumberId = requiredString(
      params.phoneNumberId,
      "Phone number id"
    );
    const codeId = requiredString(params.codeId, "Code id");
    const accessToken = requiredString(params.accessToken, "Access token");
    const { expectedEntryPointVersion, expectedCodeVersion, idempotencyKey } =
      readQrCommandGuards(params, true);
    const provider = { ...defaultProvider, ...params.provider };
    const store = { ...defaultStore, ...params.store };

    const { requestDigest, preflight } = await preflightCommand(
      { store, workspaceId, entryPointId, idempotencyKey },
      {
        kind: "DELETE",
        entryPointId,
        sourceId,
        phoneNumberId,
        codeId,
        confirmed: true,
        expectedEntryPointVersion,
        expectedCodeVersion,
      }
    );
    if (preflight) return preflight;

    let preparation = await recoverDeletePreparation({
      store,
      workspaceId,
      entryPointId,
      sourceId,
      phoneNumberId,
      codeId,
      requestDigest,
      expectedEntryPointVersion,
      expectedCodeVersion,
    });
    if (!preparation) {
      const entryPoint = await loadEntryPoint({ workspaceId, entryPointId });
      assertEntryPointVersion(entryPoint, expectedEntryPointVersion);
      requireActiveProviderBinding(entryPoint);
      if (
        entryPoint.sourceId !== sourceId ||
        entryPoint.phoneNumberId !== phoneNumberId
      ) {
        throw serviceError("OPERATION_CONFLICT");
      }
      await assertDeleteScenarioAssignmentInactive({ entryPoint });

      const code = await WhatsAppQrCode.findOne({
        workspaceId,
        entryPointId,
        codeId,
      }).lean<WhatsAppQrCodeRecord | null>();
      if (!code?.providerCode?.trim() || !code.deepLink?.trim()) {
        throw serviceError("NOT_FOUND", "Code not found");
      }
      if (
        code.sourceId !== sourceId ||
        code.wabaId !== entryPoint.wabaId ||
        code.phoneNumberId !== phoneNumberId ||
        !isCurrentOrHistoricalPlacementBinding({ entryPoint, code }) ||
        (code.providerState !== "ACTIVE" &&
          code.providerState !== "RECONCILING")
      ) {
        throw serviceError("OPERATION_CONFLICT");
      }
      assertCodeVersion(code, expectedCodeVersion);
      if (code.placementBindingState === "CURRENT") {
        await requireNoManageableHistoricalCodes({
          workspaceId,
          entryPointId,
        });
      }
      preparation = await prepareDeleteForProvider({
        store,
        workspaceId,
        entryPoint,
        code,
        sourceId,
        idempotencyKey,
        requestDigest,
        expectedEntryPointVersion,
        expectedCodeVersion,
      });
    }
    if (preparation.kind === "command") return preparation.result;
    if (preparation.kind === "failed") {
      throw serviceError(preparation.code, preparation.message);
    }
    await store.markWhatsAppQrProviderRequestSent({
      lease: preparation.lease,
      providerCodeEvidence: preparation.code.providerCode,
    });

    try {
      await provider.deleteWhatsAppChatQr({
        phoneNumberId: preparation.code.phoneNumberId,
        accessToken,
        code: preparation.code.providerCode!,
        ...(params.client ? { client: params.client } : {}),
      });
    } catch (error) {
      if (error instanceof WhatsAppChatQrProviderError) {
        return handleProviderFailure({
          store,
          lease: preparation.lease,
          entryPointId,
          error,
          entryPointVersion: preparation.entryPoint.version,
          providerCodeEvidence: preparation.code.providerCode,
          onDefiniteFailure: () =>
            restoreReconciledCode({
              code: preparation.code,
              prefilledMessage: preparation.code.prefilledMessage,
            }).then(() => undefined),
        });
      }
      throw error;
    }

    try {
      return await finalizeDeletion({
        store,
        lease: preparation.lease,
        entryPoint: preparation.entryPoint,
        code: preparation.code,
      });
    } catch {
      return markLocalFinalizationReconcileRequired({
        store,
        lease: preparation.lease,
        entryPointId,
        providerCodeEvidence: preparation.code.providerCode,
      });
    }
  } catch (error) {
    mapStoreError(error);
  }
}
