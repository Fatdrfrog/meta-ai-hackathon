/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockPrepareDrafts = jest.fn();
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
// What the drafts hold is kits.test.ts's; here, what the route answers.
jest.mock("@/lib/products/kits", () => ({
  prepareProductKitDrafts: (...args: unknown[]) => mockPrepareDrafts(...args),
}));

import { StorageQuotaError } from "@icecore/airi-runtime/storage-quota";
import { maxDuration, POST } from "./route";

const workspaceId = "workspace-1";
const ids = ["651f1f77bcf86cd799439011", "651f1f77bcf86cd799439012"];
const context = { params: Promise.resolve({ workspaceId }) };
const post = (payload: unknown) =>
  new Request(
    `https://local.test/api/workspaces/${workspaceId}/products/kits/drafts`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    }
  );
const drafts = {
  carousel: {
    name: "products_20261103_091500_abcdef",
    language: "kk",
    components: [{ type: "BODY", text: "Біздің тауарлар" }],
    productIds: ids,
    leftOut: 0,
  },
};

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
  mockPrepareDrafts.mockResolvedValue(drafts);
});

describe("POST kit drafts", () => {
  it("answers the cards the shelf would make, for the template editor to open", async () => {
    const response = await POST(
      post({ productIds: ids, language: "kk" }),
      context
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(drafts);
    expect(mockPrepareDrafts).toHaveBeenCalledWith(workspaceId, {
      productIds: ids,
      language: "kk",
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(maxDuration).toBe(60);
  });

  it("refuses requests that aren't drafts, and non-admins or a workspace without the flag", async () => {
    for (const bad of [
      "not json",
      { productIds: [], language: "kk" },
      { productIds: ids, language: "de" },
      { productIds: ids },
    ]) {
      const response = await POST(post(bad), context);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
    }
    allowRole("manager");
    expect(
      (await POST(post({ productIds: ids, language: "kk" }), context)).status
    ).toBe(403);
    allowRole("admin");
    mockFeatureEnabled.mockResolvedValue(false);
    expect(
      (await POST(post({ productIds: ids, language: "kk" }), context)).status
    ).toBe(404);
    expect(mockPrepareDrafts).not.toHaveBeenCalled();
  });

  it("says when too few products have photos, or the storage is full", async () => {
    mockPrepareDrafts.mockResolvedValueOnce({ refused: "not_enough_products" });
    const few = await POST(post({ productIds: ids, language: "kk" }), context);
    expect(few.status).toBe(409);
    expect(await few.json()).toMatchObject({ code: "not_enough_products" });

    mockPrepareDrafts.mockRejectedValueOnce(
      new StorageQuotaError("company_storage_limit_exceeded", "Storage is full")
    );
    const full = await POST(post({ productIds: ids, language: "kk" }), context);
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ code: "storage_full" });
  });

  it("answers 503 when the drafts can't be made", async () => {
    mockPrepareDrafts.mockRejectedValue(new Error("sharp crashed"));
    const response = await POST(
      post({ productIds: ids, language: "kk" }),
      context
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "draft_failed" });
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] kit drafts failed",
      expect.any(Error),
      expect.objectContaining({ event: "products.kit_drafts_failed" })
    );
  });
});
