const mockFetch = jest.fn();
const mockGetVercelOidcToken = jest.fn();

jest.mock("@vercel/oidc", () => ({
  getVercelOidcToken: (...args: unknown[]) => mockGetVercelOidcToken(...args),
}));

import { isGcpOtpApiEnabled, requestRemoteWhatsAppOtp } from "./gcp-otp-api";

describe("GCP OTP API proxy", () => {
  const previousUrl = process.env.GCP_OTP_API_URL;
  const previousToken = process.env.VERCEL_OIDC_TOKEN;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GCP_OTP_API_URL = "https://airi-otp-api.example.run.app";
    delete process.env.VERCEL_OIDC_TOKEN;
    global.fetch = mockFetch as typeof fetch;
    mockGetVercelOidcToken.mockResolvedValue("vercel-oidc-token");
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          challengeId: "challenge-1",
          expiresAt: "2026-06-02T10:05:00.000Z",
          deliveryStatus: "queued",
        }),
        { status: 200 }
      )
    );
  });

  afterAll(() => {
    process.env.GCP_OTP_API_URL = previousUrl;
    process.env.VERCEL_OIDC_TOKEN = previousToken;
    global.fetch = originalFetch;
  });

  it("is enabled when the Cloud Run OTP API URL is configured", () => {
    expect(isGcpOtpApiEnabled()).toBe(true);
  });

  it("forwards the customer API key separately from the Vercel OIDC bearer", async () => {
    const result = await requestRemoteWhatsAppOtp({
      customerAuthorization: "Bearer sk_test_customer",
      idempotencyKey: "request-1",
      payload: {
        phone: "+77001234567",
        purpose: "login",
      },
    });

    expect(result).toEqual({
      success: true,
      challengeId: "challenge-1",
      expiresAt: "2026-06-02T10:05:00.000Z",
      deliveryStatus: "queued",
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://airi-otp-api.example.run.app/v1/otp/whatsapp/request",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer vercel-oidc-token",
          "X-Airi-Api-Key": "Bearer sk_test_customer",
          "Idempotency-Key": "request-1",
        }),
      })
    );
  });

  it("returns the remote status code for Cloud Run failures", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          error: "Too many OTP requests for this workspace",
        }),
        { status: 429 }
      )
    );

    const result = await requestRemoteWhatsAppOtp({
      customerAuthorization: "Bearer sk_test_customer",
      payload: {
        phone: "+77001234567",
        purpose: "login",
      },
    });

    expect(result).toEqual({
      success: false,
      status: 429,
      error: "Too many OTP requests for this workspace",
    });
  });
});
