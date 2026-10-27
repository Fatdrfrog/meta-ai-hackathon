import {
  getAuthEmailCooldownSeconds,
  parseAuthEmailCooldownParam,
} from "./auth-email-cooldown";

describe("getAuthEmailCooldownSeconds", () => {
  it("reads the wait from Supabase's per-address email cooldown", () => {
    expect(
      getAuthEmailCooldownSeconds({
        code: "over_email_send_rate_limit",
        status: 429,
        message:
          "For security purposes, you can only request this after 31 seconds.",
      })
    ).toBe(31);
  });

  it("ignores the project-wide email limit, which names no per-address wait", () => {
    expect(
      getAuthEmailCooldownSeconds({
        code: "over_email_send_rate_limit",
        status: 429,
        message: "email rate limit exceeded",
      })
    ).toBeNull();
  });

  it("ignores unrelated auth errors", () => {
    expect(
      getAuthEmailCooldownSeconds({
        code: "weak_password",
        status: 422,
        message: "Password should be at least 6 characters.",
      })
    ).toBeNull();
    expect(getAuthEmailCooldownSeconds(null)).toBeNull();
  });
});

describe("parseAuthEmailCooldownParam", () => {
  it("accepts positive seconds and caps absurd values", () => {
    expect(parseAuthEmailCooldownParam("31")).toBe(31);
    expect(parseAuthEmailCooldownParam("999999")).toBe(3600);
  });

  it("returns 0 for missing or invalid values", () => {
    expect(parseAuthEmailCooldownParam(null)).toBe(0);
    expect(parseAuthEmailCooldownParam("")).toBe(0);
    expect(parseAuthEmailCooldownParam("-5")).toBe(0);
    expect(parseAuthEmailCooldownParam("soon")).toBe(0);
  });
});
