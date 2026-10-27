import "server-only";

import { randomUUID } from "node:crypto";

import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import connectDB from "@/lib/mongoose";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { normalizeWhatsAppCredentials } from "@/lib/whatsapp/credentials";
import {
  WhatsAppFlowSourceBindingFence,
  type WhatsAppFlowSourceBindingFenceRecord,
} from "@/models/whatsapp-flow-source-binding-fence";
import { stripDeprecatedWhatsAppCredentialAliases } from "@icecore/shared/lib/whatsapp/account-identifiers";
import { requireNonEmptyString as requiredString } from "@icecore/shared/lib/value-utils";

const SOURCE_BINDING_LEASE_DURATION_MS = 2 * 60_000;
const SOURCE_BINDING_ACQUIRE_ATTEMPTS = 3;

export const WHATSAPP_FLOW_SOURCE_FENCE_CREDENTIAL_FIELD =
  "__airi_whatsapp_flow_source_fence";

export type WhatsAppFlowSourceBindingFenceKind = "PROVISIONING" | "REBIND";

export type WhatsAppFlowSourceBindingFenceLease = {
  sourceId: string;
  workspaceId: string;
  expectedWabaId: string;
  kind: WhatsAppFlowSourceBindingFenceKind;
  semanticOperationId: string;
  ownerToken: string;
  fence: number;
  leaseExpiresAt: Date;
};

export type WhatsAppSourceBindingSnapshot = {
  id: string;
  workspaceId: string;
  updatedAt: string;
  credentials: Record<string, unknown>;
};

type MongoFenceLease = Omit<
  WhatsAppFlowSourceBindingFenceLease,
  "expectedWabaId"
>;

type SourcePatch = {
  name?: string;
};

export type WhatsAppFlowSourceBindingFenceStoreDependencies = {
  now(): Date;
  newOwnerToken(): string;
  acquireMongoFence(params: {
    sourceId: string;
    workspaceId: string;
    kind: WhatsAppFlowSourceBindingFenceKind;
    semanticOperationId: string;
    ownerToken: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<MongoFenceLease | null>;
  renewMongoFence(params: {
    lease: WhatsAppFlowSourceBindingFenceLease;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<MongoFenceLease | null>;
  assertMongoFence(params: {
    lease: WhatsAppFlowSourceBindingFenceLease;
    now: Date;
  }): Promise<boolean>;
  releaseMongoFence(lease: WhatsAppFlowSourceBindingFenceLease): Promise<void>;
  loadSource(params: {
    workspaceId: string;
    sourceId: string;
  }): Promise<WhatsAppSourceBindingSnapshot | null>;
  compareAndSetSource(params: {
    workspaceId: string;
    sourceId: string;
    expectedUpdatedAt: string;
    nextCredentials: Record<string, unknown>;
    sourcePatch?: SourcePatch;
  }): Promise<WhatsAppSourceBindingSnapshot | null>;
};

export class WhatsAppFlowSourceBindingFenceConflictError extends Error {
  readonly code = "WHATSAPP_FLOW_SOURCE_BINDING_FENCE_CONFLICT";

  constructor() {
    super("WhatsApp source binding changed or is busy; retry the operation");
    this.name = "WhatsAppFlowSourceBindingFenceConflictError";
  }
}

function bindingString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is invalid`);
  }
  return value.trim();
}

function validDate(value: unknown, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function normalizedKind(value: unknown): WhatsAppFlowSourceBindingFenceKind {
  if (value !== "PROVISIONING" && value !== "REBIND") {
    throw new Error("Source-binding fence kind is invalid");
  }
  return value;
}

function sourceWabaId(source: WhatsAppSourceBindingSnapshot): string {
  return String(
    normalizeWhatsAppCredentials(source.credentials).wabaId || ""
  ).trim();
}

function activatedFence(source: WhatsAppSourceBindingSnapshot): number | null {
  const value = source.credentials[WHATSAPP_FLOW_SOURCE_FENCE_CREDENTIAL_FIELD];
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : null;
}

/**
 * Builds the only credential shape that may cross the source-fence write
 * boundary. Alias cleanup and fence preservation belong here so update and
 * commit cannot drift into different persistence semantics. Keys missing
 * from the candidate keep their stored value; builders clear a key with null.
 */
function prepareSourceFenceCredentials(params: {
  current: Readonly<Record<string, unknown>>;
  candidate: unknown;
  fence?: number;
  now: Date;
}): Record<string, unknown> {
  if (
    !params.candidate ||
    typeof params.candidate !== "object" ||
    Array.isArray(params.candidate)
  ) {
    throw new Error("Next WhatsApp credentials are invalid");
  }

  const nextCredentials = {
    ...params.current,
    ...(params.candidate as Record<string, unknown>),
  };
  stripDeprecatedWhatsAppCredentialAliases(nextCredentials);
  const previousWabaId = normalizeWhatsAppCredentials(params.current).wabaId;
  if (previousWabaId && previousWabaId !== normalizeWhatsAppCredentials(nextCredentials).wabaId) {
    const previousConfig = params.current.conversions_api;
    const config = previousConfig && typeof previousConfig === "object" && !Array.isArray(previousConfig)
      ? previousConfig as Record<string, unknown> : {};
    const previousBoundary = typeof config.attribution_boundary_at === "string" ? Date.parse(config.attribution_boundary_at) : NaN;
    nextCredentials.conversions_api = {
      ...config,
      enabled: false,
      attribution_boundary_at: new Date(Math.max(params.now.getTime(), Number.isFinite(previousBoundary) ? previousBoundary : 0)).toISOString(),
    };
  }
  if (params.fence !== undefined) {
    nextCredentials[WHATSAPP_FLOW_SOURCE_FENCE_CREDENTIAL_FIELD] = params.fence;
  }
  return nextCredentials;
}

function normalizedLease(
  lease: WhatsAppFlowSourceBindingFenceLease
): WhatsAppFlowSourceBindingFenceLease {
  const fence = lease.fence;
  if (!Number.isSafeInteger(fence) || fence <= 0) {
    throw new Error("Source-binding fence is invalid");
  }
  return {
    sourceId: requiredString(lease.sourceId, "Source id"),
    workspaceId: requiredString(lease.workspaceId, "Workspace id"),
    expectedWabaId: bindingString(lease.expectedWabaId, "Expected WABA id"),
    kind: normalizedKind(lease.kind),
    semanticOperationId: requiredString(
      lease.semanticOperationId,
      "Semantic operation id"
    ),
    ownerToken: requiredString(lease.ownerToken, "Owner token"),
    fence,
    leaseExpiresAt: validDate(lease.leaseExpiresAt, "Lease expiry"),
  };
}

function exactMongoFenceFilter(
  lease: WhatsAppFlowSourceBindingFenceLease
): Record<string, unknown> {
  return {
    _id: lease.sourceId,
    workspaceId: lease.workspaceId,
    kind: lease.kind,
    semanticOperationId: lease.semanticOperationId,
    ownerToken: lease.ownerToken,
    fence: lease.fence,
  };
}

function mongoLeaseFromRecord(params: {
  record: WhatsAppFlowSourceBindingFenceRecord;
  now: Date;
}): MongoFenceLease | null {
  const { record, now } = params;
  if (
    !record.ownerToken ||
    !record.kind ||
    !record.semanticOperationId ||
    !Number.isSafeInteger(record.fence) ||
    record.fence <= 0 ||
    !(record.leaseExpiresAt instanceof Date) ||
    record.leaseExpiresAt.getTime() <= now.getTime()
  ) {
    return null;
  }
  return {
    sourceId: String(record._id),
    workspaceId: record.workspaceId,
    kind: record.kind,
    semanticOperationId: record.semanticOperationId,
    ownerToken: record.ownerToken,
    fence: record.fence,
    leaseExpiresAt: record.leaseExpiresAt,
  };
}

function toSourceSnapshot(
  value: unknown
): WhatsAppSourceBindingSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const workspaceId =
    typeof record.workspace_id === "string"
      ? record.workspace_id.trim()
      : typeof record.workspaceId === "string"
        ? record.workspaceId.trim()
        : "";
  const updatedAt =
    typeof record.updated_at === "string"
      ? record.updated_at.trim()
      : typeof record.updatedAt === "string"
        ? record.updatedAt.trim()
        : "";
  const credentials = record.credentials;
  if (
    !id ||
    !workspaceId ||
    !updatedAt ||
    (credentials !== null &&
      (typeof credentials !== "object" || Array.isArray(credentials)))
  ) {
    return null;
  }
  return {
    id,
    workspaceId,
    updatedAt,
    credentials: (credentials || {}) as Record<string, unknown>,
  };
}

const defaultDependencies: WhatsAppFlowSourceBindingFenceStoreDependencies = {
  now: () => new Date(),
  newOwnerToken: randomUUID,
  async acquireMongoFence(params) {
    await connectDB();
    for (
      let attempt = 0;
      attempt < SOURCE_BINDING_ACQUIRE_ATTEMPTS;
      attempt += 1
    ) {
      try {
        const record = await WhatsAppFlowSourceBindingFence.findOneAndUpdate(
          {
            _id: params.sourceId,
            workspaceId: params.workspaceId,
            $or: [
              { ownerToken: params.ownerToken },
              { ownerToken: { $exists: false } },
              { leaseExpiresAt: { $lte: params.now } },
            ],
          },
          {
            $setOnInsert: {
              _id: params.sourceId,
              workspaceId: params.workspaceId,
            },
            $set: {
              kind: params.kind,
              semanticOperationId: params.semanticOperationId,
              ownerToken: params.ownerToken,
              leaseExpiresAt: params.leaseExpiresAt,
            },
            $inc: { fence: 1 },
          },
          {
            upsert: true,
            new: true,
            runValidators: true,
            setDefaultsOnInsert: true,
          }
        ).lean<WhatsAppFlowSourceBindingFenceRecord | null>();
        if (!record) continue;
        const lease = mongoLeaseFromRecord({ record, now: params.now });
        if (
          lease?.ownerToken === params.ownerToken &&
          lease.kind === params.kind &&
          lease.semanticOperationId === params.semanticOperationId
        ) {
          return lease;
        }
      } catch (error) {
        if (!isMongoDuplicateKeyError(error)) throw error;
      }
    }
    return null;
  },
  async renewMongoFence({ lease, now, leaseExpiresAt }) {
    await connectDB();
    const record = await WhatsAppFlowSourceBindingFence.findOneAndUpdate(
      {
        ...exactMongoFenceFilter(lease),
        leaseExpiresAt: { $gt: now, $lte: leaseExpiresAt },
      },
      { $set: { leaseExpiresAt } },
      { new: true, runValidators: true }
    ).lean<WhatsAppFlowSourceBindingFenceRecord | null>();
    return record ? mongoLeaseFromRecord({ record, now }) : null;
  },
  async assertMongoFence({ lease, now }) {
    await connectDB();
    const record = await WhatsAppFlowSourceBindingFence.exists({
      ...exactMongoFenceFilter(lease),
      leaseExpiresAt: { $gt: now },
    });
    return Boolean(record);
  },
  async releaseMongoFence(lease) {
    await connectDB();
    await WhatsAppFlowSourceBindingFence.updateOne(
      exactMongoFenceFilter(lease),
      {
        $unset: {
          ownerToken: 1,
          leaseExpiresAt: 1,
        },
      },
      { runValidators: true }
    );
  },
  async loadSource({ workspaceId, sourceId }) {
    const { data, error } = await supabaseAdmin
      .from("sources")
      .select("id, workspace_id, credentials, updated_at")
      .eq("id", sourceId)
      .eq("workspace_id", workspaceId)
      .eq("type", "whatsapp")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return toSourceSnapshot(data);
  },
  async compareAndSetSource({
    workspaceId,
    sourceId,
    expectedUpdatedAt,
    nextCredentials,
    sourcePatch,
  }) {
    const { data, error } = await supabaseAdmin
      .from("sources")
      .update({
        ...(sourcePatch || {}),
        credentials: nextCredentials,
      })
      .eq("id", sourceId)
      .eq("workspace_id", workspaceId)
      .eq("type", "whatsapp")
      .eq("updated_at", expectedUpdatedAt)
      .select("id, workspace_id, credentials, updated_at")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return toSourceSnapshot(data);
  },
};

export function createWhatsAppFlowSourceBindingFenceStore(
  dependencies: WhatsAppFlowSourceBindingFenceStoreDependencies = defaultDependencies
) {
  const assertAndLoad = async (
    inputLease: WhatsAppFlowSourceBindingFenceLease
  ): Promise<WhatsAppSourceBindingSnapshot> => {
    const lease = normalizedLease(inputLease);
    const mongoCurrent = await dependencies.assertMongoFence({
      lease,
      now: dependencies.now(),
    });
    if (!mongoCurrent) {
      throw new WhatsAppFlowSourceBindingFenceConflictError();
    }
    const source = await dependencies.loadSource({
      workspaceId: lease.workspaceId,
      sourceId: lease.sourceId,
    });
    if (
      !source ||
      source.id !== lease.sourceId ||
      source.workspaceId !== lease.workspaceId ||
      sourceWabaId(source) !== lease.expectedWabaId ||
      activatedFence(source) !== lease.fence
    ) {
      throw new WhatsAppFlowSourceBindingFenceConflictError();
    }
    return source;
  };

  return {
    async updateCurrent(params: {
      workspaceId: string;
      sourceId: string;
      expectedWabaId: string;
      buildCredentials(
        current: Readonly<Record<string, unknown>>
      ): Record<string, unknown>;
      sourcePatch?: SourcePatch;
    }): Promise<WhatsAppSourceBindingSnapshot> {
      const workspaceId = requiredString(params.workspaceId, "Workspace id");
      const sourceId = requiredString(params.sourceId, "Source id");
      const expectedWabaId = bindingString(
        params.expectedWabaId,
        "Expected WABA id"
      );
      const source = await dependencies.loadSource({ workspaceId, sourceId });
      if (!source || sourceWabaId(source) !== expectedWabaId) {
        throw new WhatsAppFlowSourceBindingFenceConflictError();
      }
      const currentFence = activatedFence(source);
      const nextCredentials = prepareSourceFenceCredentials({
        current: source.credentials,
        now: dependencies.now(),
        candidate: params.buildCredentials(source.credentials),
        ...(currentFence !== null ? { fence: currentFence } : {}),
      });
      const nextSource = { ...source, credentials: nextCredentials };
      if (sourceWabaId(nextSource) !== expectedWabaId) {
        throw new WhatsAppFlowSourceBindingFenceConflictError();
      }
      const updated = await dependencies.compareAndSetSource({
        workspaceId,
        sourceId,
        expectedUpdatedAt: source.updatedAt,
        nextCredentials,
        ...(params.sourcePatch ? { sourcePatch: params.sourcePatch } : {}),
      });
      if (
        !updated ||
        sourceWabaId(updated) !== expectedWabaId ||
        activatedFence(updated) !== currentFence
      ) {
        throw new WhatsAppFlowSourceBindingFenceConflictError();
      }
      return updated;
    },

    async acquire(params: {
      workspaceId: string;
      sourceId: string;
      expectedWabaId: string;
      kind: WhatsAppFlowSourceBindingFenceKind;
      semanticOperationId: string;
    }): Promise<WhatsAppFlowSourceBindingFenceLease> {
      const workspaceId = requiredString(params.workspaceId, "Workspace id");
      const sourceId = requiredString(params.sourceId, "Source id");
      const expectedWabaId = bindingString(
        params.expectedWabaId,
        "Expected WABA id"
      );
      const kind = normalizedKind(params.kind);
      const semanticOperationId = requiredString(
        params.semanticOperationId,
        "Semantic operation id"
      );
      const ownerToken = requiredString(
        dependencies.newOwnerToken(),
        "Owner token"
      );
      const now = dependencies.now();
      const leaseExpiresAt = new Date(
        now.getTime() + SOURCE_BINDING_LEASE_DURATION_MS
      );
      const mongoLease = await dependencies.acquireMongoFence({
        workspaceId,
        sourceId,
        kind,
        semanticOperationId,
        ownerToken,
        now,
        leaseExpiresAt,
      });
      if (!mongoLease) {
        throw new WhatsAppFlowSourceBindingFenceConflictError();
      }
      const lease: WhatsAppFlowSourceBindingFenceLease = {
        ...mongoLease,
        expectedWabaId,
      };

      try {
        const source = await dependencies.loadSource({ workspaceId, sourceId });
        if (
          !source ||
          sourceWabaId(source) !== expectedWabaId ||
          (activatedFence(source) !== null &&
            activatedFence(source)! > lease.fence)
        ) {
          throw new WhatsAppFlowSourceBindingFenceConflictError();
        }
        const activated = await dependencies.compareAndSetSource({
          workspaceId,
          sourceId,
          expectedUpdatedAt: source.updatedAt,
          nextCredentials: {
            ...source.credentials,
            [WHATSAPP_FLOW_SOURCE_FENCE_CREDENTIAL_FIELD]: lease.fence,
          },
        });
        if (
          !activated ||
          sourceWabaId(activated) !== expectedWabaId ||
          activatedFence(activated) !== lease.fence
        ) {
          throw new WhatsAppFlowSourceBindingFenceConflictError();
        }
        return lease;
      } catch (error) {
        await dependencies.releaseMongoFence(lease).catch(() => undefined);
        if (error instanceof WhatsAppFlowSourceBindingFenceConflictError) {
          throw error;
        }
        throw new WhatsAppFlowSourceBindingFenceConflictError();
      }
    },

    async renew(
      inputLease: WhatsAppFlowSourceBindingFenceLease
    ): Promise<WhatsAppFlowSourceBindingFenceLease> {
      const lease = normalizedLease(inputLease);
      const now = dependencies.now();
      const renewed = await dependencies.renewMongoFence({
        lease,
        now,
        leaseExpiresAt: new Date(
          now.getTime() + SOURCE_BINDING_LEASE_DURATION_MS
        ),
      });
      if (!renewed) {
        throw new WhatsAppFlowSourceBindingFenceConflictError();
      }
      const nextLease = { ...renewed, expectedWabaId: lease.expectedWabaId };
      await assertAndLoad(nextLease);
      return nextLease;
    },

    async assertCurrent(
      lease: WhatsAppFlowSourceBindingFenceLease
    ): Promise<WhatsAppSourceBindingSnapshot> {
      return assertAndLoad(lease);
    },

    async commit(params: {
      lease: WhatsAppFlowSourceBindingFenceLease;
      nextWabaId: string;
      buildCredentials(
        current: Readonly<Record<string, unknown>>
      ): Record<string, unknown>;
      sourcePatch?: SourcePatch;
    }): Promise<WhatsAppSourceBindingSnapshot> {
      const lease = normalizedLease(params.lease);
      const nextWabaId = requiredString(params.nextWabaId, "Next WABA id");
      const source = await assertAndLoad(lease);
      const nextCredentials = prepareSourceFenceCredentials({
        current: source.credentials,
        now: dependencies.now(),
        candidate: params.buildCredentials(source.credentials),
        fence: lease.fence,
      });
      const nextSource = { ...source, credentials: nextCredentials };
      if (sourceWabaId(nextSource) !== nextWabaId) {
        throw new Error(
          "Next WhatsApp credentials do not match the WABA binding"
        );
      }
      const committed = await dependencies.compareAndSetSource({
        workspaceId: lease.workspaceId,
        sourceId: lease.sourceId,
        expectedUpdatedAt: source.updatedAt,
        nextCredentials,
        ...(params.sourcePatch ? { sourcePatch: params.sourcePatch } : {}),
      });
      if (
        !committed ||
        sourceWabaId(committed) !== nextWabaId ||
        activatedFence(committed) !== lease.fence
      ) {
        throw new WhatsAppFlowSourceBindingFenceConflictError();
      }
      return committed;
    },

    async release(lease: WhatsAppFlowSourceBindingFenceLease): Promise<void> {
      await dependencies.releaseMongoFence(normalizedLease(lease));
    },
  };
}

export const whatsAppFlowSourceBindingFenceStore =
  createWhatsAppFlowSourceBindingFenceStore();
