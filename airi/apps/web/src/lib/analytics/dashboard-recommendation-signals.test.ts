import type { SupabaseClient } from "@supabase/supabase-js";
import { getDashboardRecommendation } from "./dashboard-recommendation-signals";

const mockCacheGet = jest.fn();
const mockCacheSet = jest.fn();
const mockConnectDB = jest.fn();
const mockCountDocuments = jest.fn();
const mockWarn = jest.fn();

jest.mock("@/lib/cache", () => ({
  buildCacheKey: (namespace: string, parts: string[]) =>
    `icecore:${namespace}:${parts.join(":")}`,
  cache: {
    get: (...args: unknown[]) => mockCacheGet(...args),
    set: (...args: unknown[]) => mockCacheSet(...args),
  },
}));
jest.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockWarn(...args) },
}));
jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));
jest.mock("@/lib/meta-ads/meta-ads-source", () => ({
  META_ADS_SOURCE_TYPE: "meta_ads",
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    countDocuments: (...args: unknown[]) => mockCountDocuments(...args),
  },
}));

const now = new Date("2026-10-05T12:00:00.000Z");
type Result = { data?: unknown; error?: unknown; count?: number | null };

function fakeQuery(result: Result) {
  const calls: unknown[][] = [];
  const builder: Record<string, unknown> = {};
  for (const method of [
    "select",
    "eq",
    "gte",
    "limit",
    "abortSignal",
    "maybeSingle",
  ])
    builder[method] = (...args: unknown[]) => {
      calls.push([method, ...args]);
      return builder;
    };
  builder.then = (
    resolve: (value: unknown) => unknown,
    reject: (reason: unknown) => unknown
  ) =>
    Promise.resolve({ data: null, error: null, ...result }).then(
      resolve,
      reject
    );
  return { builder, calls };
}

function supabaseWith(results: Record<string, Result>) {
  const queries = Object.fromEntries(
    Object.entries(results).map(([table, result]) => [table, fakeQuery(result)])
  );
  const client = {
    from: jest.fn((table: string) => queries[table].builder),
  } as unknown as SupabaseClient;
  return { client, queries };
}

const established = {
  workspaces: { data: { created_at: "2026-06-01T00:00:00.000Z" } },
  company_users: { count: 4 },
  sources: { data: [] },
  campaign_history: { data: [] },
};

type CountQuery = {
  limit: jest.Mock;
  maxTimeMS: jest.Mock;
  exec: jest.Mock;
};

function countReturning(count: number | Error) {
  const query: CountQuery = {
    limit: jest.fn((): CountQuery => query),
    maxTimeMS: jest.fn((): CountQuery => query),
    exec: jest.fn(async () => {
      if (count instanceof Error) throw count;
      return count;
    }),
  };
  mockCountDocuments.mockReturnValue(query);
  return query;
}

describe("getDashboardRecommendation", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockCacheGet.mockResolvedValue(null);
    mockCacheSet.mockResolvedValue(undefined);
    mockConnectDB.mockResolvedValue(undefined);
  });

  it("reads bounded workspace signals and caches a complete recommendation", async () => {
    const { client, queries } = supabaseWith(established);
    const count = countReturning(30);
    await expect(
      getDashboardRecommendation({ supabase: client, workspaceId: "ws", now })
    ).resolves.toEqual({ templateId: "operations", reason: "team_size" });

    expect(queries.workspaces.calls).toContainEqual(["eq", "id", "ws"]);
    expect(queries.company_users.calls).toContainEqual([
      "select",
      "user_id",
      { count: "exact", head: true },
    ]);
    expect(queries.sources.calls).toEqual(
      expect.arrayContaining([
        ["eq", "workspace_id", "ws"],
        ["eq", "type", "meta_ads"],
        ["limit", 1],
      ])
    );
    expect(queries.campaign_history.calls).toEqual(
      expect.arrayContaining([
        ["eq", "workspace_id", "ws"],
        ["eq", "channel", "whatsapp"],
        ["gte", "sent_at", "2026-09-05T12:00:00.000Z"],
        ["limit", 1],
      ])
    );
    expect(mockCountDocuments).toHaveBeenCalledWith({
      workspaceId: "ws",
      createdAt: { $gte: new Date("2026-09-05T12:00:00.000Z") },
    });
    expect(count.limit).toHaveBeenCalledWith(30);
    expect(count.maxTimeMS).toHaveBeenCalled();
    expect(mockCacheSet).toHaveBeenCalledWith(
      "icecore:analytics:dashboard-recommendation:v1:ws",
      { templateId: "operations", reason: "team_size" },
      3600
    );
  });

  it.each([
    [
      {
        workspaces: { data: { created_at: "2026-09-30T00:00:00.000Z" } },
      },
      30,
      { templateId: "starter", reason: "new_workspace" },
    ],
    [{}, 4, { templateId: "starter", reason: "low_volume" }],
    [
      { sources: { data: [{ id: "source" }] } },
      30,
      { templateId: "sales", reason: "ads_connected" },
    ],
    [
      { campaign_history: { data: [{ id: "campaign" }] } },
      30,
      { templateId: "sales", reason: "recent_campaigns" },
    ],
    [
      { company_users: { count: 2 } },
      30,
      { templateId: "support", reason: "support_default" },
    ],
  ])(
    "maps signals %j with %i conversations",
    async (patch, conversations, expected) => {
      const { client } = supabaseWith({ ...established, ...patch });
      countReturning(conversations);
      await expect(
        getDashboardRecommendation({ supabase: client, workspaceId: "ws", now })
      ).resolves.toEqual(expected);
    }
  );

  it("returns a cached recommendation without reading signals", async () => {
    mockCacheGet.mockResolvedValue({
      templateId: "sales",
      reason: "ads_connected",
    });
    const { client } = supabaseWith(established);
    await expect(
      getDashboardRecommendation({ supabase: client, workspaceId: "ws", now })
    ).resolves.toEqual({ templateId: "sales", reason: "ads_connected" });
    expect(client.from).not.toHaveBeenCalled();
    expect(mockCountDocuments).not.toHaveBeenCalled();
  });

  it("skips unreadable signals and does not cache a partial answer", async () => {
    const { client } = supabaseWith({
      ...established,
      sources: { error: { message: "permission denied" } },
    });
    countReturning(new Error("mongo timeout"));
    await expect(
      getDashboardRecommendation({ supabase: client, workspaceId: "ws", now })
    ).resolves.toEqual({ templateId: "operations", reason: "team_size" });
    expect(mockCacheSet).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      "Analytics dashboard recommendation signals unavailable",
      {
        workspaceId: "ws",
        unavailable: ["metaAdsConnected", "recentConversations"],
      }
    );
  });

  it("never fails the caller", async () => {
    mockCacheGet.mockRejectedValue(new Error("redis down"));
    const { client } = supabaseWith(established);
    await expect(
      getDashboardRecommendation({ supabase: client, workspaceId: "ws", now })
    ).resolves.toBeNull();
    expect(mockWarn).toHaveBeenCalled();
  });
});
