import {
  MetaServerAppConfigError,
  getMetaServerAppConfig,
} from "@/lib/meta/app-config";
import { getRealtimeGatewayUrl } from "@/lib/realtime/gateway-url";
import { META_GRAPH_BASE_URL } from "@icecore/shared/lib/meta/graph-version";
import { Redis } from "@upstash/redis";

export type DependencyName =
  | "upstash_redis"
  | "realtime_gateway"
  | "telegram_api"
  | "meta_graph_api";

export type DependencyHealthStatus =
  | "healthy"
  | "degraded"
  | "unhealthy"
  | "not_configured";

export type DependencyAggregateStatus = "healthy" | "degraded" | "unhealthy";

type DependencyDetailsValue = string | number | boolean | null;
export type DependencyDetails = Record<string, DependencyDetailsValue>;

export interface DependencyProbeResult {
  name: DependencyName;
  status: DependencyHealthStatus;
  latencyMs?: number;
  reason?: string;
  details?: DependencyDetails;
}

export interface DependencyHealthSnapshot {
  checkedAt: string;
  status: DependencyAggregateStatus;
  dependencies: Record<DependencyName, DependencyProbeResult>;
}

export type DependencyProbeTimeouts = Partial<Record<DependencyName, number>>;

export interface CollectDependencyHealthOptions {
  timeouts?: DependencyProbeTimeouts;
}

type ProbeExecutionResult =
  | { ok: true; details?: DependencyDetails }
  | { ok: false; reason: string; details?: DependencyDetails };

const PROBE_TIMEOUT_MS = 5000;

const LATENCY_DEGRADED_THRESHOLD_MS: Record<DependencyName, number> = {
  upstash_redis: 800,
  realtime_gateway: 1500,
  telegram_api: 1500,
  meta_graph_api: 1500,
};

function isConfigured(value: string | undefined): boolean {
  return Boolean(value && value.trim());
}

function redactSecrets(raw: string): string {
  const secretCandidates = [
    process.env.META_APP_SECRET,
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.UPSTASH_REDIS_REST_TOKEN,
  ].filter((value): value is string => Boolean(value && value.trim()));

  return secretCandidates.reduce((sanitized, secret) => {
    return sanitized.split(secret).join("[redacted]");
  }, raw);
}

function toReason(error: unknown): string {
  const raw =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const sanitized = redactSecrets(raw);
  return sanitized.slice(0, 160);
}

function notConfigured(
  name: DependencyName,
  reason: string
): DependencyProbeResult {
  return {
    name,
    status: "not_configured",
    reason,
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutReason: string
): Promise<T> {
  let timeoutId: NodeJS.Timeout | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(timeoutReason));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function fetchJsonWithTimeout(
  url: string,
  timeoutMs: number,
  timeoutReason: string
): Promise<{ response: Response; body: unknown }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as unknown;
    return { response, body };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(timeoutReason);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function deriveLatencyStatus(
  latencyMs: number,
  degradedThresholdMs: number
): "healthy" | "degraded" {
  return latencyMs > degradedThresholdMs ? "degraded" : "healthy";
}

export function aggregateDependencyStatuses(
  results: DependencyProbeResult[]
): DependencyAggregateStatus {
  if (results.some(result => result.status === "unhealthy")) {
    return "unhealthy";
  }
  if (results.some(result => result.status === "degraded")) {
    return "degraded";
  }
  return "healthy";
}

async function runProbe(
  name: DependencyName,
  execute: (timeoutMs: number) => Promise<ProbeExecutionResult>,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<DependencyProbeResult> {
  const startedAt = Date.now();
  try {
    const execution = await withTimeout(
      execute(timeoutMs),
      timeoutMs,
      `${name}_timeout`
    );
    const latencyMs = Date.now() - startedAt;

    if (!execution.ok) {
      return {
        name,
        status: "unhealthy",
        latencyMs,
        reason: execution.reason,
        details: execution.details,
      };
    }

    return {
      name,
      status: deriveLatencyStatus(
        latencyMs,
        LATENCY_DEGRADED_THRESHOLD_MS[name]
      ),
      latencyMs,
      details: execution.details,
    };
  } catch (error) {
    return {
      name,
      status: "unhealthy",
      latencyMs: Date.now() - startedAt,
      reason: toReason(error),
    };
  }
}

async function probeUpstashRedis(
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<DependencyProbeResult> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!isConfigured(url) || !isConfigured(token)) {
    return notConfigured("upstash_redis", "missing_upstash_credentials");
  }

  return runProbe(
    "upstash_redis",
    async () => {
      const redis = new Redis({ url: url!, token: token! });
      await redis.get("__dependency_health_probe__");
      return { ok: true };
    },
    timeoutMs
  );
}

async function probeRealtimeGateway(
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<DependencyProbeResult> {
  const rawUrl = getRealtimeGatewayUrl();
  if (!isConfigured(rawUrl)) {
    return notConfigured("realtime_gateway", "missing_realtime_gateway_url");
  }

  return runProbe(
    "realtime_gateway",
    async probeTimeoutMs => {
      const url = new URL("/readyz", rawUrl);
      const { response, body } = await fetchJsonWithTimeout(
        url.toString(),
        probeTimeoutMs,
        "realtime_gateway_timeout"
      );
      if (!response.ok) {
        return { ok: false, reason: `http_${response.status}` };
      }
      return {
        ok: true,
        details:
          body && typeof body === "object" && "runtimeMode" in body
            ? { runtimeMode: String(body.runtimeMode) }
            : undefined,
      };
    },
    timeoutMs
  );
}

async function probeTelegramApi(
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<DependencyProbeResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!isConfigured(token)) {
    return notConfigured("telegram_api", "missing_telegram_token");
  }

  return runProbe(
    "telegram_api",
    async probeTimeoutMs => {
      const { response, body } = await fetchJsonWithTimeout(
        `https://api.telegram.org/bot${token}/getMe`,
        probeTimeoutMs,
        "telegram_api_timeout"
      );

      if (!response.ok) {
        return { ok: false, reason: `http_${response.status}` };
      }

      if (!body || typeof body !== "object" || !("ok" in body)) {
        return { ok: false, reason: "invalid_payload" };
      }

      if (!(body as { ok?: boolean }).ok) {
        return { ok: false, reason: "telegram_api_error" };
      }

      return { ok: true };
    },
    timeoutMs
  );
}

async function probeMetaGraphApi(
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<DependencyProbeResult> {
  let appConfig: ReturnType<typeof getMetaServerAppConfig>;
  try {
    appConfig = getMetaServerAppConfig();
  } catch (error) {
    if (error instanceof MetaServerAppConfigError) {
      return notConfigured("meta_graph_api", "missing_meta_app_credentials");
    }
    throw error;
  }

  return runProbe(
    "meta_graph_api",
    async probeTimeoutMs => {
      const params = new URLSearchParams({
        client_id: appConfig.appId,
        client_secret: appConfig.appSecret,
        grant_type: "client_credentials",
      });

      const { response, body } = await fetchJsonWithTimeout(
        `${META_GRAPH_BASE_URL}/oauth/access_token?${params.toString()}`,
        probeTimeoutMs,
        "meta_graph_api_timeout"
      );

      if (!response.ok) {
        return { ok: false, reason: `http_${response.status}` };
      }

      if (!body || typeof body !== "object") {
        return { ok: false, reason: "invalid_payload" };
      }

      const accessToken =
        "access_token" in body
          ? (body as { access_token?: unknown }).access_token
          : null;

      if (typeof accessToken !== "string") {
        return { ok: false, reason: "missing_access_token" };
      }

      return { ok: true };
    },
    timeoutMs
  );
}

function getProbeTimeoutMs(
  name: DependencyName,
  options: CollectDependencyHealthOptions
): number {
  const timeoutMs = options.timeouts?.[name];
  return typeof timeoutMs === "number" &&
    Number.isFinite(timeoutMs) &&
    timeoutMs > 0
    ? timeoutMs
    : PROBE_TIMEOUT_MS;
}

export async function collectDependencyHealth(
  options: CollectDependencyHealthOptions = {}
): Promise<DependencyHealthSnapshot> {
  const [upstashRedis, realtimeGateway, telegramApi, metaGraphApi] =
    await Promise.all([
      probeUpstashRedis(getProbeTimeoutMs("upstash_redis", options)),
      probeRealtimeGateway(getProbeTimeoutMs("realtime_gateway", options)),
      probeTelegramApi(getProbeTimeoutMs("telegram_api", options)),
      probeMetaGraphApi(getProbeTimeoutMs("meta_graph_api", options)),
    ]);

  const dependencies: Record<DependencyName, DependencyProbeResult> = {
    upstash_redis: upstashRedis,
    realtime_gateway: realtimeGateway,
    telegram_api: telegramApi,
    meta_graph_api: metaGraphApi,
  };

  return {
    checkedAt: new Date().toISOString(),
    status: aggregateDependencyStatuses(Object.values(dependencies)),
    dependencies,
  };
}
