import { demoRequestBodySchema, demoRequestEmailSchema } from "./demo-request";

describe("demoRequestEmailSchema", () => {
  it("accepts a valid email", () => {
    expect(demoRequestEmailSchema.safeParse("sam@company.com").success).toBe(
      true
    );
  });

  it("rejects empty and invalid emails", () => {
    expect(demoRequestEmailSchema.safeParse("").success).toBe(false);
    expect(demoRequestEmailSchema.safeParse("   ").success).toBe(false);
    expect(demoRequestEmailSchema.safeParse("not-an-email").success).toBe(
      false
    );
  });

  it("trims whitespace before validating", () => {
    const parsed = demoRequestEmailSchema.safeParse("  sam@company.com  ");
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toBe("sam@company.com");
    }
  });
});

describe("demoRequestBodySchema", () => {
  it("requires an email field", () => {
    expect(demoRequestBodySchema.safeParse({}).success).toBe(false);
    expect(
      demoRequestBodySchema.safeParse({ email: "ok@airi.chat" }).success
    ).toBe(true);
  });
});
