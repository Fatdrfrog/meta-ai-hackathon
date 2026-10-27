const mockPostJson = jest.fn();
const mockResolveCustomerMediaReadUrl = jest.fn();

jest.mock("@icecore/shared/lib/meta/api", () => ({
  ...jest.requireActual("@icecore/shared/lib/meta/api"),
  getWhatsAppGraphClient: () => ({
    postJson: (...args: unknown[]) => mockPostJson(...args),
  }),
}));
jest.mock("@/lib/media/customer-media-read-url", () => ({
  CUSTOMER_MEDIA_PROVIDER_TTL_SECONDS: 86400,
  resolveCustomerMediaReadUrl: (...args: unknown[]) =>
    mockResolveCustomerMediaReadUrl(...args),
}));

import { sendTelegramMedia } from "./telegram";
import { sendWhatsappMedia } from "./whatsapp";

const STORED =
  "https://project.supabase.co/storage/v1/object/public/conversation-attachments/outbound/x.pdf";

describe("provider sends of customer media", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveCustomerMediaReadUrl.mockImplementation(
      async (url: string) => `signed(${url})`
    );
  });

  it("gives Meta a signed link for a stored file", async () => {
    mockPostJson.mockResolvedValue({ messages: [{ id: "wamid.1" }] });

    await sendWhatsappMedia("phone-1", "token", "77000000000", {
      type: "document",
      link: STORED,
      fileName: "x.pdf",
    });

    expect(mockResolveCustomerMediaReadUrl).toHaveBeenCalledWith(STORED, 86400);
    expect(mockPostJson).toHaveBeenCalledWith(
      "phone-1/messages",
      expect.objectContaining({
        body: expect.objectContaining({
          document: expect.objectContaining({ link: `signed(${STORED})` }),
        }),
      })
    );
  });

  it("keeps uploaded Meta media ids untouched", async () => {
    mockPostJson.mockResolvedValue({ messages: [{ id: "wamid.2" }] });

    await sendWhatsappMedia("phone-1", "token", "77000000000", {
      type: "image",
      id: "meta-media-1",
    });

    expect(mockResolveCustomerMediaReadUrl).not.toHaveBeenCalled();
    expect(mockPostJson.mock.calls[0][1].body.image).toEqual({
      id: "meta-media-1",
    });
  });

  it("gives Telegram a signed URL to download", async () => {
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json({ ok: true, result: { message_id: 7 } })
      );

    await sendTelegramMedia("chat-1", { type: "file", url: STORED }, {
      botToken: "bot-token",
    } as Parameters<typeof sendTelegramMedia>[2]);

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.document).toBe(`signed(${STORED})`);
    expect(mockResolveCustomerMediaReadUrl).toHaveBeenCalledWith(STORED, 86400);
    fetchMock.mockRestore();
  });
});
