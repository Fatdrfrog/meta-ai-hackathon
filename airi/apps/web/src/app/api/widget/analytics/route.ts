import { identifyVisitor, trackWidgetEvent } from "@/lib/analytics";
import { validateEvent } from "@/lib/analytics/event-schemas";
import { logger, widgetLogger } from "@/lib/logger";
import { handleCorsOptions, jsonWithCors } from "@/lib/widget/cors";
import { resolveAuthorizedWidgetSource } from "@/lib/widget/source-context";
import {
  checkRateLimit,
  createRateLimiter,
} from "@icecore/shared/lib/rate-limiter";
import { Redis } from "@upstash/redis";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";

// Redis client for event deduplication
const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

const EVENT_DEDUP_TTL = 3600; // 1 hour in seconds
const MAX_EVENT_AGE_MS = 60 * 60 * 1000; // 1 hour
const MAX_EVENT_FUTURE_SKEW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ANALYTICS_BATCH_EVENTS = 50;

// Widget analytics rate limiters
const analyticsLimiter = createRateLimiter({
  requests: 100, // 100 events per minute per visitor
  window: "1 m",
  prefix: "widget-analytics",
});

const workspaceAnalyticsLimiter = createRateLimiter({
  requests: 1000, // 1000 events per minute per workspace
  window: "1 m",
  prefix: "workspace-analytics",
});

interface AnalyticsEvent {
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

interface AnalyticsRequest {
  clientKey: string;
  events: AnalyticsEvent[];
}

interface AnalyticsResponse {
  success: boolean;
  processed?: number;
  error?: string;
}

type AcceptedEvent = {
  event: string;
  properties: Record<string, string | number | boolean | string[] | undefined>;
  originalProperties: Record<string, unknown>;
};

async function checkBatchRateLimit(
  limiter: Parameters<typeof checkRateLimit>[0],
  identifier: string,
  eventCount: number,
  fallbackLimit: number
) {
  let lastResult = {
    success: true,
    limit: fallbackLimit,
    remaining: fallbackLimit,
    reset: Date.now() + 60000,
  };

  for (let index = 0; index < eventCount; index += 1) {
    lastResult = await checkRateLimit(limiter, identifier, fallbackLimit);
    if (!lastResult.success) return lastResult;
  }

  return lastResult;
}

function getVisitorId(event: AnalyticsEvent): string | null {
  const visitorId = event.properties?.visitor_id;
  if (typeof visitorId !== "string") return null;
  const trimmed = visitorId.trim();
  return trimmed && trimmed !== "unknown" ? trimmed : null;
}

function isAnalyticsEvent(value: unknown): value is AnalyticsEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AnalyticsEvent>;
  return (
    typeof candidate.event === "string" &&
    typeof candidate.timestamp === "string" &&
    Boolean(candidate.properties) &&
    typeof candidate.properties === "object" &&
    !Array.isArray(candidate.properties)
  );
}

function buildDeviceProperties(
  source: { workspace_id: string; company_id: string },
  eventProperties: Record<string, unknown>
): {
  workspace_id: string;
  company_id: string;
  [key: string]: string | number | boolean | undefined;
} {
  const deviceProperties: {
    workspace_id: string;
    company_id: string;
    [key: string]: string | number | boolean | undefined;
  } = {
    workspace_id: source.workspace_id,
    company_id: source.company_id,
  };

  if (eventProperties.viewport_width) {
    deviceProperties.viewport_width = Number(eventProperties.viewport_width);
  }
  if (eventProperties.viewport_height) {
    deviceProperties.viewport_height = Number(eventProperties.viewport_height);
  }
  if (eventProperties.user_agent) {
    deviceProperties.user_agent = String(eventProperties.user_agent);
  }
  if (eventProperties.language) {
    deviceProperties.language = String(eventProperties.language);
  }
  if (eventProperties.timezone) {
    deviceProperties.timezone = String(eventProperties.timezone);
  }

  return deviceProperties;
}

/**
 * OPTIONS /api/widget/analytics
 * Handle CORS preflight — echo Origin to support credentialed requests
 */
export async function OPTIONS(req: NextRequest) {
  return handleCorsOptions(req);
}

/**
 * POST /api/widget/analytics
 *
 * Receives analytics events from the widget and forwards to PostHog
 * Supports batching multiple events in a single request
 */
export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");

  try {
    const body = await req.json().catch(() => null);

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonWithCors<AnalyticsResponse>(
        {
          success: false,
          error: "Missing required fields: clientKey and events array",
        },
        { status: 400, origin }
      );
    }

    const { clientKey, events } = body as Partial<AnalyticsRequest>;

    if (!clientKey || !events || !Array.isArray(events)) {
      return jsonWithCors<AnalyticsResponse>(
        {
          success: false,
          error: "Missing required fields: clientKey and events array",
        },
        { status: 400, origin }
      );
    }

    if (events.length === 0) {
      return jsonWithCors<AnalyticsResponse>(
        {
          success: false,
          error: "Events array must contain at least one event",
        },
        { status: 400, origin }
      );
    }

    if (events.length > MAX_ANALYTICS_BATCH_EVENTS) {
      return jsonWithCors<AnalyticsResponse>(
        {
          success: false,
          error: `Analytics batch cannot exceed ${MAX_ANALYTICS_BATCH_EVENTS} events`,
        },
        { status: 413, origin }
      );
    }

    const sourceAuth = await resolveAuthorizedWidgetSource({
      request: req,
      clientKey,
    });
    if (!sourceAuth.ok) {
      return jsonWithCors<AnalyticsResponse>(
        {
          success: false,
          error: sourceAuth.error,
        },
        { status: sourceAuth.status, origin }
      );
    }

    const { source } = sourceAuth;

    const normalizedEvents: AnalyticsEvent[] = [];
    const visitorIds = new Set<string>();
    for (const event of events) {
      if (!isAnalyticsEvent(event)) {
        return jsonWithCors<AnalyticsResponse>(
          {
            success: false,
            error: "Invalid analytics event shape",
          },
          { status: 400, origin }
        );
      }

      const eventVisitorId = getVisitorId(event);
      if (!eventVisitorId) {
        return jsonWithCors<AnalyticsResponse>(
          {
            success: false,
            error: "Missing required visitor_id in events",
          },
          { status: 400, origin }
        );
      }
      visitorIds.add(eventVisitorId);
      normalizedEvents.push(event);
    }

    if (visitorIds.size !== 1) {
      return jsonWithCors<AnalyticsResponse>(
        {
          success: false,
          error: "All events in a batch must share the same visitor_id",
        },
        { status: 400, origin }
      );
    }

    const visitorId = Array.from(visitorIds)[0];

    // Rate limiting per visitor
    const visitorRateLimit = await checkBatchRateLimit(
      analyticsLimiter,
      String(visitorId),
      normalizedEvents.length,
      100
    );

    if (!visitorRateLimit.success) {
      widgetLogger.rateLimitExceeded(
        "/api/widget/analytics",
        String(visitorId),
        source.workspace_id,
        source.company_id
      );
      return jsonWithCors<AnalyticsResponse>(
        {
          success: false,
          error: "Rate limit exceeded. Please slow down.",
        },
        {
          status: 429,
          origin,
          headers: {
            "X-RateLimit-Limit": visitorRateLimit.limit.toString(),
            "X-RateLimit-Remaining": visitorRateLimit.remaining.toString(),
          },
        }
      );
    }

    // Rate limiting per workspace
    const workspaceRateLimit = await checkBatchRateLimit(
      workspaceAnalyticsLimiter,
      String(source.workspace_id),
      normalizedEvents.length,
      1000
    );

    if (!workspaceRateLimit.success) {
      widgetLogger.rateLimitExceeded(
        "/api/widget/analytics",
        source.workspace_id,
        source.workspace_id,
        source.company_id
      );
      return jsonWithCors<AnalyticsResponse>(
        {
          success: false,
          error: "Workspace rate limit exceeded.",
        },
        {
          status: 429,
          origin,
          headers: {
            "X-RateLimit-Limit": workspaceRateLimit.limit.toString(),
            "X-RateLimit-Remaining": workspaceRateLimit.remaining.toString(),
          },
        }
      );
    }

    // Forward each event to PostHog with workspace/company context
    let processedCount = 0;
    let invalidCount = 0;
    let duplicateCount = 0;
    let staleCount = 0;
    const acceptedEvents: AcceptedEvent[] = [];

    for (const event of normalizedEvents) {
      try {
        // Validate event timestamp before deduping so invalid payloads do not
        // poison a deterministic event id.
        const eventTime = new Date(event.timestamp).getTime();
        const now = Date.now();
        if (!Number.isFinite(eventTime)) {
          invalidCount++;
          logger.warn("Invalid event timestamp rejected", {
            workspaceId: source.workspace_id,
            companyId: source.company_id,
            event: event.event,
            timestamp: event.timestamp,
          });
          continue;
        }

        const eventAge = now - eventTime;
        if (eventAge > MAX_EVENT_AGE_MS) {
          staleCount++;
          logger.warn("Stale event rejected", {
            workspaceId: source.workspace_id,
            companyId: source.company_id,
            event: event.event,
            age: eventAge,
            timestamp: event.timestamp,
          });
          continue;
        }
        if (eventAge < -MAX_EVENT_FUTURE_SKEW_MS) {
          invalidCount++;
          logger.warn("Future event timestamp rejected", {
            workspaceId: source.workspace_id,
            companyId: source.company_id,
            event: event.event,
            age: eventAge,
            maxFutureSkewMs: MAX_EVENT_FUTURE_SKEW_MS,
            timestamp: event.timestamp,
          });
          continue;
        }

        // Validate event schema
        const validation = validateEvent(event.event, event.properties);
        if (!validation.isValid) {
          invalidCount++;
          logger.warn("Invalid event rejected", {
            workspaceId: source.workspace_id,
            companyId: source.company_id,
            event: event.event,
            errors: validation.errors,
            properties: Object.keys(event.properties),
          });
          continue;
        }

        // Hash the complete identity, including the authenticated tenant/source.
        // Older widgets have no event_id: exact replays retain the content hash.
        const clientEventId = event.properties.event_id;
        const eventIdentity =
          typeof clientEventId === "string" && clientEventId.trim()
            ? ["id", clientEventId]
            : ["content", event.timestamp, event.properties];
        const eventId = createHash("sha256")
          .update(
            JSON.stringify([
              source.workspace_id,
              source.id,
              visitorId,
              event.event,
              eventIdentity,
            ])
          )
          .digest("hex");

        // Check for duplicate events (if Redis is available)
        if (redis) {
          const claimed = await redis.set(
            `analytics:dedup:v2:${eventId}`,
            "1",
            {
              nx: true,
              ex: EVENT_DEDUP_TTL,
            }
          );
          if (!claimed) {
            duplicateCount++;
            continue; // Skip duplicate event
          }
        }

        // Build event properties with proper type filtering
        const eventProperties: Record<
          string,
          string | number | boolean | string[] | undefined
        > = {
          workspace_id: source.workspace_id,
          company_id: source.company_id,
          source_id: source.id,
        };

        // Filter event properties to compatible types only
        for (const [key, value] of Object.entries(event.properties)) {
          if (key === "$groups" || key === "event_id") continue;

          if (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean" ||
            Array.isArray(value)
          ) {
            eventProperties[key] = value as
              | string
              | number
              | boolean
              | string[];
          } else if (value !== undefined && value !== null) {
            eventProperties[key] = String(value);
          }
        }

        acceptedEvents.push({
          event: event.event,
          properties: eventProperties,
          originalProperties: event.properties,
        });
      } catch (eventError) {
        // Log error but don't fail the whole batch
        widgetLogger.error("analytics_event_forward", eventError, {
          workspaceId: source.workspace_id,
          companyId: source.company_id,
          event: event.event,
        });
      }
    }

    if (acceptedEvents.length > 0) {
      identifyVisitor(
        visitorId,
        buildDeviceProperties(source, acceptedEvents[0].originalProperties)
      );

      for (const event of acceptedEvents) {
        // Track event with visitor_id as distinctId
        trackWidgetEvent(
          event.event,
          event.properties,
          visitorId,
          source.company_id,
          source.workspace_id
        );
        processedCount++;
      }
    }

    // Log successful analytics batch with metrics
    logger.info("Widget analytics batch processed", {
      workspaceId: source.workspace_id,
      companyId: source.company_id,
      visitorId: String(visitorId),
      totalEvents: events.length,
      processedCount,
      invalidCount,
      duplicateCount,
      staleCount,
      eventTypes: normalizedEvents.map(e => e.event).join(", "),
    });

    return jsonWithCors<AnalyticsResponse>(
      { success: true, processed: processedCount },
      { origin }
    );
  } catch (error) {
    widgetLogger.error("analytics_batch", error, { origin });
    return jsonWithCors<AnalyticsResponse>(
      {
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500, origin }
    );
  }
}
