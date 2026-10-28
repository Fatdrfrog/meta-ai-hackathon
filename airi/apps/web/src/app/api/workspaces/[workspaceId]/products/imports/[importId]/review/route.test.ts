/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockReview = jest.fn();
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
  reviewImportProducts: (...args: unknown[]) => mockReview(...args),
}));

import { POST } from "./route";

const workspaceId = "workspace-1";
const importId = "651f1f77bcf86cd799439040";
const productIds = ["651f1f77bcf86cd799439041", "651f1f77bcf86cd799439042"];
const context = (id = importId) => ({
  params: Promise.resolve({ workspaceId, importId: id }),
});
const post = (body: unknown) =>
  new Request(
    `https://local.test/api/workspaces/${workspaceId}/products/imports/${importId}/review`,
    { method: "POST", body: JSON.stringify(body) }
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
  mockConnect.mockResolvedValue(undefined);
  mockReview.mockResolvedValue(2);
});

describe("POST an import's review", () => {
  it("adds the products to the shelf as the admin, and says how many changed", async () => {
    const response = await POST(
      post({ productIds, status: "published" }),
      context()
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ changed: 2 });
    expect(mockReview).toHaveBeenCalledWith(
      workspaceId,
      importId,
      { productIds, status: "published" },
      "user-1"
    );
  });

  it("refuses managers and workspaces without the flag", async () => {
    allowRole("manager");
    expect(
      (await POST(post({ productIds, status: "published" }), context())).status
    ).toBe(403);
    allowRole("admin");
    mockFeatureEnabled.mockResolvedValue(false);
    expect(
      (await POST(post({ productIds, status: "published" }), context())).status
    ).toBe(404);
    expect(mockReview).not.toHaveBeenCalled();
  });

  it("answers 400 for a decision it doesn't know, 404 for an import it can't find", async () => {
    expect(
      (await POST(post({ productIds, status: "sold" }), context())).status
    ).toBe(400);
    expect(
      (await POST(post({ productIds: [], status: "published" }), context()))
        .status
    ).toBe(400);
    expect(
      (await POST(post({ productIds, status: "published" }), context("nope")))
        .status
    ).toBe(404);
    expect(mockReview).not.toHaveBeenCalled();

    mockReview.mockResolvedValue(null);
    const missing = await POST(
      post({ productIds, status: "rejected" }),
      context()
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "import_not_found" });
  });

  it("answers 503 when the decision can't be saved", async () => {
    mockReview.mockRejectedValue(new Error("mongo down"));

    const response = await POST(
      post({ productIds, status: "draft" }),
      context()
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "save_failed" });
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] review POST failed",
      expect.any(Error),
      expect.objectContaining({ event: "products.review_failed", importId })
    );
  });
});
