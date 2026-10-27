const mockVerifyCronAuth = jest.fn();
const mockProcessTimerReplanIngressQueue = jest.fn();
const mockProcessAiriConversationIngressQueue = jest.fn();
const mockEnsureIndexes = jest.fn();

jest.mock("@/lib/cron-auth", () => ({
  verifyCronAuth: (...args: unknown[]) => mockVerifyCronAuth(...args),
}));

jest.mock("@/lib/airi/scenario/timer-recovery/ingress", () => ({
  processTimerReplanIngressQueue: (...args: unknown[]) =>
    mockProcessTimerReplanIngressQueue(...args),
}));

jest.mock("@/lib/mongo", () => ({
  ensureIndexes: (...args: unknown[]) => mockEnsureIndexes(...args),
}));

jest.mock("@/lib/temporal/airi-conversation-ingress", () => ({
  processAiriConversationIngressQueue: (...args: unknown[]) =>
    mockProcessAiriConversationIngressQueue(...args),
}));

import { GET } from "./route";

describe("GET /api/cron/retry-airi-ingress", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyCronAuth.mockReturnValue(null);
    mockEnsureIndexes.mockResolvedValue(undefined);
    mockProcessAiriConversationIngressQueue.mockResolvedValue({
      materialized: 2,
      materializationFailed: 0,
      signaled: 2,
      retryScheduled: 0,
    });
    mockProcessTimerReplanIngressQueue.mockResolvedValue({
      claimed: 2,
      signaled: 1,
      superseded: 1,
      retryScheduled: 0,
      failed: 0,
      leaseLost: 0,
    });
  });

  it("rejects an unauthorized cron request", async () => {
    mockVerifyCronAuth.mockReturnValue(
      Response.json({ error: "Unauthorized" }, { status: 401 })
    );

    const response = await GET(
      new Request("https://example.com/api/cron/retry-airi-ingress")
    );

    expect(response.status).toBe(401);
    expect(mockProcessTimerReplanIngressQueue).not.toHaveBeenCalled();
    expect(mockProcessAiriConversationIngressQueue).not.toHaveBeenCalled();
    expect(mockEnsureIndexes).not.toHaveBeenCalled();
  });

  it("processes one bounded retry batch", async () => {
    const response = await GET(
      new Request("https://example.com/api/cron/retry-airi-ingress")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      conversations: {
        materialized: 2,
        materializationFailed: 0,
        signaled: 2,
        retryScheduled: 0,
      },
      timerReplans: {
        claimed: 2,
        signaled: 1,
        superseded: 1,
        retryScheduled: 0,
        failed: 0,
        leaseLost: 0,
      },
    });
    expect(mockProcessTimerReplanIngressQueue).toHaveBeenCalledWith({
      limit: 25,
    });
    expect(mockEnsureIndexes).toHaveBeenCalledTimes(1);
    expect(mockProcessAiriConversationIngressQueue).toHaveBeenCalledWith({
      limit: 25,
    });
  });

  it("attempts both queues and reports a partial recovery failure", async () => {
    mockProcessTimerReplanIngressQueue.mockRejectedValue(
      new Error("timer queue unavailable")
    );
    const response = await GET(
      new Request("https://example.com/api/cron/retry-airi-ingress")
    );
    expect(response.status).toBe(500);
    expect(mockProcessAiriConversationIngressQueue).toHaveBeenCalledTimes(1);
  });
});
