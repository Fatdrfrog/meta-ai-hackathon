import crypto from "crypto";
import { POST } from "@/app/api/webhooks/instagram/route";

jest.mock("@/lib/mongoose", () => jest.fn(async () => undefined));
jest.mock("@/lib/instagram/webhook-handlers", () => ({
  handleIncomingMessage: jest.fn(),
  handleMessageEcho: jest.fn(),
  handleOptin: jest.fn(),
  handlePostback: jest.fn(),
  handleRead: jest.fn(),
  handleReferral: jest.fn(),
  handleReaction: jest.fn(),
  handleStandby: jest.fn(),
}));

function signPayload(payload: string, secret: string): string {
  const digest = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  return `sha256=${digest}`;
}

describe("Instagram webhook security", () => {
  const previousMode = process.env.META_WEBHOOK_SIGNATURE_MODE;
  const previousSecret = process.env.META_APP_SECRET;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    process.env.META_WEBHOOK_SIGNATURE_MODE = "enforce";
    process.env.META_APP_SECRET = "meta-secret";
  });

  afterEach(() => {
    warnSpy.mockRestore();
    process.env.META_WEBHOOK_SIGNATURE_MODE = previousMode;
    process.env.META_APP_SECRET = previousSecret;
  });

  it("returns 401 when signature is invalid", async () => {
    const payload = JSON.stringify({ entry: [] });
    const req = new Request("http://localhost/api/webhooks/instagram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=invalid",
      },
      body: payload,
    });

    const res = await POST(req as never);
    expect(res.status).toBe(401);
  });

  it("accepts valid signature", async () => {
    const payload = JSON.stringify({ entry: [] });
    const req = new Request("http://localhost/api/webhooks/instagram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signPayload(payload, "meta-secret"),
      },
      body: payload,
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
  });
});
