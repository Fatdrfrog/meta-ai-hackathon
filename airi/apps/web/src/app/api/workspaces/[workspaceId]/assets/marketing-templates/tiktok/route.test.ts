const mockRequireWorkspaceAccess = jest.fn();
const mockCheckRateLimit = jest.fn();
const mockLoadDiscovery = jest.fn();
const mockLogSuccess = jest.fn();
const mockCreateRequestLogger = jest.fn(
  (_scope: string, _request: Request) => ({
    success: (...args: unknown[]) => mockLogSuccess(...args),
  })
);

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireWorkspaceAccess(...args),
}));

jest.mock("@icecore/shared/lib/rate-limiter", () => ({
  createRateLimiter: jest.fn(() => ({ id: "limiter" })),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

jest.mock("@/lib/tiktok-discovery/catalog-loader", () => ({
  loadTikTokDiscoveryMarketingTemplates: (...args: unknown[]) =>
    mockLoadDiscovery(...args),
}));

jest.mock("@/lib/observability/server-logs", () => ({
  createRequestLogger: (scope: string, request: Request) =>
    mockCreateRequestLogger(scope, request),
}));

import type { TikTokDiscoveryLoadResult } from "@/lib/tiktok-discovery/catalog-loader";
import { NextRequest, NextResponse } from "next/server";

import { GET } from "./route";

const routeContext = {
  params: Promise.resolve({ workspaceId: "workspace-1" }),
};

function request(
  query = "",
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(
    `http://localhost/api/workspaces/workspace-1/assets/marketing-templates/tiktok${query}`,
    { headers }
  );
}

const emptyOk: TikTokDiscoveryLoadResult = {
  transportStatus: 200,
  cacheOutcome: "fresh",
  providerOutcome: "not_called",
  hashtagCount: 0,
  retryAt: null,
  response: {
    status: "ok",
    items: [],
    market: "KZ",
    category: "ALL",
    windowDays: 7,
    updatedAt: "2026-08-13T12:00:00.000Z",
    stale: false,
  },
};

const grantedRateLimit = {
  success: true,
  limit: 20,
  remaining: 19,
  reset: Date.now() + 300_000,
};

function allowWorkspace(): void {
  mockRequireWorkspaceAccess.mockResolvedValue({
    ok: true,
    userId: "user-1",
    supabase: {},
    accessToken: null,
  });
}

async function importIsolatedRouteWithLimiter(limiter: unknown) {
  jest.resetModules();
  jest.doMock("@icecore/shared/lib/rate-limiter", () => ({
    createRateLimiter: jest.fn(() => limiter),
    checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  }));
  let isolatedGet: typeof GET | undefined;
  await jest.isolateModulesAsync(async () => {
    ({ GET: isolatedGet } = await import("./route"));
  });
  if (!isolatedGet) throw new Error("Isolated route did not load");
  return isolatedGet;
}

function replaceNodeEnv(value: string): () => void {
  const mutableEnv = process.env as Record<string, string | undefined>;
  const original = mutableEnv.NODE_ENV;
  mutableEnv.NODE_ENV = value;
  return () => {
    mutableEnv.NODE_ENV = original;
  };
}

describe("GET workspace TikTok marketing templates", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    allowWorkspace();
    mockCheckRateLimit.mockResolvedValue(grantedRateLimit);
    mockLoadDiscovery.mockResolvedValue(emptyOk);
  });

  it("authorizes, limits by user/workspace, and uses KZ/ALL defaults", async () => {
    const response = await GET(request(), routeContext);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(emptyOk.response);
    expect(mockRequireWorkspaceAccess).toHaveBeenCalledWith("workspace-1");
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "user-1:workspace-1",
      20
    );
    expect(mockLoadDiscovery).toHaveBeenCalledTimes(1);
    expect(mockLoadDiscovery).toHaveBeenCalledWith({
      market: "KZ",
      category: "ALL",
    });
    expect(mockLogSuccess).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403] as const)(
    "returns %i before limiting or loading",
    async status => {
      mockRequireWorkspaceAccess.mockResolvedValue({
        ok: false,
        response: NextResponse.json({ error: "denied" }, { status }),
      });

      const response = await GET(request(), routeContext);

      expect(response.status).toBe(status);
      expect(mockCheckRateLimit).not.toHaveBeenCalled();
      expect(mockLoadDiscovery).not.toHaveBeenCalled();
      expect(mockLogSuccess).toHaveBeenCalledTimes(1);
    }
  );

  it("normalizes an authorization infrastructure failure before limiting", async () => {
    mockRequireWorkspaceAccess.mockRejectedValue(
      new Error("secret membership store failure")
    );

    const response = await GET(request(), routeContext);

    expect(response.status).toBe(503);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockLoadDiscovery).not.toHaveBeenCalled();
    expect(mockLogSuccess).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockLogSuccess.mock.calls[0])).not.toContain(
      "secret membership store failure"
    );
  });

  it.each([
    ["?market=kz", 400],
    ["?market=%20KZ%20", 400],
    ["?market=ZZ", 400],
    ["?market=", 400],
    ["?market=KZ&market=US", 400],
    ["?category=food_and_beverage", 400],
    ["?category=UNKNOWN", 400],
    ["?category=", 400],
    ["?category=ALL&category=TRAVEL", 400],
  ] as const)("rejects invalid query %s", async (query, status) => {
    const response = await GET(request(query), routeContext);

    expect(response.status).toBe(status);
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
    expect(mockLoadDiscovery).not.toHaveBeenCalled();
    expect(mockLogSuccess).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["?market=KZ&category=ALL", { market: "KZ", category: "ALL" }],
    [
      "?market=UZ&category=FOOD_AND_BEVERAGE",
      { market: "UZ", category: "FOOD_AND_BEVERAGE" },
    ],
    ["?market=US&category=TRAVEL", { market: "US", category: "TRAVEL" }],
  ] as const)("forwards %s exactly", async (query, coordinates) => {
    await GET(request(query), routeContext);

    expect(mockLoadDiscovery).toHaveBeenCalledTimes(1);
    expect(mockLoadDiscovery).toHaveBeenCalledWith(coordinates);
  });

  it("returns 503 when checking the request limiter throws", async () => {
    mockCheckRateLimit.mockRejectedValue(new Error("secret redis failure"));

    const response = await GET(request(), routeContext);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "TikTok Discovery is temporarily unavailable",
    });
    expect(mockLoadDiscovery).not.toHaveBeenCalled();
    expect(mockLogSuccess).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockLogSuccess.mock.calls[0])).not.toContain(
      "secret redis failure"
    );
  });

  it("returns 503 when the request limiter times out", async () => {
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 0,
      remaining: 0,
      reset: 0,
    });

    const response = await GET(request(), routeContext);

    expect(response.status).toBe(503);
    expect(mockLoadDiscovery).not.toHaveBeenCalled();
    expect(mockLogSuccess).toHaveBeenCalledTimes(1);
  });

  it.each([
    [Date.parse("2026-08-13T12:00:00.000Z") - 1, "1"],
    [Date.parse("2026-08-13T12:00:01.000Z"), "1"],
    [Date.parse("2026-08-13T12:10:00.000Z"), "300"],
  ] as const)(
    "clamps an exhausted limiter reset %i to Retry-After %s",
    async (reset, retryAfter) => {
      const now = Date.parse("2026-08-13T12:00:00.000Z");
      jest.spyOn(Date, "now").mockReturnValue(now);
      mockCheckRateLimit.mockResolvedValue({
        success: false,
        limit: 20,
        remaining: 0,
        reset,
      });

      const response = await GET(request(), routeContext);

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe(retryAfter);
      expect(response.headers.get("X-RateLimit-Limit")).toBe("20");
      expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
      expect(mockLoadDiscovery).not.toHaveBeenCalled();
      expect(mockLogSuccess).toHaveBeenCalledTimes(1);
      jest.restoreAllMocks();
    }
  );

  it.each([
    [
      "unavailable",
      {
        response: { status: "unavailable", items: [] },
        cacheOutcome: "credential_unavailable",
        retryAt: null,
      },
      200,
    ],
    [
      "temporarily_unavailable",
      {
        response: {
          status: "temporarily_unavailable",
          items: [],
          retryAt: "2026-08-13T12:00:01.000Z",
        },
        cacheOutcome: "temporarily_unavailable",
        retryAt: "2026-08-13T12:00:01.000Z",
      },
      200,
    ],
    [
      "error",
      {
        response: { status: "error", items: [], retryable: true },
        cacheOutcome: "temporarily_unavailable",
        retryAt: null,
      },
      200,
    ],
  ] as const)(
    "keeps product response %s on its transport status",
    async (_name, product, status) => {
      mockLoadDiscovery.mockResolvedValue({
        ...emptyOk,
        ...product,
        transportStatus: status,
      });

      const response = await GET(request(), routeContext);

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(product.response);
      expect(mockLoadDiscovery).toHaveBeenCalledTimes(1);
      expect(mockLogSuccess).toHaveBeenCalledTimes(1);
    }
  );

  it("returns one loader coordination outage as HTTP 503", async () => {
    mockLoadDiscovery.mockResolvedValue({
      ...emptyOk,
      transportStatus: 503,
      cacheOutcome: "coordination_unavailable",
      response: { status: "temporarily_unavailable", items: [] },
    });

    const response = await GET(request(), routeContext);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "temporarily_unavailable",
      items: [],
    });
    expect(mockLoadDiscovery).toHaveBeenCalledTimes(1);
    expect(mockLogSuccess).toHaveBeenCalledTimes(1);
  });

  it("normalizes an unexpected loader exception to a safe 503", async () => {
    mockLoadDiscovery.mockRejectedValue(new Error("raw provider secret-token"));

    const response = await GET(request(), routeContext);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "temporarily_unavailable",
      items: [],
    });
    expect(mockLoadDiscovery).toHaveBeenCalledTimes(1);
    expect(mockLogSuccess).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockLogSuccess.mock.calls[0])).not.toContain(
      "raw provider secret-token"
    );
  });

  it("logs one bounded completion event for a coordination outage", async () => {
    mockLoadDiscovery.mockResolvedValue({
      ...emptyOk,
      transportStatus: 503,
      cacheOutcome: "coordination_unavailable",
      response: { status: "temporarily_unavailable", items: [] },
      advertiserId: "advertiser",
      appId: "app-1",
      token: "secret-token",
      providerMessage: "raw provider",
    });

    const response = await GET(
      request("", {
        "x-request-id": "request-1 creator title https://unsafe.example",
        "x-correlation-id": "secret-token raw provider",
      }),
      routeContext
    );

    expect(response.status).toBe(503);
    expect(mockLogSuccess).toHaveBeenCalledTimes(1);
    expect(mockCreateRequestLogger).toHaveBeenCalledTimes(1);
    const loggerRequest = mockCreateRequestLogger.mock.calls[0]?.[1] as Request;
    expect(loggerRequest.method).toBe("GET");
    expect(loggerRequest.headers.get("x-request-id")).toBeNull();
    expect(loggerRequest.headers.get("x-correlation-id")).toBeNull();
    expect(mockLogSuccess.mock.calls[0]?.[0]).toBe(
      "TikTok Discovery catalog request completed"
    );
    expect(mockLogSuccess.mock.calls[0]?.[1]).toEqual({
      userId: "user-1",
      workspaceId: "workspace-1",
      market: "KZ",
      category: "ALL",
      httpStatus: 503,
      productStatus: "temporarily_unavailable",
      cacheOutcome: "coordination_unavailable",
      providerOutcome: "not_called",
      itemCount: 0,
      stale: false,
      retryAt: null,
    });
    const event = JSON.stringify(mockLogSuccess.mock.calls[0]);
    for (const banned of [
      "advertiser",
      "secret-token",
      "app-1",
      "https://",
      "creator",
      "title",
      "request-1",
      "raw provider",
    ]) {
      expect(event).not.toContain(banned);
    }
  });

  it("fails closed in production when the module-scope limiter is absent", async () => {
    const restoreNodeEnv = replaceNodeEnv("production");
    try {
      const isolatedGet = await importIsolatedRouteWithLimiter(null);

      const response = await isolatedGet(request(), routeContext);

      expect(response.status).toBe(503);
      expect(mockCheckRateLimit).not.toHaveBeenCalled();
      expect(mockLoadDiscovery).not.toHaveBeenCalled();
      expect(mockLogSuccess).toHaveBeenCalledTimes(1);
    } finally {
      restoreNodeEnv();
    }
  });

  it("continues deterministically outside production when the module-scope limiter is absent", async () => {
    const restoreNodeEnv = replaceNodeEnv("test");
    try {
      const isolatedGet = await importIsolatedRouteWithLimiter(null);

      const response = await isolatedGet(request(), routeContext);

      expect(response.status).toBe(200);
      expect(mockCheckRateLimit).not.toHaveBeenCalled();
      expect(mockLoadDiscovery).toHaveBeenCalledTimes(1);
      expect(mockLogSuccess).toHaveBeenCalledTimes(1);
    } finally {
      restoreNodeEnv();
    }
  });
});
