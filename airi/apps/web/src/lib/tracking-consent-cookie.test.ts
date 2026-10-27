import {
  TRACKING_CONSENT_COOKIE,
  buildTrackingConsentCookie,
  parseTrackingConsentCookie,
  resolveServerCapturePolicy,
} from "./tracking-consent-cookie";

describe("tracking consent cookie", () => {
  it.each([
    ["granted", "granted"],
    ["denied", "denied"],
    [undefined, "pending"],
    ["", "pending"],
    ["1", "pending"],
  ] as const)("parses %p as %s", (value, expected) => {
    expect(parseTrackingConsentCookie(value)).toBe(expected);
  });

  it("builds a one-year first-party cookie, Secure only on https", () => {
    expect(buildTrackingConsentCookie("granted", true)).toBe(
      `${TRACKING_CONSENT_COOKIE}=granted; Path=/; Max-Age=31536000; SameSite=Lax; Secure`
    );
    expect(buildTrackingConsentCookie("denied", false)).toBe(
      `${TRACKING_CONSENT_COOKIE}=denied; Path=/; Max-Age=31536000; SameSite=Lax`
    );
  });

  it.each([
    ["granted", "identified"],
    ["pending", "anonymous"],
    ["denied", "skip"],
    ["unknown", "skip"],
  ] as const)("captures %s consent as %s", (consent, policy) => {
    expect(resolveServerCapturePolicy(consent)).toBe(policy);
  });
});
