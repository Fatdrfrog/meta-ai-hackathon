/**
 * @jest-environment node
 */

import crypto from "node:crypto";

const mockLoadPrivateKey = jest.fn();
const mockDecrypt = jest.fn();
const mockEncrypt = jest.fn();
const mockCheckRateLimit = jest.fn();

jest.mock("@icecore/shared/lib/rate-limiter", () => ({
  rateLimitPresets: {
    webhook: { requests: 60, window: "1 m", prefix: "webhook" },
  },
  createRateLimiter: jest.fn(() => ({})),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

jest.mock("@/lib/whatsapp/flows/endpoint-crypto", () => ({
  ...jest.requireActual("@/lib/whatsapp/flows/endpoint-crypto"),
  loadFlowEndpointPrivateKeyFromEnv: () => mockLoadPrivateKey(),
  decryptFlowEndpointRequest: (...args: unknown[]) => mockDecrypt(...args),
  encryptFlowEndpointResponse: (...args: unknown[]) => mockEncrypt(...args),
}));

import { POST } from "@/app/api/webhooks/whatsapp/flow-endpoint/route";

function signPayload(payload: string): string {
  return `sha256=${crypto
    .createHmac("sha256", "meta-secret")
    .update(payload)
    .digest("hex")}`;
}

const ENCRYPTED_BODY = JSON.stringify({
  encrypted_flow_data: "flow-data",
  encrypted_aes_key: "aes-key",
  initial_vector: "initial-vector",
});

describe("legacy WhatsApp Flow endpoint route", () => {
  const originalMode = process.env.META_WEBHOOK_SIGNATURE_MODE;
  const originalSecret = process.env.META_APP_SECRET;

  beforeEach(() => {
    process.env.META_WEBHOOK_SIGNATURE_MODE = "enforce";
    process.env.META_APP_SECRET = "meta-secret";
    mockLoadPrivateKey.mockReset().mockReturnValue("legacy-private-key");
    mockDecrypt.mockReset().mockReturnValue({
      decrypted: { version: "4.0", action: "ping" },
      aesKey: Buffer.alloc(16),
      iv: Buffer.alloc(12),
    });
    mockEncrypt.mockReset().mockReturnValue("encrypted-response");
    mockCheckRateLimit.mockReset().mockResolvedValue({
      success: true,
      limit: 60,
      remaining: 59,
      reset: Date.now() + 60_000,
    });
  });

  afterAll(() => {
    process.env.META_WEBHOOK_SIGNATURE_MODE = originalMode;
    process.env.META_APP_SECRET = originalSecret;
  });

  it("keeps serving the configured fixed-key compatibility endpoint", async () => {
    const response = await POST(
      new Request(
        "https://flows.example.test/api/webhooks/whatsapp/flow-endpoint",
        {
          method: "POST",
          headers: { "x-hub-signature-256": signPayload(ENCRYPTED_BODY) },
          body: ENCRYPTED_BODY,
        }
      ) as never
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("encrypted-response");
    expect(mockDecrypt).toHaveBeenCalledWith(
      JSON.parse(ENCRYPTED_BODY),
      "legacy-private-key"
    );
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it("remains unavailable when the legacy environment key is absent", async () => {
    mockLoadPrivateKey.mockReturnValue(null);

    const response = await POST(
      new Request(
        "https://flows.example.test/api/webhooks/whatsapp/flow-endpoint",
        {
          method: "POST",
          headers: { "x-hub-signature-256": signPayload(ENCRYPTED_BODY) },
          body: ENCRYPTED_BODY,
        }
      ) as never
    );

    expect(response.status).toBe(503);
    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  it("rate limits unsigned compatibility traffic before loading key material", async () => {
    process.env.META_WEBHOOK_SIGNATURE_MODE = "off";
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      limit: 60,
      remaining: 0,
      reset: Date.now() + 30_000,
    });

    const response = await POST(
      new Request(
        "https://flows.example.test/api/webhooks/whatsapp/flow-endpoint",
        {
          method: "POST",
          headers: {
            "x-vercel-forwarded-for": "198.51.100.8",
            "x-forwarded-for": "203.0.113.10, 10.0.0.1",
            "x-hub-signature-256": "sha256=invalid",
          },
          body: ENCRYPTED_BODY,
        }
      ) as never
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "198.51.100.8",
      60
    );
    expect(mockLoadPrivateKey).not.toHaveBeenCalled();
    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  it("does not throttle valid Meta traffic when signature enforcement is off", async () => {
    process.env.META_WEBHOOK_SIGNATURE_MODE = "off";
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      limit: 60,
      remaining: 0,
      reset: Date.now() + 30_000,
    });

    const response = await POST(
      new Request(
        "https://flows.example.test/api/webhooks/whatsapp/flow-endpoint",
        {
          method: "POST",
          headers: { "x-hub-signature-256": signPayload(ENCRYPTED_BODY) },
          body: ENCRYPTED_BODY,
        }
      ) as never
    );

    expect(response.status).toBe(200);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockLoadPrivateKey).toHaveBeenCalledTimes(1);
  });

  it("fails open when the untrusted-traffic limiter backend is unavailable", async () => {
    process.env.META_WEBHOOK_SIGNATURE_MODE = "off";
    mockCheckRateLimit.mockRejectedValue(new Error("limiter unavailable"));

    const response = await POST(
      new Request(
        "https://flows.example.test/api/webhooks/whatsapp/flow-endpoint",
        {
          method: "POST",
          headers: { "x-forwarded-for": "203.0.113.12" },
          body: ENCRYPTED_BODY,
        }
      ) as never
    );

    expect(response.status).toBe(200);
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
    expect(mockLoadPrivateKey).toHaveBeenCalledTimes(1);
    expect(mockDecrypt).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized encrypted requests before signature and key work", async () => {
    const response = await POST(
      new Request(
        "https://flows.example.test/api/webhooks/whatsapp/flow-endpoint",
        {
          method: "POST",
          headers: { "content-length": String(1_024 * 1_024 + 1) },
          body: ENCRYPTED_BODY,
        }
      ) as never
    );

    expect(response.status).toBe(413);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockLoadPrivateKey).not.toHaveBeenCalled();
  });
});
