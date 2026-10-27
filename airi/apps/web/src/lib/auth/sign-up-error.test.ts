import { classifySignUpError, parseSignUpErrorParam } from "./sign-up-error";

describe("classifySignUpError", () => {
  it.each([
    [{ code: "email_address_invalid" }, "invalid_email"],
    [{ code: "weak_password" }, "weak_password"],
    [{ code: "over_request_rate_limit" }, "rate_limited"],
    [{ code: "over_email_send_rate_limit" }, "rate_limited"],
    [{ status: 429 }, "rate_limited"],
    [{ code: "signup_disabled" }, "signup_disabled"],
    [{ code: "email_provider_disabled" }, "signup_disabled"],
    [{ message: "Password should be at least 6 characters." }, "weak_password"],
    [{ message: "Signups not allowed for this instance" }, "signup_disabled"],
    [
      { message: "Unable to validate email address: invalid format" },
      "invalid_email",
    ],
  ])("classifies the supported provider failure %j", (error, expected) => {
    expect(classifySignUpError(error)).toBe(expected);
  });

  it.each([
    {
      code: "unexpected_failure",
      status: 500,
      message: "private database details",
    },
    {
      code: "email_address_not_authorized",
      message: "SMTP configuration detail",
    },
    new Error("fetch failed"),
    null,
    undefined,
  ])("falls back safely for unknown or infrastructure errors %j", error => {
    expect(classifySignUpError(error)).toBe("unknown");
  });
});

describe("parseSignUpErrorParam", () => {
  it.each([
    "invalid_email",
    "weak_password",
    "rate_limited",
    "signup_disabled",
    "unknown",
  ])("accepts the public code %s", code => {
    expect(parseSignUpErrorParam(code)).toBe(code);
  });

  it.each(["unexpected_failure", "<script>", "", null, undefined])(
    "rejects an unrecognized URL value %s",
    value => {
      expect(parseSignUpErrorParam(value)).toBeNull();
    }
  );
});
