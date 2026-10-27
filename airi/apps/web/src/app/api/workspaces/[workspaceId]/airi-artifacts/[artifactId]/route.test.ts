export {};

const mockConnectDB = jest.fn();
const mockGetSupabaseRouteAuth = jest.fn();
const mockVerifyWorkspaceAccess = jest.fn();
const mockGetAiriArtifact = jest.fn();
const mockUpdateAiriArtifact = jest.fn();
const mockArchiveAiriArtifact = jest.fn();

class MockAiriArtifactConflictError extends Error {
  current: unknown;

  constructor(current?: unknown) {
    super("Airi artifact revision conflict");
    this.current = current ?? null;
  }
}

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
  AiriArtifactConflictError: MockAiriArtifactConflictError,
  archiveAiriArtifact: (...args: unknown[]) => mockArchiveAiriArtifact(...args),
  getAiriArtifact: (...args: unknown[]) => mockGetAiriArtifact(...args),
  updateAiriArtifact: (...args: unknown[]) => mockUpdateAiriArtifact(...args),
}));

const params = {
  params: Promise.resolve({
    workspaceId: "workspace-1",
    artifactId: "artifact-1",
  }),
};

function request(body?: unknown) {
  return new Request(
    "http://localhost/api/workspaces/workspace-1/airi-artifacts/artifact-1",
    body === undefined
      ? undefined
      : {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
  ) as never;
}

describe("/api/workspaces/[workspaceId]/airi-artifacts/[artifactId]", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockGetSupabaseRouteAuth.mockResolvedValue({
      supabase: { from: jest.fn() },
      user: { id: "user-1" },
    });
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockGetAiriArtifact.mockResolvedValue({
      id: "artifact-1",
      workspaceId: "workspace-1",
      revision: 1,
    });
    mockUpdateAiriArtifact.mockResolvedValue({
      id: "artifact-1",
      workspaceId: "workspace-1",
      revision: 2,
    });
    mockArchiveAiriArtifact.mockResolvedValue({
      id: "artifact-1",
      status: "archived",
    });
  });

  it("loads a single artifact after workspace authorization", async () => {
    const { GET } = await import("./route");

    const response = await GET(request(), params);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.artifact.id).toBe("artifact-1");
    expect(mockGetAiriArtifact).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      artifactId: "artifact-1",
    });
  });

  it("updates an artifact with optimistic concurrency", async () => {
    const { PATCH } = await import("./route");

    const response = await PATCH(
      request({
        baseRevision: 1,
        snapshot: {
          flowConfig: {
            templateId: "lead_generation",
            screens: [
              {
                id: "LEAD_FORM",
                title: "Lead form",
                fields: [
                  {
                    id: "name",
                    label: "Name",
                    fieldType: "TextInput",
                  },
                ],
              },
            ],
          },
        },
      }),
      params
    );

    expect(response.status).toBe(200);
    expect(mockUpdateAiriArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        artifactId: "artifact-1",
        userId: "user-1",
        baseRevision: 1,
      })
    );
  });

  it("returns 409 instead of overwriting stale local edits", async () => {
    mockUpdateAiriArtifact.mockRejectedValue(
      new MockAiriArtifactConflictError({ id: "artifact-1", revision: 3 })
    );
    const { PATCH } = await import("./route");

    const response = await PATCH(
      request({ baseRevision: 1, snapshot: { flowConfig: {} } }),
      params
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual(
      expect.objectContaining({
        error: "Airi artifact revision conflict",
        current: expect.objectContaining({ revision: 3 }),
      })
    );
  });
});
