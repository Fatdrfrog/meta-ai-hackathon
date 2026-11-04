/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockPublish = jest.fn();
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
  publishProductAd: (...args: unknown[]) => mockPublish(...args),
}));

import { POST } from "./route";

const workspaceId = "workspace-1";
const adId = "751f1f77bcf86cd799439031";
const DOLL = "651f1f77bcf86cd799439011";
const post = (body: unknown, id = adId) =>
  POST(
    new Request(
      `https://local.test/api/workspaces/${workspaceId}/products/ads/${id}/publish`,
      { method: "POST", body: JSON.stringify(body) }
    ),
    { params: Promise.resolve({ workspaceId, adId: id }) }
  );
const reel = { requestId: "press-1", destination: "reel" };
const record = {
  id: "751f1f77bcf86cd799439041",
  destination: "reel",
  still: null,
  slides: [],
  renderNo: 2,
  motion: "shelf",
  state: "processing",
  permalink: null,
  errorCode: null,
  errorMessage: null,
  requestedAt: "2026-11-04T05:50:00.000Z",
  publishedAt: null,
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
  mockPublish.mockResolvedValue({ post: record, created: true });
});

describe("posting the ad on Instagram", () => {
  it("answers 202 with the post, Instagram processing it", async () => {
    const response = await post(reel);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ post: record });
    expect(mockPublish).toHaveBeenCalledWith({
      workspaceId,
      adId,
      request: reel,
    });
  });

  it("answers a repeated press with its post, 200", async () => {
    mockPublish.mockResolvedValue({ post: record, created: false });
    const response = await post(reel);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ post: record });
  });

  it("passes a picture post's choice and caption, the ids lower-cased", async () => {
    await post({
      requestId: "press-2",
      destination: "post",
      still: {
        kind: "studio",
        productId: DOLL.toUpperCase(),
        colourway: "rose",
      },
      caption: "Кукла",
    });
    expect(mockPublish).toHaveBeenCalledWith({
      workspaceId,
      adId,
      request: {
        requestId: "press-2",
        destination: "post",
        still: { kind: "studio", productId: DOLL, colourway: "rose" },
        caption: "Кукла",
      },
    });
  });

  it("refuses a body that isn't a press with 400 and its first issues", async () => {
    const response = await post({ requestId: "press-3", destination: "post" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "invalid_request",
      issues: ["still: a post needs its picture"],
    });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("answers 400 with the issues when the picture isn't in the latest video", async () => {
    mockPublish.mockResolvedValue({
      refused: "invalid_request",
      issues: ["a", "b", "c", "d"],
    });
    const response = await post(reel);
    expect(response.status).toBe(400);
    expect((await response.json()).issues).toEqual(["a", "b", "c"]);
  });

  it.each([
    "ad_not_ready",
    "price_to_check",
    "instagram_not_connected",
    "instagram_quota",
    "post_busy",
  ])("refuses with 409 %s", async code => {
    mockPublish.mockResolvedValue({ refused: code });
    const response = await post(reel);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe(code);
  });

  it("is 404 for an ad that isn't there or an id that isn't one", async () => {
    mockPublish.mockResolvedValue({ refused: "ad_not_found" });
    expect((await post(reel)).status).toBe(404);
    expect((await post(reel, "x")).status).toBe(404);
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it("is for admins with the flag only", async () => {
    allowRole("manager");
    expect((await post(reel)).status).toBe(403);
    allowRole("admin");
    mockFeatureEnabled.mockResolvedValue(false);
    expect((await post(reel)).status).toBe(404);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("answers 503 and logs when it can't be stored", async () => {
    mockPublish.mockRejectedValue(new Error("Mongo down"));

    const response = await post(reel);

    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("post_failed");
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] ad publish failed",
      expect.any(Error),
      expect.objectContaining({ event: "products.ad_publish_failed" })
    );
  });
});
