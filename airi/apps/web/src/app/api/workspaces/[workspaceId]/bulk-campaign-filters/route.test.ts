const mockRequireScenarioWorkspaceAccess = jest.fn();

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

import { GET, POST } from "./route";

const workspaceId = "11111111-1111-4111-8111-111111111111";

function jsonResponse(status: number, body: unknown) {
  return Response.json(body, { status });
}

function makeRequest(input: string, init?: RequestInit) {
  return new Request(input, init) as never;
}

function makeSupabaseListClient(rows: unknown[] = []) {
  const order = jest.fn(async () => ({ data: rows, error: null }));
  const eq = jest.fn(() => ({ order }));
  const select = jest.fn(() => ({ eq }));
  const from = jest.fn(() => ({ select }));

  return { from, select, eq, order };
}

function makeSupabaseUpsertClient(row: unknown) {
  const single = jest.fn(async () => ({ data: row, error: null }));
  const select = jest.fn(() => ({ single }));
  const upsert = jest.fn(() => ({ select }));
  const from = jest.fn(() => ({ upsert }));

  return { from, upsert, select, single };
}

describe("bulk campaign saved filters API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns workspace saved filters ordered by update time", async () => {
    const row = {
      id: "filter-1",
      name: "Dormant leads",
      filters: { days: "30", status: "not_replied" },
      created_at: "2026-05-05T08:00:00.000Z",
      updated_at: "2026-05-05T09:00:00.000Z",
      created_by: "user-1",
    };
    const supabase = makeSupabaseListClient([row]);
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      userId: "user-1",
      supabase,
    });

    const response = await GET(makeRequest("http://localhost/api"), {
      params: Promise.resolve({ workspaceId }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ filters: [row] });
    expect(supabase.from).toHaveBeenCalledWith("bulk_campaign_saved_filters");
    expect(supabase.select).toHaveBeenCalledWith(
      "id,name,filters,created_at,updated_at,created_by"
    );
    expect(supabase.eq).toHaveBeenCalledWith("workspace_id", workspaceId);
    expect(supabase.order).toHaveBeenCalledWith("updated_at", {
      ascending: false,
    });
  });

  it("returns auth failure responses without querying Supabase", async () => {
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: false,
      response: jsonResponse(401, { error: "Unauthorized" }),
    });

    const response = await GET(makeRequest("http://localhost/api"), {
      params: Promise.resolve({ workspaceId }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns forbidden workspace responses without querying Supabase", async () => {
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: false,
      response: jsonResponse(403, { error: "Forbidden" }),
    });

    const response = await GET(makeRequest("http://localhost/api"), {
      params: Promise.resolve({ workspaceId }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
  });

  it("rejects invalid save requests before touching Supabase", async () => {
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      userId: "user-1",
      supabase: makeSupabaseUpsertClient(null),
    });

    const response = await POST(
      makeRequest("http://localhost/api", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "   ",
          filters: { status: "maybe" },
        }),
      }),
      { params: Promise.resolve({ workspaceId }) }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
    expect(mockRequireScenarioWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("upserts a named filter for the workspace and current user", async () => {
    const saved = {
      id: "filter-1",
      name: "Dormant leads",
      filters: { days: "30", status: "not_replied" },
      created_at: "2026-05-05T08:00:00.000Z",
      updated_at: "2026-05-05T09:00:00.000Z",
      created_by: "user-1",
    };
    const supabase = makeSupabaseUpsertClient(saved);
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      userId: "user-1",
      supabase,
    });

    const response = await POST(
      makeRequest("http://localhost/api", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "  Dormant leads  ",
          filters: { days: "30", status: "not_replied" },
        }),
      }),
      { params: Promise.resolve({ workspaceId }) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ filter: saved });
    expect(supabase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: workspaceId,
        name: "Dormant leads",
        filters: { days: "30", status: "not_replied" },
        created_by: "user-1",
      }),
      { onConflict: "workspace_id,name" }
    );
  });
});
