/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockMakeKit = jest.fn();
const mockReadPlan = jest.fn();
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
// What a kit does is kits.test.ts's; here, what the route answers.
jest.mock("@/lib/products/kits", () => ({
  makeProductKit: (...args: unknown[]) => mockMakeKit(...args),
  readProductKitPlan: (...args: unknown[]) => mockReadPlan(...args),
}));

import { GET, maxDuration, POST } from "./route";

const workspaceId = "workspace-1";
const ids = ["651f1f77bcf86cd799439011", "651f1f77bcf86cd799439012"];
const importId = "651f1f77bcf86cd799439040";
const url = `https://local.test/api/workspaces/${workspaceId}/products/kits`;
const context = { params: Promise.resolve({ workspaceId }) };
const body = {
  requestId: "6f1d8a2e-5c1b-4f7e-9d3a-0b2c4e6f8a10",
  productIds: ids,
  importId,
  make: { carousel: true, orderForm: true },
  timeZone: "Asia/Tokyo",
};
const post = (payload: unknown = body) =>
  new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
const kit = {
  id: "651f1f77bcf86cd799439099",
  createdAt: "2026-11-02T04:14:05.000Z",
  language: "kk",
  productIds: ids,
  importId,
  parts: {
    orderForm: {
      state: "ready",
      flowId: "flow-1",
      flowName: "Order form · 2 Nov 09:14",
      productCount: 2,
      error: null,
    },
    carousel: {
      state: "submitted",
      templateId: "tpl-1",
      templateName: "products_20261102_041405",
      cardCount: 2,
      metaStatus: "PENDING",
      metaReason: null,
      approvedAt: null,
      error: null,
    },
  },
  status: "waiting_for_meta",
  pricesChanged: false,
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
  mockMakeKit.mockResolvedValue({ kit, repeated: false });
});

describe("POST a kit", () => {
  it("makes the kit for an admin and answers 201 once both parts settled", async () => {
    const response = await POST(post(), context);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ kit });
    expect(mockMakeKit).toHaveBeenCalledWith({
      workspaceId,
      userId: "user-1",
      request: {
        requestId: body.requestId,
        productIds: ids,
        importId,
        make: { carousel: true, orderForm: true },
        language: null,
        timeZone: "Asia/Tokyo",
      },
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("answers a carousel Meta was slow to answer as still being checked, within the route's 60 s", async () => {
    // The kit's own deadline (45 s after its parts start) is set against this.
    expect(maxDuration).toBe(60);
    const checking = {
      ...kit,
      status: "making",
      parts: {
        ...kit.parts,
        carousel: {
          ...kit.parts.carousel,
          state: "checking",
          templateId: null,
          metaStatus: null,
        },
      },
    };
    mockMakeKit.mockResolvedValue({ kit: checking, repeated: false });

    const response = await POST(post(), context);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ kit: checking });
  });

  it("answers a press sent again with the kit it made, as 200", async () => {
    mockMakeKit.mockResolvedValue({ kit, repeated: true });

    const response = await POST(post(), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kit });
  });

  it("refuses managers and workspaces without the flag, making nothing", async () => {
    allowRole("manager");
    expect((await POST(post(), context)).status).toBe(403);
    allowRole("admin");
    mockFeatureEnabled.mockResolvedValue(false);
    expect((await POST(post(), context)).status).toBe(404);
    expect(mockMakeKit).not.toHaveBeenCalled();
  });

  it("refuses a press that isn't valid", async () => {
    for (const bad of [
      "not json",
      { ...body, requestId: undefined },
      { ...body, productIds: ["nope"] },
      { ...body, make: { carousel: false, orderForm: false } },
      { ...body, language: "de" },
    ]) {
      const response = await POST(post(bad), context);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
    }
    expect(mockMakeKit).not.toHaveBeenCalled();
  });

  it("says why nothing was made: no WhatsApp number, or no products to make it from", async () => {
    mockMakeKit.mockResolvedValueOnce({ refused: "whatsapp_not_connected" });
    const offline = await POST(post(), context);
    expect(offline.status).toBe(409);
    expect(await offline.json()).toMatchObject({
      code: "whatsapp_not_connected",
    });

    mockMakeKit.mockResolvedValueOnce({ refused: "not_enough_products" });
    const few = await POST(post(), context);
    expect(few.status).toBe(409);
    expect(await few.json()).toMatchObject({ code: "not_enough_products" });
  });

  it("answers 503 when the kit can't be made at all", async () => {
    mockMakeKit.mockRejectedValue(new Error("Mongo is down"));

    const response = await POST(post(), context);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "draft_failed" });
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] kit POST failed",
      expect.any(Error),
      expect.objectContaining({ event: "products.kit_failed" })
    );
  });
});

describe("GET the make view's plan", () => {
  const plan = {
    language: "kk",
    languageIsSpoken: true,
    products: [],
    whatsapp: { connected: true, displayPhone: null },
    latestKit: null,
  };
  const get = (query: string) => new Request(`${url}?${query}`);

  it("answers what the make view needs for these products and this review", async () => {
    mockReadPlan.mockResolvedValue(plan);

    const response = await GET(
      get(`products=${ids.join(",")}&importId=${importId}`),
      context
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(plan);
    expect(mockReadPlan).toHaveBeenCalledWith({
      workspaceId,
      productIds: ids,
      importId,
    });
  });

  it("refuses a list that isn't product ids, and non-admins", async () => {
    expect((await GET(get("products="), context)).status).toBe(400);
    expect((await GET(get("products=nope"), context)).status).toBe(400);
    expect(
      (await GET(get(`products=${ids[0]}&importId=nope`), context)).status
    ).toBe(400);
    allowRole("manager");
    expect((await GET(get(`products=${ids[0]}`), context)).status).toBe(403);
    expect(mockReadPlan).not.toHaveBeenCalled();
  });

  it("answers 503 when it can't be read", async () => {
    mockReadPlan.mockRejectedValue(new Error("down"));
    const response = await GET(get(`products=${ids[0]}`), context);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "load_failed" });
  });
});
