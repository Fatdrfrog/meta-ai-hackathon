import {
  getMetaGraphAuthorizationMetadata,
  getMetaGraphRateLimitMetadata,
} from "@icecore/shared/lib/meta/api";
import {
  buildCacheKey,
  cache,
  type CacheLockAcquisition,
} from "@icecore/shared/lib/cache";
import {
  META_DIAGNOSTICS_RECONNECT_REASON_FIELD,
  META_DIAGNOSTICS_META_AUTHORIZATION_RECONNECT_REASON,
} from "./token-lifecycle";
export { hasConfirmedWhatsAppMetaAuthorizationReconnect } from "./token-lifecycle";

const WHATSAPP_META_READ_FRESHNESS_MS = 15 * 60 * 1_000;
const WHATSAPP_META_READ_MINIMUM_INTERVAL_MS = 60 * 1_000;
const WHATSAPP_META_READ_RATE_LIMIT_BASE_COOLDOWN_MS = 5 * 60 * 1_000;
const WHATSAPP_META_READ_RATE_LIMIT_MAX_COOLDOWN_MS = 6 * 60 * 60 * 1_000;
const WHATSAPP_META_READ_LOCK_TTL_SECONDS = 15 * 60;

const META_DIAGNOSTICS_LAST_ATTEMPT_AT_FIELD =
  "meta_diagnostics_last_attempt_at" as const;
const META_DIAGNOSTICS_LAST_SUCCESS_AT_FIELD =
  "meta_diagnostics_last_success_at" as const;
export const META_DIAGNOSTICS_COOLDOWN_UNTIL_FIELD =
  "meta_diagnostics_cooldown_until" as const;
const META_DIAGNOSTICS_CONSECUTIVE_RATE_LIMITS_FIELD =
  "meta_diagnostics_consecutive_rate_limits" as const;
const META_DIAGNOSTICS_LAST_ERROR_CODE_FIELD =
  "meta_diagnostics_last_error_code" as const;

export type WhatsAppMetaRefreshOutcome =
  | "fresh"
  | "cooldown"
  | "minimum_interval"
  | "in_progress"
  | "not_configured"
  | "succeeded"
  | "rate_limited"
  | "failed";

export type WhatsAppMetaRefreshResponse = {
  requested: boolean;
  performed: boolean;
  outcome: WhatsAppMetaRefreshOutcome;
  cooldown_until?: string;
};

type Credentials = Readonly<Record<string, unknown>>;
type MetaReadCacheReader = Pick<typeof cache, "get">;
type MetaReadCacheWriter = Pick<typeof cache, "set">;
type MetaReadLockClient = Pick<
  typeof cache,
  "get" | "acquireLock" | "compareAndDelete"
>;

export function buildWhatsAppMetaReadLockKey(params: {
  wabaId?: string;
  sourceId: string;
}): string {
  const wabaId = params.wabaId?.trim();
  return wabaId
    ? buildCacheKey("whatsapp:meta-read-lock:v1", ["waba", wabaId])
    : buildCacheKey("whatsapp:meta-read-lock:v1", [
        "source",
        params.sourceId.trim(),
      ]);
}

export function buildWhatsAppMetaReadCooldownCacheKey(wabaId: string): string {
  return buildCacheKey("whatsapp:meta-read-cooldown:v1", [
    "waba",
    wabaId.trim(),
  ]);
}

export async function getCachedWhatsAppMetaReadCooldownUntil(
  wabaId: string,
  options: {
    now?: Date;
    cacheClient?: MetaReadCacheReader;
  } = {}
): Promise<string | null> {
  if (!wabaId.trim()) return null;

  try {
    const value = await (options.cacheClient ?? cache).get<unknown>(
      buildWhatsAppMetaReadCooldownCacheKey(wabaId)
    );
    const timestamp = getTimestamp(value);
    const now = options.now ?? new Date();
    return timestamp !== null && timestamp > now.getTime()
      ? new Date(timestamp).toISOString()
      : null;
  } catch {
    return null;
  }
}

export async function setCachedWhatsAppMetaReadCooldownUntil(
  wabaId: string,
  cooldownUntil: string,
  options: {
    now?: Date;
    cacheClient?: MetaReadCacheWriter;
  } = {}
): Promise<void> {
  if (!wabaId.trim()) return;

  const now = options.now ?? new Date();
  const timestamp = getTimestamp(cooldownUntil);
  if (timestamp === null || timestamp <= now.getTime()) return;

  const normalized = new Date(timestamp).toISOString();
  const ttlSeconds = Math.max(
    1,
    Math.ceil((timestamp - now.getTime()) / 1_000)
  );
  try {
    await (options.cacheClient ?? cache).set(
      buildWhatsAppMetaReadCooldownCacheKey(wabaId),
      normalized,
      ttlSeconds
    );
  } catch {
    // Best-effort cross-source protection. Persisted credentials remain the
    // durable cooldown source when the shared cache is unavailable.
  }
}

export type WhatsAppMetaReadDecision =
  | {
      shouldRefresh: false;
      reason: "fresh" | "minimum_interval";
      cooldownUntil: null;
    }
  | {
      shouldRefresh: false;
      reason: "cooldown";
      cooldownUntil: string;
    }
  | {
      shouldRefresh: true;
      reason: "explicit" | "stale";
      cooldownUntil: null;
    };

export type WhatsAppMetaReadPermit =
  | {
      outcome: "fresh" | "minimum_interval" | "cooldown";
      cooldownUntil: string | null;
    }
  | {
      outcome: "acquired";
      cooldownUntil: null;
      lockKey: string;
      lockToken: string;
    }
  | {
      outcome: "in_progress" | "coordination_unavailable";
      cooldownUntil: null;
    };

type MetaReadLockOptions = {
  cacheClient?: MetaReadLockClient;
};

type AcquireWhatsAppMetaReadLockParams = {
  sourceId: string;
  wabaId?: string;
  additionalCooldownUntil?: string | null;
  now?: Date;
};

type AcquireWhatsAppMetaReadPermitParams = AcquireWhatsAppMetaReadLockParams & {
  credentials: Credentials;
  explicitRefresh?: boolean;
};

function getTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : 0;
}

function getActiveWhatsAppMetaReadCooldownUntil(
  credentials: Credentials,
  now = new Date()
): string | null {
  const cooldownUntil = credentials[META_DIAGNOSTICS_COOLDOWN_UNTIL_FIELD];
  const timestamp = getTimestamp(cooldownUntil);

  return timestamp !== null && timestamp > now.getTime()
    ? new Date(timestamp).toISOString()
    : null;
}

export function selectLaterActiveWhatsAppMetaReadCooldownUntil(
  candidates: Array<string | null | undefined>,
  now = new Date()
): string | null {
  let selected: { value: string; timestamp: number } | null = null;

  for (const value of candidates) {
    const timestamp = getTimestamp(value);
    if (timestamp === null || timestamp <= now.getTime()) continue;
    if (!selected || timestamp > selected.timestamp) {
      selected = { value: new Date(timestamp).toISOString(), timestamp };
    }
  }

  return selected?.value ?? null;
}

function getActiveCooldownForRead(
  credentials: Credentials,
  options: {
    cachedCooldownUntil?: string | null;
    additionalCooldownUntil?: string | null;
    now: Date;
  }
): string | null {
  const persistedCooldownUntil = getActiveWhatsAppMetaReadCooldownUntil(
    credentials,
    options.now
  );
  return selectLaterActiveWhatsAppMetaReadCooldownUntil(
    [
      persistedCooldownUntil,
      options.cachedCooldownUntil,
      options.additionalCooldownUntil,
    ],
    options.now
  );
}

export async function acquireWhatsAppMetaReadLock(
  params: AcquireWhatsAppMetaReadLockParams,
  options: MetaReadLockOptions = {}
): Promise<WhatsAppMetaReadPermit> {
  const now = params.now ?? new Date();
  const cacheClient = options.cacheClient ?? cache;
  const lockKey = buildWhatsAppMetaReadLockKey(params);
  const lockToken = crypto.randomUUID();
  const lockAcquisition: CacheLockAcquisition = await cacheClient.acquireLock(
    lockKey,
    lockToken,
    WHATSAPP_META_READ_LOCK_TTL_SECONDS
  );

  if (lockAcquisition === "unavailable") {
    return { outcome: "coordination_unavailable", cooldownUntil: null };
  }
  if (lockAcquisition === "contended") {
    return { outcome: "in_progress", cooldownUntil: null };
  }

  const cachedCooldownUntil = params.wabaId
    ? await getCachedWhatsAppMetaReadCooldownUntil(params.wabaId, {
        now,
        cacheClient,
      })
    : null;
  const activeCooldownUntil = getActiveCooldownForRead(
    {},
    {
      cachedCooldownUntil,
      additionalCooldownUntil: params.additionalCooldownUntil,
      now,
    }
  );
  if (activeCooldownUntil) {
    await cacheClient.compareAndDelete(lockKey, lockToken);
    return { outcome: "cooldown", cooldownUntil: activeCooldownUntil };
  }

  return {
    outcome: "acquired",
    cooldownUntil: null,
    lockKey,
    lockToken,
  };
}

export async function acquireWhatsAppMetaReadPermit(
  params: AcquireWhatsAppMetaReadPermitParams,
  options: MetaReadLockOptions = {}
): Promise<WhatsAppMetaReadPermit> {
  const now = params.now ?? new Date();
  const cachedCooldownUntil = params.wabaId
    ? await getCachedWhatsAppMetaReadCooldownUntil(params.wabaId, {
        now,
        cacheClient: options.cacheClient,
      })
    : null;
  const activeCooldownUntil = getActiveCooldownForRead(params.credentials, {
    cachedCooldownUntil,
    additionalCooldownUntil: params.additionalCooldownUntil,
    now,
  });
  const decisionCredentials = activeCooldownUntil
    ? {
        ...params.credentials,
        [META_DIAGNOSTICS_COOLDOWN_UNTIL_FIELD]: activeCooldownUntil,
      }
    : params.credentials;
  const decision = getWhatsAppMetaReadDecision(decisionCredentials, {
    now,
    explicitRefresh: params.explicitRefresh,
  });

  if (!decision.shouldRefresh) {
    return {
      outcome: decision.reason,
      cooldownUntil: decision.cooldownUntil,
    };
  }

  return acquireWhatsAppMetaReadLock(params, options);
}

export async function releaseWhatsAppMetaReadPermit(
  permit: WhatsAppMetaReadPermit,
  cacheClient: MetaReadLockClient = cache
): Promise<boolean> {
  if (permit.outcome !== "acquired") return false;
  return cacheClient.compareAndDelete(permit.lockKey, permit.lockToken);
}

export function getWhatsAppMetaReadDecision(
  credentials: Credentials,
  options: { now?: Date; explicitRefresh?: boolean } = {}
): WhatsAppMetaReadDecision {
  const now = options.now ?? new Date();
  const cooldownUntil = getActiveWhatsAppMetaReadCooldownUntil(
    credentials,
    now
  );
  if (cooldownUntil) {
    return { shouldRefresh: false, reason: "cooldown", cooldownUntil };
  }

  const lastAttemptAt = getTimestamp(
    credentials[META_DIAGNOSTICS_LAST_ATTEMPT_AT_FIELD]
  );
  const lastAttemptAgeMs =
    lastAttemptAt === null ? null : now.getTime() - lastAttemptAt;
  const attemptedWithinExplicitMinimumInterval =
    lastAttemptAgeMs !== null &&
    lastAttemptAgeMs < WHATSAPP_META_READ_MINIMUM_INTERVAL_MS;
  const attemptedWithinOrdinaryRetryInterval =
    lastAttemptAt !== null &&
    lastAttemptAgeMs !== null &&
    lastAttemptAgeMs < WHATSAPP_META_READ_FRESHNESS_MS;

  if (options.explicitRefresh) {
    if (attemptedWithinExplicitMinimumInterval) {
      return {
        shouldRefresh: false,
        reason: "minimum_interval",
        cooldownUntil: null,
      };
    }

    return { shouldRefresh: true, reason: "explicit", cooldownUntil: null };
  }

  const lastSuccessAt = getTimestamp(
    credentials[META_DIAGNOSTICS_LAST_SUCCESS_AT_FIELD] ??
      credentials.diagnostics_last_checked_at
  );
  if (
    lastSuccessAt !== null &&
    now.getTime() - lastSuccessAt < WHATSAPP_META_READ_FRESHNESS_MS
  ) {
    return { shouldRefresh: false, reason: "fresh", cooldownUntil: null };
  }

  if (attemptedWithinOrdinaryRetryInterval) {
    return {
      shouldRefresh: false,
      reason: "minimum_interval",
      cooldownUntil: null,
    };
  }

  return { shouldRefresh: true, reason: "stale", cooldownUntil: null };
}

export function buildWhatsAppMetaRateLimitCredentialPatch(
  credentials: Credentials,
  options: { now?: Date; error: unknown }
): Record<string, unknown> {
  const now = options.now ?? new Date();
  const consecutiveRateLimits = Math.min(
    getNonNegativeInteger(
      credentials[META_DIAGNOSTICS_CONSECUTIVE_RATE_LIMITS_FIELD]
    ) + 1,
    32
  );
  const cooldownMs = Math.min(
    WHATSAPP_META_READ_RATE_LIMIT_BASE_COOLDOWN_MS *
      2 ** (consecutiveRateLimits - 1),
    WHATSAPP_META_READ_RATE_LIMIT_MAX_COOLDOWN_MS
  );
  const rateLimitMetadata = getMetaGraphRateLimitMetadata(options.error);
  const errorCode =
    rateLimitMetadata?.code !== undefined
      ? String(rateLimitMetadata.code)
      : rateLimitMetadata?.status === 429
        ? "HTTP_429"
        : "UNKNOWN";

  return {
    [META_DIAGNOSTICS_LAST_ATTEMPT_AT_FIELD]: now.toISOString(),
    [META_DIAGNOSTICS_COOLDOWN_UNTIL_FIELD]: new Date(
      now.getTime() + cooldownMs
    ).toISOString(),
    [META_DIAGNOSTICS_CONSECUTIVE_RATE_LIMITS_FIELD]: consecutiveRateLimits,
    [META_DIAGNOSTICS_LAST_ERROR_CODE_FIELD]: errorCode,
  };
}

export function buildWhatsAppMetaReadSuccessCredentialPatch(
  now = new Date()
): Record<string, unknown> {
  const timestamp = now.toISOString();
  return {
    diagnostics_last_checked_at: timestamp,
    [META_DIAGNOSTICS_LAST_ATTEMPT_AT_FIELD]: timestamp,
    [META_DIAGNOSTICS_LAST_SUCCESS_AT_FIELD]: timestamp,
    [META_DIAGNOSTICS_COOLDOWN_UNTIL_FIELD]: null,
    [META_DIAGNOSTICS_CONSECUTIVE_RATE_LIMITS_FIELD]: 0,
    [META_DIAGNOSTICS_LAST_ERROR_CODE_FIELD]: null,
    [META_DIAGNOSTICS_RECONNECT_REASON_FIELD]: null,
  };
}

export function buildWhatsAppMetaReadFailureCredentialPatch(
  now = new Date()
): Record<string, unknown> {
  return {
    [META_DIAGNOSTICS_LAST_ATTEMPT_AT_FIELD]: now.toISOString(),
  };
}

export function buildWhatsAppMetaAuthorizationCredentialPatch(
  error: unknown,
  now = new Date()
): Record<string, unknown> {
  const metadata = getMetaGraphAuthorizationMetadata(error);
  const errorCode = metadata?.code
    ? metadata.subcode
      ? `${metadata.code}:${metadata.subcode}`
      : String(metadata.code)
    : metadata?.status
      ? `HTTP_${metadata.status}`
      : "UNKNOWN";

  return {
    ...buildWhatsAppMetaReadFailureCredentialPatch(now),
    [META_DIAGNOSTICS_LAST_ERROR_CODE_FIELD]: errorCode,
    [META_DIAGNOSTICS_RECONNECT_REASON_FIELD]:
      META_DIAGNOSTICS_META_AUTHORIZATION_RECONNECT_REASON,
  };
}
