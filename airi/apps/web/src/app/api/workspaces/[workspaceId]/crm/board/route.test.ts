const mockCreateClient = jest.fn();
const mockVerifyWorkspaceAccess = jest.fn();
const mockGetWorkspaceFeatureFlags = jest.fn();
const mockGetCrmBoard = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/supabase/queries", () => ({
  checkUserWorkspaceAccess: (...args: unknown[]) =>
    mockVerifyWorkspaceAccess(...args),
}));

jest.mock("@/lib/workspace-feature-flags", () => ({
  getWorkspaceFeatureFlags: (...args: unknown[]) =>
    mockGetWorkspaceFeatureFlags(...args),
}));

jest.mock("@/lib/crm/board", () => ({
  getCrmBoard: (...args: unknown[]) => mockGetCrmBoard(...args),
  resolveCrmOwnerFilter: (
    value: string | null | undefined,
    viewerUserId: string
  ) => {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed) return undefined;
    if (trimmed === "me") return viewerUserId;
    return trimmed;
  },
}));

import { GET } from "./route";
import type { NextRequest } from "next/server";
import { mockSupabaseUser } from "@/test-support/supabase-auth-test-utils";

const params = { params: Promise.resolve({ workspaceId: "workspace-1" }) };

function mockSupabase(user?: { id: string } | null) {
  return mockSupabaseUser(mockCreateClient, user, { withSession: true });
}

function request(
  url = "http://localhost/api/workspaces/workspace-1/crm/board"
) {
  return new Request(url) as unknown as NextRequest;
}

describe("CRM board API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockGetWorkspaceFeatureFlags.mockResolvedValue({
      customer_identity: true,
    });
    mockGetCrmBoard.mockResolvedValue({
      stages: [],
      columns: [],
    });
  });

  it("rejects unauthorized requests", async () => {
    mockSupabase(null);

    const response = await GET(request(), params);

    expect(response.status).toBe(401);
    expect(mockGetCrmBoard).not.toHaveBeenCalled();
  });

  it("rejects users without workspace access", async () => {
    const supabase = mockSupabase();
    mockVerifyWorkspaceAccess.mockResolvedValue(false);

    const response = await GET(request(), params);

    expect(response.status).toBe(403);
    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith(
      supabase,
      "user-1",
      "workspace-1"
    );
    expect(mockGetCrmBoard).not.toHaveBeenCalled();
  });

  it("returns the workspace CRM board with bounded per-stage limits", async () => {
    mockSupabase();
    mockGetCrmBoard.mockResolvedValue({
      stages: [{ id: "stage-qualified", key: "qualified", name: "Qualified" }],
      columns: [{ stageKey: "qualified", totalCount: 1, cards: [] }],
    });

    const response = await GET(
      request(
        "http://localhost/api/workspaces/workspace-1/crm/board?status=active&search=acme&limitPerStage=250&stageLimit.qualified=50"
      ),
      params
    );

    expect(response.status).toBe(200);
    expect(mockGetCrmBoard).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        status: "active",
        search: "acme",
        limitPerStage: 100,
        stageLimits: { qualified: 50 },
        attention: null,
        salesOnly: false,
        hideSupportSpam: true,
        ownerUserId: undefined,
      })
    );
    expect(await response.json()).toEqual({
      stages: [{ id: "stage-qualified", key: "qualified", name: "Qualified" }],
      columns: [{ stageKey: "qualified", totalCount: 1, cards: [] }],
    });
  });

  it("forwards attention and salesOnly query params", async () => {
    mockSupabase();

    const response = await GET(
      request(
        "http://localhost/api/workspaces/workspace-1/crm/board?attention=ghosted&salesOnly=1"
      ),
      params
    );

    expect(response.status).toBe(200);
    expect(mockGetCrmBoard).toHaveBeenCalledWith(
      expect.objectContaining({
        attention: "ghosted",
        salesOnly: true,
        hideSupportSpam: true,
      })
    );
  });

  it("includes Support and Spam when support=1", async () => {
    mockSupabase();

    const response = await GET(
      request("http://localhost/api/workspaces/workspace-1/crm/board?support=1"),
      params
    );

    expect(response.status).toBe(200);
    expect(mockGetCrmBoard).toHaveBeenCalledWith(
      expect.objectContaining({
        hideSupportSpam: false,
      })
    );
  });

  it("uses a small default per-stage limit for the first board load", async () => {
    mockSupabase();

    const response = await GET(request(), params);

    expect(response.status).toBe(200);
    expect(mockGetCrmBoard).toHaveBeenCalledWith(
      expect.objectContaining({
        limitPerStage: 10,
        attention: null,
        salesOnly: false,
        hideSupportSpam: true,
      })
    );
  });

  it("resolves owner=me to the current user", async () => {
    mockSupabase();

    const response = await GET(
      request("http://localhost/api/workspaces/workspace-1/crm/board?owner=me"),
      params
    );

    expect(response.status).toBe(200);
    expect(mockGetCrmBoard).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: "user-1",
      })
    );
  });
});
