/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockLoadAdded = jest.fn();
const mockCreate = jest.fn();
const mockWhatsApp = jest.fn();
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
jest.mock("@/lib/products/whatsapp-drafts", () => ({
  loadAddedProducts: (...args: unknown[]) => mockLoadAdded(...args),
  createOrderFormDraft: (...args: unknown[]) => mockCreate(...args),
}));
jest.mock("@/lib/whatsapp/get-workspace-context", () => ({
  getWhatsAppWorkspaceContext: (...args: unknown[]) => mockWhatsApp(...args),
}));

import { POST } from "./route";

const workspaceId = "workspace-1";
const importId = "651f1f77bcf86cd799439040";
const context = (id = importId) => ({
  params: Promise.resolve({ workspaceId, importId: id }),
});
const post = () =>
  new Request(
    `https://local.test/api/workspaces/${workspaceId}/products/imports/${importId}/order-form`,
    { method: "POST" }
  );
const added = { language: "Russian", products: [{ id: "p1" }] };

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
  mockLoadAdded.mockResolvedValue(added);
  mockWhatsApp.mockResolvedValue({
    context: { accessToken: "token", wabaId: "waba-1" },
  });
  mockCreate.mockResolvedValue({
    ok: true,
    flowId: "flow-1",
    name: "Order form 2026-10-28 14:32",
    leftOut: 0,
  });
});

describe("POST an import's order form", () => {
  it("saves the form as a draft Flow on the workspace's WhatsApp account", async () => {
    const response = await POST(post(), context());

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      flow: { id: "flow-1", name: "Order form 2026-10-28 14:32" },
      leftOut: 0,
    });
    expect(mockCreate).toHaveBeenCalledWith({
      accessToken: "token",
      wabaId: "waba-1",
      products: added.products,
      language: "Russian",
    });
  });

  it("refuses managers and workspaces without the flag", async () => {
    allowRole("manager");
    expect((await POST(post(), context())).status).toBe(403);
    allowRole("admin");
    mockFeatureEnabled.mockResolvedValue(false);
    expect((await POST(post(), context())).status).toBe(404);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("says why there's no form: no import, nothing added, no WhatsApp", async () => {
    expect((await POST(post(), context("nope"))).status).toBe(404);

    mockLoadAdded.mockResolvedValueOnce(null);
    expect((await POST(post(), context())).status).toBe(404);

    mockLoadAdded.mockResolvedValueOnce({ language: null, products: [] });
    const empty = await POST(post(), context());
    expect(empty.status).toBe(409);
    expect(await empty.json()).toMatchObject({ code: "not_enough_products" });

    mockWhatsApp.mockResolvedValueOnce({ error: new Response(null) });
    const offline = await POST(post(), context());
    expect(offline.status).toBe(409);
    expect(await offline.json()).toMatchObject({
      code: "whatsapp_not_connected",
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("answers 502 when Meta refuses the form, and logs why", async () => {
    mockCreate.mockResolvedValue({
      ok: false,
      error: "Flow JSON validation failed",
    });

    const response = await POST(post(), context());

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "draft_failed" });
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] order form refused",
      undefined,
      expect.objectContaining({
        event: "products.order_form_refused",
        reason: "Flow JSON validation failed",
      })
    );
  });
});
