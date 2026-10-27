/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockLoad = jest.fn();
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
jest.mock("@/lib/products/imports", () => ({
  loadProductVideoImport: (...args: unknown[]) => mockLoad(...args),
}));

import type { ProductVideoImportResponse } from "@/lib/products/types";
import { GET } from "./route";

const workspaceId = "workspace-1";
const importId = "651f1f77bcf86cd799439061";
const context = (id = importId) => ({
  params: Promise.resolve({ workspaceId, importId: id }),
});
const request = () =>
  new Request(
    `https://local.test/api/workspaces/${workspaceId}/products/imports/${importId}`
  );

const found: ProductVideoImportResponse = {
  import: {
    id: importId,
    status: "processing",
    stage: "cutting",
    productTotal: 7,
    productDone: 3,
    errorCode: null,
    createdAt: "2026-10-28T09:00:00.000Z",
    finishedAt: null,
  },
  products: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockMembership.mockResolvedValue({
    supabase: {},
    user: { id: "user-1" },
    membership: { role: "admin" },
  });
  mockFeatureEnabled.mockResolvedValue(true);
  mockConnect.mockResolvedValue(undefined);
  mockLoad.mockResolvedValue(found);
});

describe("product import API", () => {
  it("shows an import's progress and products to an admin", async () => {
    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(found);
    expect(mockLoad).toHaveBeenCalledWith(workspaceId, importId);
  });

  it("answers 404 for a malformed id or another workspace's import", async () => {
    const malformed = await GET(request(), context("not-an-id"));
    expect(malformed.status).toBe(404);
    expect(mockLoad).not.toHaveBeenCalled();

    mockLoad.mockResolvedValue(null);
    const missing = await GET(request(), context());
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe("import_not_found");
  });

  it("refuses a manager", async () => {
    mockMembership.mockResolvedValue({
      supabase: {},
      user: { id: "user-2" },
      membership: { role: "manager" },
    });

    expect((await GET(request(), context())).status).toBe(403);
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("answers 503 and logs when loading fails", async () => {
    mockLoad.mockRejectedValue(new Error("Mongo down"));

    const response = await GET(request(), context());

    expect(response.status).toBe(503);
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] import GET failed",
      expect.any(Error),
      expect.objectContaining({ event: "products.import_load_failed" })
    );
  });
});
