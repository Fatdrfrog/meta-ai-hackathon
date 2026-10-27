import {
  assertSupportedOtpTemplate,
  normalizeOtpMaxAttempts,
  normalizeOtpPurpose,
  normalizeOtpTtlSeconds,
} from "./otp-template-binding-service";

describe("otp-template-binding-service utilities", () => {
  it("normalizes purpose values", () => {
    expect(normalizeOtpPurpose(" Login Code ")).toBe("login_code");
    expect(normalizeOtpPurpose("")).toBe("login");
  });

  it("clamps ttl and attempts", () => {
    expect(normalizeOtpTtlSeconds(30)).toBe(60);
    expect(normalizeOtpTtlSeconds(900)).toBe(600);
    expect(normalizeOtpMaxAttempts(0)).toBe(1);
    expect(normalizeOtpMaxAttempts(20)).toBe(10);
  });

  it("accepts only approved authentication templates", () => {
    expect(() =>
      assertSupportedOtpTemplate({
        id: "template-1",
        name: "login_code",
        language: "ru",
        status: "APPROVED",
        category: "AUTHENTICATION",
      })
    ).not.toThrow();

    expect(() =>
      assertSupportedOtpTemplate({
        id: "template-2",
        name: "shipping",
        language: "ru",
        status: "APPROVED",
        category: "UTILITY",
      })
    ).toThrow("Only approved WhatsApp authentication templates");
  });
});
