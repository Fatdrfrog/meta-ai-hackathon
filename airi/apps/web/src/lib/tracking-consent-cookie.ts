// Shared by the browser consent store and server analytics. Keep this module
// free of imports so neither side pulls the other's runtime into its bundle.

export const TRACKING_CONSENT_COOKIE = "airi_tracking_consent";

const TRACKING_CONSENT_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export type TrackingConsentChoice = "pending" | "granted" | "denied";

/** "unknown" means no request is in scope (worker, background job). */
export type ServerTrackingConsent = TrackingConsentChoice | "unknown";

/**
 * How a server capture treats the person, following the browser rule:
 * identify only after an explicit grant, count without a person profile
 * before any choice, send nothing after a refusal or without a request.
 */
export type ServerCapturePolicy = "identified" | "anonymous" | "skip";

export function parseTrackingConsentCookie(
  value: string | null | undefined
): TrackingConsentChoice {
  if (value === "granted") return "granted";
  if (value === "denied") return "denied";
  return "pending";
}

export function buildTrackingConsentCookie(
  consent: Exclude<TrackingConsentChoice, "pending">,
  secure: boolean
): string {
  return [
    `${TRACKING_CONSENT_COOKIE}=${consent}`,
    "Path=/",
    `Max-Age=${TRACKING_CONSENT_COOKIE_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function resolveServerCapturePolicy(
  consent: ServerTrackingConsent
): ServerCapturePolicy {
  if (consent === "granted") return "identified";
  if (consent === "pending") return "anonymous";
  return "skip";
}
