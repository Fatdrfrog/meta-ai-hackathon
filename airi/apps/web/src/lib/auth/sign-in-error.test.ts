import {
  classifySignInError,
  createSignInAttemptId,
  parseSignInErrorParam,
} from "./sign-in-error";

describe("classifySignInError", () => {
  it("keeps Supabase's catch-all for a wrong password, unknown email or password-less account", () => {
    expect(
      classifySignInError({
        code: "invalid_credentials",
        status: 400,
        message: "Invalid login credentials",
      })
    ).toBe("invalid_credentials");
  });

  it("recognises older responses that only carry the message", () => {
    expect(
      classifySignInError({ status: 400, message: "Invalid login credentials" })
    ).toBe("invalid_credentials");
    expect(
      classifySignInError({ status: 400, message: "Email not confirmed" })
    ).toBe("email_not_confirmed");
  });

  it("separates an unconfirmed email, whose password was right", () => {
    expect(
      classifySignInError({
        code: "email_not_confirmed",
        status: 400,
        message: "Email not confirmed",
      })
    ).toBe("email_not_confirmed");
  });

  it("reports the sign-in rate limit", () => {
    expect(
      classifySignInError({
        code: "over_request_rate_limit",
        status: 429,
        message: "Request rate limit reached",
      })
    ).toBe("rate_limited");
  });

  it("falls back to unknown for outages and unexpected codes", () => {
    expect(classifySignInError({ status: 0, message: "fetch failed" })).toBe(
      "unknown"
    );
    expect(
      classifySignInError({
        code: "unexpected_failure",
        status: 500,
        message: "Internal Server Error",
      })
    ).toBe("unknown");
    expect(classifySignInError(null)).toBe("unknown");
  });
});

describe("parseSignInErrorParam", () => {
  it("accepts only the codes the login action sends", () => {
    expect(parseSignInErrorParam("invalid_credentials")).toBe(
      "invalid_credentials"
    );
    expect(parseSignInErrorParam("rate_limited")).toBe("rate_limited");
    expect(parseSignInErrorParam("unknown")).toBe("unknown");
    expect(parseSignInErrorParam("email_not_confirmed")).toBeNull();
    expect(parseSignInErrorParam("<script>")).toBeNull();
    expect(parseSignInErrorParam(null)).toBeNull();
  });
});

describe("createSignInAttemptId", () => {
  it("encodes the attempt time compactly and changes between attempts", () => {
    expect(createSignInAttemptId(1_000_000)).toBe("lfls");
    expect(createSignInAttemptId(1_000_001)).not.toBe(
      createSignInAttemptId(1_000_000)
    );
  });
});
