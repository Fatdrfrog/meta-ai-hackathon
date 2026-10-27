import { randomUUID } from "node:crypto";
import { cache, type CacheLockAcquisition } from "./cache";
import {
  checkCriticalRateLimit,
  createRateLimiter,
  type CriticalRateLimitResult,
} from "./rate-limiter";
import {
  getCompanyIdForWorkspace,
  type WorkspaceCompanyClient,
} from "./workspace-company";

export type CompanyRuntimeLane = "conversation" | "history";
type ThroughputLane = CompanyRuntimeLane | "ingress";
type Dependencies = {
  acquireLock(
    key: string,
    token: string,
    ttlSeconds: number,
  ): Promise<CacheLockAcquisition>;
  release(key: string, token: string): Promise<boolean>;
  throughput(
    companyId: string,
    lane: ThroughputLane,
  ): Promise<CriticalRateLimitResult>;
};

function positiveEnv(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

const limiters = {
  ingress: createRateLimiter({
    requests: positiveEnv("AIRI_COMPANY_INGRESS_PER_MINUTE", 120, 10_000),
    window: "1 m",
    prefix: "company-runtime:ingress",
    analytics: false,
  }),
  conversation: createRateLimiter({
    requests: positiveEnv("AIRI_COMPANY_PREPARATIONS_PER_MINUTE", 120, 10_000),
    window: "1 m",
    prefix: "company-runtime:conversation",
    analytics: false,
  }),
  history: createRateLimiter({
    requests: positiveEnv("AIRI_COMPANY_HISTORY_PER_MINUTE", 20, 1_000),
    window: "1 m",
    prefix: "company-runtime:history",
    analytics: false,
  }),
};

export function checkCompanyRuntimeThroughput(
  companyId: string,
  lane: ThroughputLane,
): Promise<CriticalRateLimitResult> {
  return checkCriticalRateLimit(limiters[lane], companyId);
}

export class CompanyRuntimeCapacityDeferredError extends Error {
  readonly code = "COMPANY_RUNTIME_CAPACITY_DEFERRED";

  constructor(
    readonly reason: "limited" | "unavailable",
    readonly retryAt = Date.now() + 30_000,
  ) {
    super(
      `Company processing capacity ${reason}; received work remains queued`,
    );
    this.name = "CompanyRuntimeCapacityDeferredError";
  }
}

/** Web adapters and workers can load independent CJS/ESM constructor copies. */
export function isCompanyRuntimeCapacityDeferredError(
  error: unknown,
): error is CompanyRuntimeCapacityDeferredError {
  if (!error || typeof error !== "object") return false;
  const value = error as Record<string, unknown>;
  return (
    value.code === "COMPANY_RUNTIME_CAPACITY_DEFERRED" &&
    (value.reason === "limited" || value.reason === "unavailable") &&
    typeof value.message === "string" &&
    typeof value.retryAt === "number" &&
    value.retryAt >= 0 &&
    Number.isFinite(new Date(value.retryAt).getTime())
  );
}

export async function resolveRuntimeCompanyId(
  supabase: WorkspaceCompanyClient,
  workspaceId: string,
): Promise<string> {
  const key = `company-runtime:workspace:${workspaceId}`;
  const cached = await cache.get<string>(key);
  if (typeof cached === "string" && cached) return cached;
  let companyId: string | null;
  try {
    companyId = await getCompanyIdForWorkspace(supabase, workspaceId);
  } catch {
    throw new CompanyRuntimeCapacityDeferredError("unavailable");
  }
  if (!companyId) throw new CompanyRuntimeCapacityDeferredError("unavailable");
  await cache.set(key, companyId, 60);
  return companyId;
}

export async function withCompanyRuntimeCapacity<T>(
  supabase: WorkspaceCompanyClient,
  workspaceId: string,
  lane: CompanyRuntimeLane,
  run: (companyId: string) => Promise<T>,
): Promise<T> {
  const companyId = await resolveRuntimeCompanyId(supabase, workspaceId);
  const claim = await acquireCompanyRuntimeCapacity({ companyId, lane });
  if (claim.status !== "granted")
    throw new CompanyRuntimeCapacityDeferredError(claim.status, claim.retryAt);
  try {
    return await run(companyId);
  } finally {
    await claim.release();
  }
}

export async function acquireCompanyRuntimeCapacity(
  params: { companyId: string; lane: CompanyRuntimeLane },
  deps: Dependencies = {
    acquireLock: cache.acquireLock,
    release: cache.compareAndDelete,
    throughput: checkCompanyRuntimeThroughput,
  },
): Promise<
  | { status: "granted"; release(): Promise<boolean> }
  | { status: "limited" | "unavailable"; retryAt: number }
> {
  if (!params.companyId.trim())
    return { status: "unavailable", retryAt: Date.now() + 30_000 };
  const slots =
    params.lane === "history"
      ? 1
      : positiveEnv("AIRI_COMPANY_PREPARATION_CONCURRENCY", 4, 64);
  const token = randomUUID();
  for (let slot = 0; slot < slots; slot++) {
    const key = `company-runtime:${params.lane}:${params.companyId}:${slot}`;
    // The longest covered activity has a 600-second start-to-close timeout.
    const claim = await deps.acquireLock(key, token, 900);
    if (claim === "unavailable")
      return { status: claim, retryAt: Date.now() + 30_000 };
    if (claim !== "acquired") continue;
    const throughput = await deps.throughput(params.companyId, params.lane);
    if (throughput.status !== "granted") {
      await deps.release(key, token);
      return {
        status: throughput.status,
        retryAt:
          throughput.status === "limited"
            ? throughput.reset
            : Date.now() + 30_000,
      };
    }
    return { status: "granted", release: () => deps.release(key, token) };
  }
  return { status: "limited", retryAt: Date.now() + 5_000 };
}
