const mockAdminFrom = jest.fn();
const mockCreateSessionClient = jest.fn();

jest.mock("@/lib/dependency-health", () => ({
  collectDependencyHealth: async () => ({
    status: "healthy",
    dependencies: {},
  }),
}));

jest.mock("@/lib/mongoose", () => ({
  getDBHealth: async () => ({ status: "healthy", latency: 5 }),
  getDBState: () => "connected",
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockAdminFrom(...args),
  },
}));

// Uptime probes carry no user session; the session client is anon there and
// anon cannot read companies, which would report Supabase as down.
jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateSessionClient(...args),
}));

import { GET } from "./route";

describe("GET /api/health", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAdminFrom.mockReturnValue({
      select: () => ({
        limit: async () => ({ data: [{ id: "company-1" }], error: null }),
      }),
    });
  });

  it("probes Supabase with the server client so anonymous probes stay healthy", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(body.services.supabase.status).toBe("healthy");
    expect(mockAdminFrom).toHaveBeenCalledWith("companies");
    expect(mockCreateSessionClient).not.toHaveBeenCalled();
  });

  it("still reports Supabase as unhealthy when the database read fails", async () => {
    mockAdminFrom.mockReturnValue({
      select: () => ({
        limit: async () => ({
          data: null,
          error: { code: "PGRST000", message: "connection refused" },
        }),
      }),
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.services.supabase.status).toBe("unhealthy");
  });
});
