const mockRequireScenarioWorkspaceAccess = jest.fn();

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

import { DELETE } from "./route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const filterId = "22222222-2222-4222-8222-222222222222";

function makeRequest(input: string, init?: RequestInit) {
  return new Request(input, init) as never;
}

function makeSupabaseDeleteClient() {
  const eqFilterId = jest.fn(async () => ({ data: null, error: null }));
  const eqWorkspaceId = jest.fn(() => ({ eq: eqFilterId }));
  const deleteFn = jest.fn(() => ({ eq: eqWorkspaceId }));
  const from = jest.fn(() => ({ delete: deleteFn }));

  return { from, deleteFn, eqWorkspaceId, eqFilterId };
}

describe("bulk campaign saved filter DELETE API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("deletes only the matching workspace filter", async () => {
    const supabase = makeSupabaseDeleteClient();
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      userId: "user-1",
      supabase,
    });

    const response = await DELETE(makeRequest("http://localhost/api"), {
      params: Promise.resolve({ workspaceId, filterId }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(supabase.from).toHaveBeenCalledWith("bulk_campaign_saved_filters");
    expect(supabase.deleteFn).toHaveBeenCalled();
    expect(supabase.eqWorkspaceId).toHaveBeenCalledWith(
      "workspace_id",
      workspaceId
    );
    expect(supabase.eqFilterId).toHaveBeenCalledWith("id", filterId);
  });

  it("returns access failure responses without deleting", async () => {
    const supabase = makeSupabaseDeleteClient();
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const response = await DELETE(makeRequest("http://localhost/api"), {
      params: Promise.resolve({ workspaceId, filterId }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
