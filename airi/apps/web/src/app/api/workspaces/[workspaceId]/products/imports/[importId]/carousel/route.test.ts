/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockLoadAdded = jest.fn();
const mockPrepare = jest.fn();
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
  prepareCarouselDraft: (...args: unknown[]) => mockPrepare(...args),
}));
jest.mock("@/lib/whatsapp/get-workspace-context", () => ({
  getWhatsAppWorkspaceContext: (...args: unknown[]) => mockWhatsApp(...args),
}));

import { StorageQuotaError } from "@icecore/airi-runtime/storage-quota";
import { POST } from "./route";

const workspaceId = "workspace-1";
const importId = "651f1f77bcf86cd799439040";
const context = (id = importId) => ({
  params: Promise.resolve({ workspaceId, importId: id }),
});
const post = () =>
  new Request(
    `https://local.test/api/workspaces/${workspaceId}/products/imports/${importId}/carousel`,
    { method: "POST" }
  );
const added = { language: "Kazakh", products: [{ id: "p1" }, { id: "p2" }] };
const draft = {
  name: "products_20261028_1432",
  language: "kk",
  bodyText: "Біздің тауарлар.",
  cards: [],
  leftOut: 0,
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
  mockLoadAdded.mockResolvedValue(added);
  mockWhatsApp.mockResolvedValue({
    context: { accessToken: "token", wabaId: "waba-1" },
  });
  mockPrepare.mockResolvedValue(draft);
});

describe("POST an import's carousel", () => {
  it("makes the cards for an admin with WhatsApp connected", async () => {
    const response = await POST(post(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ draft });
    expect(mockLoadAdded).toHaveBeenCalledWith(workspaceId, importId);
    expect(mockWhatsApp).toHaveBeenCalledWith(workspaceId, {
      requireManager: true,
    });
    expect(mockPrepare).toHaveBeenCalledWith(workspaceId, added);
  });

  it("refuses managers and workspaces without the flag", async () => {
    allowRole("manager");
    expect((await POST(post(), context())).status).toBe(403);
    allowRole("admin");
    mockFeatureEnabled.mockResolvedValue(false);
    expect((await POST(post(), context())).status).toBe(404);
    expect(mockPrepare).not.toHaveBeenCalled();
  });

  it("says why there's no carousel: no import, no WhatsApp, too few photos, full storage", async () => {
    expect((await POST(post(), context("nope"))).status).toBe(404);

    mockLoadAdded.mockResolvedValueOnce(null);
    expect((await POST(post(), context())).status).toBe(404);

    mockWhatsApp.mockResolvedValueOnce({ error: new Response(null) });
    const offline = await POST(post(), context());
    expect(offline.status).toBe(409);
    expect(await offline.json()).toMatchObject({
      code: "whatsapp_not_connected",
    });

    mockPrepare.mockResolvedValueOnce(null);
    const few = await POST(post(), context());
    expect(few.status).toBe(409);
    expect(await few.json()).toMatchObject({ code: "not_enough_products" });

    mockPrepare.mockRejectedValueOnce(
      new StorageQuotaError("company_storage_limit_exceeded", "Full")
    );
    const full = await POST(post(), context());
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ code: "storage_full" });
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("answers 503 when the cards can't be made", async () => {
    mockPrepare.mockRejectedValue(new Error("sharp crashed"));

    const response = await POST(post(), context());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "draft_failed" });
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[Products API] carousel POST failed",
      expect.any(Error),
      expect.objectContaining({ event: "products.carousel_draft_failed" })
    );
  });
});
