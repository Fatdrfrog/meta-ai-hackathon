/**
 * PostHog Query Service
 *
 * Server-side service for querying PostHog analytics data
 * All queries are filtered by workspace_id for multi-tenant isolation
 *
 * Configuration (both required for queries to run):
 * - POSTHOG_PERSONAL_API_KEY: Personal API key (preferred)
 * - POSTHOG_API_KEY: Legacy fallback for personal API key
 * - POSTHOG_PROJECT_ID: Numeric project id from PostHog project settings
 * - POSTHOG_QUERY_HOST: optional PostHog app/API host (default https://us.posthog.com)
 *
 * Multi-tenant isolation:
 * - Events are filtered by properties.workspace_id to ensure data isolation
 * - PostHog Groups (company) are set when capturing events for company-level analytics
 * - Workspace-level filtering provides the primary isolation mechanism
 * - Groups can be used for company-level aggregations in PostHog dashboards
 */

import type {
  ReplyFallbackAction,
  ReplyFallbackReason,
} from "@/lib/airi/reply/generation/reply-fallback-policy";
import {
  buildAiriReplyOperatorAnalytics,
  type AiriReplyOperatorAnalytics,
  type AiriReplyOperatorEventRow,
} from "@/lib/airi/reply/runtime/llm-analytics";
import type { ReplyOperatorCounterName } from "@/lib/airi/reply/runtime/reply-operator-metrics";
import { createLogger } from "@icecore/shared/lib/logger";
import { normalizeUrlBase } from "@icecore/shared/lib/value-utils";
import type {
  DateRange,
  DeviceStats,
  PageviewsData,
  SessionStats,
  TopPage,
  TrafficSource,
} from "@icecore/shared/types/analytics";

const logger = createLogger("posthog-queries");

function posthogApiHost(): string {
  return (
    normalizeUrlBase(process.env.POSTHOG_QUERY_HOST) ||
    normalizeUrlBase(process.env.NEXT_PUBLIC_POSTHOG_UI_HOST) ||
    "https://us.posthog.com"
  );
}

let loggedMissingQueryConfig = false;

function getPostHogQueryConfig(): { apiKey: string; projectId: string } | null {
  const apiKey = (
    process.env.POSTHOG_PERSONAL_API_KEY ??
    process.env.POSTHOG_API_KEY ??
    ""
  ).trim();
  const projectId = (process.env.POSTHOG_PROJECT_ID ?? "").trim();
  if (!apiKey || !projectId) {
    if (!loggedMissingQueryConfig) {
      loggedMissingQueryConfig = true;
      logger.warn(
        "PostHog query API disabled: set POSTHOG_PERSONAL_API_KEY (or legacy POSTHOG_API_KEY) and POSTHOG_PROJECT_ID"
      );
    }
    return null;
  }
  return { apiKey, projectId };
}

/**
 * UUID validation (any RFC 4122 variant; not only v4)
 */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WIDGET_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_HOGQL_LIMIT = 500;

/**
 * Validate and sanitize workspace ID
 * Returns null if invalid (prevents injection in HogQL-style where clauses)
 */
function validateWorkspaceId(workspaceId: string): string | null {
  // Validate UUID shape (Supabase workspace ids)
  if (!UUID_REGEX.test(workspaceId)) {
    logger.error("Invalid workspace ID format", undefined, {
      workspaceId,
    });
    return null;
  }

  // Return sanitized value (UUID format is already safe for PostHog queries)
  // PostHog queries use parameterized queries via JSON, but we're being extra safe
  return workspaceId;
}

function validateSourceId(sourceId: string | null | undefined): string | null {
  if (!sourceId) return null;

  if (!UUID_REGEX.test(sourceId)) {
    logger.error("Invalid source ID format", undefined, { sourceId });
    return null;
  }

  return sourceId;
}

export type PostHogQueryStatus =
  | { configured: true }
  | {
      configured: false;
      reason: "missing_config";
    };

export function getPostHogQueryStatus(): PostHogQueryStatus {
  return getPostHogQueryConfig()
    ? { configured: true }
    : { configured: false, reason: "missing_config" };
}

function escapeHogQLString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function toHogQLDateTime(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    logger.error("Invalid PostHog date range value", undefined, { value });
    return null;
  }

  return date.toISOString().slice(0, 19).replace("T", " ");
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 10;
  return Math.min(Math.max(Math.floor(limit), 1), MAX_HOGQL_LIMIT);
}

function asNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function buildWidgetWhere(
  workspaceId: string,
  dateRange: DateRange,
  sourceId?: string | null
): string[] | null {
  const validatedWorkspaceId = validateWorkspaceId(workspaceId);
  if (!validatedWorkspaceId) return null;

  const start = toHogQLDateTime(dateRange.start);
  const end = toHogQLDateTime(dateRange.end);
  if (!start || !end) return null;

  const clauses = [
    `properties.workspace_id = '${escapeHogQLString(validatedWorkspaceId)}'`,
    `timestamp >= toDateTime('${start}')`,
    `timestamp <= toDateTime('${end}')`,
  ];

  if (sourceId) {
    const validatedSourceId = validateSourceId(sourceId);
    if (!validatedSourceId) return null;
    clauses.push(
      `properties.source_id = '${escapeHogQLString(validatedSourceId)}'`
    );
  }

  return clauses;
}

/**
 * PostHog EventsQuery type
 */
interface PostHogEventsQuery {
  kind: "EventsQuery";
  select: string[];
  event: string;
  where?: string[];
  after?: string;
  before?: string;
  limit?: number;
}

interface PostHogHogQLQuery {
  kind: "HogQLQuery";
  query: string;
}

type PostHogQuery = PostHogEventsQuery | PostHogHogQLQuery;

/**
 * PostHog query response type
 */
interface PostHogQueryResponse<T = unknown[]> {
  results: T[];
  columns?: string[];
  types?: string[];
  hasMore?: boolean;
}

const REPLY_OPERATOR_COUNTER_NAMES: readonly ReplyOperatorCounterName[] = [
  "safe_conversational_replies",
  "rag_turns",
  "grounded_recovery_usage",
  "generic_clarification_usage",
  "low_confidence_understanding_results",
];

const REPLY_FALLBACK_ACTIONS: readonly ReplyFallbackAction[] = [
  "use_generated_reply",
  "grounded_recovery",
  "intent_fallback",
  "generic_clarification",
  "clarifying_generation",
];

const REPLY_FALLBACK_REASONS: readonly ReplyFallbackReason[] = [
  "generated_reply_complete",
  "empty_generated_reply",
  "incomplete_generated_reply",
  "missing_ask_coverage",
  "grounded_context_available",
  "missing_knowledge_signal",
  "generic_ungrounded_turn",
  "clarifying_generation_allowed",
  "evidence_policy_clarify",
  "evidence_policy_handoff",
];

function isReplyOperatorCounterName(
  value: string
): value is ReplyOperatorCounterName {
  return REPLY_OPERATOR_COUNTER_NAMES.includes(
    value as ReplyOperatorCounterName
  );
}

function parseReplyFallbackAction(
  value: string | null
): ReplyFallbackAction | null {
  if (!value) return null;
  return REPLY_FALLBACK_ACTIONS.includes(value as ReplyFallbackAction)
    ? (value as ReplyFallbackAction)
    : null;
}

function parseReplyFallbackReason(
  value: string | null
): ReplyFallbackReason | null {
  if (!value) return null;
  return REPLY_FALLBACK_REASONS.includes(value as ReplyFallbackReason)
    ? (value as ReplyFallbackReason)
    : null;
}

/**
 * Execute a PostHog query
 */
async function executePostHogQuery<T = unknown[]>(
  query: PostHogQuery,
  options: { requireSuccess?: boolean } = {}
): Promise<PostHogQueryResponse<T> | null> {
  const config = getPostHogQueryConfig();
  if (!config) {
    return null;
  }

  try {
    const response = await fetch(
      `${posthogApiHost()}/api/projects/${config.projectId}/query/`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(15_000),
      }
    );

    if (!response.ok) {
      logger.error("Query failed", undefined, {
        status: response.status,
        statusText: response.statusText,
      });
      if (options.requireSuccess) throw new Error("PostHog query unavailable");
      return null;
    }

    const data = await response.json();
    if (!data || !Array.isArray(data.results)) {
      throw new Error("PostHog query returned invalid results");
    }
    return data;
  } catch (error) {
    logger.error("Query error", error);
    if (options.requireSuccess) throw new Error("PostHog query unavailable");
    return null;
  }
}

/**
 * Query pageviews for a workspace within a date range
 */
export async function queryPageviews(
  workspaceId: string,
  dateRange: DateRange,
  sourceId?: string | null
): Promise<PageviewsData> {
  const where = buildWidgetWhere(workspaceId, dateRange, sourceId);
  if (!where) {
    return { total: 0, timeSeries: [] };
  }

  const query: PostHogHogQLQuery = {
    kind: "HogQLQuery",
    query: `
      SELECT toDate(timestamp) AS date, count() AS pageviews
      FROM events
      WHERE event = 'widget_pageview'
        AND ${where.join("\n        AND ")}
      GROUP BY date
      ORDER BY date ASC
      LIMIT 100
    `,
  };

  const result = await executePostHogQuery<[string, number]>(query, {
    requireSuccess: true,
  });

  if (!result || !result.results) {
    return { total: 0, timeSeries: [] };
  }

  const timeSeries = result.results.map(row => ({
    date: String(row[0]),
    count: asNumber(row[1]),
  }));
  const total = timeSeries.reduce((sum, item) => sum + item.count, 0);

  return { total, timeSeries };
}

/**
 * Query top pages by pageviews
 */
export async function queryTopPages(
  workspaceId: string,
  dateRange: DateRange,
  limit: number = 10,
  sourceId?: string | null
): Promise<TopPage[]> {
  const where = buildWidgetWhere(workspaceId, dateRange, sourceId);
  if (!where) {
    return [];
  }

  const query: PostHogHogQLQuery = {
    kind: "HogQLQuery",
    query: `
      SELECT coalesce(properties.page_url, '/') AS url, count() AS views
      FROM events
      WHERE event = 'widget_pageview'
        AND ${where.join("\n        AND ")}
      GROUP BY url
      ORDER BY views DESC
      LIMIT ${normalizeLimit(limit)}
    `,
  };

  const result = await executePostHogQuery<[string, number]>(query, {
    requireSuccess: true,
  });

  if (!result || !result.results) {
    return [];
  }

  return result.results.map(row => ({
    url: row[0] || "/",
    views: asNumber(row[1]),
  }));
}

/**
 * Query session statistics
 */
export async function querySessionStats(
  workspaceId: string,
  dateRange: DateRange,
  sourceId?: string | null
): Promise<SessionStats> {
  const where = buildWidgetWhere(workspaceId, dateRange, sourceId);
  if (!where) {
    return {
      totalSessions: 0,
      avgSessionDuration: 0,
      bounceRate: 0,
    };
  }

  const query: PostHogHogQLQuery = {
    kind: "HogQLQuery",
    query: `
      SELECT
        countIf(started > 0) AS total_sessions,
        avgIf(duration_ms, completed > 0 AND duration_ms > 0) AS avg_duration_ms,
        countIf(completed > 0 AND page_count <= 1) AS bounced_sessions,
        countIf(completed > 0) AS completed_sessions
      FROM (
        SELECT
          countIf(event = 'widget_session_start') AS started,
          countIf(event = 'widget_session_end') AS completed,
          maxIf(
            least(properties.duration_ms, ${WIDGET_SESSION_TIMEOUT_MS}),
            event = 'widget_session_end'
          ) AS duration_ms,
          maxIf(properties.page_count, event = 'widget_session_end') AS page_count
        FROM events
        WHERE event IN ('widget_session_start', 'widget_session_end')
          AND ${where.join("\n          AND ")}
          AND properties.visitor_id IS NOT NULL AND properties.visitor_id != ''
          AND properties.session_id IS NOT NULL AND properties.session_id != ''
        GROUP BY properties.source_id, properties.visitor_id, properties.session_id
      )
    `,
  };

  const result = await executePostHogQuery<[number, number, number, number]>(
    query,
    { requireSuccess: true }
  );

  if (!result || !result.results || result.results.length === 0) {
    return {
      totalSessions: 0,
      avgSessionDuration: 0,
      bounceRate: 0,
    };
  }

  const row = result.results[0] || [0, 0, 0, 0];
  const totalSessions = asNumber(row[0]);
  const avgDurationMs = asNumber(row[1]);
  const bouncedSessions = asNumber(row[2]);
  const completedSessions = asNumber(row[3]);
  const bounceRate =
    completedSessions > 0 ? (bouncedSessions / completedSessions) * 100 : 0;

  return {
    totalSessions,
    avgSessionDuration: avgDurationMs / 1000,
    bounceRate,
  };
}

/**
 * Query traffic sources (referrers)
 */
export async function queryTrafficSources(
  workspaceId: string,
  dateRange: DateRange,
  limit: number = 5,
  sourceId?: string | null
): Promise<TrafficSource[]> {
  const where = buildWidgetWhere(workspaceId, dateRange, sourceId);
  if (!where) {
    return [];
  }

  const query: PostHogHogQLQuery = {
    kind: "HogQLQuery",
    query: `
      SELECT
        coalesce(properties.page_referrer, '(direct)') AS source,
        uniq(properties.visitor_id) AS visitors
      FROM events
      WHERE event = 'widget_pageview'
        AND ${where.join("\n        AND ")}
      GROUP BY source
      ORDER BY visitors DESC
      LIMIT ${normalizeLimit(limit)}
    `,
  };

  const result = await executePostHogQuery<[string, number]>(query, {
    requireSuccess: true,
  });

  if (!result || !result.results) {
    return [];
  }

  const rows = result.results.map(row => ({
    source: row[0] || "(direct)",
    visitors: asNumber(row[1]),
  }));
  const totalVisitors = rows.reduce((sum, row) => sum + row.visitors, 0);

  return rows.map(row => ({
    ...row,
    percentage: totalVisitors > 0 ? (row.visitors / totalVisitors) * 100 : 0,
  }));
}

/**
 * Query device breakdown
 */
export async function queryDeviceStats(
  workspaceId: string,
  dateRange: DateRange,
  sourceId?: string | null
): Promise<DeviceStats> {
  const where = buildWidgetWhere(workspaceId, dateRange, sourceId);
  if (!where) {
    return {
      desktop: 0,
      mobile: 0,
      tablet: 0,
    };
  }

  const query: PostHogHogQLQuery = {
    kind: "HogQLQuery",
    query: `
      SELECT
        countIf(properties.viewport_width >= 1024) AS desktop,
        countIf(properties.viewport_width < 768) AS mobile,
        countIf(properties.viewport_width >= 768 AND properties.viewport_width < 1024) AS tablet
      FROM events
      WHERE event = 'widget_pageview'
        AND ${where.join("\n        AND ")}
      LIMIT 100
    `,
  };

  const result = await executePostHogQuery<[number, number, number]>(query, {
    requireSuccess: true,
  });

  if (!result || !result.results || result.results.length === 0) {
    return {
      desktop: 0,
      mobile: 0,
      tablet: 0,
    };
  }

  const row = result.results[0] || [0, 0, 0];
  return {
    desktop: asNumber(row[0]),
    mobile: asNumber(row[1]),
    tablet: asNumber(row[2]),
  };
}

export async function queryAiriReplyOperatorAnalytics(
  workspaceId: string,
  dateRange: DateRange
): Promise<AiriReplyOperatorAnalytics> {
  const validatedWorkspaceId = validateWorkspaceId(workspaceId);
  if (!validatedWorkspaceId) {
    return buildAiriReplyOperatorAnalytics({ rows: [] });
  }

  const query: PostHogEventsQuery = {
    kind: "EventsQuery",
    select: [
      "timestamp",
      "properties.counter_name",
      "properties.channel",
      "properties.turn_kind",
      "properties.confidence",
      "properties.result_type",
      "properties.fallback_action",
      "properties.fallback_reason",
    ],
    event: "airi_reply_operator_counter",
    where: [`properties.workspace_id = '${validatedWorkspaceId}'`],
    after: dateRange.start,
    before: dateRange.end,
    limit: 10000,
  };

  const result =
    await executePostHogQuery<
      [
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
      ]
    >(query);

  if (!result || !result.results) {
    return buildAiriReplyOperatorAnalytics({ rows: [] });
  }

  const rows: AiriReplyOperatorEventRow[] = [];
  for (const row of result.results) {
    const counterName = String(row[1] || "").trim();
    if (!isReplyOperatorCounterName(counterName)) {
      continue;
    }

    rows.push({
      timestamp: row[0],
      counterName,
      channel: row[2] || null,
      turnKind: row[3] || null,
      confidence: row[4] || null,
      resultType: row[5] || null,
      fallbackAction: parseReplyFallbackAction(row[6] || null),
      fallbackReason: parseReplyFallbackReason(row[7] || null),
    });
  }

  return buildAiriReplyOperatorAnalytics({
    rows,
    limited: Boolean(result.hasMore),
  });
}
