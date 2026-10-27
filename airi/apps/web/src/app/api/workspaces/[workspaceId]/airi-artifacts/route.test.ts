export {};

const mockConnectDB = jest.fn();
const mockGetSupabaseRouteAuth = jest.fn();
const mockVerifyWorkspaceAccess = jest.fn();
const mockListAiriArtifacts = jest.fn();
const mockCreateAiriArtifact = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/supabase/route-auth", () => ({
  getSupabaseRouteAuth: (...args: unknown[]) =>
    mockGetSupabaseRouteAuth(...args),
  isSupabaseRouteAuthError: (value: unknown) =>
    Boolean(value && typeof value === "object" && "error" in value),
}));

jest.mock("@/lib/sources/utils", () => ({
  verifyWorkspaceAccess: (...args: unknown[]) =>
    mockVerifyWorkspaceAccess(...args),
}));

jest.mock("@/lib/airi-artifacts/service", () => ({
  createAiriArtifact: (...args: unknown[]) => mockCreateAiriArtifact(...args),
  listAiriArtifacts: (...args: unknown[]) => mockListAiriArtifacts(...args),
}));

const params = { params: Promise.resolve({ workspaceId: "workspace-1" }) };

function request(url: string, init?: RequestInit) {
  return new Request(url, init) as never;
}

describe("/api/workspaces/[workspaceId]/airi-artifacts", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockGetSupabaseRouteAuth.mockResolvedValue({
      supabase: { from: jest.fn() },
      user: { id: "user-1" },
    });
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockListAiriArtifacts.mockResolvedValue([
      {
        id: "artifact-1",
        workspaceId: "workspace-1",
        threadId: "thread-1",
        kind: "whatsapp_template",
        revision: 0,
      },
    ]);
    mockCreateAiriArtifact.mockResolvedValue({
      id: "artifact-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      kind: "whatsapp_template",
      revision: 0,
    });
  });

  it("lists artifacts scoped to the authenticated workspace and thread", async () => {
    const { GET } = await import("./route");

    const response = await GET(
      request(
        "http://localhost/api/workspaces/workspace-1/airi-artifacts?threadId=thread-1&kind=whatsapp_template"
      ),
      params
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.artifacts).toHaveLength(1);
    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "workspace-1"
    );
    expect(mockListAiriArtifacts).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      kind: "whatsapp_template",
      limit: 50,
    });
  });

  it("creates an artifact using the authenticated user as owner", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      request("http://localhost/api/workspaces/workspace-1/airi-artifacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-1",
          kind: "whatsapp_template",
          snapshot: {
            templateDraft: {
              name: "airi_template",
              language: "en",
              category: "MARKETING",
              components: [{ type: "BODY", text: "Hello" }],
            },
          },
        }),
      }),
      params
    );

    expect(response.status).toBe(201);
    expect(mockCreateAiriArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        threadId: "thread-1",
        userId: "user-1",
        kind: "whatsapp_template",
      })
    );
  });

  it("accepts marketing campaign artifacts", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      request("http://localhost/api/workspaces/workspace-1/airi-artifacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-1",
          kind: "marketing_campaign",
          snapshot: {
            campaignPackage: {
              title: "Pricing lead win-back",
              goal: "Recover warm leads who asked about pricing.",
              audience: "Warm WhatsApp leads",
              angle: "Helpful follow-up with one clear reply",
              evidence: ["Recent conversations mention pricing."],
              tools: {
                whatsapp: { available: true, label: "WhatsApp" },
                scenarios: { available: true, label: "Scenarios" },
                bulkCampaigns: {
                  available: true,
                  label: "Bulk campaigns",
                },
                canva: { available: false, label: "Canva" },
                visualGeneration: {
                  available: false,
                  label: "Visual generation",
                },
                audioGeneration: {
                  available: false,
                  label: "Audio generation",
                },
                metaAds: { available: false, label: "Meta Ads" },
              },
              steps: [
                {
                  id: "template",
                  kind: "whatsapp_template",
                  title: "Draft WhatsApp template",
                  description: "Create a compliant re-engagement template.",
                  status: "ready",
                  tool: "whatsapp",
                },
              ],
              checks: [{ label: "Human approval", status: "pending" }],
              nextAction: "Review the WhatsApp template.",
            },
          },
        }),
      }),
      params
    );

    expect(response.status).toBe(201);
    expect(mockCreateAiriArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        threadId: "thread-1",
        userId: "user-1",
        kind: "marketing_campaign",
      })
    );
  });

  it("rejects access when the user is not a workspace member", async () => {
    mockVerifyWorkspaceAccess.mockResolvedValue(false);
    const { GET } = await import("./route");

    const response = await GET(
      request("http://localhost/api/workspaces/workspace-1/airi-artifacts"),
      params
    );

    expect(response.status).toBe(403);
    expect(mockListAiriArtifacts).not.toHaveBeenCalled();
  });
});
