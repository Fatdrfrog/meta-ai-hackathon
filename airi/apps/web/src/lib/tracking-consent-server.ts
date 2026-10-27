import {
  TRACKING_CONSENT_COOKIE,
  parseTrackingConsentCookie,
  type ServerTrackingConsent,
} from "@/lib/tracking-consent-cookie";

/**
 * Reads the visitor's cookie choice mirrored by lib/tracking-consent.ts.
 * Outside a request (worker, background job) there is no choice to honor,
 * so callers get "unknown" and must not capture person-linked events.
 */
export async function readServerTrackingConsent(): Promise<ServerTrackingConsent> {
  try {
    // Loaded lazily: worker code imports analytics helpers without Next.
    const { cookies } = await import("next/headers");
    const cookieStore = await cookies();
    return parseTrackingConsentCookie(
      cookieStore.get(TRACKING_CONSENT_COOKIE)?.value
    );
  } catch {
    return "unknown";
  }
}
