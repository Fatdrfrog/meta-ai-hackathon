import deploymentConfig from "../../../../../vercel.json";

const mockVerifyCronAuth = jest.fn();
const mockCollectDependencyHealth = jest.fn();
const mockDependencyHealthWarn = jest.fn();

jest.mock("@/lib/cron-auth", () => ({
  verifyCronAuth: (...args: unknown[]) => mockVerifyCronAuth(...args),
}));

jest.mock("@/lib/dependency-health", () => ({
  collectDependencyHealth: (...args: unknown[]) =>
    mockCollectDependencyHealth(...args),
}));

jest.mock("@icecore/shared/lib/logger", () => ({
  createLogger: () => ({ warn: mockDependencyHealthWarn }),
}));

describe("/api/cron/check-dependencies", () => {
  it("checks dependencies every ten minutes", () => {
    expect(
      deploymentConfig.crons.find(
        cron => cron.path === "/api/cron/check-dependencies"
      )?.schedule
    ).toBe("*/10 * * * *");
  });
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockVerifyCronAuth.mockReturnValue(null);
    mockCollectDependencyHealth.mockResolvedValue({
      checkedAt: "2026-06-30T08:50:45.397Z",
      status: "healthy",
      dependencies: {
        upstash_redis: { name: "upstash_redis", status: "not_configured" },
        realtime_gateway: { name: "realtime_gateway", status: "healthy" },
        telegram_api: { name: "telegram_api", status: "not_configured" },
        meta_graph_api: { name: "meta_graph_api", status: "not_configured" },
      },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("gives the realtime gateway probe a cron-sized cold start budget", async () => {
    const { GET } = await import("./route");

    await GET(new Request("https://example.com/api/cron/check-dependencies"));

    expect(mockCollectDependencyHealth).toHaveBeenCalledWith({
      timeouts: {
        realtime_gateway: expect.any(Number),
      },
    });
    const call = mockCollectDependencyHealth.mock.calls[0][0];
    expect(call.timeouts.realtime_gateway).toBeGreaterThan(5_000);
  });

  it("never probes dependencies for an unauthorized request", async () => {
    mockVerifyCronAuth.mockReturnValue(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })
    );
    const { GET } = await import("./route");

    const response = await GET(
      new Request("https://example.com/api/cron/check-dependencies")
    );

    expect(response.status).toBe(401);
    expect(mockCollectDependencyHealth).not.toHaveBeenCalled();
  });

  it("returns the collected dependencies when they are healthy", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://example.com/api/cron/check-dependencies")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      ...(await mockCollectDependencyHealth.mock.results[0].value),
      failingDependencies: [],
    });
  });

  it.each([
    ["unhealthy", 503, false],
    ["degraded", 200, true],
  ] as const)(
    "preserves %s dependency failures and logs",
    async (status, statusCode, ok) => {
      const dependency = {
        name: "realtime_gateway",
        reason: "gateway_unavailable",
        status,
        latencyMs: 47,
      };
      mockCollectDependencyHealth.mockResolvedValue({
        checkedAt: "2026-10-10T00:00:00.000Z",
        status,
        dependencies: { realtime_gateway: dependency },
      });
      const { GET } = await import("./route");
      const response = await GET(
        new Request("https://example.com/api/cron/check-dependencies")
      );

      expect(response.status).toBe(statusCode);
      expect(await response.json()).toEqual({
        ok,
        status,
        checkedAt: "2026-10-10T00:00:00.000Z",
        failingDependencies: [dependency],
        dependencies: { realtime_gateway: dependency },
      });
      expect(mockDependencyHealthWarn).toHaveBeenCalledWith(
        "dependency_health",
        expect.objectContaining({
          status,
          failing_dependencies: [dependency],
        })
      );
    }
  );
});

export {};
