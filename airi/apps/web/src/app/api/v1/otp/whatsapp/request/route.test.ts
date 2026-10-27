const mockAuthenticateRequest = jest.fn();
const mockHasPermission = jest.fn();
const mockRequestWhatsAppOtp = jest.fn();
const mockIsGcpOtpApiEnabled = jest.fn();
const mockRequestRemoteWhatsAppOtp = jest.fn();

jest.mock("@/lib/api-auth", () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args),
  hasPermission: (...args: unknown[]) => mockHasPermission(...args),
}));

jest.mock("@/lib/otp/whatsapp-otp-service", () => ({
  requestWhatsAppOtp: (...args: unknown[]) => mockRequestWhatsAppOtp(...args),
}));

jest.mock("@/lib/otp/gcp-otp-api", () => ({
  isGcpOtpApiEnabled: (...args: unknown[]) => mockIsGcpOtpApiEnabled(...args),
  requestRemoteWhatsAppOtp: (...args: unknown[]) =>
    mockRequestRemoteWhatsAppOtp(...args),
}));

import { POST } from "./route";

describe("POST /api/v1/otp/whatsapp/request", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthenticateRequest.mockResolvedValue({
      apiKey: { workspace_id: "workspace-1" },
      error: null,
    });
    mockHasPermission.mockReturnValue(true);
    mockIsGcpOtpApiEnabled.mockReturnValue(false);
    mockRequestRemoteWhatsAppOtp.mockResolvedValue({
      success: true,
      challengeId: "remote-challenge-1",
      expiresAt: "2026-06-02T10:05:00.000Z",
      deliveryStatus: "queued",
    });
    mockRequestWhatsAppOtp.mockResolvedValue({
      challengeId: "challenge-1",
      expiresAt: "2026-06-02T10:05:00.000Z",
      deliveryStatus: "queued",
    });
  });

  it("proxies to the GCP OTP API when configured", async () => {
    mockIsGcpOtpApiEnabled.mockReturnValue(true);

    const response = await POST(
      new Request("http://localhost/api/v1/otp/whatsapp/request", {
        method: "POST",
        headers: {
          Authorization: "Bearer sk_test_customer",
          "Idempotency-Key": "header-request-1",
        },
        body: JSON.stringify({ phone: "+77001234567", purpose: "login" }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      challengeId: "remote-challenge-1",
      expiresAt: "2026-06-02T10:05:00.000Z",
      deliveryStatus: "queued",
    });
    expect(mockAuthenticateRequest).not.toHaveBeenCalled();
    expect(mockRequestWhatsAppOtp).not.toHaveBeenCalled();
    expect(mockRequestRemoteWhatsAppOtp).toHaveBeenCalledWith({
      customerAuthorization: "Bearer sk_test_customer",
      idempotencyKey: "header-request-1",
      payload: {
        phone: "+77001234567",
        purpose: "login",
      },
    });
  });

  it("preserves remote OTP API failure status codes", async () => {
    mockIsGcpOtpApiEnabled.mockReturnValue(true);
    mockRequestRemoteWhatsAppOtp.mockResolvedValue({
      success: false,
      status: 429,
      error: "Too many OTP requests for this phone number",
    });

    const response = await POST(
      new Request("http://localhost/api/v1/otp/whatsapp/request", {
        method: "POST",
        headers: { Authorization: "Bearer sk_test_customer" },
        body: JSON.stringify({ phone: "+77001234567", purpose: "login" }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body).toEqual({
      success: false,
      status: 429,
      error: "Too many OTP requests for this phone number",
    });
    expect(mockAuthenticateRequest).not.toHaveBeenCalled();
  });

  it("requires write permission", async () => {
    mockHasPermission.mockReturnValue(false);

    const response = await POST(
      new Request("http://localhost/api/v1/otp/whatsapp/request", {
        method: "POST",
        body: JSON.stringify({ phone: "+77001234567", purpose: "login" }),
      })
    );

    expect(response.status).toBe(403);
  });

  it("requests an OTP for the authenticated workspace without returning a code", async () => {
    const response = await POST(
      new Request("http://localhost/api/v1/otp/whatsapp/request", {
        method: "POST",
        body: JSON.stringify({ phone: "+77001234567", purpose: "login" }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      challengeId: "challenge-1",
      expiresAt: "2026-06-02T10:05:00.000Z",
      deliveryStatus: "queued",
    });
    expect(JSON.stringify(body)).not.toMatch(/"code"/);
    expect(mockRequestWhatsAppOtp).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      recipientPhone: "+77001234567",
      purpose: "login",
      idempotencyKey: undefined,
    });
  });

  it("passes the idempotency key from the request header", async () => {
    await POST(
      new Request("http://localhost/api/v1/otp/whatsapp/request", {
        method: "POST",
        headers: { "Idempotency-Key": "header-request-1" },
        body: JSON.stringify({ phone: "+77001234567", purpose: "login" }),
      })
    );

    expect(mockRequestWhatsAppOtp).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "header-request-1" })
    );
  });

  it("lets the body idempotency key override the request header", async () => {
    await POST(
      new Request("http://localhost/api/v1/otp/whatsapp/request", {
        method: "POST",
        headers: { "Idempotency-Key": "header-request-1" },
        body: JSON.stringify({
          phone: "+77001234567",
          purpose: "login",
          idempotencyKey: "body-request-1",
        }),
      })
    );

    expect(mockRequestWhatsAppOtp).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "body-request-1" })
    );
  });
});
