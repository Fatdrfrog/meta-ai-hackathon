const mockCreateClient = jest.fn();
const mockRpc = jest.fn();
jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));
jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/models/conversation", () => ({ Conversation: {} }));
jest.mock("@/models/message", () => ({ __esModule: true, default: {} }));
jest.mock("@/models/scenario", () => ({ Scenario: {} }));
jest.mock("@/lib/customers/service", () => ({
  ensureCustomerForConversation: jest.fn(),
  recordCustomerConversionEvent: jest.fn(),
}));
jest.mock("@/lib/conversions/meta-conversion-intent", () => ({
  prepareMetaConversionIntent: jest.fn(),
}));
import { GET } from "./route";
describe("authenticated conversion attribution", () => {
  let user: { id: string } | null;
  let membership: { workspace_id: string } | null;
  beforeEach(() => {
    jest.clearAllMocks();
    user = { id: "user" };
    membership = { workspace_id: "workspace" };
    mockRpc.mockResolvedValue({
      data: { rows: [], recentDeliveries: [], truncated: false },
      error: null,
    });
    const query = {
      select: jest.fn(),
      eq: jest.fn(),
      maybeSingle: async () => ({ data: membership, error: null }),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    mockCreateClient.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user } }) },
      from: () => query,
      rpc: mockRpc,
    });
  });
  const request = (extra = "") =>
    new Request(
      "http://localhost/api/conversions?workspaceId=workspace&report=attribution&start=2026-09-01T00:00:00Z&end=2026-09-10T00:00:00Z" +
        extra
    );
  it("returns the database report within the authenticated workspace", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      rows: [],
      recentDeliveries: [],
      truncated: false,
    });
    expect(mockRpc).toHaveBeenCalledWith(
      "get_conversion_attribution_report",
      expect.objectContaining({
        p_workspace_id: "workspace",
        p_start: "2026-09-01T00:00:00.000Z",
      })
    );
  });
  it("rejects an unauthenticated caller", async () => {
    user = null;
    expect((await GET(request())).status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it("rejects another workspace before querying its ledger", async () => {
    membership = null;
    expect((await GET(request())).status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it("rejects a malformed source scope", async () => {
    expect((await GET(request("&sourceId=invalid"))).status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it("rejects an unbounded interval", async () => {
    expect(
      (
        await GET(
          new Request(
            "http://localhost/api/conversions?workspaceId=workspace&report=attribution&start=2000-01-01&end=2026-09-10"
          )
        )
      ).status
    ).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it("subtracts refunds in legacy total and channel summaries", async () => {
    const conversions = [
      {
        conversion_type: "sale",
        conversion_value: 100,
        currency: "USD",
        attributed_to_channel: "whatsapp",
      },
      {
        conversion_type: "refund",
        conversion_value: 25,
        currency: "USD",
        attributed_to_channel: "whatsapp",
      },
    ];
    const query = {
      select: jest.fn(),
      eq: jest.fn(),
      gte: jest.fn(),
      order: async () => ({ data: conversions, error: null }),
      maybeSingle: async () => ({ data: membership, error: null }),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.gte.mockReturnValue(query);
    mockCreateClient.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user } }) },
      from: () => query,
    });
    const response = await GET(
      new Request("http://localhost/api/conversions?workspaceId=workspace")
    );
    expect((await response.json()).aggregates).toMatchObject({
      total_value: 75,
      by_channel: { whatsapp: { count: 2, total_value: 75 } },
      by_type: { refund: { count: 1, total_value: 25 } },
    });
  });
});
