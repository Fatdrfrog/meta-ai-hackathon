const mockCreateClient = jest.fn();
const mockVerifyWorkspaceAccess = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("@/lib/sources/utils", () => ({
  verifyWorkspaceAccess: (...args: unknown[]) =>
    mockVerifyWorkspaceAccess(...args),
}));

import { GET } from "./route";

describe("GET /panel/w/[workspaceId]/test-airi", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
  });

  it("redirects authorized users to the persisted Airi chat onboarding thread", async () => {
    const supabase = {
      auth: {
        getUser: jest.fn(async () => ({
          data: { user: { id: "user-1" } },
        })),
      },
    };
    mockCreateClient.mockResolvedValue(supabase);

    const response = await GET(
      new Request("http://localhost/panel/w/workspace-1/test-airi"),
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledWith(
      supabase,
      "user-1",
      "workspace-1"
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost/panel/w/workspace-1/airi?source=onboarding"
    );
  });

  it("redirects signed-out users to login", async () => {
    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: jest.fn(async () => ({ data: { user: null } })),
      },
    });

    const response = await GET(
      new Request("http://localhost/panel/w/workspace-1/test-airi"),
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/login");
    expect(mockVerifyWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("returns forbidden when the user cannot access the workspace", async () => {
    mockCreateClient.mockResolvedValue({
      auth: {
        getUser: jest.fn(async () => ({
          data: { user: { id: "user-1" } },
        })),
      },
    });
    mockVerifyWorkspaceAccess.mockResolvedValue(false);

    const response = await GET(
      new Request("http://localhost/panel/w/workspace-1/test-airi"),
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
  });
});
