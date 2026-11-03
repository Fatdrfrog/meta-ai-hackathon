/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockCreate = jest.fn();
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
jest.mock("@/lib/products/ads", () => ({
  createProductAd: (...args: unknown[]) => mockCreate(...args),
}));

import { POST } from "./route";

const workspaceId = "workspace-1";
const DOLL = "651f1f77bcf86cd799439011";
const MUG = "651f1f77bcf86cd799439012";
const context = { params: Promise.resolve({ workspaceId }) };
const post = (body: unknown) =>
  new Request(`https://local.test/api/workspaces/${workspaceId}/products/ads`, {
    method: "POST",
    body: JSON.stringify(body),
  });
const brief = (overrides: Record<string, unknown> = {}) => ({
  requestId: "press-1",
  productIds: [DOLL, MUG],
  idea: { kind: "gift" },
  voice: "own",
  presenter: { use: true, consent: true },
  ...overrides,
});
const ad = { id: "751f1f77bcf86cd799439031", status: "making" };

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
  mockCreate.mockResolvedValue({ ad, created: true });
});

describe("making a video ad", () => {
  it("makes the ad from the owner's brief and answers 201 with it", async () => {
    const response = await POST(post(brief()), context);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ad });
    expect(mockCreate).toHaveBeenCalledWith({
      workspaceId,
      userId: "user-1",
      request: {
        requestId: "press-1",
        productIds: [DOLL, MUG],
        idea: { kind: "gift" },
        voice: "own",
        presenter: { use: true, consent: true },
      },
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("answers the same press again with the ad it made", async () => {
    mockCreate.mockResolvedValue({ ad, created: false });

    const response = await POST(post(brief()), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ad });
  });

  it("refuses managers and workspaces without the flag before reading anything", async () => {
    allowRole("manager");
    expect((await POST(post(brief()), context)).status).toBe(403);

    allowRole("admin");
    mockFeatureEnabled.mockResolvedValue(false);
    expect((await POST(post(brief()), context)).status).toBe(404);

    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("asks for a whole brief, and the person from the video only with consent", async () => {
    for (const body of [
      null,
      brief({ productIds: [DOLL, MUG, DOLL] }),
      brief({ productIds: ["651f", MUG] }),
      brief({ idea: { kind: "own" } }),
      brief({ voice: "tts" }),
      brief({ presenter: { use: true, consent: false } }),
    ]) {
      const response = await POST(post(body), context);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "The request is invalid",
        code: "invalid_request",
      });
    }
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["not_enough_products", "Not enough products with photos for this draft"],
    [
      "ad_letters_unsupported",
      "Video ads support Latin and Cyrillic letters for now",
    ],
    ["trial_ended", "The free trial has ended"],
    ["spend_limit", "The company's AI spending limit has been reached"],
    ["ai_actions_used", "The plan's included AI actions are used up"],
  ])("answers 409 %s with its message", async (code, error) => {
    mockCreate.mockResolvedValue({ refused: code });

    const response = await POST(post(brief()), context);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error, code });
  });

  it("answers 503 and logs when the ad can't start", async () => {
    mockCreate.mockRejectedValue(new Error("Temporal down"));

    const response = await POST(post(brief()), context);

    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("ad_unavailable");
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] ad POST failed",
      expect.any(Error),
      expect.objectContaining({ event: "products.ad_create_failed" })
    );
  });
});
