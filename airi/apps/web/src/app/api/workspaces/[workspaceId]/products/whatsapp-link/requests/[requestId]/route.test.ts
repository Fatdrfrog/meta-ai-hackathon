/** @jest-environment node */

const mockMembership = jest.fn();
const mockFeatureEnabled = jest.fn();
const mockConnect = jest.fn();
const mockApprove = jest.fn();
const mockDeny = jest.fn();
const mockLoad = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerInfo = jest.fn();

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
    info: (...args: unknown[]) => mockLoggerInfo(...args),
  },
}));
jest.mock("@/lib/products/whatsapp-intake", () => ({
  approveProductsWhatsAppRequest: (...args: unknown[]) => mockApprove(...args),
  denyProductsWhatsAppRequest: (...args: unknown[]) => mockDeny(...args),
  loadProductsWhatsAppLink: (...args: unknown[]) => mockLoad(...args),
}));

import type { ProductsWhatsAppLinkResponse } from "@/lib/products/types";
import { DELETE, POST } from "./route";

const workspaceId = "workspace-1";
const requestId = "651f1f77bcf86cd799439081";
const context = (id = requestId) => ({
  params: Promise.resolve({ workspaceId, requestId: id }),
});
const request = (method: string) =>
  new Request(
    `https://local.test/api/workspaces/${workspaceId}/products/whatsapp-link/requests/${requestId}`,
    { method }
  );
const panel: ProductsWhatsAppLinkResponse = {
  pairing: null,
  requests: [],
  linkedPhones: [
    {
      id: "651f1f77bcf86cd799439091",
      phone: "+7 ••• ••• 45 67",
      via: "approved",
      linkedAt: "2026-10-28T12:02:00.000Z",
      lastVideoAt: null,
    },
  ],
  businessNumbers: [],
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
  mockApprove.mockResolvedValue("linked");
  mockDeny.mockResolvedValue(true);
  mockLoad.mockResolvedValue(panel);
});

// Each method, and what its lib answers for an ask it didn't find.
describe.each([
  ["POST", POST, mockApprove, "gone"],
  ["DELETE", DELETE, mockDeny, false],
] as const)("%s a phone's ask", (method, handler, lib, missingAsk) => {
  test.each([401, 403])(
    "passes a denied membership (%s) through",
    async status => {
      mockMembership.mockResolvedValue({
        error: new Response("Denied", { status }),
      });

      expect((await handler(request(method), context())).status).toBe(status);
      expect(lib).not.toHaveBeenCalled();
    }
  );

  it("refuses managers and workspaces without the flag", async () => {
    allowRole("manager");
    expect((await handler(request(method), context())).status).toBe(403);
    allowRole("admin");
    mockFeatureEnabled.mockResolvedValue(false);
    expect((await handler(request(method), context())).status).toBe(404);
    expect(lib).not.toHaveBeenCalled();
  });

  it("answers 404 for a malformed id, and for another workspace's or an expired ask", async () => {
    const malformed = await handler(request(method), context("not-an-id"));
    expect(malformed.status).toBe(404);
    expect(await malformed.json()).toMatchObject({
      code: "whatsapp_link_not_found",
    });
    expect(lib).not.toHaveBeenCalled();

    // The ask is looked up within this workspace; one elsewhere, or past
    // its 10 minutes, isn't found.
    lib.mockResolvedValueOnce(missingAsk);
    const missing = await handler(request(method), context());
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      code: "whatsapp_link_not_found",
    });
    expect(lib.mock.calls[0]!.slice(0, 2)).toEqual([workspaceId, requestId]);
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("answers 503 and logs when the answer can't be saved", async () => {
    lib.mockRejectedValueOnce(new Error("mongo down"));

    const response = await handler(request(method), context());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "save_failed" });
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("WhatsApp link request"),
      expect.any(Error),
      expect.objectContaining({ workspaceId, requestId })
    );
  });
});

describe("POST a phone's ask", () => {
  it("links the phone for the admin and answers with the panel", async () => {
    const response = await POST(request("POST"), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(panel);
    expect(mockApprove).toHaveBeenCalledWith(workspaceId, requestId, "user-1");
    expect(mockLoad).toHaveBeenCalledWith(workspaceId);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[Products API] WhatsApp phone linked",
      {
        event: "products.whatsapp_phone_linked",
        workspaceId,
        requestId,
        userId: "user-1",
      }
    );
    expect(mockDeny).not.toHaveBeenCalled();
  });

  it("answers 409 for a phone another workspace has, which stays there", async () => {
    mockApprove.mockResolvedValueOnce("linked_elsewhere");

    const response = await POST(request("POST"), context());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "whatsapp_link_linked_elsewhere",
    });
    expect(mockLoad).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[Products API] WhatsApp phone linked elsewhere",
      {
        event: "products.whatsapp_phone_linked_elsewhere",
        workspaceId,
        requestId,
        userId: "user-1",
      }
    );
  });
});

describe("DELETE a phone's ask", () => {
  it("forgets the ask for the admin and answers with the panel", async () => {
    const response = await DELETE(request("DELETE"), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(panel);
    expect(mockDeny).toHaveBeenCalledWith(workspaceId, requestId);
    expect(mockApprove).not.toHaveBeenCalled();
  });
});
