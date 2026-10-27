const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockFetchCanvaBrandTemplates = jest.fn();

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

jest.mock("@/lib/canva/brand-templates", () => {
  const actual = jest.requireActual("@/lib/canva/brand-templates");
  return {
    ...actual,
    fetchCanvaBrandTemplates: (...args: unknown[]) =>
      mockFetchCanvaBrandTemplates(...args),
  };
});

import { NextResponse } from "next/server";
import { POST } from "./route";

function createSupabaseMock(source: Record<string, unknown> | null) {
  const selectChain: Record<string, jest.Mock> = {};
  const updateChain: Record<string, jest.Mock> = {};

  selectChain.select = jest.fn(() => selectChain);
  selectChain.eq = jest.fn(() => selectChain);
  selectChain.order = jest.fn(() => selectChain);
  selectChain.limit = jest.fn(() => selectChain);
  selectChain.maybeSingle = jest.fn().mockResolvedValue({ data: source });
  selectChain.update = jest.fn(() => updateChain);
  updateChain.eq = jest.fn(() => updateChain);

  return {
    from: jest.fn(() => selectChain),
    selectChain,
    updateChain,
  };
}

function createRequest(body: Record<string, unknown>) {
  return new Request(
    "http://localhost/api/workspaces/workspace-1/scenario-generator/canva/templates",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

describe("POST /api/workspaces/[workspaceId]/scenario-generator/canva/templates", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchCanvaBrandTemplates.mockResolvedValue(
      Response.json({
        items: [
          {
            id: "template-1",
            title: "VIP Campaign",
            thumbnail: { url: "https://cdn.canva.com/template.png" },
            create_url: "https://www.canva.com/create/template-1",
          },
        ],
        continuation: "page-3",
      })
    );
  });

  it("rejects unauthorized workspace access", async () => {
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const response = await POST(
      createRequest({ prompt: "Generate" }) as never,
      {
        params: Promise.resolve({ workspaceId: "workspace-1" }),
      }
    );

    expect(response.status).toBe(401);
    expect(mockFetchCanvaBrandTemplates).not.toHaveBeenCalled();
  });

  it("returns connection-needed when the workspace has no Canva source", async () => {
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      supabase: createSupabaseMock(null),
    });

    const response = await POST(
      createRequest({
        prompt: "Generate a VIP reactivation campaign",
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "connection_needed",
      items: [],
      continuation: null,
      connectUrl: "/api/sources/canva/connect?workspaceId=workspace-1",
    });
    expect(mockFetchCanvaBrandTemplates).not.toHaveBeenCalled();
  });

  it("returns reconnect-required when the Canva source lacks brand template scope", async () => {
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      supabase: createSupabaseMock({
        id: "source-1",
        credentials: {
          access_token: "canva-token",
          scope: "design:meta:read",
        },
      }),
    });

    const response = await POST(
      createRequest({
        prompt: "Generate a VIP reactivation campaign",
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "reconnect_required",
      items: [],
      continuation: null,
    });
    expect(mockFetchCanvaBrandTemplates).not.toHaveBeenCalled();
  });

  it("passes the Canva continuation token and returns normalized templates", async () => {
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      supabase: createSupabaseMock({
        id: "source-1",
        credentials: {
          access_token: "canva-token",
          scope: "brandtemplate:meta:read",
        },
      }),
    });

    const response = await POST(
      createRequest({
        query: "VIP reactivation",
        continuation: "page-2",
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(200);
    expect(mockFetchCanvaBrandTemplates).toHaveBeenCalledWith({
      accessToken: "canva-token",
      query: "VIP reactivation",
      continuation: "page-2",
    });
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      query: "VIP reactivation",
      continuation: "page-3",
      items: [
        {
          id: "template-1",
          title: "VIP Campaign",
          thumbnailUrl: "https://cdn.canva.com/template.png",
          createUrl: "https://www.canva.com/create/template-1",
          source: "canva_brand_template",
        },
      ],
    });
  });
});
