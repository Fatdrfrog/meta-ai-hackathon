/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockLoad = jest.fn();
const mockUpdate = jest.fn();
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
  loadProductAdRecord: (...args: unknown[]) => mockLoad(...args),
  updateProductAdWords: (...args: unknown[]) => mockUpdate(...args),
}));

import { GET, PATCH } from "./route";

const workspaceId = "workspace-1";
const adId = "751f1f77bcf86cd799439031";
const DOLL = "651f1f77bcf86cd799439011";
const contextFor = (id: string) => ({
  params: Promise.resolve({ workspaceId, adId: id }),
});
const url = `https://local.test/api/workspaces/${workspaceId}/products/ads/${adId}`;
const patch = (body: unknown, id = adId) =>
  PATCH(
    new Request(url, { method: "PATCH", body: JSON.stringify(body) }),
    contextFor(id)
  );
const ad = { id: adId, status: "ready", renderNo: 1 };

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
  mockLoad.mockResolvedValue(ad);
  mockUpdate.mockResolvedValue({
    ad: { ...ad, status: "making", renderNo: 2 },
    started: true,
  });
});

describe("one video ad", () => {
  it("answers with the ad, its links signed", async () => {
    const response = await GET(
      new Request(url),
      contextFor(adId.toUpperCase())
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ad });
    expect(mockLoad).toHaveBeenCalledWith(workspaceId, adId);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("is 404 for an id that isn't one and for another workspace's ad", async () => {
    const bad = await GET(new Request(url), contextFor("../imports"));
    expect(bad.status).toBe(404);
    expect((await bad.json()).code).toBe("ad_not_found");
    expect(mockLoad).not.toHaveBeenCalled();

    mockLoad.mockResolvedValue(null);
    expect((await GET(new Request(url), contextFor(adId))).status).toBe(404);
  });

  it("is for admins with the flag only", async () => {
    allowRole("manager");
    expect((await GET(new Request(url), contextFor(adId))).status).toBe(403);
    allowRole("admin");
    mockFeatureEnabled.mockResolvedValue(false);
    expect((await GET(new Request(url), contextFor(adId))).status).toBe(404);
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("answers 503 when it can't be read", async () => {
    mockLoad.mockRejectedValue(new Error("Mongo down"));
    const response = await GET(new Request(url), contextFor(adId));
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("load_failed");
  });
});

describe("changing the words on screen", () => {
  it("saves them and answers 202 with the video being made again", async () => {
    const response = await patch({
      sticker: "Жаңа тауар",
      captions: [{ productId: DOLL, caption: "Көк көйлек" }],
    });

    expect(response.status).toBe(202);
    expect((await response.json()).ad).toMatchObject({
      status: "making",
      renderNo: 2,
    });
    expect(mockUpdate).toHaveBeenCalledWith({
      workspaceId,
      adId,
      changes: {
        sticker: "Жаңа тауар",
        captions: [{ productId: DOLL, caption: "Көк көйлек" }],
      },
    });
  });

  it("answers 200 as it is when nothing changed", async () => {
    mockUpdate.mockResolvedValue({ ad, started: false });
    expect((await patch({ sticker: "Same" })).status).toBe(200);
  });

  it("asks for edits it can read", async () => {
    for (const body of [{}, null, { sticker: 4 }, { captions: "x" }])
      expect((await patch(body)).status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("refuses words that fail the script's checks, an ad not ready, and one not found", async () => {
    mockUpdate.mockResolvedValue({
      refused: "invalid_request",
      issues: [
        "sticker has a digit; write no numbers or prices, code adds the prices.",
      ],
    });
    const invalid = await patch({ sticker: "5000 ₸" });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).code).toBe("invalid_request");
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "[Products API] ad words refused",
      expect.objectContaining({
        event: "products.ad_words_refused",
        issues: [expect.stringContaining("digit")],
      })
    );

    mockUpdate.mockResolvedValue({ refused: "ad_not_ready" });
    const notReady = await patch({ sticker: "Жаңа" });
    expect(notReady.status).toBe(409);
    expect(await notReady.json()).toEqual({
      error: "The ad can only be changed once it's ready",
      code: "ad_not_ready",
    });

    mockUpdate.mockResolvedValue({ refused: "ad_not_found" });
    expect((await patch({ sticker: "Жаңа" })).status).toBe(404);
    expect((await patch({ sticker: "Жаңа" }, "nope")).status).toBe(404);
  });

  it("answers 503 and logs when the video can't be made again", async () => {
    mockUpdate.mockRejectedValue(new Error("Temporal down"));

    const response = await patch({ sticker: "Жаңа" });

    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("ad_unavailable");
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] ad PATCH failed",
      expect.any(Error),
      expect.objectContaining({ event: "products.ad_update_failed" })
    );
  });
});
