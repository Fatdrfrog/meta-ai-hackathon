import {
  normalizeOtpIdempotencyKey,
  normalizeOtpPurpose,
} from "@icecore/otp-runtime";

describe("OTP normalization", () => {
  it("canonicalizes purpose values for every OTP entrypoint", () => {
    expect(normalizeOtpPurpose(undefined)).toBe("login");
    expect(normalizeOtpPurpose(" Password Reset! ")).toBe("password_reset_");
    expect(normalizeOtpPurpose("x".repeat(80))).toBe("x".repeat(64));
  });

  it("trims and caps idempotency keys", () => {
    expect(normalizeOtpIdempotencyKey(undefined)).toBeUndefined();
    expect(normalizeOtpIdempotencyKey(" ")).toBeUndefined();
    expect(normalizeOtpIdempotencyKey(` ${"x".repeat(140)} `)).toBe(
      "x".repeat(128)
    );
  });
});
