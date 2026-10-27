const mockGetWhatsAppWorkspaceContext = jest.fn();
const mockListWhatsAppChatQrPage = jest.fn();

jest.mock("@/lib/whatsapp/get-workspace-context", () => ({
  getWhatsAppWorkspaceContext: (...args: unknown[]) =>
    mockGetWhatsAppWorkspaceContext(...args),
}));

jest.mock("@/lib/whatsapp/qr-entry-points/provider", () => ({
  listWhatsAppChatQrPage: (...args: unknown[]) =>
    mockListWhatsAppChatQrPage(...args),
  WhatsAppChatQrProviderError: class WhatsAppChatQrProviderError extends Error {
    outcome = "definite";
    evidence = { category: "http_error" };
  },
}));

import { GET } from "./route";

describe("GET /api/whatsapp/qr-entry-points/provider-codes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetWhatsAppWorkspaceContext.mockResolvedValue({
      context: {
        sourceId: "source-1",
        accessToken: "token",
        phoneNumberId: "phone-1",
        wabaId: "waba-1",
        credentials: {},
        membership: { role: "admin" },
        user: { id: "user-1" },
      },
    });
    mockListWhatsAppChatQrPage.mockResolvedValue({
      data: [
        {
          code: "ABC",
          prefilledMessage: "Hi",
          deepLink: "https://wa.me/message/ABC",
        },
      ],
      nextCursor: "opaque-next",
    });
  });

  it("lists one Meta-owned page for the manager source", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/whatsapp/qr-entry-points/provider-codes?workspaceId=workspace-1&sourceId=source-1&limit=25&cursor=opaque%2Bcursor"
      )
    );

    expect(response.status).toBe(200);
    expect(mockGetWhatsAppWorkspaceContext).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        requireManager: true,
        sourceId: "source-1",
        requirePhoneNumber: true,
      })
    );
    expect(mockListWhatsAppChatQrPage).toHaveBeenCalledTimes(1);
    expect(mockListWhatsAppChatQrPage).toHaveBeenCalledWith({
      phoneNumberId: "phone-1",
      accessToken: "token",
      limit: 25,
      cursor: "opaque+cursor",
    });
    await expect(response.json()).resolves.toEqual({
      codes: [
        {
          code: "ABC",
          prefilledMessage: "Hi",
          deepLink: "https://wa.me/message/ABC",
        },
      ],
      nextCursor: "opaque-next",
    });
  });

  it("omits absent provider continuation evidence", async () => {
    mockListWhatsAppChatQrPage.mockResolvedValueOnce({ data: [] });

    const response = await GET(
      new Request(
        "http://localhost/api/whatsapp/qr-entry-points/provider-codes?workspaceId=workspace-1&sourceId=source-1&limit=100"
      )
    );

    expect(mockListWhatsAppChatQrPage).toHaveBeenCalledWith({
      phoneNumberId: "phone-1",
      accessToken: "token",
      limit: 100,
    });
    await expect(response.json()).resolves.toEqual({ codes: [] });
  });

  it.each([
    "workspaceId=workspace-1",
    "workspaceId=workspace-1&sourceId=source-1",
    "workspaceId=workspace-1&sourceId=source-1&limit=0",
    "workspaceId=workspace-1&sourceId=source-1&limit=101",
    "workspaceId=workspace-1&sourceId=source-1&limit=1.5",
  ])("rejects invalid query params before auth: %s", async query => {
    const response = await GET(
      new Request(
        `http://localhost/api/whatsapp/qr-entry-points/provider-codes?${query}`
      )
    );
    expect(response.status).toBe(400);
    expect(mockGetWhatsAppWorkspaceContext).not.toHaveBeenCalled();
  });

  it("rejects changed source ownership or missing phone credentials", async () => {
    mockGetWhatsAppWorkspaceContext.mockResolvedValueOnce({
      context: {
        sourceId: "source-2",
        accessToken: "token",
        phoneNumberId: "phone-1",
      },
    });

    const response = await GET(
      new Request(
        "http://localhost/api/whatsapp/qr-entry-points/provider-codes?workspaceId=workspace-1&sourceId=source-1&limit=25"
      )
    );

    expect(response.status).toBe(409);
    expect(mockListWhatsAppChatQrPage).not.toHaveBeenCalled();
  });
});
