const mockLogger = {
  error: jest.fn(),
  info: jest.fn(),
  start: jest.fn(),
  success: jest.fn(),
  warn: jest.fn(),
};
const mockCreateRequestLogger = jest.fn(() => mockLogger);

jest.mock("@/lib/observability/server-logs", () => ({
  createRequestLogger: (...args: Parameters<typeof mockCreateRequestLogger>) =>
    mockCreateRequestLogger(...args),
}));

import { handleWhatsAppWebhookVerification } from "@/lib/whatsapp/webhook-verification";

describe("handleWhatsAppWebhookVerification", () => {
  const previousVerifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.WHATSAPP_VERIFY_TOKEN = "verify-token";
  });

  afterAll(() => {
    if (previousVerifyToken === undefined) {
      delete process.env.WHATSAPP_VERIFY_TOKEN;
    } else {
      process.env.WHATSAPP_VERIFY_TOKEN = previousVerifyToken;
    }
  });

  it("returns the Meta challenge when the verification token matches", async () => {
    const response = await handleWhatsAppWebhookVerification(
      new Request(
        "https://www.airi.chat/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=challenge-123"
      )
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("challenge-123");
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(mockLogger.success).toHaveBeenCalledWith(
      "WhatsApp webhook verification completed",
      { mode: "subscribe" }
    );
  });

  it("rejects verification when the token does not match", async () => {
    const response = await handleWhatsAppWebhookVerification(
      new Request(
        "https://www.airi.chat/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge-123"
      )
    );

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe("Failed to verify webhook");
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "WhatsApp webhook verification token mismatch",
      expect.objectContaining({
        receivedLength: 5,
        expectedLength: 12,
      })
    );
  });

  it("rejects malformed verification requests before token comparison", async () => {
    const response = await handleWhatsAppWebhookVerification(
      new Request("https://www.airi.chat/api/webhooks/whatsapp")
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Missing required parameters");
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "WhatsApp webhook verification missing required query parameters",
      expect.objectContaining({
        hasMode: false,
        hasToken: false,
        hasChallenge: false,
      })
    );
  });

  it("uses route-specific logging context for alternate WhatsApp webhook endpoints", async () => {
    await handleWhatsAppWebhookVerification(
      new Request(
        "https://www.airi.chat/api/webhooks/whatsapp/account-update?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=account-challenge"
      ),
      {
        logScope: "api.webhooks.whatsapp.account-update.verify",
        route: "/api/webhooks/whatsapp/account-update",
      }
    );

    expect(mockCreateRequestLogger).toHaveBeenCalledWith(
      "api.webhooks.whatsapp.account-update.verify",
      expect.any(Request),
      {
        route: "/api/webhooks/whatsapp/account-update",
        webhookKind: "verification",
      }
    );
  });
});
