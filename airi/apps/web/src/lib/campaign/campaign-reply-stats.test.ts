import { attachWhatsAppCampaignReplyStats } from "./campaign-reply-stats";

const mockSupabaseFrom = jest.fn();
const mockMessageAggregate = jest.fn();
const mockConnectDB = jest.fn(async () => undefined);
const mockCacheEntries = new Map<
  string,
  { value: unknown; expiresAt: number }
>();
const mockCacheLocks = new Map<string, string>();
const mockAcquireLock = jest.fn(async (key: string, owner: string) => {
  if (mockCacheLocks.has(key)) return "contended";
  mockCacheLocks.set(key, owner);
  return "acquired";
});

jest.mock("@icecore/shared/lib/cache", () => ({
  buildCacheKey: (namespace: string, parts: string[]) =>
    `icecore:${namespace}:${parts.join(":")}`,
  cache: {
    get: async (key: string) => {
      const entry = mockCacheEntries.get(key);
      return entry && entry.expiresAt > Date.now()
        ? JSON.parse(JSON.stringify(entry.value))
        : null;
    },
    set: async (key: string, value: unknown, ttl: number) => {
      mockCacheEntries.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    },
    acquireLock: (key: string, owner: string) => mockAcquireLock(key, owner),
    compareAndDelete: async (key: string, owner: string) => {
      if (mockCacheLocks.get(key) === owner) mockCacheLocks.delete(key);
    },
  },
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
  },
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: () => mockConnectDB(),
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    aggregate: (...args: unknown[]) => mockMessageAggregate(...args),
  },
}));

jest.mock("@/lib/analytics/bulk-analytics-audience", () => ({
  buildEnrichmentStages: () => [{ $addFields: { replied: true } }],
}));

function createMessagesQuery(rows: unknown[]) {
  const query = {
    select: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    abortSignal: jest.fn().mockReturnThis(),
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(resolve),
  };
  return query;
}

function createAggregate(rows: Promise<unknown[]> | unknown[]) {
  return {
    allowDiskUse: jest.fn().mockReturnThis(),
    option: jest.fn().mockReturnThis(),
    then: (
      resolve: (value: unknown[]) => unknown,
      reject?: (error: unknown) => unknown
    ) => Promise.resolve(rows).then(resolve, reject),
  };
}

const campaign = {
  id: "campaign-1",
  channel: "whatsapp",
  estimated_cost: 1.1,
  cost_coverage_started_at: "2026-10-02T00:00:00Z",
  unknown_cost_count: 0,
  successful_sends: 1,
};

describe("attachWhatsAppCampaignReplyStats", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date("2026-10-10T12:00:00Z") });
    jest.clearAllMocks();
    mockCacheEntries.clear();
    mockCacheLocks.clear();
    mockConnectDB.mockResolvedValue(undefined);
    mockSupabaseFrom.mockImplementation(() =>
      createMessagesQuery([
        {
          campaign_id: "campaign-1",
          message_id: "wamid.1",
          status: "delivered",
        },
        {
          campaign_id: "campaign-1",
          message_id: "wamid.2",
          status: "failed",
        },
      ])
    );
    mockMessageAggregate.mockReturnValue(
      createAggregate([{ messageId: "wamid.1", replied: true }])
    );
  });

  afterEach(() => jest.useRealTimers());

  it("computes reply rate and cost per reply for WhatsApp campaigns", async () => {
    const stats = await attachWhatsAppCampaignReplyStats({
      workspaceId: "ws-1",
      campaigns: [
        {
          id: "campaign-1",
          channel: "whatsapp",
          estimated_cost: 1.1,
          cost_coverage_started_at: "2026-10-02T00:00:00Z",
          unknown_cost_count: 0,
          successful_sends: 1,
        },
        {
          id: "campaign-email",
          channel: "email",
          estimated_cost: null,
          successful_sends: 5,
        },
      ],
    });

    expect(stats.get("campaign-1")).toEqual({
      replied: 1,
      accepted: 1,
      replyRate: 100,
      costPerReply: 1.1,
    });
    expect(stats.has("campaign-email")).toBe(false);
    expect(mockConnectDB).toHaveBeenCalled();
  });

  it("does not divide an unverified legacy cost or partially covered ledger by replies", async () => {
    for (const coverage of [
      {},
      { cost_coverage_started_at: "2026-10-02", unknown_cost_count: 1 },
    ]) {
      const stats = await attachWhatsAppCampaignReplyStats({
        workspaceId: "ws-1",
        campaigns: [
          {
            id: "campaign-1",
            channel: "whatsapp",
            estimated_cost: 1.1,
            successful_sends: 1,
            ...coverage,
          },
        ],
      });
      expect(stats.get("campaign-1")?.costPerReply).toBeNull();
    }
  });

  it("reuses reply observations across history polls and campaign order while using current cost coverage", async () => {
    const other = {
      id: "campaign-2",
      channel: "whatsapp",
      successful_sends: 4,
    };
    const first = await attachWhatsAppCampaignReplyStats({
      workspaceId: "ws-1",
      campaigns: [campaign, other],
    });
    const second = await attachWhatsAppCampaignReplyStats({
      workspaceId: "ws-1",
      campaigns: [other, { ...campaign, estimated_cost: 2.2 }],
    });
    expect(first.get("campaign-1")?.costPerReply).toBe(1.1);
    expect(second.get("campaign-1")).toEqual({
      replied: 1,
      accepted: 1,
      replyRate: 100,
      costPerReply: 2.2,
    });
    expect(second.get("campaign-2")?.accepted).toBe(4);
    expect(mockSupabaseFrom).toHaveBeenCalledTimes(1);
    expect(mockMessageAggregate).toHaveBeenCalledTimes(1);
  });

  it("coalesces simultaneous viewers into one source read and enrichment", async () => {
    let complete!: (rows: unknown[]) => void;
    mockMessageAggregate.mockReturnValue(
      createAggregate(
        new Promise<unknown[]>(resolve => {
          complete = resolve;
        })
      )
    );
    const input = { workspaceId: "ws-1", campaigns: [campaign] };
    const first = attachWhatsAppCampaignReplyStats(input);
    const second = attachWhatsAppCampaignReplyStats(input);
    await jest.advanceTimersByTimeAsync(0);
    complete([{ messageId: "wamid.1", replied: true }]);
    await jest.advanceTimersByTimeAsync(500);
    const results = await Promise.all([first, second]);
    expect(results[0].get("campaign-1")?.replied).toBe(1);
    expect(results[1]).toEqual(results[0]);
    expect(mockSupabaseFrom).toHaveBeenCalledTimes(1);
    expect(mockMessageAggregate).toHaveBeenCalledTimes(1);
  });

  it("refreshes expired reply observations and isolates workspace and reply-window keys", async () => {
    const input = { workspaceId: "ws-1", campaigns: [campaign] };
    await attachWhatsAppCampaignReplyStats(input);
    await attachWhatsAppCampaignReplyStats({ ...input, workspaceId: "ws-2" });
    await attachWhatsAppCampaignReplyStats({ ...input, replyWindowHours: 24 });
    expect(mockMessageAggregate).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(60_001);
    mockMessageAggregate.mockReturnValue(createAggregate([]));
    const fresh = await attachWhatsAppCampaignReplyStats(input);
    expect(fresh.get("campaign-1")?.replied).toBe(0);
    expect(mockMessageAggregate).toHaveBeenCalledTimes(4);
  });

  it("passes one deadline through SQL and Mongo instead of starting an unbounded aggregate", async () => {
    const sql = createMessagesQuery([
      { campaign_id: campaign.id, message_id: "wamid.1", status: "sent" },
    ]);
    mockSupabaseFrom.mockReturnValue(sql);
    mockConnectDB.mockImplementationOnce(async () => {
      await jest.advanceTimersByTimeAsync(2000);
    });
    const aggregate = createAggregate([
      { messageId: "wamid.1", replied: true },
    ]);
    mockMessageAggregate.mockReturnValue(aggregate);
    await attachWhatsAppCampaignReplyStats({
      workspaceId: "ws-1",
      campaigns: [campaign],
    });
    expect(sql.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(aggregate.option).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      maxTimeMS: 23_000,
    });
  });

  it("does not cache a failed observation and retries it on the next poll", async () => {
    mockMessageAggregate.mockReturnValueOnce({
      allowDiskUse: jest.fn().mockReturnThis(),
      option: jest.fn().mockReturnThis(),
      then: (_resolve: unknown, reject: (error: unknown) => unknown) =>
        Promise.reject(new Error("database unavailable")).catch(reject),
    });
    const input = { workspaceId: "ws-1", campaigns: [campaign] };
    await expect(attachWhatsAppCampaignReplyStats(input)).rejects.toThrow(
      "database unavailable"
    );
    const recovered = await attachWhatsAppCampaignReplyStats(input);
    expect(recovered.get("campaign-1")?.replied).toBe(1);
    expect(mockMessageAggregate).toHaveBeenCalledTimes(2);
  });

  it("rechecks an observation published between the initial miss and acquiring the lock", async () => {
    let continueClaim!: () => void;
    const delayedClaim = new Promise<void>(resolve => {
      continueClaim = resolve;
    });
    mockAcquireLock
      .mockImplementationOnce(async (key, owner) => {
        mockCacheLocks.set(key, owner);
        return "acquired";
      })
      .mockImplementationOnce(async (key, owner) => {
        await delayedClaim;
        mockCacheLocks.set(key, owner);
        return "acquired";
      });
    const input = { workspaceId: "ws-1", campaigns: [campaign] };
    const first = attachWhatsAppCampaignReplyStats(input);
    const second = attachWhatsAppCampaignReplyStats(input);
    await first;
    continueClaim();
    expect((await second).get("campaign-1")?.replied).toBe(1);
    expect(mockMessageAggregate).toHaveBeenCalledTimes(1);
    expect(mockCacheLocks.size).toBe(0);
  });

  it("stops waiting on a connection deadline and never starts Mongo work after it", async () => {
    let connected!: () => void;
    mockConnectDB.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          connected = resolve;
        })
    );
    const input = { workspaceId: "ws-1", campaigns: [campaign] };
    const pending = attachWhatsAppCampaignReplyStats(input);
    const rejected = expect(pending).rejects.toThrow("execution budget");
    await jest.advanceTimersByTimeAsync(25_000);
    await rejected;
    connected();
    await jest.advanceTimersByTimeAsync(0);
    expect(mockMessageAggregate).not.toHaveBeenCalled();
    expect(mockCacheEntries.size).toBe(0);
    expect(
      (await attachWhatsAppCampaignReplyStats(input)).get("campaign-1")?.replied
    ).toBe(1);
  });

  it("abandons a cancelled viewer without cancelling the other viewer's shared observation", async () => {
    let complete!: (rows: unknown[]) => void;
    mockMessageAggregate.mockReturnValue(
      createAggregate(
        new Promise<unknown[]>(resolve => {
          complete = resolve;
        })
      )
    );
    const cancelled = new AbortController();
    const input = { workspaceId: "ws-1", campaigns: [campaign] };
    const first = attachWhatsAppCampaignReplyStats({
      ...input,
      signal: cancelled.signal,
    });
    let settled = false;
    const firstResult = first.then(
      () => {
        settled = true;
        return { status: "resolved" };
      },
      error => {
        settled = true;
        return { status: "rejected", message: error.message };
      }
    );
    const second = attachWhatsAppCampaignReplyStats(input);
    await jest.advanceTimersByTimeAsync(0);
    cancelled.abort(new Error("viewer left"));
    await jest.advanceTimersByTimeAsync(0);
    const cancelledBeforeCompletion = settled;
    complete([{ messageId: "wamid.1", replied: true }]);
    await jest.advanceTimersByTimeAsync(500);
    expect(cancelledBeforeCompletion).toBe(true);
    expect(await firstResult).toEqual({
      status: "rejected",
      message: "viewer left",
    });
    expect((await second).get("campaign-1")?.replied).toBe(1);
    expect(mockMessageAggregate).toHaveBeenCalledTimes(1);
  });
});
