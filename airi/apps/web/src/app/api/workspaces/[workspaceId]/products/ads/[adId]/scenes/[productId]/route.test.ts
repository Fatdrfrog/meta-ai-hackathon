/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockRedo = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();

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
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}));
jest.mock("@/lib/products/ads", () => ({
  redoProductAdScene: (...args: unknown[]) => mockRedo(...args),
}));

import { POST, maxDuration } from "./route";

// "New picture" on one scene: a scene run that pays only for that scene.

const workspaceId = "workspace-1";
const adId = "751f1f77bcf86cd799439031";
const DOLL = "651f1f77bcf86cd799439011";
const MUG = "651f1f77bcf86cd799439012";
const url = `https://local.test/api/workspaces/${workspaceId}/products/ads/${adId}/scenes/${DOLL}`;
const post = (body: unknown, ids: { adId?: string; productId?: string } = {}) =>
  POST(new Request(url, { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({
      workspaceId,
      adId: ids.adId ?? adId,
      productId: ids.productId ?? DOLL,
    }),
  });
const ad = { id: adId, status: "making", runKind: "scene", renderNo: 2 };

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
  mockRedo.mockResolvedValue({ ad, started: true });
});

describe("New picture", () => {
  it("starts the scene's run and answers 202 with the ad, within 30 s", async () => {
    const response = await post({
      requestId: "press-2",
      setting: "gift_table",
      changes: { scenes: [{ productId: MUG, textZone: "top" }] },
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ad });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mockRedo).toHaveBeenCalledWith({
      workspaceId,
      adId,
      productId: DOLL,
      request: {
        requestId: "press-2",
        setting: "gift_table",
        changes: { scenes: [{ productId: MUG, textZone: "top" }] },
      },
    });
    expect(maxDuration).toBe(30);
  });

  it("takes the owner's own place, in one line", async () => {
    await post(
      { requestId: "press-3", words: " a felt rug\ninside a yurt " },
      { adId: adId.toUpperCase(), productId: DOLL.toUpperCase() }
    );
    expect(mockRedo).toHaveBeenCalledWith(
      expect.objectContaining({
        adId,
        productId: DOLL,
        request: { requestId: "press-3", words: "a felt rug inside a yurt" },
      })
    );
  });

  it("answers the same press again with 200 as it is", async () => {
    mockRedo.mockResolvedValue({ ad, started: false });
    expect(
      (await post({ requestId: "press-2", setting: "gift_table" })).status
    ).toBe(200);
  });

  it("asks for a press it can read", async () => {
    for (const body of [
      null,
      { setting: "gift_table" },
      { requestId: "p" },
      { requestId: "p", setting: "gift_table", words: "a yurt" },
      { requestId: "p", words: "x".repeat(81) },
      { requestId: "p", setting: "moon" },
    ]) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe("invalid_request");
    }
    expect(mockRedo).not.toHaveBeenCalled();
  });

  it("is 404 for ids that aren't ones, another workspace's ad, or a product the ad doesn't show", async () => {
    const press = { requestId: "p", setting: "gift_table" };
    expect((await post(press, { adId: "../x" })).status).toBe(404);
    const badProduct = await post(press, { productId: "../x" });
    expect(badProduct.status).toBe(404);
    expect((await badProduct.json()).code).toBe("product_not_found");
    expect(mockRedo).not.toHaveBeenCalled();

    mockRedo.mockResolvedValue({ refused: "ad_not_found" });
    expect((await post(press)).status).toBe(404);
    mockRedo.mockResolvedValue({ refused: "product_not_found" });
    expect((await post(press)).status).toBe(404);
  });

  it("refuses a busy ad, an ad with no pictures left and the ledger's stops with 409", async () => {
    const press = { requestId: "p", setting: "gift_table" };
    for (const refused of [
      "ad_not_ready",
      "no_pictures_left",
      "trial_ended",
      "spend_limit",
      "ai_actions_used",
      "ai_disabled",
    ]) {
      mockRedo.mockResolvedValue({ refused });
      const response = await post(press);
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe(refused);
    }
  });

  it("names the first issues of changes that don't fit", async () => {
    mockRedo.mockResolvedValue({
      refused: "invalid_request",
      issues: ["a", "b", "c", "d"],
    });
    const response = await post({ requestId: "p", setting: "gift_table" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "invalid_request",
      issues: ["a", "b", "c"],
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "[Products API] ad scene changes refused",
      expect.objectContaining({ event: "products.ad_scene_refused" })
    );
  });

  it("is for admins with the flag only", async () => {
    allowRole("member");
    expect((await post({ requestId: "p", setting: "gift_table" })).status).toBe(
      403
    );
    allowRole("admin");
    mockFeatureEnabled.mockResolvedValue(false);
    expect((await post({ requestId: "p", setting: "gift_table" })).status).toBe(
      404
    );
    expect(mockRedo).not.toHaveBeenCalled();
  });

  it("answers 503 and logs when the run can't start", async () => {
    mockRedo.mockRejectedValue(new Error("Temporal down"));
    const response = await post({ requestId: "p", setting: "gift_table" });
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("ad_unavailable");
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] ad scene POST failed",
      expect.any(Error),
      expect.objectContaining({ event: "products.ad_scene_failed" })
    );
  });
});
