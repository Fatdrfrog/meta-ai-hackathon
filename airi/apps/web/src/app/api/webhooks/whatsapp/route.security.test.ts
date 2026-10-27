import crypto from "crypto";
import { POST } from "@/app/api/webhooks/whatsapp/route";
import { enqueueWhatsAppWebhookEvents } from "@/lib/whatsapp/webhook-event-ingest";

jest.mock("@/lib/mongoose", () => jest.fn(async () => undefined));
jest.mock("@/lib/observability/server-logs", () => ({
  createRequestLogger: jest.fn(() => ({
    error: jest.fn(),
    info: jest.fn(),
    start: jest.fn(),
    success: jest.fn(),
    warn: jest.fn(),
  })),
  createServerLogger: jest.fn(() => ({
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  })),
}));
jest.mock("@/lib/whatsapp/webhook-event-ingest", () => ({
  enqueueWhatsAppWebhookEvents: jest.fn(async () => ({
    received: 1,
    persisted: 1,
    published: 1,
    publishFailures: 0,
    eventIds: ["event-1"],
  })),
}));

function signPayload(payload: string, secret: string): string {
  const digest = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  return `sha256=${digest}`;
}

describe("WhatsApp webhook security", () => {
  const previousMode = process.env.META_WEBHOOK_SIGNATURE_MODE;
  const previousSecret = process.env.META_APP_SECRET;
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    process.env.META_WEBHOOK_SIGNATURE_MODE = "enforce";
    process.env.META_APP_SECRET = "meta-secret";
    (enqueueWhatsAppWebhookEvents as jest.Mock).mockResolvedValue({
      received: 1,
      persisted: 1,
      published: 1,
      publishFailures: 0,
      eventIds: ["event-1"],
    });
  });

  afterEach(() => {
    process.env.META_WEBHOOK_SIGNATURE_MODE = previousMode;
    process.env.META_APP_SECRET = previousSecret;
    consoleWarnSpy.mockRestore();
    jest.clearAllMocks();
  });

  it("returns 401 for invalid signature", async () => {
    const payload = JSON.stringify({});
    const req = new Request("http://localhost/api/webhooks/whatsapp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=bad",
      },
      body: payload,
    });

    const res = await POST(req as never);
    expect(res.status).toBe(401);
    expect(enqueueWhatsAppWebhookEvents).not.toHaveBeenCalled();
  });

  it("accepts valid signature", async () => {
    const payload = JSON.stringify({});
    const req = new Request("http://localhost/api/webhooks/whatsapp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signPayload(payload, "meta-secret"),
      },
      body: payload,
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(enqueueWhatsAppWebhookEvents).toHaveBeenCalledWith({
      body: {},
      rawBody: payload,
      providerSignatureVerified: true,
    });
  });

  it("enqueues status payloads instead of processing campaign status inline", async () => {
    process.env.META_WEBHOOK_SIGNATURE_MODE = "off";
    const timestamp = "1710000000";
    const expectedIso = new Date(Number(timestamp) * 1000).toISOString();
    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "messages",
              value: {
                statuses: [
                  {
                    id: "wamid.campaign-1",
                    status: "read",
                    timestamp,
                    recipient_id: "15551234567",
                    biz_opaque_callback_data: "callback-data",
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const req = new Request("http://localhost/api/webhooks/whatsapp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });

    const res = await POST(req as never);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual(
      expect.objectContaining({
        status: "ok",
        ingest: "queued",
        persisted: 1,
        published: 1,
      })
    );
    expect(enqueueWhatsAppWebhookEvents).toHaveBeenCalledWith({
      body: JSON.parse(payload),
      rawBody: payload,
      providerSignatureVerified: false,
    });
    expect(expectedIso).toEqual("2024-03-09T16:00:00.000Z");
  });

  it.each(["log", "off"])(
    "records actual signature verification in %s mode without trusting the body",
    async mode => {
      process.env.META_WEBHOOK_SIGNATURE_MODE = mode;
      const payload = JSON.stringify({ providerSignatureVerified: true });
      for (const valid of [false, true]) {
        const response = await POST(
          new Request("http://localhost/api/webhooks/whatsapp", {
            method: "POST",
            body: payload,
            headers: {
              "content-type": "application/json",
              "x-hub-signature-256": valid
                ? signPayload(payload, "meta-secret")
                : "sha256=bad",
            },
          }) as never
        );
        expect(response.status).toBe(200);
        expect(enqueueWhatsAppWebhookEvents).toHaveBeenLastCalledWith({
          body: { providerSignatureVerified: true },
          rawBody: payload,
          providerSignatureVerified: valid,
        });
      }
    }
  );

  it("acknowledges publish failures after durable persistence", async () => {
    process.env.META_WEBHOOK_SIGNATURE_MODE = "off";
    (enqueueWhatsAppWebhookEvents as jest.Mock).mockResolvedValueOnce({
      received: 1,
      persisted: 1,
      published: 0,
      publishFailures: 1,
      eventIds: ["event-1"],
    });
    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "messages",
              value: {
                statuses: [
                  {
                    id: "wamid.campaign-1",
                    status: "read",
                    timestamp: "1710000000",
                    recipient_id: "15551234567",
                    biz_opaque_callback_data: "callback-data",
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const req = new Request("http://localhost/api/webhooks/whatsapp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });

    const response = await POST(req as never);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual(
      expect.objectContaining({
        status: "ok",
        persisted: 1,
        published: 0,
        publishFailures: 1,
      })
    );
  });
});
