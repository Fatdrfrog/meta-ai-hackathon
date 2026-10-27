export {};

const mockConnectDB = jest.fn();
const mockGetSupabaseRouteAuth = jest.fn();
const mockVerifyWorkspaceAccess = jest.fn();
const mockValidateAiriArtifact = jest.fn();

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
  validateAiriArtifact: (...args: unknown[]) =>
    mockValidateAiriArtifact(...args),
}));

const params = {
  params: Promise.resolve({
    workspaceId: "workspace-1",
    artifactId: "artifact-1",
  }),
};

describe("/api/workspaces/[workspaceId]/airi-artifacts/[artifactId]/validate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockGetSupabaseRouteAuth.mockResolvedValue({
      supabase: { from: jest.fn() },
      user: { id: "user-1" },
    });
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockValidateAiriArtifact.mockResolvedValue({
      status: "valid",
      issues: [],
    });
  });

  it("validates the current artifact snapshot", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      new Request(
        "http://localhost/api/workspaces/workspace-1/airi-artifacts/artifact-1/validate",
        { method: "POST" }
      ) as never,
      params
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.validation).toEqual({ status: "valid", issues: [] });
    expect(mockValidateAiriArtifact).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      artifactId: "artifact-1",
    });
  });
});
