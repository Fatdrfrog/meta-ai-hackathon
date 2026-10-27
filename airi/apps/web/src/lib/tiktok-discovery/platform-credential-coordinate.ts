import "server-only";

import { randomBytes } from "node:crypto";

import type { CachePublishResult } from "@icecore/shared/lib/cache";

import { buildCacheKey, cache } from "@/lib/cache";
import {
  markTikTokPlatformCredentialFailure,
  markTikTokPlatformCredentialValidated,
  readTikTokPlatformCredentialStatus,
  replaceTikTokPlatformCredential,
  type TikTokPlatformCredentialSafeRecord,
} from "@/lib/tiktok-discovery/platform-credential";

const COORDINATE_KEY = buildCacheKey("tiktok:credential-coordinate:v1", [
  "primary",
]);
const COORDINATE_TTL_SECONDS = 300;
const PUBLICATION_LOCK_KEY = buildCacheKey(
  "tiktok:credential-publication-lock:v1",
  ["primary"]
);
const PUBLICATION_LOCK_TTL_SECONDS = 240;

export type TikTokCredentialCoordinate =
  | { status: "unavailable" }
  | {
      status: "connected" | "reconnect_required";
      generation: string;
      advertiserId: string;
    };

export type TikTokCredentialCoordinateDependencies = {
  cacheClient: Pick<
    typeof cache,
    "readWithStatus" | "acquireLock" | "consumeIfMatches" | "publishIfLockOwned"
  >;
  store: { readStatus: typeof readTikTokPlatformCredentialStatus };
};

export type TikTokCredentialCoordinatePublisherDependencies = {
  cacheClient: Pick<typeof cache, "publishIfLockOwned">;
};

export type TikTokCredentialReplacePublication =
  | { status: "published"; record: TikTokPlatformCredentialSafeRecord }
  | {
      status: "coordination_unavailable";
      record: TikTokPlatformCredentialSafeRecord | null;
    };

export type TikTokCredentialMutationPublication =
  | "published"
  | "changed"
  | "coordination_unavailable";

export type TikTokCredentialPublicationDependencies = {
  cacheClient: Pick<
    typeof cache,
    "acquireLock" | "consumeIfMatches" | "publishIfLockOwned"
  >;
  replaceCredential: typeof replaceTikTokPlatformCredential;
  markValidated: typeof markTikTokPlatformCredentialValidated;
  markFailure: typeof markTikTokPlatformCredentialFailure;
  readStatus: typeof readTikTokPlatformCredentialStatus;
  publishCoordinate: typeof publishTikTokPlatformCredentialCoordinate;
};

function coordinateFromRecord(
  record: TikTokPlatformCredentialSafeRecord
): TikTokCredentialCoordinate {
  return {
    status: record.status,
    generation: record.generation,
    advertiserId: record.advertiserId,
  };
}

async function acquirePublicationLock(
  cacheClient: Pick<typeof cache, "acquireLock">
): Promise<string | null> {
  const ownerToken = randomBytes(16).toString("hex");
  const result = await cacheClient.acquireLock(
    PUBLICATION_LOCK_KEY,
    ownerToken,
    PUBLICATION_LOCK_TTL_SECONDS
  );
  return result === "acquired" ? ownerToken : null;
}

export async function publishTikTokPlatformCredentialCoordinate(
  input: {
    coordinate: TikTokCredentialCoordinate;
    lockKey: string;
    ownerToken: string;
  },
  dependencies: Partial<TikTokCredentialCoordinatePublisherDependencies> = {}
): Promise<CachePublishResult> {
  const cacheClient = dependencies.cacheClient ?? cache;
  return cacheClient.publishIfLockOwned({
    lockKey: input.lockKey,
    ownerToken: input.ownerToken,
    valueKey: COORDINATE_KEY,
    value: input.coordinate,
    ttlSeconds: COORDINATE_TTL_SECONDS,
  });
}

export async function resolveTikTokPlatformCredentialCoordinate(
  dependencies: Partial<TikTokCredentialCoordinateDependencies> = {}
): Promise<
  TikTokCredentialCoordinate | { status: "infrastructure_unavailable" }
> {
  const cacheClient = dependencies.cacheClient ?? cache;
  const store = dependencies.store ?? {
    readStatus: readTikTokPlatformCredentialStatus,
  };

  const cached =
    await cacheClient.readWithStatus<TikTokCredentialCoordinate>(
      COORDINATE_KEY
    );
  if (cached.status === "hit") return cached.value;
  if (cached.status === "unavailable") {
    return { status: "infrastructure_unavailable" };
  }

  const ownerToken = await acquirePublicationLock(cacheClient);
  if (!ownerToken) return { status: "infrastructure_unavailable" };

  const record = await store.readStatus();
  const coordinate = record
    ? coordinateFromRecord(record)
    : { status: "unavailable" as const };
  const published = await publishTikTokPlatformCredentialCoordinate(
    {
      coordinate,
      lockKey: PUBLICATION_LOCK_KEY,
      ownerToken,
    },
    { cacheClient }
  );
  return published === "published"
    ? coordinate
    : { status: "infrastructure_unavailable" };
}

function publicationDependencies(
  dependencies: Partial<TikTokCredentialPublicationDependencies>
) {
  const cacheClient = dependencies.cacheClient ?? cache;
  return {
    cacheClient,
    replaceCredential:
      dependencies.replaceCredential ?? replaceTikTokPlatformCredential,
    markValidated:
      dependencies.markValidated ?? markTikTokPlatformCredentialValidated,
    markFailure:
      dependencies.markFailure ?? markTikTokPlatformCredentialFailure,
    readStatus: dependencies.readStatus ?? readTikTokPlatformCredentialStatus,
    publishCoordinate:
      dependencies.publishCoordinate ??
      ((
        input: Parameters<typeof publishTikTokPlatformCredentialCoordinate>[0]
      ) => publishTikTokPlatformCredentialCoordinate(input, { cacheClient })),
  };
}

export async function replaceTikTokPlatformCredentialAndPublish(
  input: Parameters<typeof replaceTikTokPlatformCredential>[0],
  dependencies: Partial<TikTokCredentialPublicationDependencies> = {}
): Promise<TikTokCredentialReplacePublication> {
  const deps = publicationDependencies(dependencies);
  const ownerToken = await acquirePublicationLock(deps.cacheClient);
  if (!ownerToken) {
    return { status: "coordination_unavailable", record: null };
  }

  const record = await deps.replaceCredential(input);
  const result = await deps.publishCoordinate({
    coordinate: coordinateFromRecord(record),
    lockKey: PUBLICATION_LOCK_KEY,
    ownerToken,
  });
  return result === "published"
    ? { status: "published", record }
    : { status: "coordination_unavailable", record };
}

async function releaseChangedMutation(
  cacheClient: Pick<typeof cache, "consumeIfMatches">,
  ownerToken: string
): Promise<TikTokCredentialMutationPublication> {
  const released = await cacheClient.consumeIfMatches(
    PUBLICATION_LOCK_KEY,
    ownerToken
  );
  return released === "unavailable" ? "coordination_unavailable" : "changed";
}

async function publishMatchedMutation(
  input: { generation: string },
  ownerToken: string,
  deps: ReturnType<typeof publicationDependencies>
): Promise<TikTokCredentialMutationPublication> {
  const record = await deps.readStatus();
  if (!record || record.generation !== input.generation) return "changed";

  const published = await deps.publishCoordinate({
    coordinate: coordinateFromRecord(record),
    lockKey: PUBLICATION_LOCK_KEY,
    ownerToken,
  });
  return published === "published" ? "published" : "coordination_unavailable";
}

export async function markTikTokPlatformCredentialValidatedAndPublish(
  input: Parameters<typeof markTikTokPlatformCredentialValidated>[0],
  dependencies: Partial<TikTokCredentialPublicationDependencies> = {}
): Promise<TikTokCredentialMutationPublication> {
  const deps = publicationDependencies(dependencies);
  const ownerToken = await acquirePublicationLock(deps.cacheClient);
  if (!ownerToken) return "coordination_unavailable";

  const matched = await deps.markValidated(input);
  if (!matched) return releaseChangedMutation(deps.cacheClient, ownerToken);
  return publishMatchedMutation(input, ownerToken, deps);
}

export async function markTikTokPlatformCredentialFailureAndPublish(
  input: Parameters<typeof markTikTokPlatformCredentialFailure>[0],
  dependencies: Partial<TikTokCredentialPublicationDependencies> = {}
): Promise<TikTokCredentialMutationPublication> {
  const deps = publicationDependencies(dependencies);
  const ownerToken = await acquirePublicationLock(deps.cacheClient);
  if (!ownerToken) return "coordination_unavailable";

  const matched = await deps.markFailure(input);
  if (!matched) return releaseChangedMutation(deps.cacheClient, ownerToken);
  return publishMatchedMutation(input, ownerToken, deps);
}
