/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockAdvance = jest.fn();
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
jest.mock("@/lib/products/meta-publish", () => ({
  advanceProductAdPost: (...args: unknown[]) => mockAdvance(...args),
}));

import { GET } from "./route";

const workspaceId = "workspace-1";
const adId = "751f1f77bcf86cd799439031";
const postId = "751f1f77bcf86cd799439041";
const get = (ids: { adId?: string; postId?: string } = {}) => {
  const params = { workspaceId, adId, postId, ...ids };
  return GET(
    new Request(
      `https://local.test/api/workspaces/${workspaceId}/products/ads/${params.adId}/publish/${params.postId}`
    ),
    { params: Promise.resolve(params) }
  );
};
const published = {
  id: postId,
  destination: "reel",
  state: "published",
  permalink: "https://www.instagram.com/reel/abc/",
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
  mockAdvance.mockResolvedValue({ post: published });
});

describe("one post of the ad", () => {
  it("answers the post, advanced first", async () => {
    const response = await get({ postId: postId.toUpperCase() });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ post: published });
    expect(mockAdvance).toHaveBeenCalledWith({ workspaceId, adId, postId });
  });

  it.each(["ad_not_found", "post_not_found"])("is 404 %s", async code => {
    mockAdvance.mockResolvedValue({ refused: code });
    const response = await get();
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe(code);
  });

  it("is 404 for ids that aren't ones, asking nothing", async () => {
    expect((await (await get({ adId: "x" })).json()).code).toBe("ad_not_found");
    expect((await (await get({ postId: "x" })).json()).code).toBe(
      "post_not_found"
    );
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it("is for admins with the flag only", async () => {
    allowRole("manager");
    expect((await get()).status).toBe(403);
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it("answers 503 and logs when it can't be read", async () => {
    mockAdvance.mockRejectedValue(new Error("Mongo down"));
    const response = await get();
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("load_failed");
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] ad post GET failed",
      expect.any(Error),
      expect.objectContaining({ event: "products.ad_post_load_failed" })
    );
  });
});
