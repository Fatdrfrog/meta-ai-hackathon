import {
  buildSupabaseAuthErrorRedirectPath,
  hasSupabaseAuthErrorSearchParams,
} from "./supabase-auth-error-params";

describe("supabase-auth-error-params", () => {
  it("detects Supabase OAuth error redirects", () => {
    const params = new URLSearchParams(
      "error=invalid_request&error_code=bad_oauth_state&error_description=OAuth+state+not+found+or+expired"
    );

    expect(hasSupabaseAuthErrorSearchParams(params)).toBe(true);
  });

  it("ignores bare marketing error params", () => {
    expect(
      hasSupabaseAuthErrorSearchParams(new URLSearchParams("error=1"))
    ).toBe(false);
  });

  it("sends authenticated users to onboarding", () => {
    const params = new URLSearchParams(
      "error=invalid_request&error_code=bad_oauth_state&error_description=OAuth+state+not+found+or+expired"
    );

    expect(
      buildSupabaseAuthErrorRedirectPath(params, { hasAuthCookie: true })
    ).toBe("/onboarding");
  });

  it("sends anonymous users to auth-code-error with reason", () => {
    const params = new URLSearchParams(
      "error=invalid_request&error_code=bad_oauth_state&error_description=OAuth+state+not+found+or+expired"
    );

    expect(
      buildSupabaseAuthErrorRedirectPath(params, { hasAuthCookie: false })
    ).toBe(
      "/auth/auth-code-error?reason=OAuth+state+not+found+or+expired&raw=OAuth+state+not+found+or+expired"
    );
  });
});
