const mockFetchSourceWithCredentialsResult = jest.fn();
const mockDomainUnauthorized = jest.fn();
const mockCheckRateLimit = jest.fn();
const mockTrackWidgetEvent = jest.fn();
const mockIdentifyVisitor = jest.fn();
const mockRedisGet = jest.fn();
const mockRedisSetex = jest.fn();
const mockRedisSet = jest.fn();
const mockDedupKeys = new Map<string, string>();

jest.mock("@upstash/redis", () => ({
  Redis: jest.fn(() => ({
    get: (...args: unknown[]) => mockRedisGet(...args),
    setex: (...args: unknown[]) => mockRedisSetex(...args),
    set: (...args: unknown[]) => mockRedisSet(...args),
  })),
}));

jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentialsResult: (...args: unknown[]) =>
    mockFetchSourceWithCredentialsResult(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
  },
  widgetLogger: {
    domainUnauthorized: (...args: unknown[]) => mockDomainUnauthorized(...args),
    error: jest.fn(),
    rateLimitExceeded: jest.fn(),
  },
}));

jest.mock("@/lib/analytics", () => ({
  identifyVisitor: (...args: unknown[]) => mockIdentifyVisitor(...args),
  trackWidgetEvent: (...args: unknown[]) => mockTrackWidgetEvent(...args),
}));

jest.mock("@/lib/analytics/event-schemas", () => ({
  validateEvent: jest.fn(() => ({ isValid: true, errors: [] })),
}));

jest.mock("@icecore/shared/lib/rate-limiter", () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  createRateLimiter: jest.fn(() => ({})),
}));

import { validateEvent } from "@/lib/analytics/event-schemas";
import { NextRequest } from "next/server";

const mockValidateEvent = validateEvent as jest.Mock;
let POST: typeof import("./route").POST;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

function buildAnalyticsRequest(events: unknown[]) {
  return new NextRequest("https://www.airi.chat/api/widget/analytics", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://www.airi.chat",
    },
    body: JSON.stringify({
      clientKey: "widget_test",
      events,
    }),
  });
}

function buildWidgetPageview(overrides: Record<string, unknown> = {}) {
  return {
    event: "widget_pageview",
    timestamp: new Date().toISOString(),
    properties: {
      visitor_id: "visitor-1",
      page_url: "/",
      ...overrides,
    },
  };
}

describe("POST /api/widget/analytics", () => {
  beforeAll(async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    ({ POST } = await import("./route"));
  });

  afterAll(() => {
    if (originalRedisUrl === undefined)
      delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
    if (originalRedisToken === undefined)
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockDedupKeys.clear();
    mockRedisGet.mockImplementation(async key => mockDedupKeys.get(key));
    mockRedisSetex.mockImplementation(async (key, _ttl, value) => {
      mockDedupKeys.set(key, value);
      return "OK";
    });
    mockRedisSet.mockImplementation(async (key, value, options) => {
      if (options.nx && mockDedupKeys.has(key)) return null;
      mockDedupKeys.set(key, value);
      return "OK";
    });
    mockValidateEvent.mockReturnValue({ isValid: true, errors: [] });
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 100,
      remaining: 99,
    });
    mockFetchSourceWithCredentialsResult.mockResolvedValue({
      ok: true,
      source: {
        id: "source-1",
        workspace_id: "workspace-1",
        company_id: "company-1",
        credentials: {
          client_key: "widget_test",
          allowed_domains: ["www.airi.chat"],
          status: "active",
        },
      },
    });
  });

  it("keeps distinct legacy pageviews and only drops an exact retry", async () => {
    const first = buildWidgetPageview({
      visitor_id: "12345678-1234-1234-1234-123456789012",
    });
    const second = {
      ...first,
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      properties: { ...first.properties, page_url: "/pricing" },
    };
    const response = await POST(buildAnalyticsRequest([first, second, first]));
    expect(await response.json()).toEqual({ success: true, processed: 2 });
    expect(
      mockTrackWidgetEvent.mock.calls.map(call => call[1].page_url)
    ).toEqual(["/", "/pricing"]);
  });

  it("claims concurrent retries atomically", async () => {
    const event = buildWidgetPageview({ event_id: "stable-event-1" });
    const responses = await Promise.all([
      POST(buildAnalyticsRequest([event])),
      POST(buildAnalyticsRequest([event])),
    ]);
    const bodies = await Promise.all(
      responses.map(response => response.json())
    );
    expect(bodies.reduce((sum, body) => sum + body.processed, 0)).toBe(1);
    expect(mockTrackWidgetEvent).toHaveBeenCalledTimes(1);
    expect(mockRedisSet).toHaveBeenCalledWith(expect.any(String), "1", {
      nx: true,
      ex: 3600,
    });
  });

  it("scopes supplied event identities to their workspace and widget source", async () => {
    const event = buildWidgetPageview({ event_id: "same-client-event" });
    await POST(buildAnalyticsRequest([event]));
    const authorized = await mockFetchSourceWithCredentialsResult();
    mockFetchSourceWithCredentialsResult.mockResolvedValue({
      ...authorized,
      source: { ...authorized.source, id: "source-2" },
    });
    await POST(buildAnalyticsRequest([event]));
    mockFetchSourceWithCredentialsResult.mockResolvedValue({
      ...authorized,
      source: { ...authorized.source, workspace_id: "workspace-2" },
    });
    await POST(buildAnalyticsRequest([event]));
    expect(mockTrackWidgetEvent).toHaveBeenCalledTimes(3);
  });

  it("rejects analytics batches from origins outside the widget allowlist", async () => {
    const response = await POST(
      new NextRequest("https://www.airi.chat/api/widget/analytics", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin:
            "https://nest-ai-front-8q6yj82dg-fatdrfrogs-projects.vercel.app",
        },
        body: JSON.stringify({
          clientKey: "widget_test",
          events: [
            {
              event: "widget_pageview",
              timestamp: new Date().toISOString(),
              properties: {
                visitor_id: "visitor-1",
              },
            },
          ],
        }),
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Domain not authorized",
    });
    expect(mockDomainUnauthorized).toHaveBeenCalledWith(
      "https://nest-ai-front-8q6yj82dg-fatdrfrogs-projects.vercel.app",
      "widget_test",
      "workspace-1",
      "company-1"
    );
    expect(mockTrackWidgetEvent).not.toHaveBeenCalled();
    expect(mockIdentifyVisitor).not.toHaveBeenCalled();
  });

  it("rejects oversized batches before resolving the widget source", async () => {
    const response = await POST(
      buildAnalyticsRequest(
        Array.from({ length: 51 }, () => buildWidgetPageview())
      )
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Analytics batch cannot exceed 50 events",
    });
    expect(mockFetchSourceWithCredentialsResult).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockTrackWidgetEvent).not.toHaveBeenCalled();
    expect(mockIdentifyVisitor).not.toHaveBeenCalled();
  });

  it("rejects mixed visitor batches", async () => {
    const response = await POST(
      buildAnalyticsRequest([
        buildWidgetPageview({ visitor_id: "visitor-1" }),
        buildWidgetPageview({ visitor_id: "visitor-2" }),
      ])
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "All events in a batch must share the same visitor_id",
    });
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockTrackWidgetEvent).not.toHaveBeenCalled();
    expect(mockIdentifyVisitor).not.toHaveBeenCalled();
  });

  it("rejects malformed event objects", async () => {
    const response = await POST(
      buildAnalyticsRequest([null, buildWidgetPageview()])
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Invalid analytics event shape",
    });
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockTrackWidgetEvent).not.toHaveBeenCalled();
    expect(mockIdentifyVisitor).not.toHaveBeenCalled();
  });

  it("rejects invalid timestamps without identifying the visitor", async () => {
    const response = await POST(
      buildAnalyticsRequest([
        {
          ...buildWidgetPageview(),
          timestamp: "not-a-date",
        },
      ])
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      processed: 0,
    });
    expect(mockValidateEvent).not.toHaveBeenCalled();
    expect(mockTrackWidgetEvent).not.toHaveBeenCalled();
    expect(mockIdentifyVisitor).not.toHaveBeenCalled();
  });

  it("accepts session end events with small client clock skew into the future", async () => {
    const response = await POST(
      buildAnalyticsRequest([
        {
          event: "widget_session_end",
          timestamp: new Date(Date.now() + 30_000).toISOString(),
          properties: {
            visitor_id: "visitor-1",
            session_id: "session-1",
            duration_ms: 1500,
            page_count: 1,
          },
        },
      ])
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      processed: 1,
    });
    expect(mockTrackWidgetEvent).toHaveBeenCalledWith(
      "widget_session_end",
      expect.objectContaining({
        workspace_id: "workspace-1",
        company_id: "company-1",
        source_id: "source-1",
        visitor_id: "visitor-1",
        session_id: "session-1",
        duration_ms: 1500,
        page_count: 1,
      }),
      "visitor-1",
      "company-1",
      "workspace-1"
    );
  });

  it("does not identify the visitor when every event fails schema validation", async () => {
    mockValidateEvent.mockReturnValue({
      isValid: false,
      errors: ["Missing required property: page_url"],
    });

    const response = await POST(buildAnalyticsRequest([buildWidgetPageview()]));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      processed: 0,
    });
    expect(mockTrackWidgetEvent).not.toHaveBeenCalled();
    expect(mockIdentifyVisitor).not.toHaveBeenCalled();
  });

  it("identifies and forwards accepted events after validation", async () => {
    const response = await POST(
      buildAnalyticsRequest([
        buildWidgetPageview({
          viewport_width: 1440,
          viewport_height: 900,
          language: "en",
        }),
      ])
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      processed: 1,
    });
    expect(mockIdentifyVisitor).toHaveBeenCalledWith("visitor-1", {
      workspace_id: "workspace-1",
      company_id: "company-1",
      viewport_width: 1440,
      viewport_height: 900,
      language: "en",
    });
    expect(mockTrackWidgetEvent).toHaveBeenCalledWith(
      "widget_pageview",
      expect.objectContaining({
        workspace_id: "workspace-1",
        company_id: "company-1",
        source_id: "source-1",
        visitor_id: "visitor-1",
        page_url: "/",
      }),
      "visitor-1",
      "company-1",
      "workspace-1"
    );
  });

  it("consumes rate limits by event volume for visitor and workspace limits", async () => {
    const response = await POST(
      buildAnalyticsRequest([
        buildWidgetPageview(),
        buildWidgetPageview({ page_url: "/pricing" }),
        buildWidgetPageview({ page_url: "/docs" }),
      ])
    );

    expect(response.status).toBe(200);
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(6);
    expect(mockTrackWidgetEvent).toHaveBeenCalledTimes(3);
    expect(mockIdentifyVisitor).toHaveBeenCalledTimes(1);
  });
});
