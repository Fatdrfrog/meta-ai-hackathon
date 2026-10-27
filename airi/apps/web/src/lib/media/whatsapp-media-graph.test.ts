const mockGraphGetJson = jest.fn();

jest.mock("@icecore/shared/lib/meta/api", () => ({
  getWhatsAppGraphClient: () => ({
    getJson: (...args: unknown[]) => mockGraphGetJson(...args),
  }),
}));

import { fetchWhatsAppMediaFromMeta } from "@/lib/media/whatsapp-media-graph";

describe("WhatsApp media Graph helpers", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGraphGetJson.mockResolvedValue({
      url: "https://lookaside.whatsapp.test/media",
      mime_type: "application/pdf",
      file_size: 4,
      sha256: "sha",
      id: "media_1",
    });
    global.fetch = jest.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "content-length": "4",
          },
        })
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("resolves the short-lived Meta media URL and downloads it with the access token", async () => {
    const result = await fetchWhatsAppMediaFromMeta({
      mediaId: "media_1",
      accessToken: "access_token",
      phoneNumberId: "phone_1",
    });

    expect(mockGraphGetJson).toHaveBeenCalledWith("media_1", {
      token: "access_token",
      query: { phone_number_id: "phone_1" },
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://lookaside.whatsapp.test/media",
      {
        headers: { Authorization: "Bearer access_token" },
      }
    );
    expect(result.mediaInfo).toMatchObject({
      url: "https://lookaside.whatsapp.test/media",
      mime_type: "application/pdf",
      file_size: 4,
    });
    expect(result.response.status).toBe(200);
  });
});
