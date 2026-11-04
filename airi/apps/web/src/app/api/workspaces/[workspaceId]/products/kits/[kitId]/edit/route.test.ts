/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockEdit = jest.fn();
const mockSource = jest.fn();
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
// How a part is sent again is kits.test.ts's; here, what the route answers.
jest.mock("@/lib/products/kits", () => ({
  editProductKitPart: (...args: unknown[]) => mockEdit(...args),
  productKitEditSource: (...args: unknown[]) => mockSource(...args),
}));

import { StorageQuotaError } from "@icecore/airi-runtime/storage-quota";
import { GET, maxDuration, POST } from "./route";

const workspaceId = "workspace-1";
const kitId = "651f1f77bcf86cd799439099";
const context = { params: Promise.resolve({ workspaceId, kitId }) };
const url = `https://local.test/api/workspaces/${workspaceId}/products/kits/${kitId}/edit`;
const post = (body: unknown) =>
  new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const kit = { id: kitId, status: "waiting_for_meta", parts: {} };
const components = [{ type: "BODY", text: "Жаңа сөздер" }];
const carouselEdit = {
  requestId: "6f1d8a2e-5c1b-4f7e-9d3a-0b2c4e6f8a10",
  part: "carousel",
  name: "products_20261103_101500_799099",
  components,
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
  mockEdit.mockResolvedValue({ kit });
});

describe("POST an edited kit part", () => {
  it("sends the part again for an admin and answers with the kit", async () => {
    const response = await POST(post(carouselEdit), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kit });
    expect(mockEdit).toHaveBeenCalledWith({
      workspaceId,
      userId: "user-1",
      kitId,
      request: carouselEdit,
    });
    expect(maxDuration).toBe(60);
  });

  it("takes an order form's config", async () => {
    const config = { templateId: "products_order_form", screens: [] };
    const response = await POST(
      post({ requestId: carouselEdit.requestId, part: "orderForm", config }),
      context
    );
    expect(response.status).toBe(200);
    expect(mockEdit.mock.calls[0]![0].request).toEqual({
      requestId: carouselEdit.requestId,
      part: "orderForm",
      config,
    });
  });

  it("refuses what isn't an edit, non-admins and workspaces without the flag", async () => {
    for (const bad of [
      "not json",
      { ...carouselEdit, requestId: "x" },
      { ...carouselEdit, part: "banner" },
      { ...carouselEdit, components: "cards" },
    ]) {
      const response = await POST(post(bad), context);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
    }
    allowRole("manager");
    expect((await POST(post(carouselEdit), context)).status).toBe(403);
    allowRole("admin");
    mockFeatureEnabled.mockResolvedValue(false);
    expect((await POST(post(carouselEdit), context)).status).toBe(404);
    expect(mockEdit).not.toHaveBeenCalled();
  });

  it("finds no kit of another workspace", async () => {
    mockEdit.mockResolvedValue(null);
    const response = await POST(post(carouselEdit), context);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "kit_not_found" });
  });

  it("answers each refusal with its code", async () => {
    const cases: Array<[unknown, number, Record<string, unknown>]> = [
      [{ refused: "kit_part_busy" }, 409, { code: "kit_part_busy" }],
      // A carousel whose send failed moments ago, now looked for: its kit too.
      [{ refused: "kit_part_busy", kit }, 409, { code: "kit_part_busy", kit }],
      [
        { refused: "template_name_taken" },
        409,
        { code: "template_name_taken" },
      ],
      [
        { refused: "whatsapp_not_connected" },
        409,
        { code: "whatsapp_not_connected" },
      ],
      [{ refused: "invalid_request" }, 400, { code: "invalid_request" }],
      [{ refused: "meta_unavailable" }, 503, { code: "draft_failed" }],
      [
        { invalid: ["One", "Two", "Three", "Four"] },
        400,
        { code: "invalid_request", issues: ["One", "Two", "Three"] },
      ],
      [{ carouselFound: kit }, 409, { code: "carousel_found", kit }],
      [
        { metaRefused: { words: "Your card breaks a policy.", kit } },
        409,
        {
          code: "meta_refused",
          issues: ["Your card breaks a policy."],
          kit,
        },
      ],
    ];
    for (const [outcome, status, body] of cases) {
      mockEdit.mockResolvedValueOnce(outcome);
      const response = await POST(post(carouselEdit), context);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject(body);
    }
  });

  it("says the storage is full when the edited cards' pictures can't be kept", async () => {
    mockEdit.mockRejectedValueOnce(
      new StorageQuotaError("company_storage_limit_exceeded", "Storage is full")
    );
    const response = await POST(post(carouselEdit), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "storage_full" });
  });

  it("answers 503 when the part can't be sent at all", async () => {
    mockEdit.mockRejectedValue(new Error("Mongo is down"));
    const response = await POST(post(carouselEdit), context);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "draft_failed" });
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] kit edit failed",
      expect.any(Error),
      expect.objectContaining({ event: "products.kit_edit_failed" })
    );
  });
});

describe("GET what an edit opens with", () => {
  const get = (part: string) =>
    GET(new Request(`${url}?part=${part}`), context);

  it("answers the part as it was sent", async () => {
    const source = {
      kit,
      carousel: {
        name: "products_20261103_101500_799099",
        language: "kk",
        components,
      },
    };
    mockSource.mockResolvedValue(source);

    const response = await get("carousel");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(source);
    expect(mockSource).toHaveBeenCalledWith({
      workspaceId,
      kitId,
      part: "carousel",
    });
  });

  it("refuses another part, another workspace's kit, and non-admins", async () => {
    expect((await get("banner")).status).toBe(400);
    mockSource.mockResolvedValueOnce(null);
    expect((await get("orderForm")).status).toBe(404);
    mockSource.mockResolvedValueOnce({ refused: "invalid_request" });
    expect((await get("orderForm")).status).toBe(400);
    allowRole("manager");
    expect((await get("carousel")).status).toBe(403);
  });

  it("says when a kit from before can't be made again: too few products, storage full", async () => {
    mockSource.mockResolvedValueOnce({ refused: "not_enough_products" });
    const few = await get("carousel");
    expect(few.status).toBe(409);
    expect(await few.json()).toMatchObject({ code: "not_enough_products" });

    mockSource.mockRejectedValueOnce(
      new StorageQuotaError("company_storage_limit_exceeded", "Storage is full")
    );
    const full = await get("carousel");
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ code: "storage_full" });

    mockSource.mockRejectedValueOnce(new Error("down"));
    const down = await get("carousel");
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ code: "load_failed" });
  });
});
