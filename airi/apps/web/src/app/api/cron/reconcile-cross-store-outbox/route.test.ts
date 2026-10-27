const mockVerifyCronAuth = jest.fn();
const mockProcessCrossStoreOutboxBatch = jest.fn();

jest.mock("@/lib/cron-auth", () => ({
  verifyCronAuth: (...args: unknown[]) => mockVerifyCronAuth(...args),
}));

jest.mock("@/lib/cross-store-outbox", () => ({
  processCrossStoreOutboxBatch: (...args: unknown[]) =>
    mockProcessCrossStoreOutboxBatch(...args),
}));

import { GET } from "./route";

describe("/api/cron/reconcile-cross-store-outbox", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyCronAuth.mockReturnValue(null);
  });

  it("drains the business outbox and returns its analytics backlog", async () => {
    const result = {
      processed: 3,
      analyticsBacklog: 2,
      analyticsFailed: 1,
    };
    mockProcessCrossStoreOutboxBatch.mockResolvedValue(result);
    const startedAt = Date.now();

    const response = await GET(
      new Request(
        "https://example.com/api/cron/reconcile-cross-store-outbox?limit=50"
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ...result });
    expect(mockProcessCrossStoreOutboxBatch).toHaveBeenCalledTimes(1);
    expect(mockProcessCrossStoreOutboxBatch).toHaveBeenCalledWith({
      limit: 50,
      deadlineAtMs: expect.any(Number),
    });
    const { deadlineAtMs } = mockProcessCrossStoreOutboxBatch.mock.calls[0][0];
    expect(deadlineAtMs).toBeGreaterThanOrEqual(startedAt + 50_000);
    expect(deadlineAtMs).toBeLessThanOrEqual(Date.now() + 50_000);
  });

  it("rejects unauthorized requests before draining the outbox", async () => {
    mockVerifyCronAuth.mockReturnValue(new Response(null, { status: 401 }));

    const response = await GET(
      new Request("https://example.com/api/cron/reconcile-cross-store-outbox")
    );

    expect(response.status).toBe(401);
    expect(mockProcessCrossStoreOutboxBatch).not.toHaveBeenCalled();
  });

  it("keeps failed business drains visible to the cron caller", async () => {
    mockProcessCrossStoreOutboxBatch.mockRejectedValue(
      new Error("outbox unavailable")
    );

    const response = await GET(
      new Request("https://example.com/api/cron/reconcile-cross-store-outbox")
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "outbox unavailable" });
    expect(mockProcessCrossStoreOutboxBatch).toHaveBeenCalledWith({
      limit: 200,
      deadlineAtMs: expect.any(Number),
    });
  });
});
