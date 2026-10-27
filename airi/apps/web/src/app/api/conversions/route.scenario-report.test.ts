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

describe("authenticated scenario conversion report", () => {
  const scenarioId = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const totals = { sales: 2, bookings: 1, signups: 3, refunds: 1 };
  let user: { id: string } | null;
  let membership: { workspace_id: string } | null;
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date("2026-09-11T12:00:00Z"));
    user = { id: "user" };
    membership = { workspace_id: "workspace" };
    mockRpc.mockResolvedValue({
      data: { totals, currencies: [], truncated: false },
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
  afterEach(() => jest.useRealTimers());
  const request = (extra = "", selectedScenario = scenarioId) =>
    new Request(
      `http://localhost/api/conversions?workspaceId=workspace&report=scenario&scenarioId=${selectedScenario}${extra}`
    );

  it("returns complete recorded outcome counts for exactly the selected scenario", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      scenarioId,
      period: {
        startDate: "2026-08-12T12:00:00.000Z",
        endDate: "2026-09-11T12:00:00.000Z",
      },
      totals,
      currencies: [],
      truncated: false,
    });
    expect(mockRpc).toHaveBeenCalledWith("get_scenario_conversion_report", {
      p_workspace_id: "workspace",
      p_scenario_id: scenarioId,
      p_start: "2026-08-12T12:00:00.000Z",
      p_end: "2026-09-11T12:00:00.000Z",
    });
  });

  it("accepts an explicit 90-day window and normalizes the Mongo identifier", async () => {
    expect((await GET(request("&days=90", scenarioId.toUpperCase()))).status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith("get_scenario_conversion_report", expect.objectContaining({
      p_scenario_id: scenarioId,
      p_start: "2026-06-13T12:00:00.000Z",
    }));
  });

  it("accepts the existing explicit start/end query contract", async () => {
    expect((await GET(request("&start=2026-09-01&end=2026-09-10"))).status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith("get_scenario_conversion_report", expect.objectContaining({
      p_start: "2026-09-01T00:00:00.000Z",
      p_end: "2026-09-10T00:00:00.000Z",
    }));
  });

  it.each(["", "not-a-scenario", "aaaa"]) ("rejects invalid scenario identity %s", async selectedScenario => {
    expect((await GET(request("", selectedScenario))).status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each(["0", "91", "1.5", "30oops", "NaN", "-1", ""]) ("rejects invalid days %s", async invalidDays => {
    expect((await GET(request(`&days=${invalidDays}`))).status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    "&start=2020-01-01&end=2026-09-10",
    "&start=invalid",
    "&end=invalid",
    "&start=2026-09-10&end=2026-09-01",
  ])("rejects invalid intervals %s", async extra => {
    expect((await GET(request(extra))).status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated callers before reading the ledger", async () => {
    user = null;
    expect((await GET(request())).status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("rejects another workspace before reading its ledger", async () => {
    membership = null;
    expect((await GET(request())).status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("reports database failures instead of showing zero outcomes", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "offline" } });
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect((await GET(request())).status).toBe(500);
    } finally {
      consoleError.mockRestore();
    }
  });
});
