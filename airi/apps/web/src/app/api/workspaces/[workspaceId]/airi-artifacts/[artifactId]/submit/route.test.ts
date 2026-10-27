export {};

const mockConnectDB = jest.fn();
const mockGetSupabaseRouteAuth = jest.fn();
const mockVerifyWorkspaceAccess = jest.fn();
const mockSubmitAiriArtifact = jest.fn();

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
  submitAiriArtifact: (...args: unknown[]) => mockSubmitAiriArtifact(...args),
}));

const params = {
  params: Promise.resolve({
    workspaceId: "workspace-1",
    artifactId: "artifact-1",
  }),
};

describe("/api/workspaces/[workspaceId]/airi-artifacts/[artifactId]/submit", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockGetSupabaseRouteAuth.mockResolvedValue({
      supabase: { from: jest.fn() },
      user: { id: "user-1" },
    });
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockSubmitAiriArtifact.mockResolvedValue({
      artifact: {
        id: "artifact-1",
        status: "submitted",
        externalRefs: { unifiedTemplateId: "template-row-1" },
      },
      result: {
        kind: "whatsapp_template",
        unifiedTemplateId: "template-row-1",
      },
    });
  });

  it("submits an artifact through the durable artifact service", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      new Request(
        "http://localhost/api/workspaces/workspace-1/airi-artifacts/artifact-1/submit",
        { method: "POST" }
      ) as never,
      params
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.result).toEqual(
      expect.objectContaining({ unifiedTemplateId: "template-row-1" })
    );
    expect(mockSubmitAiriArtifact).toHaveBeenCalledWith({
      supabase: expect.anything(),
      workspaceId: "workspace-1",
      artifactId: "artifact-1",
      userId: "user-1",
    });
  });
});
