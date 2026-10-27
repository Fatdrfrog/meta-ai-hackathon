const mockStartProjection = jest.fn();
const mockReplayBatch = jest.fn();
const mockDrainAnalytics = jest.fn();

jest.mock("@/lib/requests-projection/activation", () => ({
  startProductionRequestsProjectionRuntime: (input: Record<string, unknown>) =>
    mockStartProjection(input),
}));

jest.mock("@/lib/realtime/outbox-replay", () => ({
  replayRealtimeOutboxBatch: (input: unknown) => mockReplayBatch(input),
}));

jest.mock("@/lib/llm-analytics/events", () => ({
  drainPendingLlmAnalyticsEvents: (timeoutMs: number) =>
    mockDrainAnalytics(timeoutMs),
}));

import * as runtime from "./temporal-worker-runtime";

describe("temporal worker web-runtime boundary", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("exposes only the outbox replay, the Requests projection runtime and the analytics drain", () => {
    expect(Object.keys(runtime).sort()).toEqual([
      "drainPendingLlmAnalyticsEvents",
      "replayRealtimeOutboxBatch",
      "startProductionRequestsProjectionRuntime",
    ]);
  });

  it("passes the worker's inputs through unchanged", async () => {
    const shouldContinue = () => false;
    await runtime.replayRealtimeOutboxBatch({ shouldContinue });
    expect(mockReplayBatch).toHaveBeenCalledWith({ shouldContinue });

    const stop = jest.fn(async () => undefined);
    mockStartProjection.mockResolvedValue(stop);
    const input = {
      signal: new AbortController().signal,
      ownerToken: "owner-1",
      realtimeEnabled: true,
    };
    await expect(
      runtime.startProductionRequestsProjectionRuntime(input)
    ).resolves.toBe(stop);
    expect(mockStartProjection).toHaveBeenCalledWith(input);

    mockDrainAnalytics.mockResolvedValue(true);
    await expect(runtime.drainPendingLlmAnalyticsEvents(5_000)).resolves.toBe(
      true
    );
    expect(mockDrainAnalytics).toHaveBeenCalledWith(5_000);
  });
});
