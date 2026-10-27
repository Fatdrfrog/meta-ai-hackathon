import { createHash, randomUUID } from "node:crypto";

import { Storage } from "@google-cloud/storage";
import { readTrimmedString } from "./value-utils";

/** Object prefix — keep Temporal `itemsPayloadKey` as the full object path. */
export const BULK_DISPATCH_PAYLOAD_KEY_PREFIX = "bulk_campaign_dispatch/v1";
/** 7d — large queues / worker outages should not expire payload mid-run */
export const BULK_DISPATCH_PAYLOAD_BASE_TTL_SEC = 604800;
/** GCS-friendly ceiling (was 12MB on Upstash Redis). */
export const BULK_DISPATCH_PAYLOAD_MAX_BYTES = 256 * 1024 * 1024;
const CHUNK_MAX_ITEMS = 100;
const CHUNK_MAX_BYTES = 256 * 1024;

type PayloadManifest = {
  version: 2;
  itemCount: number;
  chunks: Array<{
    offset: number;
    count: number;
    byteLength: number;
    sha256: string;
  }>;
};

type BulkDispatchGcsFile = {
  save: (
    data: Buffer | string,
    options?: {
      resumable?: boolean;
      contentType?: string;
      preconditionOpts?: { ifGenerationMatch: number };
      metadata?: {
        contentType?: string;
        customTime?: string;
        metadata?: Record<string, string>;
      };
    },
  ) => Promise<unknown>;
  download: () => Promise<[Buffer]>;
};

export type BulkDispatchGcsClient = {
  bucket: (name: string) => {
    file: (path: string) => BulkDispatchGcsFile;
  };
};

let storageClient: BulkDispatchGcsClient | null | undefined;
let storageOverride: BulkDispatchGcsClient | null | undefined;

export function getBulkDispatchBucketName(): string {
  return (
    readTrimmedString(process.env.GCS_BULK_DISPATCH_BUCKET) ||
    readTrimmedString(process.env.GCS_CREATIVE_ASSETS_BUCKET)
  );
}

export function isBulkDispatchPayloadStoreConfigured(): boolean {
  return Boolean(getBulkDispatchBucketName());
}

export function resolveBulkDispatchPayloadTtlSeconds(params?: {
  retainUntil?: string | Date | null;
  now?: Date;
}): number {
  const retainUntil = params?.retainUntil;
  if (!retainUntil) return BULK_DISPATCH_PAYLOAD_BASE_TTL_SEC;

  const retainUntilMs =
    retainUntil instanceof Date
      ? retainUntil.getTime()
      : Date.parse(retainUntil);
  if (!Number.isFinite(retainUntilMs)) {
    return BULK_DISPATCH_PAYLOAD_BASE_TTL_SEC;
  }

  const nowMs = params?.now?.getTime() ?? Date.now();
  const secondsUntilRetain = Math.ceil((retainUntilMs - nowMs) / 1000);
  return Math.max(
    BULK_DISPATCH_PAYLOAD_BASE_TTL_SEC,
    secondsUntilRetain + BULK_DISPATCH_PAYLOAD_BASE_TTL_SEC,
  );
}

function assertKeyForWorkspace(workspaceId: string, payloadKey: string): void {
  const expectedPrefix = `${BULK_DISPATCH_PAYLOAD_KEY_PREFIX}/${workspaceId}/`;
  if (
    !payloadKey.startsWith(expectedPrefix) ||
    payloadKey.includes("..") ||
    payloadKey.startsWith("/")
  ) {
    throw new Error("Invalid bulk dispatch payload key for workspace");
  }
}

/**
 * Default client uses Application Default Credentials (Cloud Run SA, gcloud ADC,
 * or GOOGLE_APPLICATION_CREDENTIALS file). No separate JSON env required.
 * Vercel WIF injects a REST client via {@link setBulkDispatchStorageClient}.
 */
function createDefaultStorageClient(): BulkDispatchGcsClient {
  return new Storage({
    projectId:
      readTrimmedString(process.env.GOOGLE_CLOUD_PROJECT) ||
      readTrimmedString(process.env.GCP_PROJECT_ID) ||
      undefined,
  }) as unknown as BulkDispatchGcsClient;
}

function getStorageClient(): BulkDispatchGcsClient {
  if (storageOverride !== undefined && storageOverride !== null) {
    return storageOverride;
  }
  if (storageClient) return storageClient;
  storageClient = createDefaultStorageClient();
  return storageClient;
}

/** Inject Storage client (Vercel WIF REST, tests). Pass `null` to reset to ADC. */
export function setBulkDispatchStorageClient(
  client: BulkDispatchGcsClient | null,
): void {
  storageOverride = client;
  if (client === null) {
    storageClient = undefined;
  }
}

/** @deprecated Prefer {@link setBulkDispatchStorageClient} */
export function setBulkDispatchStorageClientForTests(
  client: BulkDispatchGcsClient | null,
): void {
  setBulkDispatchStorageClient(client);
}

/**
 * Publish the manifest only after its immutable chunks have been saved.
 */
export async function storeBulkCampaignDispatchItems<T>(params: {
  workspaceId: string;
  items: T[];
  retainUntil?: string | Date | null;
}): Promise<{ payloadKey: string; byteLength: number }> {
  const bucketName = getBulkDispatchBucketName();
  if (!bucketName) {
    throw new Error(
      "GCS_BULK_DISPATCH_BUCKET (or GCS_CREATIVE_ASSETS_BUCKET) required for large bulk campaigns",
    );
  }

  const chunks: string[] = [];
  const manifest: PayloadManifest = {
    version: 2,
    itemCount: params.items.length,
    chunks: [],
  };
  let chunk: string[] = [];
  let chunkBytes = 2;
  let byteLength = 2;
  let offset = 0;
  const flush = () => {
    if (!chunk.length) return;
    const payload = `[${chunk.join(",")}]`;
    manifest.chunks.push({
      offset,
      count: chunk.length,
      byteLength: chunkBytes,
      sha256: createHash("sha256").update(payload).digest("hex"),
    });
    chunks.push(payload);
    offset += chunk.length;
    chunk = [];
    chunkBytes = 2;
  };
  for (const item of params.items) {
    const serialized = JSON.stringify(item) ?? "null";
    const itemBytes = Buffer.byteLength(serialized, "utf8");
    if (itemBytes + 2 > CHUNK_MAX_BYTES)
      throw new Error("Bulk campaign item exceeds staging chunk limit");
    byteLength += itemBytes + (offset + chunk.length > 0 ? 1 : 0);
    if (byteLength > BULK_DISPATCH_PAYLOAD_MAX_BYTES)
      throw new Error(
        `Bulk campaign payload too large for staging store (${byteLength} bytes; max ${BULK_DISPATCH_PAYLOAD_MAX_BYTES})`,
      );
    if (
      chunk.length >= CHUNK_MAX_ITEMS ||
      chunkBytes + itemBytes + 1 > CHUNK_MAX_BYTES
    )
      flush();
    chunkBytes += itemBytes + (chunk.length ? 1 : 0);
    chunk.push(serialized);
  }
  flush();

  const ttlSeconds = resolveBulkDispatchPayloadTtlSeconds({
    retainUntil: params.retainUntil,
  });
  // Expire-at timestamp for GCS Object Lifecycle `daysSinceCustomTime: 0`
  // (official Custom-Time + DaysSinceCustomTime model — not `age`).
  const expireAt = new Date(Date.now() + ttlSeconds * 1000);
  const payloadKey = `${BULK_DISPATCH_PAYLOAD_KEY_PREFIX}/${params.workspaceId}/${randomUUID()}.json`;

  const bucket = getStorageClient().bucket(bucketName);
  const saveOptions = {
    resumable: false,
    preconditionOpts: { ifGenerationMatch: 0 },
    contentType: "application/json; charset=utf-8",
    metadata: {
      contentType: "application/json; charset=utf-8",
      customTime: expireAt.toISOString(),
      metadata: {
        workspaceId: params.workspaceId,
        ttlSeconds: String(ttlSeconds),
        retainUntil:
          params.retainUntil instanceof Date
            ? params.retainUntil.toISOString()
            : params.retainUntil
              ? String(params.retainUntil)
              : "",
      },
    },
  };
  for (let index = 0; index < chunks.length; index++) {
    await bucket
      .file(`${payloadKey}.chunks/${index}.json`)
      .save(chunks[index]!, saveOptions);
  }
  await bucket.file(payloadKey).save(JSON.stringify(manifest), saveOptions);

  return { payloadKey, byteLength };
}

/**
 * Old staged arrays remain readable until their existing lifecycle expires.
 */
export async function loadBulkCampaignDispatchItemsSlice<T = unknown>(params: {
  workspaceId: string;
  payloadKey: string;
  offset: number;
  limit: number;
}): Promise<T[]> {
  assertKeyForWorkspace(params.workspaceId, params.payloadKey);
  const { offset, limit } = params;
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(limit) ||
    offset < 0 ||
    limit < 1 ||
    !Number.isSafeInteger(offset + limit)
  ) {
    throw new Error("Invalid bulk dispatch slice bounds");
  }
  const bucketName = getBulkDispatchBucketName();
  if (!bucketName) {
    throw new Error(
      "GCS bulk dispatch bucket not configured; cannot load bulk dispatch payload",
    );
  }

  const file = getStorageClient().bucket(bucketName).file(params.payloadKey);
  let buffer: Buffer;
  try {
    const [downloaded] = await file.download();
    buffer = downloaded;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? Number((error as { code?: unknown }).code)
        : NaN;
    if (code === 404) {
      throw new Error(
        "Bulk dispatch payload expired or missing - retry the campaign from the API",
      );
    }
    throw error;
  }

  const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
  if (Array.isArray(parsed)) return parsed.slice(offset, offset + limit) as T[];
  const manifest = parsed as PayloadManifest | null;
  if (
    !manifest ||
    manifest.version !== 2 ||
    !Number.isSafeInteger(manifest.itemCount) ||
    manifest.itemCount < 0 ||
    !Array.isArray(manifest.chunks)
  ) {
    throw new Error("Invalid bulk dispatch payload manifest");
  }
  let expectedOffset = 0;
  for (const chunk of manifest.chunks) {
    if (
      !chunk ||
      chunk.offset !== expectedOffset ||
      !Number.isSafeInteger(chunk.count) ||
      chunk.count < 1 ||
      chunk.count > CHUNK_MAX_ITEMS ||
      !Number.isSafeInteger(chunk.byteLength) ||
      chunk.byteLength < 2 ||
      chunk.byteLength > CHUNK_MAX_BYTES ||
      !/^[a-f0-9]{64}$/.test(chunk.sha256)
    ) {
      throw new Error("Invalid bulk dispatch payload manifest chunk");
    }
    expectedOffset += chunk.count;
  }
  if (expectedOffset !== manifest.itemCount)
    throw new Error("Invalid bulk dispatch payload manifest count");
  const result: T[] = [];
  for (const [index, chunk] of manifest.chunks.entries()) {
    if (chunk.offset + chunk.count <= offset || chunk.offset >= offset + limit)
      continue;
    const [data] = await getStorageClient()
      .bucket(bucketName)
      .file(`${params.payloadKey}.chunks/${index}.json`)
      .download();
    if (
      data.byteLength !== chunk.byteLength ||
      createHash("sha256").update(data).digest("hex") !== chunk.sha256
    )
      throw new Error("Bulk dispatch payload chunk integrity mismatch");
    const items: unknown = JSON.parse(data.toString("utf8"));
    if (!Array.isArray(items) || items.length !== chunk.count)
      throw new Error("Bulk dispatch payload chunk count mismatch");
    result.push(
      ...items.slice(
        Math.max(0, offset - chunk.offset),
        offset + limit - chunk.offset,
      ),
    );
  }
  return result;
}
