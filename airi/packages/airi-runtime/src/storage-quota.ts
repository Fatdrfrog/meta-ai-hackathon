import { createHash } from "node:crypto";
import type { Connection, mongo } from "mongoose";

export const COMPANY_STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;

export function getStorageQuotaRolloutMode(): "strict" | "record" {
  return process.env.STORAGE_QUOTA_ROLLOUT_MODE === "record"
    ? "record"
    : "strict";
}

export type StorageObjectInput = {
  companyId: string;
  workspaceId: string;
  provider: "gcs" | "supabase";
  bucket: string;
  path: string;
  bytes: number;
  grantByteCeiling?: number;
  generation?: string;
  expiresAt?: Date;
};

export type StorageObjectRecord = StorageObjectInput & {
  _id: string;
  status: "reserved" | "stored" | "tombstoned";
  createdAt: Date;
  checkedAt?: Date;
  publicationRevision?: number;
  retainedGeneration?: string;
};

export type StorageGeneration = { generation: string; bytes: number };

export type CompanyStorageUsage = {
  _id: string;
  ready: boolean;
  limitBytes: number;
  chargedBytes: number;
  storedBytes: number;
  inventoryStartedAt: Date;
  inventoryCompletedAt?: Date;
};

export class StorageQuotaError extends Error {
  constructor(
    readonly code:
      | "storage_inventory_required"
      | "company_storage_limit_exceeded"
      | "storage_object_deleted"
      | "storage_identity_conflict",
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "StorageQuotaError";
  }
}

export function storageObjectId(
  input: Pick<
    StorageObjectInput,
    "provider" | "bucket" | "path" | "generation"
  >,
): string {
  return createHash("sha256")
    .update(
      `${input.provider}\0${input.bucket}\0${input.path}${input.generation ? `\0${input.generation}` : ""}`,
    )
    .digest("hex");
}

function assertBytes(bytes: number, allowEmpty = false): void {
  if (!Number.isSafeInteger(bytes) || bytes < (allowEmpty ? 0 : 1)) {
    throw new Error("Storage byte count must be a safe positive integer");
  }
}

function assertOwnership(
  existing: StorageObjectRecord,
  input: StorageObjectInput,
): void {
  if (
    existing.companyId !== input.companyId ||
    existing.workspaceId !== input.workspaceId
  ) {
    throw new StorageQuotaError(
      "storage_identity_conflict",
      "Storage object identity conflicts with an existing reservation",
    );
  }
}

function assertIdentity(
  existing: StorageObjectRecord,
  input: StorageObjectInput,
): void {
  assertOwnership(existing, input);
  if (existing.bytes !== input.bytes)
    throw new StorageQuotaError(
      "storage_identity_conflict",
      "Storage object identity conflicts with an existing reservation",
    );
}

function assertActive(
  record: StorageObjectRecord,
): asserts record is StorageObjectRecord & { status: "reserved" | "stored" } {
  if (record.status === "tombstoned")
    throw new StorageQuotaError(
      "storage_object_deleted",
      "Storage object was deleted; use a new object identity",
    );
}

export class StorageQuotaStore {
  constructor(
    private readonly connection: Connection,
    private readonly rolloutMode = getStorageQuotaRolloutMode(),
  ) {}

  private get accounts() {
    return this.connection.db!.collection<CompanyStorageUsage>(
      "company_storage_usage",
    );
  }

  private get objects() {
    return this.connection.db!.collection<StorageObjectRecord>(
      "company_storage_objects",
    );
  }

  async ensureIndexes(): Promise<void> {
    await this.objects.createIndex({ companyId: 1, status: 1, _id: 1 });
    await this.objects.createIndex({ workspaceId: 1, provider: 1, path: 1 });
  }

  private async transaction<T>(
    run: (session: mongo.ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = this.connection.getClient().startSession();
    try {
      return (await session.withTransaction(() => run(session), {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        maxCommitTimeMS: 10_000,
      })) as T;
    } finally {
      await session.endSession();
    }
  }

  async reserve(
    input: StorageObjectInput,
  ): Promise<StorageObjectRecord & { status: "reserved" | "stored" }> {
    assertBytes(input.bytes);
    if (
      input.grantByteCeiling !== undefined &&
      input.grantByteCeiling !== input.bytes
    )
      throw new Error(
        "Upload grant ceiling must equal its reserved byte count",
      );
    if (
      ![input.companyId, input.workspaceId, input.bucket, input.path].every(
        (value) => value.trim(),
      )
    ) {
      throw new Error(
        "Storage reservation requires company, workspace and object identity",
      );
    }
    const _id = storageObjectId(input);
    return this.transaction(async (session) => {
      const existing = await this.objects.findOne({ _id }, { session });
      if (existing) {
        assertActive(existing);
        assertIdentity(existing, input);
        return existing;
      }
      let account = await this.accounts.findOne(
        { _id: input.companyId },
        { session },
      );
      if (!account?.ready && this.rolloutMode !== "record") {
        throw new StorageQuotaError(
          "storage_inventory_required",
          "Storage inventory is required before new uploads can be accepted",
          503,
        );
      }
      if (!account) {
        account = {
          _id: input.companyId,
          ready: false,
          limitBytes: COMPANY_STORAGE_LIMIT_BYTES,
          chargedBytes: 0,
          storedBytes: 0,
          inventoryStartedAt: new Date(),
        };
        await this.accounts.insertOne(account, { session });
      }
      const result = await this.accounts.updateOne(
        {
          _id: input.companyId,
          ready: account.ready,
          $expr: {
            $lte: [{ $add: ["$chargedBytes", input.bytes] }, "$limitBytes"],
          },
        },
        { $inc: { chargedBytes: input.bytes } },
        { session },
      );
      if (result.modifiedCount !== 1) {
        throw new StorageQuotaError(
          "company_storage_limit_exceeded",
          "Company storage limit exceeded. The allowance is 10 GiB.",
        );
      }
      const record: StorageObjectRecord & { status: "reserved" } = {
        ...input,
        _id,
        status: "reserved",
        createdAt: new Date(),
      };
      await this.objects.insertOne(record, { session });
      return record;
    });
  }

  async settle(
    id: string,
    bytes: number,
    persist?: (session: mongo.ClientSession) => Promise<void>,
  ): Promise<void> {
    assertBytes(bytes, true);
    await this.transaction(async (session) => {
      const record = await this.objects.findOne({ _id: id }, { session });
      if (!record) throw new Error("Storage reservation was not found");
      assertActive(record);
      if (record.status === "stored") {
        if (record.bytes !== bytes)
          throw new Error("Stored object size changed after settlement");
        // Take a write conflict with deletion before publishing an asset record.
        if (persist) {
          await this.objects.updateOne(
            { _id: id },
            {
              $inc: { publicationRevision: 1 },
              $set: { checkedAt: new Date() },
            },
            { session },
          );
          await persist(session);
        }
        return;
      }
      await this.settleRecord(record, bytes, session);
      await persist?.(session);
    });
  }

  private async settleRecord(
    record: StorageObjectRecord,
    bytes: number,
    session: mongo.ClientSession,
  ): Promise<void> {
    // Authoritative excess is debt, never a reason to omit a physical object.
    await this.accounts.updateOne(
      { _id: record.companyId },
      {
        $inc: {
          chargedBytes:
            Math.max(bytes, record.grantByteCeiling || 0) - record.bytes,
          storedBytes: bytes,
        },
      },
      { session },
    );
    await this.objects.updateOne(
      { _id: record._id },
      {
        $set: { bytes, status: "stored", checkedAt: new Date() },
      },
      { session },
    );
  }

  async tombstone(id: string, observed?: StorageGeneration): Promise<void> {
    if (observed) {
      assertBytes(observed.bytes, true);
      if (!observed.generation.trim())
        throw new Error("Storage generation is required");
    }
    await this.transaction(async (session) => {
      const record = await this.objects.findOne({ _id: id }, { session });
      if (!record)
        throw new StorageQuotaError(
          "storage_inventory_required",
          "Storage inventory is required before deleting this object",
          503,
        );
      if (observed) {
        if (record.provider !== "gcs" || record.generation)
          throw new Error("Retained generation requires a current GCS object");
        if (
          record.retainedGeneration &&
          record.retainedGeneration !== observed.generation
        )
          throw new Error(
            "Storage generation changed after deletion was claimed",
          );
        if (record.status === "reserved")
          await this.settleRecord(record, observed.bytes, session);
        else if (record.bytes !== observed.bytes)
          throw new Error("Storage object size changed before deletion");
      }
      await this.objects.updateOne(
        { _id: id },
        {
          $set: {
            status: "tombstoned",
            checkedAt: new Date(),
            ...(observed ? { retainedGeneration: observed.generation } : {}),
          },
        },
        { session },
      );
    });
    // Retained generations and issued requests keep their allocation. No refund.
  }

  async beginInventory(
    companyId: string,
    limitBytes = COMPANY_STORAGE_LIMIT_BYTES,
  ): Promise<void> {
    assertBytes(limitBytes);
    await this.transaction(async (session) => {
      const existing = await this.accounts.findOne(
        { _id: companyId },
        { session },
      );
      if (existing?.ready)
        throw new Error(
          "Storage inventory is already active; it cannot reset capacity",
        );
      if (existing) return;
      await this.accounts.insertOne(
        {
          _id: companyId,
          ready: false,
          limitBytes,
          chargedBytes: 0,
          storedBytes: 0,
          inventoryStartedAt: new Date(),
        },
        { session },
      );
    });
  }

  async inventoryObject(input: StorageObjectInput): Promise<void> {
    assertBytes(input.bytes, true);
    await this.transaction(async (session) => {
      const account = await this.accounts.findOne(
        { _id: input.companyId, ready: false },
        { session },
      );
      if (!account) throw new Error("Storage inventory is not open");
      const _id = storageObjectId(input);
      if (input.provider === "gcs" && input.generation) {
        const current = await this.objects.findOne(
          { _id: storageObjectId({ ...input, generation: undefined }) },
          { session },
        );
        if (current?.status === "tombstoned") {
          assertOwnership(current, input);
          if (!current.retainedGeneration)
            throw new Error(
              "Retained generation is unknown; reconcile this object's deletion before activation",
            );
          if (current.retainedGeneration === input.generation) {
            assertIdentity(current, input);
            return;
          }
        }
      }
      const existing = await this.objects.findOne({ _id }, { session });
      if (existing) {
        assertOwnership(existing, input);
        if (existing.status === "reserved") {
          await this.settleRecord(existing, input.bytes, session);
          return;
        }
        if (existing.status === "tombstoned") {
          if (input.bytes !== 0)
            throw new Error(
              "Storage tombstone changed; reconcile its provider generation before activation",
            );
          return;
        }
        assertIdentity(existing, input);
        return;
      }
      await this.objects.insertOne(
        {
          ...input,
          _id,
          status: "stored",
          createdAt: new Date(),
          checkedAt: new Date(),
        },
        { session },
      );
      await this.accounts.updateOne(
        { _id: input.companyId, ready: false },
        {
          $inc: { chargedBytes: input.bytes, storedBytes: input.bytes },
        },
        { session },
      );
    });
  }

  async finishInventory(companyId: string): Promise<void> {
    const result = await this.accounts.updateOne(
      { _id: companyId, ready: false },
      {
        $set: { ready: true, inventoryCompletedAt: new Date() },
      },
    );
    if (result.modifiedCount !== 1)
      throw new Error("Storage inventory is not open");
  }

  async usage(companyId: string): Promise<CompanyStorageUsage | null> {
    return this.accounts.findOne({ _id: companyId });
  }

  async read(id: string): Promise<StorageObjectRecord | null> {
    return this.objects.findOne({ _id: id });
  }

  async readWorkspaceObject(
    input: Pick<StorageObjectInput, "workspaceId" | "provider" | "path">,
  ): Promise<StorageObjectRecord | null> {
    return this.objects.findOne(
      { ...input, generation: { $exists: false } },
      { maxTimeMS: 10_000 },
    );
  }

  async pending(
    companyId: string,
    afterId = "",
    limit = 100,
  ): Promise<StorageObjectRecord[]> {
    return this.objects
      .find({ companyId, status: "reserved", _id: { $gt: afterId } })
      .sort({ _id: 1 })
      .limit(Math.max(1, Math.min(500, limit)))
      .maxTimeMS(10_000)
      .toArray();
  }

  async reconcile(
    id: string,
    object: { exists: false } | { exists: true; bytes: number },
  ): Promise<void> {
    if (object.exists) {
      await this.settle(id, object.bytes);
    } else {
      // Absence is not cancellation: an issued request may still complete.
      await this.objects.updateOne(
        { _id: id, status: "reserved" },
        { $set: { checkedAt: new Date() } },
      );
    }
  }
}

export async function getStorageQuotaStore(): Promise<StorageQuotaStore> {
  const { default: connectDB } = await import("./mongoose");
  const mongoose = await connectDB();
  return new StorageQuotaStore(mongoose.connection);
}

export async function resolveStorageCompanyId(
  workspaceId: string,
): Promise<string> {
  const baseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !key)
    throw new Error("Storage company lookup is unavailable");
  const query = new URLSearchParams({
    id: `eq.${workspaceId}`,
    select: "company_id",
    limit: "1",
  });
  const response = await fetch(
    `${baseUrl.replace(/\/$/, "")}/rest/v1/workspaces?${query}`,
    {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) throw new Error("Storage company lookup failed");
  const rows = (await response.json()) as Array<{ company_id?: unknown }>;
  const companyId = rows[0]?.company_id;
  if (typeof companyId !== "string" || !companyId)
    throw new Error("Workspace company was not found");
  return companyId;
}

export async function reserveWorkspaceStorage(
  input: Omit<StorageObjectInput, "companyId">,
): Promise<StorageObjectRecord & { status: "reserved" | "stored" }> {
  const companyId = await resolveStorageCompanyId(input.workspaceId);
  return (await getStorageQuotaStore()).reserve({ ...input, companyId });
}

export async function settleStorageObject(
  id: string,
  bytes: number,
  persist?: (session: mongo.ClientSession) => Promise<void>,
): Promise<void> {
  await (await getStorageQuotaStore()).settle(id, bytes, persist);
}

export async function tombstoneStorageObject(
  id: string,
  observed?: StorageGeneration,
): Promise<void> {
  await (await getStorageQuotaStore()).tombstone(id, observed);
}

export async function readStorageObject(
  id: string,
): Promise<StorageObjectRecord | null> {
  return (await getStorageQuotaStore()).read(id);
}

export async function readWorkspaceStorageObject(
  input: Pick<StorageObjectInput, "workspaceId" | "provider" | "path">,
): Promise<StorageObjectRecord | null> {
  return (await getStorageQuotaStore()).readWorkspaceObject(input);
}

type StorageWriteQuota = {
  reserve(
    input: Omit<StorageObjectInput, "companyId">,
  ): Promise<{ _id: string; status?: StorageObjectRecord["status"] }>;
  settle(id: string, bytes: number): Promise<void>;
};

const workspaceStorageQuota: StorageWriteQuota = {
  reserve: reserveWorkspaceStorage,
  settle: settleStorageObject,
};

export async function storeSupabaseWorkspaceBuffer(params: {
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        buffer: Buffer,
        options: { contentType: string; cacheControl: string; upsert: false },
      ): Promise<{ error?: { message?: string } | null }>;
      info?(
        path: string,
      ): Promise<{ data?: { size?: number } | null; error?: unknown }>;
    };
  };
  workspaceId: string;
  bucket: string;
  path: string;
  buffer: Buffer;
  mimeType: string;
  cacheControl?: string;
  quota?: StorageWriteQuota;
}): Promise<void> {
  const quota = params.quota || workspaceStorageQuota;
  const claim = await quota.reserve({
    workspaceId: params.workspaceId,
    provider: "supabase",
    bucket: params.bucket,
    path: params.path,
    bytes: params.buffer.byteLength,
  });
  if (claim.status === "tombstoned")
    throw new StorageQuotaError(
      "storage_object_deleted",
      "Storage object was deleted; use a new object identity",
    );
  if (claim.status === "stored") return;
  const bucket = params.storage.from(params.bucket);
  try {
    const { error } = await bucket.upload(params.path, params.buffer, {
      contentType: params.mimeType,
      cacheControl: params.cacheControl || "31536000",
      upsert: false,
    });
    if (error) throw new Error(error.message || "Storage upload failed");
  } catch (error) {
    const existing = await bucket.info?.(params.path).catch(() => null);
    if (existing?.error || existing?.data?.size !== params.buffer.byteLength)
      throw error;
  }
  await quota.settle(claim._id, params.buffer.byteLength);
}

export async function createReservedSupabaseUpload(params: {
  storage: {
    getBucket(bucket: string): Promise<{
      data?: { file_size_limit?: number | null } | null;
      error?: unknown;
    }>;
    from(bucket: string): {
      createSignedUploadUrl(
        path: string,
        options: { upsert: false },
      ): Promise<{
        data?: { token: string } | null;
        error?: { message?: string } | null;
      }>;
    };
  };
  workspaceId: string;
  bucket: string;
  path: string;
  declaredBytes: number;
  quota?: StorageWriteQuota;
}): Promise<{ token: string }> {
  assertBytes(params.declaredBytes);
  const { data: bucket, error } = await params.storage.getBucket(params.bucket);
  const maximumBytes = bucket?.file_size_limit;
  if (
    error ||
    !Number.isSafeInteger(maximumBytes) ||
    !maximumBytes ||
    maximumBytes < 1
  ) {
    throw new StorageQuotaError(
      "storage_inventory_required",
      "A finite provider bucket upload limit is required before direct uploads",
      503,
    );
  }
  if (params.declaredBytes > maximumBytes)
    throw new Error("File exceeds the provider bucket upload limit");
  const claim = await (params.quota || workspaceStorageQuota).reserve({
    workspaceId: params.workspaceId,
    provider: "supabase",
    bucket: params.bucket,
    path: params.path,
    bytes: maximumBytes,
    grantByteCeiling: maximumBytes,
    expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
  });
  if (claim.status === "tombstoned")
    throw new StorageQuotaError(
      "storage_object_deleted",
      "Storage object was deleted; use a new object identity",
    );
  if (claim.status === "stored")
    throw new StorageQuotaError(
      "storage_identity_conflict",
      "Storage object is already stored; use a new object identity",
    );
  const grant = await params.storage
    .from(params.bucket)
    .createSignedUploadUrl(params.path, { upsert: false });
  if (grant.error || !grant.data?.token)
    throw new Error(
      grant.error?.message || "Storage upload token was not returned",
    );
  return { token: grant.data.token };
}
