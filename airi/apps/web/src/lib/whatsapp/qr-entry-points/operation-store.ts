import "server-only";

import { createHash, randomUUID } from "node:crypto";

import {
  CanonicalJsonSerializationError,
  serializeCanonicalJson,
} from "@icecore/shared/lib/canonical-json";
import type { ClientSession } from "mongoose";

import connectDB from "@/lib/mongoose";
import {
  WhatsAppQrOperation,
  type WhatsAppQrOperationRecord,
} from "@/models/whatsapp-qr-operation";
import { requireNonEmptyString } from "@icecore/shared/lib/value-utils";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";

import {
  WHATSAPP_QR_OPERATION_LEASE_MS,
  WHATSAPP_QR_OPERATION_TERMINAL_TTL_MS,
  WhatsAppQrStoreError,
  type AcquireWhatsAppQrReconciliationResult,
  type LookupWhatsAppQrOperationResult,
  type ReserveWhatsAppQrOperationResult,
  type WhatsAppQrCommandKind,
  type WhatsAppQrOperationLease,
  type WhatsAppQrSanitizedError,
  type WhatsAppQrStoreErrorCode,
  type WhatsAppQrTerminalResult,
} from "./contract";

type ActiveStatus = "RUNNING" | "RECONCILE_REQUIRED";

function storeError(
  code: WhatsAppQrStoreErrorCode,
  message: string
): WhatsAppQrStoreError {
  return new WhatsAppQrStoreError(code, message);
}

const requiredString = (value: unknown, label: string) =>
  requireNonEmptyString(value, label, message =>
    storeError("INVALID_INPUT", message)
  );

function requiredNonNegativeInt(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw storeError("INVALID_INPUT", `${label} is invalid`);
  }
  return value as number;
}

function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

function isActiveStatus(status: unknown): status is ActiveStatus {
  return status === "RUNNING" || status === "RECONCILE_REQUIRED";
}

function isTerminalStatus(status: unknown): status is "COMPLETED" | "FAILED" {
  return status === "COMPLETED" || status === "FAILED";
}

function requireTerminalResult(
  operation: WhatsAppQrOperationRecord
): WhatsAppQrTerminalResult {
  const result = operation.cachedTerminalResult;
  if (
    !result ||
    (operation.status === "COMPLETED" &&
      (result.outcome !== "applied" || result.status !== "COMPLETED")) ||
    (operation.status === "FAILED" &&
      (result.outcome !== "failed" || result.status !== "FAILED"))
  ) {
    throw storeError(
      "STORAGE_FAILED",
      "QR operation terminal cache is incomplete"
    );
  }
  return result;
}

function hasLiveLease(
  operation: WhatsAppQrOperationRecord,
  now: Date
): boolean {
  return Boolean(
    operation.lease?.ownerToken &&
      operation.lease.expiresAt instanceof Date &&
      operation.lease.expiresAt.getTime() > now.getTime()
  );
}

export function isWhatsAppQrOperationLeaseLive(
  operation: WhatsAppQrOperationRecord,
  now = new Date()
): boolean {
  return hasLiveLease(operation, now);
}

function toLease(
  operation: WhatsAppQrOperationRecord,
  ownerToken: string
): WhatsAppQrOperationLease {
  if (
    operation.lease.ownerToken !== ownerToken ||
    !(operation.lease.expiresAt instanceof Date) ||
    !Number.isSafeInteger(operation.lease.fence) ||
    operation.lease.fence < 1
  ) {
    throw storeError("STORAGE_FAILED", "QR operation lease is incomplete");
  }
  return {
    operationId: operation.operationId,
    workspaceId: operation.workspaceId,
    entryPointId: operation.entryPointId,
    ownerToken,
    fence: operation.lease.fence,
    expiresAt: operation.lease.expiresAt,
  };
}

function leaseIdentityFilter(
  lease: WhatsAppQrOperationLease,
  now: Date
): Record<string, unknown> {
  return {
    operationId: lease.operationId,
    workspaceId: lease.workspaceId,
    entryPointId: lease.entryPointId,
    "lease.ownerToken": lease.ownerToken,
    "lease.fence": lease.fence,
    "lease.expiresAt": { $gt: now },
  };
}

function liveLeaseFilter(
  lease: WhatsAppQrOperationLease,
  status: ActiveStatus,
  now: Date
): Record<string, unknown> {
  return {
    ...leaseIdentityFilter(lease, now),
    status,
  };
}

function ownerAcquireFilter(
  operation: WhatsAppQrOperationRecord,
  ownerToken: string,
  now: Date
): Record<string, unknown> {
  if (!operation.lease.ownerToken) {
    return { "lease.ownerToken": { $exists: false } };
  }
  if (operation.lease.ownerToken === ownerToken) {
    return { "lease.ownerToken": ownerToken };
  }
  return {
    "lease.ownerToken": operation.lease.ownerToken,
    "lease.expiresAt": { $lte: now },
  };
}

export function hashWhatsAppQrIdempotencyKey(params: {
  workspaceId: string;
  entryPointId: string;
  kind: WhatsAppQrCommandKind;
  idempotencyKey: string;
}): string {
  try {
    return sha256Hex(
      serializeCanonicalJson({
        workspaceId: requiredString(params.workspaceId, "Workspace id"),
        entryPointId: requiredString(params.entryPointId, "Entry point id"),
        kind: params.kind,
        idempotencyKey: requiredString(
          params.idempotencyKey,
          "Idempotency key"
        ),
      })
    );
  } catch (error) {
    if (error instanceof WhatsAppQrStoreError) throw error;
    if (error instanceof CanonicalJsonSerializationError) {
      throw storeError("INVALID_INPUT", "Idempotency key payload is invalid");
    }
    throw error;
  }
}

export function hashWhatsAppQrRequestDigest(canonicalRequest: unknown): string {
  try {
    return sha256Hex(serializeCanonicalJson(canonicalRequest));
  } catch (error) {
    if (error instanceof CanonicalJsonSerializationError) {
      throw storeError("INVALID_INPUT", "Request digest payload is invalid");
    }
    throw error;
  }
}

export async function hasActiveWhatsAppQrDeleteOperation(params: {
  workspaceId: string;
  entryPointId: string;
  session?: ClientSession;
}): Promise<boolean> {
  const workspaceId = requiredString(params.workspaceId, "Workspace id");
  const entryPointId = requiredString(params.entryPointId, "Entry point id");
  await connectDB();
  const query = WhatsAppQrOperation.exists({
    workspaceId,
    entryPointId,
    kind: "DELETE",
    status: { $in: ["RUNNING", "RECONCILE_REQUIRED"] },
  });
  if (params.session) query.session(params.session);
  return Boolean(await query);
}

async function findLiveLeasedOperation(
  lease: WhatsAppQrOperationLease,
  now: Date,
  session?: ClientSession
): Promise<WhatsAppQrOperationRecord | null> {
  const query = WhatsAppQrOperation.findOne({
    ...leaseIdentityFilter(lease, now),
    status: { $in: ["RUNNING", "RECONCILE_REQUIRED"] },
  });
  if (session) query.session(session);
  return query.lean<WhatsAppQrOperationRecord | null>();
}

async function acquireLeaseOnOperation(params: {
  operation: WhatsAppQrOperationRecord;
  ownerToken: string;
  now: Date;
  session?: ClientSession;
}): Promise<{
  operation: WhatsAppQrOperationRecord;
  lease: WhatsAppQrOperationLease;
}> {
  const { operation, ownerToken, now } = params;
  if (!isActiveStatus(operation.status)) {
    throw storeError("OPERATION_CONFLICT", "QR operation is not leaseable");
  }
  if (
    hasLiveLease(operation, now) &&
    operation.lease.ownerToken !== ownerToken
  ) {
    throw storeError("OPERATION_BUSY", "QR operation is busy");
  }

  const expiresAt = new Date(now.getTime() + WHATSAPP_QR_OPERATION_LEASE_MS);
  const acquired = await WhatsAppQrOperation.findOneAndUpdate(
    {
      operationId: operation.operationId,
      workspaceId: operation.workspaceId,
      entryPointId: operation.entryPointId,
      status: operation.status,
      "lease.fence": operation.lease.fence,
      ...ownerAcquireFilter(operation, ownerToken, now),
    },
    {
      $set: {
        "lease.ownerToken": ownerToken,
        "lease.expiresAt": expiresAt,
      },
      $inc: { "lease.fence": 1 },
    },
    {
      new: true,
      runValidators: true,
      ...(params.session ? { session: params.session } : {}),
    }
  ).lean<WhatsAppQrOperationRecord | null>();

  if (
    !acquired ||
    acquired.lease.ownerToken !== ownerToken ||
    !acquired.lease.expiresAt ||
    acquired.lease.fence !== operation.lease.fence + 1
  ) {
    throw storeError("OPERATION_BUSY", "QR operation is busy");
  }

  return {
    operation: acquired,
    lease: toLease(acquired, ownerToken),
  };
}

export async function lookupWhatsAppQrOperation(params: {
  workspaceId: string;
  entryPointId: string;
  kind: WhatsAppQrCommandKind;
  idempotencyKey: string;
  requestDigest: string;
  now?: Date;
}): Promise<LookupWhatsAppQrOperationResult> {
  const workspaceId = requiredString(params.workspaceId, "Workspace id");
  const entryPointId = requiredString(params.entryPointId, "Entry point id");
  const requestDigest = requiredString(params.requestDigest, "Request digest");
  if (!/^[a-f0-9]{64}$/.test(requestDigest)) {
    throw storeError("INVALID_INPUT", "Request digest is invalid");
  }
  const operationKeyHash = hashWhatsAppQrIdempotencyKey({
    workspaceId,
    entryPointId,
    kind: params.kind,
    idempotencyKey: requiredString(params.idempotencyKey, "Idempotency key"),
  });
  const now = params.now ?? new Date();

  await connectDB();
  const operation = await WhatsAppQrOperation.findOne({
    workspaceId,
    operationKeyHash,
  }).lean<WhatsAppQrOperationRecord | null>();
  if (!operation) return { kind: "miss" };
  if (operation.entryPointId !== entryPointId) {
    throw storeError("OPERATION_CONFLICT", "QR operation resource conflicts");
  }
  if (operation.requestDigest !== requestDigest) {
    throw storeError(
      "OPERATION_CONFLICT",
      "QR operation request digest conflicts"
    );
  }
  if (isTerminalStatus(operation.status)) {
    return {
      kind: "replay",
      operation,
      result: requireTerminalResult(operation),
    };
  }
  if (!isActiveStatus(operation.status)) {
    throw storeError("OPERATION_CONFLICT", "QR operation state is invalid");
  }
  if (
    operation.status === "RECONCILE_REQUIRED" ||
    hasLiveLease(operation, now)
  ) {
    return { kind: "busy", operation };
  }
  return { kind: "miss" };
}

export type RecoverWhatsAppQrDeleteOperationResult =
  | { kind: "miss" }
  | { kind: "busy"; operation: WhatsAppQrOperationRecord }
  | { kind: "reconcile_required"; operation: WhatsAppQrOperationRecord }
  | {
      kind: "acquired";
      operation: WhatsAppQrOperationRecord;
      lease: WhatsAppQrOperationLease;
    };

/**
 * Reacquires the single active DELETE for a semantically identical request.
 * The request digest deliberately survives a fresh client idempotency key so
 * a process crash cannot leave a prepared resource permanently unreachable.
 */
export async function recoverWhatsAppQrDeleteOperation(params: {
  workspaceId: string;
  entryPointId: string;
  sourceId: string;
  codeId: string;
  requestDigest: string;
  expectedEntryPointVersion: number;
  expectedCodeVersion: number;
  ownerToken?: string;
  now?: Date;
}): Promise<RecoverWhatsAppQrDeleteOperationResult> {
  const workspaceId = requiredString(params.workspaceId, "Workspace id");
  const entryPointId = requiredString(params.entryPointId, "Entry point id");
  const sourceId = requiredString(params.sourceId, "Source id");
  const codeId = requiredString(params.codeId, "Code id");
  const requestDigest = requiredString(params.requestDigest, "Request digest");
  if (!/^[a-f0-9]{64}$/.test(requestDigest)) {
    throw storeError("INVALID_INPUT", "Request digest is invalid");
  }
  const expectedEntryPointVersion = requiredNonNegativeInt(
    params.expectedEntryPointVersion,
    "Expected entry-point version"
  );
  const expectedCodeVersion = requiredNonNegativeInt(
    params.expectedCodeVersion,
    "Expected code version"
  );
  const ownerToken = requiredString(
    params.ownerToken ?? randomUUID(),
    "Lease owner token"
  );
  const now = params.now ?? new Date();

  await connectDB();
  const current = await WhatsAppQrOperation.findOne({
    workspaceId,
    entryPointId,
    status: { $in: ["RUNNING", "RECONCILE_REQUIRED"] },
  }).lean<WhatsAppQrOperationRecord | null>();
  if (!current) return { kind: "miss" };
  if (
    current.kind !== "DELETE" ||
    current.requestDigest !== requestDigest ||
    current.sourceId !== sourceId ||
    current.codeId !== codeId ||
    current.expectedEntryPointVersion !== expectedEntryPointVersion ||
    current.expectedCodeVersion !== expectedCodeVersion
  ) {
    return { kind: "busy", operation: current };
  }
  if (current.status === "RECONCILE_REQUIRED") {
    return { kind: "reconcile_required", operation: current };
  }
  if (hasLiveLease(current, now)) {
    return { kind: "busy", operation: current };
  }

  try {
    const acquired = await acquireLeaseOnOperation({
      operation: current,
      ownerToken,
      now,
    });
    return { kind: "acquired", ...acquired };
  } catch (error) {
    if (
      error instanceof WhatsAppQrStoreError &&
      error.code === "OPERATION_BUSY"
    ) {
      const latest = await WhatsAppQrOperation.findOne({
        operationId: current.operationId,
        workspaceId,
        entryPointId,
      }).lean<WhatsAppQrOperationRecord | null>();
      if (latest?.status === "RECONCILE_REQUIRED") {
        return { kind: "reconcile_required", operation: latest };
      }
      if (latest?.status === "RUNNING") {
        return { kind: "busy", operation: latest };
      }
    }
    throw error;
  }
}

export async function reserveWhatsAppQrOperation(params: {
  workspaceId: string;
  entryPointId: string;
  sourceId: string;
  kind: WhatsAppQrCommandKind;
  idempotencyKey: string;
  requestDigest: string;
  expectedEntryPointVersion: number;
  codeId?: string;
  currentCodeId?: string;
  expectedCodeVersion?: number;
  ownerToken?: string;
  now?: Date;
  session?: ClientSession;
}): Promise<ReserveWhatsAppQrOperationResult> {
  const workspaceId = requiredString(params.workspaceId, "Workspace id");
  const entryPointId = requiredString(params.entryPointId, "Entry point id");
  const sourceId = requiredString(params.sourceId, "Source id");
  const idempotencyKey = requiredString(
    params.idempotencyKey,
    "Idempotency key"
  );
  const requestDigest = requiredString(params.requestDigest, "Request digest");
  if (!/^[a-f0-9]{64}$/.test(requestDigest)) {
    throw storeError("INVALID_INPUT", "Request digest is invalid");
  }
  const expectedEntryPointVersion = requiredNonNegativeInt(
    params.expectedEntryPointVersion,
    "Expected entry-point version"
  );
  const kind = params.kind;
  const ownerToken = requiredString(
    params.ownerToken ?? randomUUID(),
    "Lease owner token"
  );
  const now = params.now ?? new Date();
  const operationKeyHash = hashWhatsAppQrIdempotencyKey({
    workspaceId,
    entryPointId,
    kind,
    idempotencyKey,
  });
  const operationId = randomUUID();

  const insert: Omit<
    WhatsAppQrOperationRecord,
    | "createdAt"
    | "updatedAt"
    | "codeId"
    | "currentCodeId"
    | "expectedCodeVersion"
  > & {
    codeId?: string;
    currentCodeId?: string;
    expectedCodeVersion?: number;
  } = {
    operationId,
    workspaceId,
    entryPointId,
    sourceId,
    operationKeyHash,
    requestDigest,
    kind,
    expectedEntryPointVersion,
    status: "RUNNING",
    providerStage: "NOT_STARTED",
    lease: { fence: 0 },
    ...(params.codeId !== undefined
      ? { codeId: requiredString(params.codeId, "Code id") }
      : {}),
    ...(params.currentCodeId !== undefined
      ? {
          currentCodeId: requiredString(
            params.currentCodeId,
            "Current code id"
          ),
        }
      : {}),
    ...(params.expectedCodeVersion !== undefined
      ? {
          expectedCodeVersion: requiredNonNegativeInt(
            params.expectedCodeVersion,
            "Expected code version"
          ),
        }
      : {}),
  };

  await connectDB();

  let reserved: WhatsAppQrOperationRecord | null;
  let isNew: boolean;
  try {
    const result = await WhatsAppQrOperation.findOneAndUpdate(
      { workspaceId, operationKeyHash },
      { $setOnInsert: insert },
      {
        upsert: true,
        new: true,
        runValidators: true,
        setDefaultsOnInsert: false,
        includeResultMetadata: true,
        lean: true,
        ...(params.session ? { session: params.session } : {}),
      }
    );
    reserved =
      (result?.value as WhatsAppQrOperationRecord | null | undefined) ?? null;
    isNew = result?.lastErrorObject?.updatedExisting !== true;
  } catch (error) {
    if (isMongoDuplicateKeyError(error)) {
      throw storeError("OPERATION_BUSY", "QR operation is busy");
    }
    throw error;
  }

  if (!reserved) {
    throw storeError("STORAGE_FAILED", "QR operation could not be reserved");
  }

  if (reserved.requestDigest !== requestDigest) {
    throw storeError(
      "OPERATION_CONFLICT",
      "QR operation request digest conflicts"
    );
  }

  if (isTerminalStatus(reserved.status)) {
    return {
      kind: "replay",
      operation: reserved,
      result: requireTerminalResult(reserved),
    };
  }

  if (!isActiveStatus(reserved.status)) {
    throw storeError("OPERATION_CONFLICT", "QR operation state is invalid");
  }

  if (hasLiveLease(reserved, now) && reserved.lease.ownerToken !== ownerToken) {
    return { kind: "busy", operation: reserved };
  }

  try {
    const acquired = await acquireLeaseOnOperation({
      operation: reserved,
      ownerToken,
      now,
      ...(params.session ? { session: params.session } : {}),
    });
    return {
      kind: "acquired",
      operation: acquired.operation,
      lease: acquired.lease,
      isNew,
    };
  } catch (error) {
    if (
      error instanceof WhatsAppQrStoreError &&
      error.code === "OPERATION_BUSY"
    ) {
      const currentQuery = WhatsAppQrOperation.findOne({
        operationId: reserved.operationId,
        workspaceId,
        entryPointId,
      });
      if (params.session) currentQuery.session(params.session);
      const current =
        await currentQuery.lean<WhatsAppQrOperationRecord | null>();
      if (current && isActiveStatus(current.status)) {
        return { kind: "busy", operation: current };
      }
    }
    throw error;
  }
}

export async function acquireWhatsAppQrOperationLease(params: {
  operationId: string;
  workspaceId: string;
  entryPointId: string;
  ownerToken?: string;
  now?: Date;
}): Promise<{
  operation: WhatsAppQrOperationRecord;
  lease: WhatsAppQrOperationLease;
}> {
  const operationId = requiredString(params.operationId, "Operation id");
  const workspaceId = requiredString(params.workspaceId, "Workspace id");
  const entryPointId = requiredString(params.entryPointId, "Entry point id");
  const ownerToken = requiredString(
    params.ownerToken ?? randomUUID(),
    "Lease owner token"
  );
  const now = params.now ?? new Date();
  await connectDB();

  const current = await WhatsAppQrOperation.findOne({
    operationId,
    workspaceId,
    entryPointId,
  }).lean<WhatsAppQrOperationRecord | null>();
  if (!current || !isActiveStatus(current.status)) {
    throw storeError("OPERATION_CONFLICT", "QR operation is not leaseable");
  }

  return acquireLeaseOnOperation({
    operation: current,
    ownerToken,
    now,
  });
}

export async function acquireWhatsAppQrReconciliationOperation(params: {
  operationId: string;
  workspaceId: string;
  entryPointId: string;
  ownerToken?: string;
  now?: Date;
}): Promise<AcquireWhatsAppQrReconciliationResult> {
  const operationId = requiredString(params.operationId, "Operation id");
  const workspaceId = requiredString(params.workspaceId, "Workspace id");
  const entryPointId = requiredString(params.entryPointId, "Entry point id");
  const ownerToken = requiredString(
    params.ownerToken ?? randomUUID(),
    "Lease owner token"
  );
  const now = params.now ?? new Date();
  await connectDB();

  const current = await WhatsAppQrOperation.findOne({
    operationId,
    workspaceId,
    entryPointId,
  }).lean<WhatsAppQrOperationRecord | null>();
  const recoverableExpiredDelete = Boolean(
    current?.status === "RUNNING" &&
      current.kind === "DELETE" &&
      !hasLiveLease(current, now)
  );
  if (
    !current ||
    (current.status !== "RECONCILE_REQUIRED" && !recoverableExpiredDelete)
  ) {
    throw storeError(
      "OPERATION_CONFLICT",
      "QR operation is not awaiting reconciliation"
    );
  }
  if (hasLiveLease(current, now) && current.lease.ownerToken !== ownerToken) {
    return { kind: "busy", operation: current };
  }

  try {
    const acquired = await acquireLeaseOnOperation({
      operation: current,
      ownerToken,
      now,
    });
    return { kind: "acquired", ...acquired };
  } catch (error) {
    if (
      error instanceof WhatsAppQrStoreError &&
      error.code === "OPERATION_BUSY"
    ) {
      const latest = await WhatsAppQrOperation.findOne({
        operationId,
        workspaceId,
        entryPointId,
      }).lean<WhatsAppQrOperationRecord | null>();
      if (
        latest?.status === "RECONCILE_REQUIRED" ||
        (latest?.status === "RUNNING" && latest.kind === "DELETE")
      ) {
        return { kind: "busy", operation: latest };
      }
    }
    throw error;
  }
}

export async function renewWhatsAppQrOperationLease(params: {
  lease: WhatsAppQrOperationLease;
  now?: Date;
}): Promise<WhatsAppQrOperationLease> {
  const now = params.now ?? new Date();
  const expiresAt = new Date(now.getTime() + WHATSAPP_QR_OPERATION_LEASE_MS);
  const current = await findLiveLeasedOperation(params.lease, now);
  if (!current || !isActiveStatus(current.status)) {
    throw storeError("OPERATION_CONFLICT", "QR operation lease was lost");
  }

  const renewed = await WhatsAppQrOperation.findOneAndUpdate(
    liveLeaseFilter(params.lease, current.status, now),
    { $set: { "lease.expiresAt": expiresAt } },
    { new: true, runValidators: true }
  ).lean<WhatsAppQrOperationRecord | null>();

  if (
    !renewed ||
    renewed.lease.ownerToken !== params.lease.ownerToken ||
    renewed.lease.fence !== params.lease.fence ||
    !renewed.lease.expiresAt
  ) {
    throw storeError("OPERATION_CONFLICT", "QR operation lease was lost");
  }

  return {
    ...params.lease,
    expiresAt: renewed.lease.expiresAt,
  };
}

export async function releaseWhatsAppQrOperationLease(params: {
  lease: WhatsAppQrOperationLease;
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  const current = await findLiveLeasedOperation(params.lease, now);
  if (!current || !isActiveStatus(current.status)) {
    throw storeError("OPERATION_CONFLICT", "QR operation lease was lost");
  }
  const released = await WhatsAppQrOperation.findOneAndUpdate(
    liveLeaseFilter(params.lease, current.status, now),
    {
      $unset: {
        "lease.ownerToken": 1,
        "lease.expiresAt": 1,
      },
    },
    { new: true, runValidators: true }
  ).lean<WhatsAppQrOperationRecord | null>();
  if (
    !released ||
    released.lease.ownerToken !== undefined ||
    released.lease.expiresAt !== undefined ||
    released.lease.fence !== params.lease.fence
  ) {
    throw storeError("OPERATION_CONFLICT", "QR operation lease was lost");
  }
}

export async function markWhatsAppQrProviderRequestSent(params: {
  lease: WhatsAppQrOperationLease;
  providerCodeEvidence?: string;
  now?: Date;
}): Promise<WhatsAppQrOperationRecord> {
  const now = params.now ?? new Date();
  const current = await findLiveLeasedOperation(params.lease, now);
  if (!current || !isActiveStatus(current.status)) {
    throw storeError("OPERATION_CONFLICT", "QR operation lease was lost");
  }

  const providerCodeEvidence =
    params.providerCodeEvidence !== undefined
      ? requiredString(
          params.providerCodeEvidence,
          "Provider code evidence"
        ).slice(0, 256)
      : undefined;

  const updated = await WhatsAppQrOperation.findOneAndUpdate(
    liveLeaseFilter(params.lease, current.status, now),
    {
      $set: {
        providerStage: "REQUEST_SENT",
        attemptedAt: now,
        ...(providerCodeEvidence ? { providerCodeEvidence } : {}),
      },
    },
    { new: true, runValidators: true }
  ).lean<WhatsAppQrOperationRecord | null>();

  if (!updated) {
    throw storeError("OPERATION_CONFLICT", "QR operation lease was lost");
  }
  return updated;
}

export async function markWhatsAppQrReconcileRequired(params: {
  lease: WhatsAppQrOperationLease;
  sanitizedError?: WhatsAppQrSanitizedError;
  providerCodeEvidence?: string;
  now?: Date;
  session?: ClientSession;
}): Promise<WhatsAppQrOperationRecord> {
  const now = params.now ?? new Date();
  const current = await findLiveLeasedOperation(
    params.lease,
    now,
    params.session
  );
  if (!current || !isActiveStatus(current.status)) {
    throw storeError("OPERATION_CONFLICT", "QR operation lease was lost");
  }

  const sanitizedError = params.sanitizedError
    ? {
        code: requiredString(params.sanitizedError.code, "Error code").slice(
          0,
          128
        ),
        retryable: Boolean(params.sanitizedError.retryable),
      }
    : undefined;
  const providerCodeEvidence =
    params.providerCodeEvidence !== undefined
      ? requiredString(
          params.providerCodeEvidence,
          "Provider code evidence"
        ).slice(0, 256)
      : undefined;

  const updated = await WhatsAppQrOperation.findOneAndUpdate(
    liveLeaseFilter(params.lease, current.status, now),
    {
      $set: {
        status: "RECONCILE_REQUIRED" satisfies ActiveStatus,
        providerStage: "RECONCILING",
        ...(sanitizedError ? { sanitizedError } : {}),
        ...(providerCodeEvidence ? { providerCodeEvidence } : {}),
      },
      $unset: {
        "lease.ownerToken": 1,
        "lease.expiresAt": 1,
      },
    },
    {
      new: true,
      runValidators: true,
      ...(params.session ? { session: params.session } : {}),
    }
  ).lean<WhatsAppQrOperationRecord | null>();

  if (!updated) {
    throw storeError("OPERATION_CONFLICT", "QR operation lease was lost");
  }
  return updated;
}

export async function completeWhatsAppQrOperation(params: {
  lease: WhatsAppQrOperationLease;
  result: WhatsAppQrTerminalResult;
  now?: Date;
  session?: ClientSession;
}): Promise<WhatsAppQrOperationRecord> {
  if (
    params.result.outcome !== "applied" ||
    params.result.status !== "COMPLETED"
  ) {
    throw storeError(
      "INVALID_INPUT",
      "Completed QR result must be applied/COMPLETED"
    );
  }
  const now = params.now ?? new Date();
  const cleanupAt = new Date(
    now.getTime() + WHATSAPP_QR_OPERATION_TERMINAL_TTL_MS
  );
  const current = await findLiveLeasedOperation(
    params.lease,
    now,
    params.session
  );
  if (!current || !isActiveStatus(current.status)) {
    throw storeError("OPERATION_CONFLICT", "QR operation lease was lost");
  }

  const completed = await WhatsAppQrOperation.findOneAndUpdate(
    liveLeaseFilter(params.lease, current.status, now),
    {
      $set: {
        status: "COMPLETED",
        cleanupAt,
        cachedTerminalResult: params.result,
        providerStage: "CONFIRMED",
      },
      $unset: {
        sanitizedError: 1,
        "lease.ownerToken": 1,
        "lease.expiresAt": 1,
      },
    },
    {
      new: true,
      runValidators: true,
      ...(params.session ? { session: params.session } : {}),
    }
  ).lean<WhatsAppQrOperationRecord | null>();

  if (!completed) {
    throw storeError("OPERATION_CONFLICT", "QR operation lease was lost");
  }
  return completed;
}

export async function failWhatsAppQrOperation(params: {
  lease: WhatsAppQrOperationLease;
  sanitizedError: WhatsAppQrSanitizedError;
  result: WhatsAppQrTerminalResult;
  now?: Date;
  session?: ClientSession;
}): Promise<WhatsAppQrOperationRecord> {
  if (params.result.outcome !== "failed" || params.result.status !== "FAILED") {
    throw storeError("INVALID_INPUT", "Failed QR result must be failed/FAILED");
  }
  const now = params.now ?? new Date();
  const cleanupAt = new Date(
    now.getTime() + WHATSAPP_QR_OPERATION_TERMINAL_TTL_MS
  );
  const sanitizedError = {
    code: requiredString(params.sanitizedError.code, "Error code").slice(
      0,
      128
    ),
    retryable: Boolean(params.sanitizedError.retryable),
  };
  const current = await findLiveLeasedOperation(
    params.lease,
    now,
    params.session
  );
  if (!current || !isActiveStatus(current.status)) {
    throw storeError("OPERATION_CONFLICT", "QR operation lease was lost");
  }

  const failed = await WhatsAppQrOperation.findOneAndUpdate(
    liveLeaseFilter(params.lease, current.status, now),
    {
      $set: {
        status: "FAILED",
        cleanupAt,
        cachedTerminalResult: params.result,
        sanitizedError,
      },
      $unset: {
        "lease.ownerToken": 1,
        "lease.expiresAt": 1,
      },
    },
    {
      new: true,
      runValidators: true,
      ...(params.session ? { session: params.session } : {}),
    }
  ).lean<WhatsAppQrOperationRecord | null>();

  if (!failed) {
    throw storeError("OPERATION_CONFLICT", "QR operation lease was lost");
  }
  return failed;
}
