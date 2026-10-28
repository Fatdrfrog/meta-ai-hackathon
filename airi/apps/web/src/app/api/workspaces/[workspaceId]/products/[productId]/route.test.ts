/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockUpdate = jest.fn();
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
jest.mock("@/lib/products/review", () => ({
  ...jest.requireActual("@/lib/products/review"),
  updateWorkspaceProduct: (...args: unknown[]) => mockUpdate(...args),
}));

import { PATCH } from "./route";

const workspaceId = "workspace-1";
const productId = "651f1f77bcf86cd799439041";
const context = (id = productId) => ({
  params: Promise.resolve({ workspaceId, productId: id }),
});
const patch = (body: unknown) =>
  new Request(
    `https://local.test/api/workspaces/${workspaceId}/products/${productId}`,
    { method: "PATCH", body: JSON.stringify(body) }
  );
const product = { id: productId, name: "Шежіре", price: 16900 };

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
  mockConnect.mockResolvedValue(undefined);
  mockUpdate.mockResolvedValue(product);
});

describe("PATCH a product", () => {
  it("changes the product for an admin and answers with it", async () => {
    const response = await PATCH(patch({ price: 16900 }), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ product });
    expect(mockUpdate).toHaveBeenCalledWith(workspaceId, productId, {
      price: 16900,
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("refuses managers and workspaces without the flag before changing anything", async () => {
    allowRole("manager");
    expect((await PATCH(patch({ price: 1 }), context())).status).toBe(403);
    allowRole("admin");
    mockFeatureEnabled.mockResolvedValue(false);
    expect((await PATCH(patch({ price: 1 }), context())).status).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("answers 400 for a change it can't make, 404 for a product it can't find", async () => {
    expect((await PATCH(patch({ price: -5 }), context())).status).toBe(400);
    expect((await PATCH(patch({}), context())).status).toBe(400);
    expect((await PATCH(patch({ price: 1 }), context("nope"))).status).toBe(
      404
    );
    expect(mockUpdate).not.toHaveBeenCalled();

    mockUpdate.mockResolvedValue("invalid");
    const invalid = await PATCH(patch({ featuredOption: 9 }), context());
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "invalid_request" });

    mockUpdate.mockResolvedValue(null);
    const missing = await PATCH(patch({ price: 1 }), context());
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "product_not_found" });
  });

  it("answers 503 when the change can't be saved", async () => {
    mockUpdate.mockRejectedValue(new Error("mongo down"));

    const response = await PATCH(patch({ name: "Шежіре" }), context());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "save_failed" });
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] product PATCH failed",
      expect.any(Error),
      expect.objectContaining({ event: "products.product_update_failed" })
    );
  });
});
