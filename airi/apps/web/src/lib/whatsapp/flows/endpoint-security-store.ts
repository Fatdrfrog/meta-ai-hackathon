import "server-only";

import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import connectDB from "@/lib/mongoose";
import {
  generateWhatsAppFlowEndpointId,
  loadWhatsAppFlowKeySet,
} from "@/lib/whatsapp/flows/endpoint-crypto";
import {
  MAX_PREVIOUS_FLOW_KEY_SETS,
  WhatsAppFlowEndpointSecurity,
  type WhatsAppFlowEndpointSecurityRecord,
  type WhatsAppFlowKeySet,
  type WhatsAppFlowPhoneSecurityState,
  type WhatsAppFlowSanitizedSecurityError,
} from "@/models/whatsapp-flow-endpoint-security";
import { requireNonEmptyString as requiredString } from "@icecore/shared/lib/value-utils";

const ENDPOINT_ID_COLLISION_ATTEMPTS = 3;
const LEASE_ACQUISITION_CAS_ATTEMPTS = 3;

type WhatsAppFlowSecurityMutationKind = "ENSURE" | "ROTATE";

type EndpointSecurityBinding = {
  workspaceId: string;
  wabaId: string;
  applicationId: string;
};

export type EndpointSecurityMutationLease = {
  wabaId: string;
  kind: WhatsAppFlowSecurityMutationKind;
  semanticOperationId: string;
  generationId: string;
  ownerToken: string;
  fence: number;
  leaseExpiresAt: Date;
};

type EndpointSecurityMutationLeaseRequest = {
  wabaId: string;
  semanticOperationId: string;
  ownerToken: string;
  now: Date;
  leaseExpiresAt: Date;
};

export type AcquireEndpointSecurityMutationLeaseParams =
  | (EndpointSecurityMutationLeaseRequest & {
      kind: "ROTATE";
      candidateKeySet: WhatsAppFlowKeySet;
      candidateGenerationId?: never;
    })
  | (EndpointSecurityMutationLeaseRequest & {
      kind: "ENSURE";
      candidateGenerationId: string;
      candidateKeySet?: never;
    });

export type EndpointSecurityFencedMutation =
  | { type: "replace-phones"; phones: WhatsAppFlowPhoneSecurityState[] }
  | {
      type: "set-provisioning";
      state: WhatsAppFlowEndpointSecurityRecord["keyProvisioning"];
    }
  | {
      type: "promote-pending";
      activeKeySet: WhatsAppFlowKeySet;
      expectedActiveGenerationId: string;
      previousKeySets: WhatsAppFlowKeySet[];
      phones: WhatsAppFlowPhoneSecurityState[];
      completedAt: Date;
    }
  | { type: "complete"; completedAt: Date }
  | { type: "fail"; error: WhatsAppFlowSanitizedSecurityError };

export class EndpointSecurityBindingConflictError extends Error {
  readonly code = "WHATSAPP_FLOW_ENDPOINT_SECURITY_BINDING_CONFLICT";

  constructor() {
    super("WhatsApp Flow endpoint security belongs to another binding");
    this.name = "EndpointSecurityBindingConflictError";
  }
}

export class EndpointSecurityMutationConflictError extends Error {
  readonly code = "WHATSAPP_FLOW_ENDPOINT_SECURITY_MUTATION_CONFLICT";

  constructor() {
    super("WhatsApp Flow endpoint security mutation is stale or conflicted");
    this.name = "EndpointSecurityMutationConflictError";
  }
}

export class EndpointSecurityRecordCorruptionError extends Error {
  readonly code = "WHATSAPP_FLOW_ENDPOINT_SECURITY_RECORD_CORRUPT";

  constructor() {
    super("WhatsApp Flow endpoint security record is incomplete or corrupt");
    this.name = "EndpointSecurityRecordCorruptionError";
  }
}

function validDate(value: unknown, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function futureLeaseExpiry(value: unknown, now: Date): Date {
  const leaseExpiresAt = validDate(value, "Lease expiry");
  if (leaseExpiresAt.getTime() <= now.getTime()) {
    throw new Error("Lease expiry must be after now");
  }
  return leaseExpiresAt;
}

function validMutationKind(value: unknown): WhatsAppFlowSecurityMutationKind {
  if (value !== "ENSURE" && value !== "ROTATE") {
    throw new Error("Endpoint security mutation kind is invalid");
  }
  return value as WhatsAppFlowSecurityMutationKind;
}

function exactBinding(
  record: WhatsAppFlowEndpointSecurityRecord,
  binding: EndpointSecurityBinding
): WhatsAppFlowEndpointSecurityRecord {
  if (
    record.workspaceId !== binding.workspaceId ||
    record.wabaId !== binding.wabaId ||
    record.applicationId !== binding.applicationId
  ) {
    throw new EndpointSecurityBindingConflictError();
  }
  return record;
}

function validatedExistingRecord(
  record: WhatsAppFlowEndpointSecurityRecord,
  binding: EndpointSecurityBinding
): WhatsAppFlowEndpointSecurityRecord {
  const boundRecord = exactBinding(record, binding);
  if (!boundRecord.activeKeySet) {
    throw new EndpointSecurityRecordCorruptionError();
  }
  try {
    loadWhatsAppFlowKeySet(boundRecord.activeKeySet);
  } catch {
    throw new EndpointSecurityRecordCorruptionError();
  }
  return boundRecord;
}

async function findByWabaId(
  wabaId: string
): Promise<WhatsAppFlowEndpointSecurityRecord | null> {
  return (
    (await WhatsAppFlowEndpointSecurity.findOne({
      wabaId,
    }).lean<WhatsAppFlowEndpointSecurityRecord | null>()) ?? null
  );
}

async function findByEndpointId(
  endpointId: string
): Promise<WhatsAppFlowEndpointSecurityRecord | null> {
  return (
    (await WhatsAppFlowEndpointSecurity.findOne({
      endpointId,
    }).lean<WhatsAppFlowEndpointSecurityRecord | null>()) ?? null
  );
}

function normalizeBinding(
  params: EndpointSecurityBinding
): EndpointSecurityBinding {
  return {
    workspaceId: requiredString(params.workspaceId, "Workspace id"),
    wabaId: requiredString(params.wabaId, "WABA id"),
    applicationId: requiredString(params.applicationId, "Application id"),
  };
}

export async function findWhatsAppFlowEndpointSecurity(
  params: EndpointSecurityBinding
): Promise<WhatsAppFlowEndpointSecurityRecord | null> {
  const binding = normalizeBinding(params);
  await connectDB();
  const record = await findByWabaId(binding.wabaId);
  return record ? validatedExistingRecord(record, binding) : null;
}

export async function findWhatsAppFlowEndpointSecurityByEndpointId(
  endpointIdValue: string
): Promise<WhatsAppFlowEndpointSecurityRecord | null> {
  const endpointId = requiredString(endpointIdValue, "Endpoint id");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(endpointId)) {
    throw new Error("Endpoint id is invalid");
  }
  await connectDB();
  const record = await findByEndpointId(endpointId);
  if (!record) return null;
  try {
    if (requiredString(record.endpointId, "Endpoint id") !== endpointId) {
      throw new Error("Stored endpoint id does not match");
    }
    return validatedExistingRecord(record, normalizeBinding(record));
  } catch {
    throw new EndpointSecurityRecordCorruptionError();
  }
}

export async function loadOrCreateWhatsAppFlowEndpointSecurity(params: {
  workspaceId: string;
  wabaId: string;
  applicationId: string;
  initialActiveKeySet: WhatsAppFlowKeySet;
}): Promise<WhatsAppFlowEndpointSecurityRecord> {
  const binding = normalizeBinding(params);
  if (
    !params.initialActiveKeySet ||
    typeof params.initialActiveKeySet !== "object"
  ) {
    throw new Error("Initial active key set is required");
  }
  loadWhatsAppFlowKeySet(params.initialActiveKeySet);
  await connectDB();

  for (
    let attempt = 0;
    attempt < ENDPOINT_ID_COLLISION_ATTEMPTS;
    attempt += 1
  ) {
    const endpointId = generateWhatsAppFlowEndpointId();
    try {
      const record = await WhatsAppFlowEndpointSecurity.findOneAndUpdate(
        { wabaId: binding.wabaId },
        {
          $setOnInsert: {
            workspaceId: binding.workspaceId,
            wabaId: binding.wabaId,
            endpointId,
            applicationId: binding.applicationId,
            activeKeySet: params.initialActiveKeySet,
            previousKeySets: [],
            phones: [],
            keyProvisioning: { status: "NOT_STARTED" },
            mutation: { status: "IDLE", fence: 0 },
          },
        },
        {
          upsert: true,
          new: true,
          runValidators: true,
          setDefaultsOnInsert: false,
        }
      ).lean<WhatsAppFlowEndpointSecurityRecord | null>();
      if (!record) throw new EndpointSecurityMutationConflictError();
      return validatedExistingRecord(record, binding);
    } catch (error) {
      if (!isMongoDuplicateKeyError(error)) throw error;
      const winner = await findByWabaId(binding.wabaId);
      if (winner) return validatedExistingRecord(winner, binding);
    }
  }

  throw new EndpointSecurityMutationConflictError();
}

function normalizedLease(
  lease: EndpointSecurityMutationLease
): EndpointSecurityMutationLease {
  const fence = lease.fence;
  if (!Number.isSafeInteger(fence) || fence <= 0) {
    throw new Error("Endpoint security mutation fence is invalid");
  }
  return {
    wabaId: requiredString(lease.wabaId, "WABA id"),
    kind: validMutationKind(lease.kind),
    semanticOperationId: requiredString(
      lease.semanticOperationId,
      "Semantic operation id"
    ),
    generationId: requiredString(lease.generationId, "Generation id"),
    ownerToken: requiredString(lease.ownerToken, "Owner token"),
    fence,
    leaseExpiresAt: validDate(lease.leaseExpiresAt, "Lease expiry"),
  };
}

function keySetForGeneration(
  record: WhatsAppFlowEndpointSecurityRecord,
  generationId: string
): WhatsAppFlowKeySet | null {
  for (const keySet of [record.pendingKeySet, record.activeKeySet]) {
    if (keySet?.generationId === generationId) {
      loadWhatsAppFlowKeySet(keySet);
      return keySet;
    }
  }
  return null;
}

function acquisitionOwnerFilter(
  record: WhatsAppFlowEndpointSecurityRecord,
  ownerToken: string,
  now: Date
): Record<string, unknown> | null {
  if (record.mutation.ownerToken === ownerToken) {
    return { "mutation.ownerToken": ownerToken };
  }
  if (!record.mutation.ownerToken) {
    return { "mutation.ownerToken": { $exists: false } };
  }
  const storedExpiry = record.mutation.leaseExpiresAt;
  if (
    storedExpiry instanceof Date &&
    Number.isFinite(storedExpiry.getTime()) &&
    storedExpiry.getTime() <= now.getTime()
  ) {
    return {
      "mutation.ownerToken": record.mutation.ownerToken,
      "mutation.leaseExpiresAt": { $lte: now },
    };
  }
  return null;
}

function leaseFromAcquiredRecord(params: {
  record: WhatsAppFlowEndpointSecurityRecord;
  wabaId: string;
  kind: WhatsAppFlowSecurityMutationKind;
  semanticOperationId: string;
  ownerToken: string;
  now: Date;
}): EndpointSecurityMutationLease {
  const mutation = params.record.mutation;
  if (
    params.record.wabaId !== params.wabaId ||
    mutation.status !== "RUNNING" ||
    mutation.kind !== params.kind ||
    mutation.semanticOperationId !== params.semanticOperationId ||
    mutation.ownerToken !== params.ownerToken ||
    typeof mutation.generationId !== "string" ||
    !mutation.generationId ||
    !Number.isSafeInteger(mutation.fence) ||
    mutation.fence <= 0 ||
    !(mutation.leaseExpiresAt instanceof Date) ||
    mutation.leaseExpiresAt.getTime() <= params.now.getTime()
  ) {
    throw new EndpointSecurityMutationConflictError();
  }
  if (!keySetForGeneration(params.record, mutation.generationId)) {
    throw new EndpointSecurityMutationConflictError();
  }
  return {
    wabaId: params.wabaId,
    kind: params.kind,
    semanticOperationId: params.semanticOperationId,
    generationId: mutation.generationId,
    ownerToken: params.ownerToken,
    fence: mutation.fence,
    leaseExpiresAt: mutation.leaseExpiresAt,
  };
}

export async function acquireEndpointSecurityMutationLease(
  params: AcquireEndpointSecurityMutationLeaseParams
): Promise<EndpointSecurityMutationLease | null> {
  const wabaId = requiredString(params.wabaId, "WABA id");
  const kind = validMutationKind(params.kind);
  const semanticOperationId = requiredString(
    params.semanticOperationId,
    "Semantic operation id"
  );
  const ownerToken = requiredString(params.ownerToken, "Owner token");
  const now = validDate(params.now, "Lease time");
  const leaseExpiresAt = futureLeaseExpiry(params.leaseExpiresAt, now);
  let requestedGenerationId: string;
  let rotationCandidate: WhatsAppFlowKeySet | null = null;
  if (params.kind === "ROTATE") {
    if (!params.candidateKeySet || typeof params.candidateKeySet !== "object") {
      throw new Error("Rotation candidate key set is required");
    }
    loadWhatsAppFlowKeySet(params.candidateKeySet);
    rotationCandidate = params.candidateKeySet;
    requestedGenerationId = params.candidateKeySet.generationId;
  } else {
    requestedGenerationId = requiredString(
      params.candidateGenerationId,
      "Candidate generation id"
    );
  }

  await connectDB();
  for (
    let attempt = 0;
    attempt < LEASE_ACQUISITION_CAS_ATTEMPTS;
    attempt += 1
  ) {
    const current = await findByWabaId(wabaId);
    if (!current) return null;
    if (
      current.mutation.status === "COMPLETED" &&
      current.mutation.kind === kind &&
      current.mutation.semanticOperationId === semanticOperationId
    ) {
      return null;
    }
    if (kind === "ENSURE" && current.pendingKeySet) {
      return null;
    }

    let generationId: string;
    let installPendingKeySet: WhatsAppFlowKeySet | null = null;
    let filter: Record<string, unknown> = {
      wabaId,
      "mutation.status": current.mutation.status,
      "mutation.fence": current.mutation.fence,
    };

    if (current.mutation.status === "RUNNING") {
      if (
        current.mutation.kind !== kind ||
        current.mutation.semanticOperationId !== semanticOperationId ||
        !current.mutation.generationId
      ) {
        return null;
      }
      const ownerFilter = acquisitionOwnerFilter(current, ownerToken, now);
      if (!ownerFilter) return null;
      generationId = current.mutation.generationId;
      if (!keySetForGeneration(current, generationId)) {
        throw new EndpointSecurityMutationConflictError();
      }
      filter = {
        ...filter,
        "mutation.kind": kind,
        "mutation.semanticOperationId": semanticOperationId,
        "mutation.generationId": generationId,
        ...ownerFilter,
      };
      if (kind === "ROTATE") {
        if (current.pendingKeySet?.generationId !== generationId) {
          throw new EndpointSecurityMutationConflictError();
        }
        filter["pendingKeySet.generationId"] = generationId;
      }
    } else if (kind === "ROTATE") {
      if (current.mutation.status === "FAILED") {
        if (
          current.mutation.kind !== "ROTATE" ||
          current.mutation.semanticOperationId !== semanticOperationId ||
          !current.mutation.generationId ||
          current.pendingKeySet?.generationId !== current.mutation.generationId
        ) {
          return null;
        }
      }
      if (current.pendingKeySet) {
        loadWhatsAppFlowKeySet(current.pendingKeySet);
        generationId = current.pendingKeySet.generationId;
        filter["pendingKeySet.generationId"] = generationId;
      } else {
        generationId = requestedGenerationId;
        installPendingKeySet = rotationCandidate;
        filter.pendingKeySet = { $exists: false };
      }
    } else {
      const durableKeySet = keySetForGeneration(current, requestedGenerationId);
      if (!durableKeySet) {
        throw new EndpointSecurityMutationConflictError();
      }
      generationId = durableKeySet.generationId;
      filter["activeKeySet.generationId"] = generationId;
      filter.pendingKeySet = { $exists: false };
    }

    const set: Record<string, unknown> = {
      "mutation.kind": kind,
      "mutation.status": "RUNNING",
      "mutation.semanticOperationId": semanticOperationId,
      "mutation.generationId": generationId,
      "mutation.ownerToken": ownerToken,
      "mutation.leaseExpiresAt": leaseExpiresAt,
      "mutation.updatedAt": now,
    };
    if (installPendingKeySet) set.pendingKeySet = installPendingKeySet;

    const acquired = await WhatsAppFlowEndpointSecurity.findOneAndUpdate(
      filter,
      {
        $set: set,
        $unset: { "mutation.lastError": 1 },
        $inc: { "mutation.fence": 1 },
      },
      { new: true, runValidators: true }
    ).lean<WhatsAppFlowEndpointSecurityRecord | null>();
    if (!acquired) continue;
    return leaseFromAcquiredRecord({
      record: acquired,
      wabaId,
      kind,
      semanticOperationId,
      ownerToken,
      now,
    });
  }

  return null;
}

function exactLeaseFilter(
  lease: EndpointSecurityMutationLease
): Record<string, unknown> {
  return {
    wabaId: lease.wabaId,
    "mutation.kind": lease.kind,
    "mutation.semanticOperationId": lease.semanticOperationId,
    "mutation.generationId": lease.generationId,
    "mutation.ownerToken": lease.ownerToken,
    "mutation.fence": lease.fence,
  };
}

function liveLeaseFilter(
  lease: EndpointSecurityMutationLease,
  now: Date
): Record<string, unknown> {
  return {
    ...exactLeaseFilter(lease),
    "mutation.status": "RUNNING",
    "mutation.leaseExpiresAt": { $gt: now },
  };
}

export async function renewEndpointSecurityMutationLease(params: {
  lease: EndpointSecurityMutationLease;
  now: Date;
  leaseExpiresAt: Date;
}): Promise<boolean> {
  const lease = normalizedLease(params.lease);
  const now = validDate(params.now, "Lease time");
  const leaseExpiresAt = futureLeaseExpiry(params.leaseExpiresAt, now);
  await connectDB();
  const renewed = await WhatsAppFlowEndpointSecurity.findOneAndUpdate(
    {
      ...exactLeaseFilter(lease),
      "mutation.status": "RUNNING",
      "mutation.leaseExpiresAt": { $gt: now, $lte: leaseExpiresAt },
    },
    {
      $set: {
        "mutation.leaseExpiresAt": leaseExpiresAt,
        "mutation.updatedAt": now,
      },
    },
    { new: true, runValidators: true }
  ).lean<WhatsAppFlowEndpointSecurityRecord | null>();
  return Boolean(renewed);
}

export async function assertEndpointSecurityFence(params: {
  lease: EndpointSecurityMutationLease;
  now: Date;
}): Promise<void> {
  const lease = normalizedLease(params.lease);
  const now = validDate(params.now, "Fence assertion time");
  await connectDB();
  const record = await WhatsAppFlowEndpointSecurity.findOne(
    liveLeaseFilter(lease, now)
  ).lean<{ _id?: unknown } | null>();
  if (!record) throw new EndpointSecurityMutationConflictError();
}

export async function releaseEndpointSecurityMutationLease(
  inputLease: EndpointSecurityMutationLease
): Promise<boolean> {
  const lease = normalizedLease(inputLease);
  await connectDB();
  const released = await WhatsAppFlowEndpointSecurity.findOneAndUpdate(
    exactLeaseFilter(lease),
    {
      $unset: {
        "mutation.ownerToken": 1,
        "mutation.leaseExpiresAt": 1,
      },
    },
    { new: true, runValidators: true }
  ).lean<WhatsAppFlowEndpointSecurityRecord | null>();
  return Boolean(released);
}

function assertPhonesMatchGeneration(
  phones: WhatsAppFlowPhoneSecurityState[],
  generationId: string
): void {
  if (
    !Array.isArray(phones) ||
    phones.some(
      phone =>
        !phone ||
        typeof phone !== "object" ||
        phone.generationId !== generationId
    )
  ) {
    throw new Error("Phone generation must match the mutation lease");
  }
}

function assertSanitizedError(error: WhatsAppFlowSanitizedSecurityError): void {
  if (
    !error ||
    typeof error !== "object" ||
    !requiredString(error.code, "Security error code") ||
    !requiredString(error.message, "Security error message") ||
    typeof error.retryable !== "boolean"
  ) {
    throw new Error("Sanitized security error is invalid");
  }
  validDate(error.at, "Security error time");
}

export async function applyEndpointSecurityFencedMutation(params: {
  lease: EndpointSecurityMutationLease;
  now: Date;
  mutation: EndpointSecurityFencedMutation;
}): Promise<WhatsAppFlowEndpointSecurityRecord> {
  const lease = normalizedLease(params.lease);
  const now = validDate(params.now, "Mutation time");
  const filter = liveLeaseFilter(lease, now);
  let update: {
    $set: Record<string, unknown>;
    $unset?: Record<string, unknown>;
  };

  switch (params.mutation.type) {
    case "replace-phones":
      assertPhonesMatchGeneration(params.mutation.phones, lease.generationId);
      update = {
        $set: {
          phones: params.mutation.phones,
          "mutation.updatedAt": now,
        },
      };
      break;
    case "set-provisioning":
      if (params.mutation.state.generationId !== lease.generationId) {
        throw new Error(
          "Provisioning generation must match the mutation lease"
        );
      }
      update = {
        $set: {
          keyProvisioning: params.mutation.state,
          "mutation.updatedAt": now,
        },
      };
      break;
    case "promote-pending": {
      const completedAt = validDate(
        params.mutation.completedAt,
        "Completion time"
      );
      loadWhatsAppFlowKeySet(params.mutation.activeKeySet);
      if (params.mutation.activeKeySet.generationId !== lease.generationId) {
        throw new Error("Active key generation must match the mutation lease");
      }
      if (params.mutation.activeKeySet.retireAt !== undefined) {
        throw new Error("Incoming active key cannot have a retirement time");
      }
      const expectedActiveGenerationId = requiredString(
        params.mutation.expectedActiveGenerationId,
        "Expected active generation id"
      );
      if (expectedActiveGenerationId === lease.generationId) {
        throw new Error("Outgoing active generation must differ from incoming");
      }
      if (
        !Array.isArray(params.mutation.previousKeySets) ||
        params.mutation.previousKeySets.length > MAX_PREVIOUS_FLOW_KEY_SETS
      ) {
        throw new Error(
          "At most two previous WhatsApp Flow key sets are retained"
        );
      }
      const previousGenerationIds: string[] = [];
      for (const keySet of params.mutation.previousKeySets) {
        loadWhatsAppFlowKeySet(keySet);
        previousGenerationIds.push(keySet.generationId);
      }
      if (
        new Set(previousGenerationIds).size !== previousGenerationIds.length
      ) {
        throw new Error("Promotion history generations must be unique");
      }
      if (previousGenerationIds.includes(lease.generationId)) {
        throw new Error(
          "Promotion history cannot contain the incoming active generation"
        );
      }
      if (
        previousGenerationIds.filter(
          generationId => generationId === expectedActiveGenerationId
        ).length !== 1
      ) {
        throw new Error(
          "Promotion history must contain the outgoing active generation exactly once"
        );
      }
      const retirementBoundary = Math.max(now.getTime(), completedAt.getTime());
      for (const keySet of params.mutation.previousKeySets) {
        if (
          !(keySet.retireAt instanceof Date) ||
          !Number.isFinite(keySet.retireAt.getTime()) ||
          keySet.retireAt.getTime() <= retirementBoundary
        ) {
          throw new Error("Previous key retirement must be after promotion");
        }
      }
      assertPhonesMatchGeneration(params.mutation.phones, lease.generationId);
      filter["pendingKeySet.generationId"] = lease.generationId;
      filter["activeKeySet.generationId"] = expectedActiveGenerationId;
      update = {
        $set: {
          activeKeySet: {
            ...params.mutation.activeKeySet,
            activatedAt: completedAt,
          },
          previousKeySets: params.mutation.previousKeySets,
          phones: params.mutation.phones,
          keyProvisioning: {
            status: "READY",
            generationId: lease.generationId,
            updatedAt: completedAt,
          },
          "mutation.status": "COMPLETED",
          "mutation.updatedAt": completedAt,
        },
        $unset: {
          pendingKeySet: 1,
          "mutation.lastError": 1,
        },
      };
      break;
    }
    case "complete":
      if (lease.kind === "ROTATE") {
        throw new Error("Rotation must complete through pending-key promotion");
      }
      update = {
        $set: {
          "mutation.status": "COMPLETED",
          "mutation.updatedAt": validDate(
            params.mutation.completedAt,
            "Completion time"
          ),
        },
        $unset: { "mutation.lastError": 1 },
      };
      break;
    case "fail":
      assertSanitizedError(params.mutation.error);
      update = {
        $set: {
          "mutation.status": "FAILED",
          "mutation.lastError": params.mutation.error,
          "mutation.updatedAt": params.mutation.error.at,
        },
      };
      break;
  }

  await connectDB();
  const record = await WhatsAppFlowEndpointSecurity.findOneAndUpdate(
    filter,
    update,
    { new: true, runValidators: true }
  ).lean<WhatsAppFlowEndpointSecurityRecord | null>();
  if (!record) throw new EndpointSecurityMutationConflictError();
  return record;
}
