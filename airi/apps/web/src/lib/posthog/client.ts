import { shouldDropBenignExceptionEvent } from "@/lib/benign-browser-errors";
import { normalizeUrlBase } from "@icecore/shared/lib/value-utils";
import {
  maskPostHogAttribute,
  POSTHOG_URL_ATTRIBUTES,
  redactPostHogUrl,
  redactPostHogUrls,
} from "./privacy";

type PostHogClient = (typeof import("posthog-js"))["default"];

let posthogPromise: Promise<PostHogClient | null> | null = null;
let initializedClient: PostHogClient | null = null;
type AnalyticsUser = { id: string; email?: string };
let currentUser: AnalyticsUser | null | undefined;
let identityRevision = 0;
let identityResetRequested = false;

const DEFAULT_POSTHOG_CAPTURE_HOST = "https://us.i.posthog.com";
const DEFAULT_POSTHOG_UI_HOST = "https://us.posthog.com";

const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
]);

// A developer's local session must not file production issues, so we never
// init PostHog on a local host. `*.localhost` and `*.local` also resolve to
// the developer machine.
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    LOCAL_HOSTNAMES.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  );
}

function isLocalHost(): boolean {
  if (typeof window === "undefined") return false;
  return isLocalHostname(window.location.hostname);
}

function getPostHogKey(): string | null {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  return key && key.trim().length > 0 ? key : null;
}

export function getPostHogConsentStorageKey(): string | null {
  const key = getPostHogKey();
  // The SDK's default consent key. Independently scheduled initialization must
  // see the same persisted choice as the banner and other tracking providers.
  return key ? `__ph_opt_in_out_${key}` : null;
}

export function getInitializedPostHogClient(): PostHogClient | null {
  return initializedClient;
}

export function setPostHogUser(
  user: AnalyticsUser | null,
  { reset = false }: { reset?: boolean } = {}
): Promise<void> {
  currentUser = user ? { id: user.id, email: user.email } : null;
  identityRevision += 1;
  identityResetRequested ||= reset;
  return syncPostHogIdentity();
}

// Consent can change after the auth session resolves. Both paths use the same
// latest user, and an older SDK import must never identify a signed-out user.
export async function syncPostHogIdentity(): Promise<void> {
  if (currentUser === undefined) return;
  const revision = identityRevision;
  try {
    const posthog = initializedClient ?? (await loadPostHogClient());
    if (!posthog || revision !== identityRevision) return;

    if (
      identityResetRequested ||
      (posthog.get_property("$user_state") === "identified" &&
        posthog.get_distinct_id() !== currentUser?.id)
    ) {
      // SDK reset clears consent too. Restore the existing choice without
      // treating logout as a new opt-in or changing the shared banner state.
      const consent = posthog.get_explicit_consent_status();
      posthog.reset(true);
      if (consent === "granted")
        posthog.opt_in_capturing({ captureEventName: false });
      else if (consent === "denied") posthog.opt_out_capturing();
      identityResetRequested = false;
    }

    if (currentUser && posthog.get_explicit_consent_status() === "granted") {
      posthog.identify(currentUser.id, { email: currentUser.email });
    }
  } catch {
    // Auth remains usable when analytics is unavailable; later changes retry.
  }
}

function getPostHogCaptureHost(): string {
  return (
    normalizeUrlBase(process.env.NEXT_PUBLIC_POSTHOG_CAPTURE_HOST) ??
    normalizeUrlBase(process.env.NEXT_PUBLIC_POSTHOG_HOST) ??
    DEFAULT_POSTHOG_CAPTURE_HOST
  );
}

function getPostHogUiHost(): string {
  return (
    normalizeUrlBase(process.env.NEXT_PUBLIC_POSTHOG_UI_HOST) ??
    DEFAULT_POSTHOG_UI_HOST
  );
}

export async function loadPostHogClient(): Promise<PostHogClient | null> {
  if (typeof window === "undefined") return null;

  const key = getPostHogKey();
  if (!key) return null;

  if (isLocalHost()) return null;

  posthogPromise ??= import("posthog-js")
    .then(({ default: posthog }) => {
      if (!initializedClient) {
        posthog.init(key, {
          api_host: getPostHogCaptureHost(),
          ui_host: getPostHogUiHost(),
          defaults: "2026-01-30",
          cookieless_mode: "on_reject",
          consent_persistence_name: getPostHogConsentStorageKey(),
          get_current_url: redactPostHogUrl,
          // Autocapture serializes DOM attributes into an elements-chain string
          // before before_send, so exclude URL attributes at that source.
          autocapture: { element_attribute_ignorelist: POSTHOG_URL_ATTRIBUTES },
          session_recording: {
            maskCapturedNetworkRequestFn: request => {
              const masked = {
                ...request,
                name: redactPostHogUrl(request.name),
              };
              // Preserve network timings/status without auth cookies, bearer
              // credentials, invite JSON or token-bearing redirect headers.
              delete masked.requestHeaders;
              delete masked.responseHeaders;
              delete masked.requestBody;
              delete masked.responseBody;
              return masked;
            },
            maskAttributeFn: maskPostHogAttribute,
          },
          before_send: event => {
            if (event && shouldDropBenignExceptionEvent(event)) {
              return null;
            }
            return redactPostHogUrls(event);
          },
        });
        initializedClient = posthog;
      }

      return posthog;
    })
    .catch(error => {
      console.error("PostHog client load error:", error);
      posthogPromise = null;
      return null;
    });

  return posthogPromise;
}

/**
 * Capture a client-side event without dragging server-only PostHog code into a
 * client bundle. Failures are swallowed so tracking never breaks the UI.
 */
export function captureClientEvent(
  event: string,
  properties?: Record<string, string | number | boolean | undefined>
): void {
  void loadPostHogClient()
    .then(posthog => {
      posthog?.capture(event, properties);
    })
    .catch(error => {
      console.error("PostHog capture error:", error);
    });
}

/**
 * Report an error that a React error boundary caught; those never reach the
 * SDK's uncaught-error autocapture. Failures are swallowed like events.
 */
export function captureClientException(
  error: unknown,
  properties?: Record<string, string | number | boolean | undefined>
): void {
  void loadPostHogClient()
    .then(posthog => {
      posthog?.captureException(error, properties);
    })
    .catch(captureError => {
      console.error("PostHog exception capture error:", captureError);
    });
}

export function schedulePostHogInit(): void {
  if (typeof window === "undefined" || !getPostHogKey() || isLocalHost())
    return;

  const init = () => {
    void loadPostHogClient();
  };

  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(init, { timeout: 3000 });
  } else {
    globalThis.setTimeout(init, 1000);
  }
}
