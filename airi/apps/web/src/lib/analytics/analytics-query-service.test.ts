import {
  readCachedLocalAnalytics,
  withAnalyticsQueryBudget,
  type AnalyticsQueryBudget,
} from "./analytics-query-service";

const mockEntries = new Map<string, unknown>();
const mockGet = jest.fn(async (key: string) => mockEntries.get(key) ?? null);

jest.mock("@icecore/shared/lib/cache", () => ({
  cache: {
    get: (key: string) => mockGet(key),
    set: async (key: string, value: unknown) => {
      mockEntries.set(key, JSON.parse(JSON.stringify(value)));
    },
    acquireLock: async () => "acquired",
    compareAndDelete: async () => true,
  },
}));

beforeEach(() => {
  jest.useFakeTimers({ now: new Date("2026-10-10T12:00:00Z") });
  mockEntries.clear();
  mockGet.mockClear();
});

afterEach(() => jest.useRealTimers());

describe("readCachedLocalAnalytics", () => {
  it("recomputes a malformed cache envelope without an observation", async () => {
    mockEntries.set("analytics:workspace-1", {
      generatedAt: new Date().toISOString(),
    });

    expect(
      await readCachedLocalAnalytics({
        key: "analytics:workspace-1",
        run: async () => ({ count: 3 }),
      })
    ).toEqual({ count: 3 });
  });

  it.each([0, false, "", null])(
    "reuses a cached %p observation without repeating the source read",
    async raw => {
      let sourceReads = 0;
      const input = {
        key: "analytics:workspace-1",
        run: async () => {
          sourceReads++;
          return raw;
        },
      };

      expect(await readCachedLocalAnalytics(input)).toBe(raw);
      expect(await readCachedLocalAnalytics(input)).toBe(raw);
      expect(sourceReads).toBe(1);
    }
  );

  it("rejects an already cancelled viewer before reading a cached observation", async () => {
    const controller = new AbortController();
    const reason = new Error("viewer left");
    controller.abort(reason);
    mockEntries.set("analytics:workspace-1", {
      generatedAt: new Date().toISOString(),
      raw: { count: 3 },
    });

    await expect(
      readCachedLocalAnalytics({
        key: "analytics:workspace-1",
        signal: controller.signal,
        run: async () => ({ count: 0 }),
      })
    ).rejects.toBe(reason);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("rejects a viewer cancelled while its cache hit is being read", async () => {
    const controller = new AbortController();
    const reason = new Error("viewer left");
    mockGet.mockImplementationOnce(async () => {
      controller.abort(reason);
      return { generatedAt: new Date().toISOString(), raw: { count: 3 } };
    });

    await expect(
      readCachedLocalAnalytics({
        key: "analytics:workspace-1",
        signal: controller.signal,
        run: async () => ({ count: 0 }),
      })
    ).rejects.toBe(reason);
  });
});

describe("withAnalyticsQueryBudget", () => {
  it("shares the remaining deadline across reads and clears its timer on success", async () => {
    const result = await withAnalyticsQueryBudget({
      maxTimeMS: 5_000,
      run: async budget => {
        expect(budget.remainingMs()).toBe(5_000);
        await jest.advanceTimersByTimeAsync(2_000);
        expect(budget.remainingMs()).toBe(3_000);
        return 4;
      },
    });

    expect(result).toBe(4);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("expires stalled work at the shared upper bound and keeps late work cancelled", async () => {
    let finish!: (value: number) => void;
    let captured!: AnalyticsQueryBudget;
    const pending = withAnalyticsQueryBudget({
      maxTimeMS: 60_000,
      run: budget => {
        captured = budget;
        return new Promise(resolve => {
          finish = resolve;
        });
      },
    });
    const rejected = expect(pending).rejects.toThrow("execution budget");
    await jest.advanceTimersByTimeAsync(25_000);
    await rejected;
    expect(captured.signal.aborted).toBe(true);
    expect(() => captured.remainingMs()).toThrow("execution budget");
    finish(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("preserves caller cancellation reasons and releases the deadline timer", async () => {
    const controller = new AbortController();
    const reason = new Error("viewer left");
    let executionSignal!: AbortSignal;
    const pending = withAnalyticsQueryBudget({
      signal: controller.signal,
      run: async budget => {
        executionSignal = budget.signal;
        controller.abort(reason);
        return 3;
      },
    });

    await expect(pending).rejects.toBe(reason);
    expect(executionSignal.reason).toBe(reason);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("preserves source failures and releases the deadline timer", async () => {
    const reason = new Error("source unavailable");
    await expect(
      withAnalyticsQueryBudget({
        run: async () => {
          throw reason;
        },
      })
    ).rejects.toBe(reason);
    expect(jest.getTimerCount()).toBe(0);
  });
});
