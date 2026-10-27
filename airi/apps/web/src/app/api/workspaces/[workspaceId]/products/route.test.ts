/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockList = jest.fn();
const mockLoggerError = jest.fn();

jest.mock("@/lib/auth/workspace-membership", () => ({
  getAuthenticatedWorkspaceMembership: (...args: unknown[]) =>
    mockMembership(...args),
}));
jest.mock("@/lib/workspace-feature-flags", () => ({
  isWorkspaceFeatureEnabled: (...args: unknown[]) =>
    mockFeatureEnabled(...args),
}));
jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: () => mockConnect(),
}));
jest.mock("@/lib/logger", () => ({
  logger: { error: (...args: unknown[]) => mockLoggerError(...args) },
}));
jest.mock("@/lib/products/store", () => ({
  listPublishedProducts: (...args: unknown[]) => mockList(...args),
}));

import type { WorkspaceProductRecord } from "@/lib/products/types";
import { GET } from "./route";

const workspaceId = "workspace-1";
const context = { params: Promise.resolve({ workspaceId }) };
const request = () =>
  new Request(`https://local.test/api/workspaces/${workspaceId}/products`);

const doll: WorkspaceProductRecord = {
  id: "651f1f77bcf86cd799439031",
  name: "Кукла Лол",
  price: 5000,
  updatedAt: "2026-10-27T09:30:00.000Z",
};

function allowRole(role: string) {
  mockMembership.mockResolvedValue({
    supabase: {},
    user: { id: "user-1" },
    membership: { role },
  });
}

function expectNoDataAccess() {
  expect(mockConnect).not.toHaveBeenCalled();
  expect(mockList).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  allowRole("admin");
  mockFeatureEnabled.mockResolvedValue(true);
  mockConnect.mockResolvedValue(undefined);
  mockList.mockResolvedValue([doll]);
});

describe("products API", () => {
  it("lists the workspace's published products for an admin", async () => {
    const response = await GET(request(), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ products: [doll] });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mockFeatureEnabled).toHaveBeenCalledWith(workspaceId, "products");
    expect(mockList).toHaveBeenCalledWith(workspaceId);
  });

  test.each([401, 403])(
    "passes a denied membership (%s) through before the flag or any data",
    async status => {
      mockMembership.mockResolvedValue({
        error: new Response("Denied", { status }),
      });

      expect((await GET(request(), context)).status).toBe(status);
      expect(mockMembership).toHaveBeenCalledWith(workspaceId);
      expect(mockFeatureEnabled).not.toHaveBeenCalled();
      expectNoDataAccess();
    }
  );

  it("answers 404 feature_disabled while the flag is off, before any read", async () => {
    mockFeatureEnabled.mockResolvedValue(false);

    const response = await GET(request(), context);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Feature disabled",
      code: "feature_disabled",
    });
    expectNoDataAccess();
  });

  it("treats a failed flag read as off", async () => {
    mockFeatureEnabled.mockRejectedValue(new Error("flags unavailable"));

    expect((await GET(request(), context)).status).toBe(404);
    expectNoDataAccess();
  });

  test.each(["manager", "owner", ""])(
    "refuses role %j with 403 admin_required",
    async role => {
      allowRole(role);

      const response = await GET(request(), context);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "Workspace admin access required",
        code: "admin_required",
      });
      expectNoDataAccess();
    }
  );

  it("answers 503 load_failed and logs when the read fails", async () => {
    mockList.mockRejectedValue(new Error("mongo down"));

    const response = await GET(request(), context);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Products could not be loaded",
      code: "load_failed",
    });
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] GET failed",
      expect.any(Error),
      { event: "products.list_failed", workspaceId }
    );
  });
});
