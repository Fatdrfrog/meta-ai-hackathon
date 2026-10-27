const mockGetWhatsAppWorkspaceContext = jest.fn();
const mockNormalizeWhatsAppQrImportUrl = jest.fn();
const mockInspectWhatsAppQrImage = jest.fn();

jest.mock("@/lib/whatsapp/get-workspace-context", () => ({
  getWhatsAppWorkspaceContext: (...args: unknown[]) =>
    mockGetWhatsAppWorkspaceContext(...args),
}));

jest.mock("@/lib/whatsapp/qr-entry-points/import-link", () => ({
  normalizeWhatsAppQrImportUrl: (...args: unknown[]) =>
    mockNormalizeWhatsAppQrImportUrl(...args),
  WhatsAppQrImportLinkError: class WhatsAppQrImportLinkError extends Error {
    code = "UNSUPPORTED_WHATSAPP_QR_LINK";
  },
}));

jest.mock("@/lib/whatsapp/qr-entry-points/image-inspection.server", () => ({
  inspectWhatsAppQrImage: (...args: unknown[]) =>
    mockInspectWhatsAppQrImage(...args),
  WhatsAppQrImageInspectionError: class WhatsAppQrImageInspectionError extends Error {
    code = "EMPTY_IMAGE";
  },
}));

import { POST } from "./route";

describe("POST /api/whatsapp/qr-entry-points/inspect", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetWhatsAppWorkspaceContext.mockResolvedValue({
      context: {
        sourceId: "source-1",
        credentials: { displayPhoneNumber: "15551234567" },
        membership: { role: "admin" },
        user: { id: "user-1" },
      },
    });
    mockNormalizeWhatsAppQrImportUrl.mockReturnValue({
      kind: "provider",
      providerCode: "ABC",
      deepLink: "https://wa.me/message/ABC",
    });
  });

  it("inspects a pasted link without storing anything", async () => {
    const response = await POST(
      new Request("http://localhost/api/whatsapp/qr-entry-points/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "workspace-1",
          sourceId: "source-1",
          url: "https://wa.me/message/ABC",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(mockNormalizeWhatsAppQrImportUrl).toHaveBeenCalledWith({
      url: "https://wa.me/message/ABC",
      displayPhoneNumber: "15551234567",
    });
    expect(mockInspectWhatsAppQrImage).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      intent: {
        kind: "provider",
        providerCode: "ABC",
        deepLink: "https://wa.me/message/ABC",
      },
    });
  });

  it("uses the selected source phone when a JSON request supplies another phone", async () => {
    const response = await POST(
      new Request("http://localhost/api/whatsapp/qr-entry-points/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "workspace-1",
          sourceId: "source-1",
          url: "https://wa.me/15551234567?text=Hello",
          displayPhoneNumber: "15550000000",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(mockNormalizeWhatsAppQrImportUrl).toHaveBeenCalledWith({
      url: "https://wa.me/15551234567?text=Hello",
      displayPhoneNumber: "15551234567",
    });
  });

  it("rejects unknown JSON fields", async () => {
    const response = await POST(
      new Request("http://localhost/api/whatsapp/qr-entry-points/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "workspace-1",
          sourceId: "source-1",
          url: "https://wa.me/message/ABC",
          extra: true,
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(mockGetWhatsAppWorkspaceContext).not.toHaveBeenCalled();
  });
  it("rejects oversized multipart requests before authentication or parsing", async () => {
    const formData = jest.fn();
    const request = {
      url: "http://localhost/api/whatsapp/qr-entry-points/inspect?workspaceId=workspace-1&sourceId=source-1",
      headers: new Headers({
        "content-type": "multipart/form-data; boundary=test",
        "content-length": String(5 * 1024 * 1024 + 64 * 1024 + 1),
      }),
      formData,
    } as unknown as Request;

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(mockGetWhatsAppWorkspaceContext).not.toHaveBeenCalled();
    expect(formData).not.toHaveBeenCalled();
  });

  it("authenticates a bounded multipart upload before parsing its body", async () => {
    const events: string[] = [];
    mockGetWhatsAppWorkspaceContext.mockImplementationOnce(async () => {
      events.push("auth");
      return {
        context: {
          sourceId: "source-1",
          credentials: { displayPhoneNumber: "15551234567" },
          membership: { role: "admin" },
          user: { id: "user-1" },
        },
      };
    });
    mockInspectWhatsAppQrImage.mockResolvedValueOnce({
      intent: {
        kind: "provider",
        providerCode: "ABC",
        deepLink: "https://wa.me/message/ABC",
      },
      image: { mimeType: "image/png", width: 10, height: 10, sizeBytes: 3 },
    });
    const data = new FormData();
    data.set(
      "image",
      new File([new Uint8Array([1, 2, 3])], "qr.png", {
        type: "image/png",
      })
    );
    const realRequest = new Request(
      "http://localhost/api/whatsapp/qr-entry-points/inspect?workspaceId=workspace-1&sourceId=source-1",
      { method: "POST", body: data }
    );
    const request = {
      url: realRequest.url,
      headers: realRequest.headers,
      get body() {
        events.push("parse");
        return realRequest.body;
      },
    } as unknown as Request;

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(events).toEqual(["auth", "parse"]);
    expect(mockInspectWhatsAppQrImage).toHaveBeenCalledWith(
      expect.objectContaining({ displayPhoneNumber: "15551234567" })
    );
  });

  it("uses the selected source phone when a multipart request supplies another phone", async () => {
    mockInspectWhatsAppQrImage.mockResolvedValueOnce({
      intent: {
        kind: "provider",
        providerCode: "ABC",
        deepLink: "https://wa.me/message/ABC",
      },
      image: { mimeType: "image/png", width: 10, height: 10, sizeBytes: 3 },
    });
    const data = new FormData();
    data.set("displayPhoneNumber", "15550000000");
    data.set(
      "image",
      new File([new Uint8Array([1, 2, 3])], "qr.png", {
        type: "image/png",
      })
    );

    const response = await POST(
      new Request(
        "http://localhost/api/whatsapp/qr-entry-points/inspect?workspaceId=workspace-1&sourceId=source-1",
        { method: "POST", body: data }
      )
    );

    expect(response.status).toBe(200);
    expect(mockInspectWhatsAppQrImage).toHaveBeenCalledWith(
      expect.objectContaining({ displayPhoneNumber: "15551234567" })
    );
  });

  it("accepts a chunked multipart request through the bounded reader", async () => {
    mockInspectWhatsAppQrImage.mockResolvedValueOnce({
      intent: {
        kind: "provider",
        providerCode: "ABC",
        deepLink: "https://wa.me/message/ABC",
      },
      image: { mimeType: "image/png", width: 10, height: 10, sizeBytes: 3 },
    });
    const data = new FormData();
    data.set(
      "image",
      new File([new Uint8Array([1, 2, 3])], "qr.png", {
        type: "image/png",
      })
    );
    const request = new Request(
      "http://localhost/api/whatsapp/qr-entry-points/inspect?workspaceId=workspace-1&sourceId=source-1",
      { method: "POST", body: data }
    );

    const response = await POST(request);

    expect(request.headers.has("content-length")).toBe(false);
    expect(response.status).toBe(200);
    expect(mockGetWhatsAppWorkspaceContext).toHaveBeenCalled();
  });

  it("rejects a chunked multipart body that exceeds the streaming limit", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5 * 1024 * 1024));
        controller.enqueue(new Uint8Array(64 * 1024 + 1));
        controller.close();
      },
    });
    const request = {
      url: "http://localhost/api/whatsapp/qr-entry-points/inspect?workspaceId=workspace-1&sourceId=source-1",
      headers: new Headers({
        "content-type": "multipart/form-data; boundary=test",
      }),
      body,
    } as unknown as Request;

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(mockGetWhatsAppWorkspaceContext).toHaveBeenCalled();
    expect(mockInspectWhatsAppQrImage).not.toHaveBeenCalled();
  });
});
