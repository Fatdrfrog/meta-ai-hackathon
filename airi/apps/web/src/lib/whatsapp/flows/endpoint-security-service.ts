import "server-only";

import { randomUUID } from "node:crypto";

import connectDB from "@/lib/mongoose";
import { resolveWhatsAppFlowEndpointUri } from "@/lib/meta/app-config";
import {
  evaluateManagedFlowReleasePolicy,
  MANAGED_FLOW_RELEASE_POLICY,
  type ManagedFlowReleasePolicy,
} from "@/lib/whatsapp/flows/managed-flow-release-policy";
import {
  computeWhatsAppFlowPublicKeyFingerprint,
  generateWhatsAppFlowKeySet,
  importLegacyWhatsAppFlowKeySet,
  loadFlowEndpointPrivateKeyFromEnv,
  loadWhatsAppFlowKeySet,
  resolveWhatsAppFlowKeyCandidates,
  toSafeWhatsAppFlowKeyDescriptor,
} from "@/lib/whatsapp/flows/endpoint-crypto";
import type {
  AcquireEndpointSecurityMutationLeaseParams,
  EndpointSecurityFencedMutation,
  EndpointSecurityMutationLease,
} from "@/lib/whatsapp/flows/endpoint-security-store";
import {
  EndpointSecurityBindingConflictError,
  EndpointSecurityMutationConflictError,
  EndpointSecurityRecordCorruptionError,
  acquireEndpointSecurityMutationLease,
  applyEndpointSecurityFencedMutation,
  assertEndpointSecurityFence,
  findWhatsAppFlowEndpointSecurity,
  findWhatsAppFlowEndpointSecurityByEndpointId,
  loadOrCreateWhatsAppFlowEndpointSecurity,
  releaseEndpointSecurityMutationLease,
  renewEndpointSecurityMutationLease,
} from "@/lib/whatsapp/flows/endpoint-security-store";
import {
  getWhatsAppBusinessEncryptionStatus,
  uploadWhatsAppBusinessEncryptionPublicKey,
} from "@/lib/whatsapp/flows/service";
import {
  getWABAPhoneNumbersStrict,
  type PhoneNumberInfo,
} from "@/lib/whatsapp/waba-service";
import type {
  SafeEndpointIdentity,
  SafeEndpointKeyDescriptor,
  SafeEndpointSecurityError,
  SafeEndpointSecurityStatus,
  WhatsAppFlowEndpointSecurityErrorCode,
} from "@/lib/whatsapp/flows/endpoint-security-contract";
import type {
  WhatsAppFlowEndpointSecurityRecord,
  WhatsAppFlowKeySet,
  WhatsAppFlowPhoneSecurityState,
  WhatsAppFlowSanitizedSecurityError,
} from "@/models/whatsapp-flow-endpoint-security";
import { MAX_PREVIOUS_FLOW_KEY_SETS } from "@/models/whatsapp-flow-endpoint-security";
import { WhatsAppFlowSession } from "@/models/whatsapp-flow-session";
import {
  WHATSAPP_FLOW_SESSION_CLOCK_SKEW_MS,
  WHATSAPP_FLOW_SESSION_ISSUANCE_LIFETIME_MS,
} from "@/lib/whatsapp/flows/endpoint-session-policy";

const ENDPOINT_SECURITY_LEASE_MS = 2 * 60 * 1_000;
const ENDPOINT_SECURITY_PROVIDER_CALL_TIMEOUT_MS = 45 * 1_000;
const ENDPOINT_SECURITY_LEASE_RENEWAL_MARGIN_MS = 60 * 1_000;

export type ResolvedEndpointSecurityContext = {
  workspaceId: string;
  sourceId: string;
  wabaId: string;
  applicationId: string;
  accessToken: string;
};

type ResolvedEndpointIdentity = SafeEndpointIdentity & {
  endpointId: string;
};

export type ResolvedEndpointRuntimeKeys = {
  endpointId: string;
  keyCandidates: Array<{
    generationId: string;
    privateKeyPem: string;
  }>;
};

type EndpointSecurityBinding = Pick<
  ResolvedEndpointSecurityContext,
  "workspaceId" | "wabaId" | "applicationId"
>;

type EndpointSecurityServiceDependencies = {
  releasePolicy: ManagedFlowReleasePolicy;
  now(): Date;
  findSecurity(
    binding: EndpointSecurityBinding
  ): Promise<WhatsAppFlowEndpointSecurityRecord | null>;
  findSecurityByEndpointId(
    endpointId: string
  ): Promise<WhatsAppFlowEndpointSecurityRecord | null>;
  loadOrCreateSecurity(
    params: EndpointSecurityBinding & {
      initialActiveKeySet: WhatsAppFlowKeySet;
    }
  ): Promise<WhatsAppFlowEndpointSecurityRecord>;
  acquireLease(
    params: AcquireEndpointSecurityMutationLeaseParams
  ): Promise<EndpointSecurityMutationLease | null>;
  releaseLease(lease: EndpointSecurityMutationLease): Promise<boolean>;
  renewLease(params: {
    lease: EndpointSecurityMutationLease;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<boolean>;
  assertFence(params: {
    lease: EndpointSecurityMutationLease;
    now: Date;
  }): Promise<void>;
  applyMutation(params: {
    lease: EndpointSecurityMutationLease;
    now: Date;
    mutation: EndpointSecurityFencedMutation;
  }): Promise<WhatsAppFlowEndpointSecurityRecord>;
  createOwnerToken(): string;
  generateKeySet(options: { now: () => Date }): WhatsAppFlowKeySet;
  importLegacyKeySet(options: {
    privateKeyPem: string;
    now: () => Date;
  }): WhatsAppFlowKeySet;
  loadLegacyPrivateKey(): string | null;
  loadKeySet(
    keySet: WhatsAppFlowKeySet
  ): ReturnType<typeof loadWhatsAppFlowKeySet>;
  computePublicKeyFingerprint(publicKeyPem: string): string;
  listPhones(params: {
    wabaId: string;
    accessToken: string;
    beforePage?: () => void | Promise<void>;
  }): Promise<PhoneNumberInfo[]>;
  getEncryptionStatus(params: {
    phoneNumberId: string;
    accessToken: string;
  }): Promise<
    | { configured: false }
    | {
        configured: true;
        businessPublicKey: string;
        signatureStatus: "VALID" | "INVALID";
      }
  >;
  uploadPublicKey(params: {
    phoneNumberId: string;
    businessPublicKey: string;
    accessToken: string;
  }): Promise<void>;
  getMaxActiveSessionExpiry(endpointId: string): Promise<Date | null>;
  resolveEndpointUri(endpointId: string): string;
};

export class EndpointSecurityServiceError extends Error {
  constructor(
    readonly code: WhatsAppFlowEndpointSecurityErrorCode,
    message: string
  ) {
    super(message);
    this.name = "EndpointSecurityServiceError";
  }
}

function releaseStatus(
  policy: ManagedFlowReleasePolicy,
  now: Date
): SafeEndpointSecurityStatus["release"] {
  const decision = evaluateManagedFlowReleasePolicy(now, policy);
  const legacyCutoffAt =
    policy.state === "active" ? policy.legacyCutoffAt : null;
  let stage: SafeEndpointSecurityStatus["release"]["stage"];
  if (!decision.valid) stage = "INVALID";
  else if (policy.state === "dark") stage = "DARK";
  else if (!decision.managedFlowEnabled) stage = "INACTIVE";
  else if (decision.legacyFlowAllowed) stage = "LEGACY_WINDOW";
  else stage = "MANAGED";
  return {
    stage,
    managedFlowEnabled: decision.managedFlowEnabled,
    legacyFlowAllowed: decision.legacyFlowAllowed,
    legacyCutoffAt,
  };
}

function bindingFromContext(
  context: ResolvedEndpointSecurityContext
): EndpointSecurityBinding {
  return {
    workspaceId: context.workspaceId,
    wabaId: context.wabaId,
    applicationId: context.applicationId,
  };
}

function serializeKey(
  keySet: WhatsAppFlowEndpointSecurityRecord["activeKeySet"]
): SafeEndpointKeyDescriptor {
  const descriptor = toSafeWhatsAppFlowKeyDescriptor(keySet);
  return {
    generationId: descriptor.generationId,
    origin: descriptor.origin,
    rsaKeyId: descriptor.rsaKeyId,
    publicKeyFingerprint: descriptor.publicKeyFingerprint,
    signingKeyId: descriptor.signingKeyId,
    createdAt: descriptor.createdAt.toISOString(),
    ...(descriptor.activatedAt
      ? { activatedAt: descriptor.activatedAt.toISOString() }
      : {}),
    ...(descriptor.retireAt
      ? { retireAt: descriptor.retireAt.toISOString() }
      : {}),
  };
}

function serializeError(
  error: NonNullable<
    WhatsAppFlowEndpointSecurityRecord["keyProvisioning"]["lastError"]
  >
): SafeEndpointSecurityError {
  return {
    code: error.code,
    message: error.message,
    ...(error.stage ? { stage: error.stage } : {}),
    ...(error.providerCode !== undefined
      ? { providerCode: error.providerCode }
      : {}),
    ...(error.providerSubcode !== undefined
      ? { providerSubcode: error.providerSubcode }
      : {}),
    retryable: error.retryable,
    at: error.at.toISOString(),
  };
}

function serializeStatus(params: {
  record: WhatsAppFlowEndpointSecurityRecord;
  release: SafeEndpointSecurityStatus["release"];
  endpointUri: string;
}): SafeEndpointSecurityStatus {
  return {
    configured: true,
    endpointUri: params.endpointUri,
    release: params.release,
    activeKey: serializeKey(params.record.activeKeySet),
    pendingKey: params.record.pendingKeySet
      ? serializeKey(params.record.pendingKeySet)
      : null,
    previousKeys: params.record.previousKeySets.map(serializeKey),
    provisioning: {
      status: params.record.keyProvisioning.status,
      ...(params.record.keyProvisioning.generationId
        ? { generationId: params.record.keyProvisioning.generationId }
        : {}),
      ...(params.record.keyProvisioning.updatedAt
        ? { updatedAt: params.record.keyProvisioning.updatedAt.toISOString() }
        : {}),
      ...(params.record.keyProvisioning.lastError
        ? { lastError: serializeError(params.record.keyProvisioning.lastError) }
        : {}),
    },
    phones: params.record.phones.map(phone => ({
      phoneNumberId: phone.phoneNumberId,
      ...(phone.generationId ? { generationId: phone.generationId } : {}),
      ...(phone.publicKeyFingerprint
        ? { publicKeyFingerprint: phone.publicKeyFingerprint }
        : {}),
      signatureStatus: phone.signatureStatus,
      stage: phone.stage,
      ...(phone.verifiedAt
        ? { verifiedAt: phone.verifiedAt.toISOString() }
        : {}),
      updatedAt: phone.updatedAt.toISOString(),
      ...(phone.lastError
        ? { lastError: serializeError(phone.lastError) }
        : {}),
    })),
  };
}

function assertMutationEnabled(
  policy: ManagedFlowReleasePolicy,
  now: Date
): void {
  const release = releaseStatus(policy, now);
  if (
    release.stage === "DARK" ||
    release.stage === "INACTIVE" ||
    release.stage === "INVALID"
  ) {
    throw new EndpointSecurityServiceError(
      "WHATSAPP_FLOW_ENDPOINT_SECURITY_POLICY_DISABLED",
      "Managed WhatsApp Flow endpoint security is not enabled"
    );
  }
}

function assertDedicatedRotationEnabled(
  policy: ManagedFlowReleasePolicy,
  now: Date
): void {
  assertMutationEnabled(policy, now);
  if (releaseStatus(policy, now).stage !== "MANAGED") {
    throw new EndpointSecurityServiceError(
      "WHATSAPP_FLOW_ENDPOINT_SECURITY_POLICY_DISABLED",
      "Dedicated WhatsApp Flow endpoint key rotation is not enabled"
    );
  }
}

export function assertWhatsAppFlowEndpointSecurityMutationEnabled(
  kind: "ENSURE" | "ROTATE",
  now: Date = new Date()
): void {
  if (kind === "ROTATE") {
    assertDedicatedRotationEnabled(MANAGED_FLOW_RELEASE_POLICY, now);
    return;
  }
  assertMutationEnabled(MANAGED_FLOW_RELEASE_POLICY, now);
}

function identityFromRecord(params: {
  record: WhatsAppFlowEndpointSecurityRecord;
  expectedGenerationId: string;
  release: SafeEndpointSecurityStatus["release"];
  resolveEndpointUri(endpointId: string): string;
}): ResolvedEndpointIdentity {
  const status = serializeStatus({
    record: params.record,
    release: params.release,
    endpointUri: params.resolveEndpointUri(params.record.endpointId),
  });
  return {
    endpointId: params.record.endpointId,
    configured: status.configured,
    endpointUri: status.endpointUri,
    release: status.release,
    activeKey: status.activeKey,
    pendingKey: status.pendingKey,
    expectedGenerationId: params.expectedGenerationId,
  };
}

function safeIdentityFromResolved(
  identity: ResolvedEndpointIdentity
): SafeEndpointIdentity {
  return {
    configured: identity.configured,
    endpointUri: identity.endpointUri,
    release: identity.release,
    activeKey: identity.activeKey,
    pendingKey: identity.pendingKey,
    expectedGenerationId: identity.expectedGenerationId,
  };
}

function rotationSemanticOperationId(params: {
  wabaId: string;
  activeGenerationId: string;
}): string {
  return `rotate:${params.wabaId}:${params.activeGenerationId}`;
}

function mutationSemanticOperationId(params: {
  record: WhatsAppFlowEndpointSecurityRecord;
  kind: "ENSURE" | "ROTATE";
  generationId: string;
}): string {
  const mutation = params.record.mutation;
  if (
    (mutation.status === "RUNNING" || mutation.status === "FAILED") &&
    mutation.kind === params.kind &&
    mutation.generationId === params.generationId &&
    mutation.semanticOperationId
  ) {
    return mutation.semanticOperationId;
  }
  return params.kind === "ROTATE"
    ? rotationSemanticOperationId({
        wabaId: params.record.wabaId,
        activeGenerationId: params.record.activeKeySet.generationId,
      })
    : `ensure:${params.record.wabaId}:${params.generationId}:${mutation.fence}`;
}

function mutationConflict(): EndpointSecurityServiceError {
  return new EndpointSecurityServiceError(
    "WHATSAPP_FLOW_ENDPOINT_SECURITY_MUTATION_CONFLICT",
    "WhatsApp Flow endpoint security mutation is busy"
  );
}

function providerFailure(): EndpointSecurityServiceError {
  return new EndpointSecurityServiceError(
    "WHATSAPP_FLOW_ENDPOINT_SECURITY_PROVIDER_FAILED",
    "WhatsApp could not verify the Flow endpoint public key"
  );
}

function storageFailure(): EndpointSecurityServiceError {
  return new EndpointSecurityServiceError(
    "WHATSAPP_FLOW_ENDPOINT_SECURITY_STORAGE_FAILED",
    "WhatsApp Flow endpoint security storage failed"
  );
}

function configurationFailure(): EndpointSecurityServiceError {
  return new EndpointSecurityServiceError(
    "WHATSAPP_FLOW_ENDPOINT_SECURITY_CONFIGURATION_FAILED",
    "WhatsApp Flow endpoint security key material is invalid"
  );
}

function historyCapacityFailure(): EndpointSecurityServiceError {
  return new EndpointSecurityServiceError(
    "WHATSAPP_FLOW_ENDPOINT_SECURITY_HISTORY_CAPACITY",
    "WhatsApp Flow endpoint key history is at capacity"
  );
}

function createEndpointSecurityProviderSignal(): AbortSignal {
  return AbortSignal.timeout(ENDPOINT_SECURITY_PROVIDER_CALL_TIMEOUT_MS);
}

function normalizeStorageFailure(error: unknown): EndpointSecurityServiceError {
  if (error instanceof EndpointSecurityServiceError) return error;
  if (error instanceof EndpointSecurityBindingConflictError) {
    return new EndpointSecurityServiceError(
      "WHATSAPP_FLOW_ENDPOINT_SECURITY_BINDING_CONFLICT",
      "WhatsApp Flow endpoint security belongs to another binding"
    );
  }
  if (error instanceof EndpointSecurityMutationConflictError) {
    return mutationConflict();
  }
  if (error instanceof EndpointSecurityRecordCorruptionError) {
    return storageFailure();
  }
  return storageFailure();
}

function buildPromotionHistory(params: {
  record: WhatsAppFlowEndpointSecurityRecord;
  now: Date;
  maxActiveSessionExpiry: Date | null;
}): WhatsAppFlowKeySet[] {
  if (
    params.maxActiveSessionExpiry !== null &&
    (!(params.maxActiveSessionExpiry instanceof Date) ||
      !Number.isFinite(params.maxActiveSessionExpiry.getTime()))
  ) {
    throw storageFailure();
  }
  const liveByGeneration = new Map<string, WhatsAppFlowKeySet>();
  for (const keySet of params.record.previousKeySets) {
    if (
      !(keySet.retireAt instanceof Date) ||
      !Number.isFinite(keySet.retireAt.getTime())
    ) {
      throw storageFailure();
    }
    if (keySet.retireAt.getTime() <= params.now.getTime()) continue;
    const current = liveByGeneration.get(keySet.generationId);
    if (!current || current.retireAt!.getTime() < keySet.retireAt.getTime()) {
      liveByGeneration.set(keySet.generationId, keySet);
    }
  }

  const floor =
    params.now.getTime() +
    WHATSAPP_FLOW_SESSION_ISSUANCE_LIFETIME_MS +
    WHATSAPP_FLOW_SESSION_CLOCK_SKEW_MS;
  const retireAt = new Date(
    Math.max(
      floor,
      params.maxActiveSessionExpiry?.getTime() ?? Number.NEGATIVE_INFINITY
    )
  );
  const existingOutgoing = liveByGeneration.get(
    params.record.activeKeySet.generationId
  );
  liveByGeneration.set(params.record.activeKeySet.generationId, {
    ...params.record.activeKeySet,
    retireAt: new Date(
      Math.max(retireAt.getTime(), existingOutgoing?.retireAt?.getTime() ?? 0)
    ),
  });

  const history = [...liveByGeneration.values()];
  if (history.length > MAX_PREVIOUS_FLOW_KEY_SETS) {
    throw historyCapacityFailure();
  }
  return history;
}

export function createWhatsAppFlowEndpointSecurityService(
  dependencies: EndpointSecurityServiceDependencies
) {
  async function resolvePendingRotationIdentity(params: {
    context: ResolvedEndpointSecurityContext;
    record: WhatsAppFlowEndpointSecurityRecord;
    release: SafeEndpointSecurityStatus["release"];
    now: Date;
  }): Promise<ResolvedEndpointIdentity> {
    if (params.record.pendingKeySet) {
      dependencies.loadKeySet(params.record.pendingKeySet);
      return identityFromRecord({
        record: params.record,
        expectedGenerationId: params.record.pendingKeySet.generationId,
        release: params.release,
        resolveEndpointUri: dependencies.resolveEndpointUri,
      });
    }

    const candidateKeySet = dependencies.generateKeySet({
      now: () => new Date(params.now),
    });
    dependencies.loadKeySet(candidateKeySet);
    const acquireNow = dependencies.now();
    const lease = await dependencies.acquireLease({
      wabaId: params.context.wabaId,
      kind: "ROTATE",
      semanticOperationId: rotationSemanticOperationId({
        wabaId: params.context.wabaId,
        activeGenerationId: params.record.activeKeySet.generationId,
      }),
      candidateKeySet,
      ownerToken: dependencies.createOwnerToken(),
      now: acquireNow,
      leaseExpiresAt: new Date(
        acquireNow.getTime() + ENDPOINT_SECURITY_LEASE_MS
      ),
    });
    if (lease && !(await dependencies.releaseLease(lease))) {
      throw mutationConflict();
    }

    const record = await dependencies.findSecurity(
      bindingFromContext(params.context)
    );
    if (!record?.pendingKeySet) throw mutationConflict();
    dependencies.loadKeySet(record.pendingKeySet);
    return identityFromRecord({
      record,
      expectedGenerationId: record.pendingKeySet.generationId,
      release: params.release,
      resolveEndpointUri: dependencies.resolveEndpointUri,
    });
  }

  async function resolveIdentity(
    context: ResolvedEndpointSecurityContext,
    now: Date
  ): Promise<ResolvedEndpointIdentity> {
    assertMutationEnabled(dependencies.releasePolicy, now);
    const release = releaseStatus(dependencies.releasePolicy, now);
    const binding = bindingFromContext(context);
    let record = await dependencies.findSecurity(binding);

    if (!record) {
      let initialActiveKeySet: WhatsAppFlowKeySet;
      if (release.stage === "LEGACY_WINDOW") {
        const privateKeyPem = dependencies.loadLegacyPrivateKey();
        if (!privateKeyPem?.trim()) {
          throw new EndpointSecurityServiceError(
            "WHATSAPP_FLOW_ENDPOINT_SECURITY_CONFIGURATION_FAILED",
            "Legacy WhatsApp Flow endpoint key is not configured"
          );
        }
        initialActiveKeySet = dependencies.importLegacyKeySet({
          privateKeyPem,
          now: () => new Date(now),
        });
      } else {
        initialActiveKeySet = dependencies.generateKeySet({
          now: () => new Date(now),
        });
      }
      dependencies.loadKeySet(initialActiveKeySet);
      record = await dependencies.loadOrCreateSecurity({
        ...binding,
        initialActiveKeySet,
      });
    }

    dependencies.loadKeySet(record.activeKeySet);
    if (record.pendingKeySet) {
      return resolvePendingRotationIdentity({
        context,
        record,
        release,
        now,
      });
    }

    if (
      release.stage !== "MANAGED" ||
      record.activeKeySet.origin !== "LEGACY_IMPORTED"
    ) {
      return identityFromRecord({
        record,
        expectedGenerationId: record.activeKeySet.generationId,
        release,
        resolveEndpointUri: dependencies.resolveEndpointUri,
      });
    }

    return resolvePendingRotationIdentity({
      context,
      record,
      release,
      now,
    });
  }

  async function resolveDedicatedRotationIdentity(
    context: ResolvedEndpointSecurityContext,
    now: Date
  ): Promise<ResolvedEndpointIdentity> {
    assertDedicatedRotationEnabled(dependencies.releasePolicy, now);
    const release = releaseStatus(dependencies.releasePolicy, now);
    const record = await dependencies.findSecurity(bindingFromContext(context));
    if (!record) {
      throw new EndpointSecurityServiceError(
        "WHATSAPP_FLOW_ENDPOINT_SECURITY_NOT_CONFIGURED",
        "Ensure WhatsApp Flow endpoint security before rotating its key"
      );
    }
    dependencies.loadKeySet(record.activeKeySet);
    return resolvePendingRotationIdentity({ context, record, release, now });
  }

  async function ensurePhoneKeyReadiness(params: {
    context: ResolvedEndpointSecurityContext;
    expectedGenerationId: string;
    phoneNumberIds?: readonly string[];
    now?: Date;
  }): Promise<SafeEndpointSecurityStatus> {
    const policyNow = params.now ?? dependencies.now();
    assertMutationEnabled(dependencies.releasePolicy, policyNow);
    if (params.phoneNumberIds?.length === 0) {
      throw new EndpointSecurityServiceError(
        "WHATSAPP_FLOW_ENDPOINT_SECURITY_INVALID_INPUT",
        "Requested WhatsApp phone number subset cannot be empty"
      );
    }
    const binding = bindingFromContext(params.context);
    let record: WhatsAppFlowEndpointSecurityRecord | null;
    try {
      record = await dependencies.findSecurity(binding);
    } catch (error) {
      throw normalizeStorageFailure(error);
    }
    if (!record) {
      throw new EndpointSecurityServiceError(
        "WHATSAPP_FLOW_ENDPOINT_SECURITY_NOT_CONFIGURED",
        "WhatsApp Flow endpoint security must be initialized first"
      );
    }

    if (
      record.pendingKeySet &&
      record.pendingKeySet.generationId !== params.expectedGenerationId
    ) {
      throw mutationConflict();
    }

    const isPending =
      record.pendingKeySet?.generationId === params.expectedGenerationId;
    const keySet = isPending
      ? record.pendingKeySet
      : record.activeKeySet.generationId === params.expectedGenerationId
        ? record.activeKeySet
        : null;
    if (!keySet) throw mutationConflict();
    if (
      releaseStatus(dependencies.releasePolicy, policyNow).stage ===
        "MANAGED" &&
      keySet.origin === "LEGACY_IMPORTED"
    ) {
      throw mutationConflict();
    }
    let loadedKeySet: ReturnType<
      EndpointSecurityServiceDependencies["loadKeySet"]
    >;
    try {
      loadedKeySet = dependencies.loadKeySet(keySet);
    } catch {
      throw configurationFailure();
    }
    const kind = isPending ? "ROTATE" : "ENSURE";
    const semanticOperationId = mutationSemanticOperationId({
      record,
      kind,
      generationId: keySet.generationId,
    });
    const acquireNow = dependencies.now();
    let lease: EndpointSecurityMutationLease | null;
    try {
      lease = await dependencies.acquireLease(
        kind === "ROTATE"
          ? {
              wabaId: params.context.wabaId,
              kind,
              semanticOperationId,
              candidateKeySet: keySet,
              ownerToken: dependencies.createOwnerToken(),
              now: acquireNow,
              leaseExpiresAt: new Date(
                acquireNow.getTime() + ENDPOINT_SECURITY_LEASE_MS
              ),
            }
          : {
              wabaId: params.context.wabaId,
              kind,
              semanticOperationId,
              candidateGenerationId: keySet.generationId,
              ownerToken: dependencies.createOwnerToken(),
              now: acquireNow,
              leaseExpiresAt: new Date(
                acquireNow.getTime() + ENDPOINT_SECURITY_LEASE_MS
              ),
            }
      );
    } catch (error) {
      throw normalizeStorageFailure(error);
    }
    if (!lease) throw mutationConflict();
    const rotationBaseRecord = kind === "ROTATE" ? record : null;

    const applyFenced = async (
      createMutation: (boundaryNow: Date) => EndpointSecurityFencedMutation
    ): Promise<WhatsAppFlowEndpointSecurityRecord> => {
      const boundaryNow = dependencies.now();
      return dependencies.applyMutation({
        lease,
        now: boundaryNow,
        mutation: createMutation(boundaryNow),
      });
    };

    let observedLeaseExpiresAt = lease.leaseExpiresAt;
    const renewLeaseIfNeeded = async (force = false): Promise<void> => {
      const renewNow = dependencies.now();
      if (
        !force &&
        observedLeaseExpiresAt.getTime() - renewNow.getTime() >
          ENDPOINT_SECURITY_LEASE_RENEWAL_MARGIN_MS
      ) {
        return;
      }
      const leaseExpiresAt = new Date(
        renewNow.getTime() + ENDPOINT_SECURITY_LEASE_MS
      );
      let renewed: boolean;
      try {
        renewed = await dependencies.renewLease({
          lease,
          now: renewNow,
          leaseExpiresAt,
        });
      } catch (error) {
        throw normalizeStorageFailure(error);
      }
      if (!renewed) throw mutationConflict();
      observedLeaseExpiresAt = leaseExpiresAt;
    };

    const renewAndAssertFence = async (): Promise<void> => {
      await renewLeaseIfNeeded(true);
      const assertNow = dependencies.now();
      await dependencies.assertFence({ lease, now: assertNow });
    };

    let result: SafeEndpointSecurityStatus | null = null;
    let failure: unknown;
    let phoneStates: WhatsAppFlowPhoneSecurityState[] = [];
    let currentPhoneNumberId: string | null = null;
    try {
      if (rotationBaseRecord) {
        const historyNow = dependencies.now();
        let maxActiveSessionExpiry: Date | null;
        try {
          maxActiveSessionExpiry = await dependencies.getMaxActiveSessionExpiry(
            rotationBaseRecord.endpointId
          );
        } catch (error) {
          throw normalizeStorageFailure(error);
        }
        buildPromotionHistory({
          record: rotationBaseRecord,
          now: historyNow,
          maxActiveSessionExpiry,
        });
      }
      let inventory: PhoneNumberInfo[];
      try {
        inventory = await dependencies.listPhones({
          wabaId: params.context.wabaId,
          accessToken: params.context.accessToken,
          beforePage: () => renewLeaseIfNeeded(),
        });
      } catch (error) {
        if (error instanceof EndpointSecurityServiceError) throw error;
        throw providerFailure();
      }
      if (inventory.length === 0) {
        throw new EndpointSecurityServiceError(
          "WHATSAPP_FLOW_ENDPOINT_SECURITY_NOT_CONFIGURED",
          "WhatsApp Business Account has no phone numbers to secure"
        );
      }
      const inventoryIds = new Set(inventory.map(phone => phone.id));
      if (params.phoneNumberIds) {
        const requestedIds = new Set(params.phoneNumberIds);
        if (
          requestedIds.size !== params.phoneNumberIds.length ||
          params.phoneNumberIds.some(
            phoneNumberId => !inventoryIds.has(phoneNumberId)
          )
        ) {
          throw new EndpointSecurityServiceError(
            "WHATSAPP_FLOW_ENDPOINT_SECURITY_INVALID_INPUT",
            "Requested WhatsApp phone numbers are not a unique inventory subset"
          );
        }
      }
      const targetIds = new Set(
        params.phoneNumberIds ?? inventory.map(phone => phone.id)
      );
      const uploadIds: string[] = [];
      const readyPhoneIds = new Set<string>();

      for (const phone of inventory) {
        await renewLeaseIfNeeded();
        let providerStatus: Awaited<
          ReturnType<EndpointSecurityServiceDependencies["getEncryptionStatus"]>
        >;
        try {
          providerStatus = await dependencies.getEncryptionStatus({
            phoneNumberId: phone.id,
            accessToken: params.context.accessToken,
          });
        } catch {
          throw providerFailure();
        }
        let signatureStatus: WhatsAppFlowPhoneSecurityState["signatureStatus"] =
          "UNKNOWN";
        let stage: WhatsAppFlowPhoneSecurityState["stage"] = "DISCOVERED";
        if (providerStatus.configured) {
          let fingerprint: string;
          try {
            fingerprint = dependencies.computePublicKeyFingerprint(
              providerStatus.businessPublicKey
            );
          } catch {
            throw providerFailure();
          }
          const matchesExpectedKey =
            fingerprint === keySet.publicKeyFingerprint;
          const matchesOutgoingActiveKey =
            kind === "ROTATE" &&
            fingerprint ===
              rotationBaseRecord?.activeKeySet.publicKeyFingerprint;
          if (!matchesExpectedKey && !matchesOutgoingActiveKey) {
            throw new EndpointSecurityServiceError(
              "WHATSAPP_FLOW_ENDPOINT_SECURITY_FOREIGN_KEY",
              "A WhatsApp phone already uses a different Flow public key"
            );
          }
          signatureStatus = providerStatus.signatureStatus;
          if (
            matchesExpectedKey &&
            providerStatus.signatureStatus === "VALID"
          ) {
            stage = "READY";
            readyPhoneIds.add(phone.id);
          }
        }
        if (stage !== "READY" && targetIds.has(phone.id)) {
          uploadIds.push(phone.id);
        }
        if (providerStatus.configured || targetIds.has(phone.id)) {
          phoneStates.push({
            phoneNumberId: phone.id,
            generationId: keySet.generationId,
            publicKeyFingerprint: keySet.publicKeyFingerprint,
            signatureStatus,
            stage,
            ...(stage === "READY" ? { verifiedAt: policyNow } : {}),
            updatedAt: policyNow,
          });
        }
      }

      record = await applyFenced(boundaryNow => ({
        type: "set-provisioning",
        state: {
          status: "IN_PROGRESS",
          generationId: keySet.generationId,
          updatedAt: boundaryNow,
        },
      }));
      record = await applyFenced(boundaryNow => {
        phoneStates = phoneStates.map(state => ({
          ...state,
          updatedAt: boundaryNow,
          ...(state.stage === "READY" ? { verifiedAt: boundaryNow } : {}),
        }));
        return {
          type: "replace-phones",
          phones: phoneStates.map(state => ({ ...state })),
        };
      });

      for (const phoneNumberId of uploadIds) {
        currentPhoneNumberId = phoneNumberId;
        record = await applyFenced(boundaryNow => {
          phoneStates = phoneStates.map(state =>
            state.phoneNumberId === phoneNumberId
              ? { ...state, stage: "UPLOADING", updatedAt: boundaryNow }
              : state
          );
          return {
            type: "replace-phones",
            phones: phoneStates.map(state => ({ ...state })),
          };
        });
        await renewAndAssertFence();
        try {
          await dependencies.uploadPublicKey({
            phoneNumberId,
            businessPublicKey: loadedKeySet.publicKeyPem,
            accessToken: params.context.accessToken,
          });
        } catch {
          throw providerFailure();
        }
        record = await applyFenced(boundaryNow => {
          phoneStates = phoneStates.map(state =>
            state.phoneNumberId === phoneNumberId
              ? { ...state, stage: "VERIFYING", updatedAt: boundaryNow }
              : state
          );
          return {
            type: "replace-phones",
            phones: phoneStates.map(state => ({ ...state })),
          };
        });
        let readback: Awaited<
          ReturnType<EndpointSecurityServiceDependencies["getEncryptionStatus"]>
        >;
        try {
          readback = await dependencies.getEncryptionStatus({
            phoneNumberId,
            accessToken: params.context.accessToken,
          });
        } catch {
          throw providerFailure();
        }
        let readbackMatches = false;
        try {
          readbackMatches =
            readback.configured &&
            readback.signatureStatus === "VALID" &&
            dependencies.computePublicKeyFingerprint(
              readback.businessPublicKey
            ) === keySet.publicKeyFingerprint;
        } catch {
          throw providerFailure();
        }
        if (!readbackMatches) throw providerFailure();
        readyPhoneIds.add(phoneNumberId);
        record = await applyFenced(boundaryNow => {
          phoneStates = phoneStates.map(state =>
            state.phoneNumberId === phoneNumberId
              ? {
                  ...state,
                  signatureStatus: "VALID",
                  stage: "READY",
                  verifiedAt: boundaryNow,
                  updatedAt: boundaryNow,
                }
              : state
          );
          return {
            type: "replace-phones",
            phones: phoneStates.map(state => ({ ...state })),
          };
        });
        currentPhoneNumberId = null;
      }

      const allInventoryReady = inventory.every(phone =>
        readyPhoneIds.has(phone.id)
      );
      if (allInventoryReady && kind === "ENSURE") {
        record = await applyFenced(boundaryNow => ({
          type: "set-provisioning",
          state: {
            status: "READY",
            generationId: keySet.generationId,
            updatedAt: boundaryNow,
          },
        }));
      }
      if (kind === "ROTATE" && allInventoryReady) {
        const rotationRecord = rotationBaseRecord!;
        let maxActiveSessionExpiry: Date | null;
        try {
          maxActiveSessionExpiry = await dependencies.getMaxActiveSessionExpiry(
            rotationRecord.endpointId
          );
        } catch (error) {
          throw normalizeStorageFailure(error);
        }
        const promotionNow = dependencies.now();
        const previousKeySets = buildPromotionHistory({
          record: rotationRecord,
          now: promotionNow,
          maxActiveSessionExpiry,
        });
        record = await dependencies.applyMutation({
          lease,
          now: promotionNow,
          mutation: {
            type: "promote-pending",
            activeKeySet: keySet,
            expectedActiveGenerationId:
              rotationRecord.activeKeySet.generationId,
            previousKeySets,
            phones: phoneStates.map(state => ({ ...state })),
            completedAt: promotionNow,
          },
        });
      }
      if (kind === "ENSURE") {
        record = await applyFenced(boundaryNow => ({
          type: "complete",
          completedAt: boundaryNow,
        }));
      }
      result = serializeStatus({
        record,
        release: releaseStatus(dependencies.releasePolicy, policyNow),
        endpointUri: dependencies.resolveEndpointUri(record.endpointId),
      });
    } catch (error) {
      failure = normalizeStorageFailure(error);
      let sanitizedFailure: WhatsAppFlowSanitizedSecurityError | null = null;
      const makeSanitizedFailure = (
        at: Date
      ): WhatsAppFlowSanitizedSecurityError => {
        if (sanitizedFailure) return sanitizedFailure;
        const safeFailure = failure as EndpointSecurityServiceError;
        sanitizedFailure = {
          code: safeFailure.code,
          message: safeFailure.message,
          retryable:
            safeFailure.code ===
            "WHATSAPP_FLOW_ENDPOINT_SECURITY_PROVIDER_FAILED",
          at,
        };
        return sanitizedFailure;
      };
      if (currentPhoneNumberId) {
        try {
          await applyFenced(boundaryNow => {
            const lastError = makeSanitizedFailure(boundaryNow);
            phoneStates = phoneStates.map(state =>
              state.phoneNumberId === currentPhoneNumberId
                ? {
                    ...state,
                    stage: "FAILED",
                    lastError,
                    updatedAt: boundaryNow,
                  }
                : state
            );
            return {
              type: "replace-phones",
              phones: phoneStates.map(state => ({ ...state })),
            };
          });
        } catch {
          // A stale fence may preserve the last observable UPLOADING/VERIFYING state.
        }
      }
      try {
        await applyFenced(boundaryNow => {
          const lastError = makeSanitizedFailure(boundaryNow);
          return {
            type: "set-provisioning",
            state: {
              status: "FAILED",
              generationId: keySet.generationId,
              lastError,
              updatedAt: boundaryNow,
            },
          };
        });
      } catch {
        // Preserve the original safe failure when a stale fence blocks failure persistence.
      }
      try {
        await applyFenced(boundaryNow => ({
          type: "fail",
          error: makeSanitizedFailure(boundaryNow),
        }));
      } catch {
        // Preserve the original safe failure when a stale fence blocks failure persistence.
      }
    }

    let released = false;
    try {
      released = await dependencies.releaseLease(lease);
    } catch (error) {
      if (!failure) failure = normalizeStorageFailure(error);
    }
    if (!released && !failure) failure = mutationConflict();
    if (failure) throw failure;
    return result!;
  }

  return {
    async resolveRuntimeKeyCandidates(
      endpointId: string,
      now: Date
    ): Promise<ResolvedEndpointRuntimeKeys | null> {
      try {
        const record = await dependencies.findSecurityByEndpointId(endpointId);
        if (!record) return null;
        const keyCandidates = resolveWhatsAppFlowKeyCandidates(record, now).map(
          keySet => {
            const loaded = dependencies.loadKeySet(keySet);
            return {
              generationId: loaded.generationId,
              privateKeyPem: loaded.privateKeyPem,
            };
          }
        );
        if (keyCandidates.length === 0) throw storageFailure();
        return { endpointId: record.endpointId, keyCandidates };
      } catch (error) {
        throw normalizeStorageFailure(error);
      }
    },
    async getStatus(
      context: ResolvedEndpointSecurityContext,
      now: Date
    ): Promise<SafeEndpointSecurityStatus> {
      try {
        const record = await dependencies.findSecurity(
          bindingFromContext(context)
        );
        if (record) {
          return serializeStatus({
            record,
            release: releaseStatus(dependencies.releasePolicy, now),
            endpointUri: dependencies.resolveEndpointUri(record.endpointId),
          });
        }
        return {
          configured: false,
          endpointUri: null,
          release: releaseStatus(dependencies.releasePolicy, now),
          activeKey: null,
          pendingKey: null,
          previousKeys: [],
          provisioning: { status: "NOT_STARTED" },
          phones: [],
        };
      } catch (error) {
        throw normalizeStorageFailure(error);
      }
    },
    async resolveIdentity(
      context: ResolvedEndpointSecurityContext,
      now: Date
    ): Promise<SafeEndpointIdentity> {
      try {
        return safeIdentityFromResolved(await resolveIdentity(context, now));
      } catch (error) {
        throw normalizeStorageFailure(error);
      }
    },
    async resolveManagedIdentity(
      context: ResolvedEndpointSecurityContext,
      now: Date
    ): Promise<ResolvedEndpointIdentity> {
      try {
        return await resolveIdentity(context, now);
      } catch (error) {
        throw normalizeStorageFailure(error);
      }
    },
    ensurePhoneKeyReadiness,
    async ensure(
      context: ResolvedEndpointSecurityContext,
      now: Date
    ): Promise<SafeEndpointSecurityStatus> {
      try {
        const identity = await resolveIdentity(context, now);
        return await ensurePhoneKeyReadiness({
          context,
          expectedGenerationId: identity.expectedGenerationId,
          now,
        });
      } catch (error) {
        throw normalizeStorageFailure(error);
      }
    },
    async rotate(
      context: ResolvedEndpointSecurityContext,
      now: Date
    ): Promise<SafeEndpointSecurityStatus> {
      try {
        const identity = await resolveDedicatedRotationIdentity(context, now);
        return await ensurePhoneKeyReadiness({
          context,
          expectedGenerationId: identity.expectedGenerationId,
          now,
        });
      } catch (error) {
        throw normalizeStorageFailure(error);
      }
    },
  };
}

async function getMaxActiveWhatsAppFlowSessionExpiry(
  endpointId: string
): Promise<Date | null> {
  await connectDB();
  const session = await WhatsAppFlowSession.findOne({
    endpointId,
    status: "ACTIVE",
  })
    .sort({ expiresAt: -1 })
    .select({ expiresAt: 1, _id: 0 })
    .lean<{ expiresAt: Date } | null>();
  if (!session) return null;
  if (
    !(session.expiresAt instanceof Date) ||
    !Number.isFinite(session.expiresAt.getTime())
  ) {
    throw new Error("Stored WhatsApp Flow session expiry is invalid");
  }
  return session.expiresAt;
}

const defaultEndpointSecurityService =
  createWhatsAppFlowEndpointSecurityService({
    releasePolicy: MANAGED_FLOW_RELEASE_POLICY,
    now: () => new Date(),
    findSecurity: findWhatsAppFlowEndpointSecurity,
    findSecurityByEndpointId: findWhatsAppFlowEndpointSecurityByEndpointId,
    loadOrCreateSecurity: loadOrCreateWhatsAppFlowEndpointSecurity,
    acquireLease: acquireEndpointSecurityMutationLease,
    releaseLease: releaseEndpointSecurityMutationLease,
    renewLease: renewEndpointSecurityMutationLease,
    assertFence: assertEndpointSecurityFence,
    applyMutation: applyEndpointSecurityFencedMutation,
    createOwnerToken: randomUUID,
    generateKeySet: generateWhatsAppFlowKeySet,
    importLegacyKeySet: importLegacyWhatsAppFlowKeySet,
    loadLegacyPrivateKey: loadFlowEndpointPrivateKeyFromEnv,
    loadKeySet: loadWhatsAppFlowKeySet,
    computePublicKeyFingerprint: computeWhatsAppFlowPublicKeyFingerprint,
    listPhones: params =>
      getWABAPhoneNumbersStrict({
        ...params,
        createRequestSignal: createEndpointSecurityProviderSignal,
      }),
    getEncryptionStatus: params =>
      getWhatsAppBusinessEncryptionStatus({
        ...params,
        signal: createEndpointSecurityProviderSignal(),
      }),
    uploadPublicKey: params =>
      uploadWhatsAppBusinessEncryptionPublicKey({
        ...params,
        signal: createEndpointSecurityProviderSignal(),
      }),
    getMaxActiveSessionExpiry: getMaxActiveWhatsAppFlowSessionExpiry,
    resolveEndpointUri: resolveWhatsAppFlowEndpointUri,
  });

type EndpointSecurityPublicParams = {
  context: ResolvedEndpointSecurityContext;
  now?: Date;
};

export async function getWhatsAppFlowEndpointSecurityStatus(
  params: EndpointSecurityPublicParams
): Promise<SafeEndpointSecurityStatus> {
  return defaultEndpointSecurityService.getStatus(
    params.context,
    params.now ?? new Date()
  );
}

export async function resolveWhatsAppFlowEndpointRuntimeKeys(params: {
  endpointId: string;
  now?: Date;
}): Promise<ResolvedEndpointRuntimeKeys | null> {
  return defaultEndpointSecurityService.resolveRuntimeKeyCandidates(
    params.endpointId,
    params.now ?? new Date()
  );
}

export async function resolveManagedWhatsAppFlowEndpointIdentity(
  params: EndpointSecurityPublicParams
): Promise<ResolvedEndpointIdentity> {
  return defaultEndpointSecurityService.resolveManagedIdentity(
    params.context,
    params.now ?? new Date()
  );
}

export async function ensureWhatsAppFlowPhoneKeyReadiness(params: {
  context: ResolvedEndpointSecurityContext;
  expectedGenerationId: string;
  phoneNumberIds?: readonly string[];
  now?: Date;
}): Promise<SafeEndpointSecurityStatus> {
  return defaultEndpointSecurityService.ensurePhoneKeyReadiness(params);
}

export async function ensureWhatsAppFlowEndpointSecurity(
  params: EndpointSecurityPublicParams
): Promise<SafeEndpointSecurityStatus> {
  return defaultEndpointSecurityService.ensure(
    params.context,
    params.now ?? new Date()
  );
}

export async function rotateWhatsAppFlowEndpointSecurity(
  params: EndpointSecurityPublicParams
): Promise<SafeEndpointSecurityStatus> {
  return defaultEndpointSecurityService.rotate(
    params.context,
    params.now ?? new Date()
  );
}
