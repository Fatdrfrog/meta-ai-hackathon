/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockLoggerError = jest.fn();

jest.mock("@/lib/auth/workspace-membership", () => ({
  getAuthenticatedWorkspaceMembership: (...args: unknown[]) =>
    mockMembership(...args),
}));
jest.mock("@/lib/workspace-feature-flags", () => ({
  isWorkspaceFeatureEnabled: (...args: unknown[]) =>
    mockFeatureEnabled(...args),
}));
jest.mock("@/lib/logger", () => ({
  logger: { error: (...args: unknown[]) => mockLoggerError(...args) },
}));

import { GET } from "./route";

const workspaceId = "workspace-1";
const context = { params: Promise.resolve({ workspaceId }) };
const request = () =>
  new Request(
    `https://local.test/api/workspaces/${workspaceId}/products/access`
  );

function allowRole(role: string) {
  mockMembership.mockResolvedValue({
    supabase: {},
    user: { id: "user-1" },
    membership: { role },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  allowRole("admin");
  mockFeatureEnabled.mockResolvedValue(true);
});

describe("products access API", () => {
  it("is available to an admin with the flag on", async () => {
    const response = await GET(request(), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: true });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mockFeatureEnabled).toHaveBeenCalledWith(workspaceId, "products");
  });

  it("is unavailable while the flag is off, even to an admin", async () => {
    mockFeatureEnabled.mockResolvedValue(false);

    expect(await (await GET(request(), context)).json()).toEqual({
      available: false,
    });
  });

  it("is unavailable to a manager with the flag on", async () => {
    allowRole("manager");

    expect(await (await GET(request(), context)).json()).toEqual({
      available: false,
    });
  });

  test.each([401, 403])(
    "passes a denied membership (%s) through before the flag",
    async status => {
      mockMembership.mockResolvedValue({
        error: new Response("Denied", { status }),
      });

      expect((await GET(request(), context)).status).toBe(status);
      expect(mockFeatureEnabled).not.toHaveBeenCalled();
    }
  );

  it("hides the entry and logs when the check throws", async () => {
    mockMembership.mockRejectedValue(new Error("auth down"));

    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: false });
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] access check failed",
      expect.any(Error),
      { event: "products.access_failed", workspaceId }
    );
  });
});
