import {
  normalizeWhatsAppOtpRequestBody,
  WhatsAppOtpRequestValidationError,
} from "./whatsapp-otp-request";

describe("WhatsApp OTP request normalizer", () => {
  it("normalizes request fields once for web and Cloud Run entrypoints", () => {
    const normalized = normalizeWhatsAppOtpRequestBody({
      phone: " +77001234567 ",
      purpose: " Password Reset! ",
      idempotencyKey: ` ${"x".repeat(140)} `,
      metadata: { source: "checkout" },
    });

    expect(normalized).toEqual({
      phone: "+77001234567",
      purpose: "password_reset_",
      idempotencyKey: "x".repeat(128),
      metadata: { source: "checkout" },
    });
  });

  it("defaults missing or blank purpose to login", () => {
    expect(
      normalizeWhatsAppOtpRequestBody({
        phone: "+77001234567",
        purpose: " ",
      })
    ).toEqual({
      phone: "+77001234567",
      purpose: "login",
    });
  });

  it("uses the shared purpose canonicalizer instead of rejecting raw purpose variants", () => {
    expect(
      normalizeWhatsAppOtpRequestBody({
        phone: "+77001234567",
        purpose: "x".repeat(80),
      }).purpose
    ).toBe("x".repeat(64));
  });

  it("rejects invalid request shapes with a dedicated validation error", () => {
    expect(() => normalizeWhatsAppOtpRequestBody({ phone: "123" })).toThrow(
      WhatsAppOtpRequestValidationError
    );
    expect(() =>
      normalizeWhatsAppOtpRequestBody({
        phone: "+77001234567",
        metadata: [],
      })
    ).toThrow(/metadata/);
    expect(() =>
      normalizeWhatsAppOtpRequestBody({ phone: "abcdef" })
    ).toThrow(WhatsAppOtpRequestValidationError);
  });
});
