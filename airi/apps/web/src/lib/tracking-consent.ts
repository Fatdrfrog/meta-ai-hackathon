import {
  getInitializedPostHogClient,
  getPostHogConsentStorageKey,
  loadPostHogClient,
  syncPostHogIdentity,
} from "@/lib/posthog/client";
import { updateTikTokConsent } from "@/lib/tiktok-pixel";
import {
  buildTrackingConsentCookie,
  type TrackingConsentChoice,
} from "@/lib/tracking-consent-cookie";

export type TrackingConsent = TrackingConsentChoice;

// Reuse PostHog's persisted choice. A fallback is only needed on deployments
// without a project key; it migrates into the SDK's key when one is configured.
const FALLBACK_STORAGE_KEY = "airi_tracking_consent";
let choiceRevision = 0;
let sessionChoice: TrackingConsent = "pending";
let storageUnavailable = false;

function parseChoice(value: string | null): TrackingConsent {
  if (value === "1") return "granted";
  if (value === "0") return "denied";
  return "pending";
}

function readChoice(): TrackingConsent {
  if (storageUnavailable) return sessionChoice;
  try {
    const sdkKey = getPostHogConsentStorageKey();
    if (sdkKey) {
      const fallback = parseChoice(
        window.localStorage.getItem(FALLBACK_STORAGE_KEY)
      );
      if (fallback !== "pending") {
        persistChoice(fallback);
        return fallback;
      }
    }
    return parseChoice(
      window.localStorage.getItem(sdkKey ?? FALLBACK_STORAGE_KEY)
    );
  } catch {
    storageUnavailable = true;
    return sessionChoice;
  }
}

// Server analytics cannot read localStorage, so the choice is mirrored into a
// first-party cookie that only stores the choice itself.
function mirrorChoiceToCookie(consent: TrackingConsent): void {
  if (consent === "pending") return;
  try {
    document.cookie = buildTrackingConsentCookie(
      consent,
      window.location.protocol === "https:"
    );
  } catch {
    // Without the cookie the server treats the visitor as undecided.
  }
}

function persistChoice(consent: TrackingConsent): void {
  sessionChoice = consent;
  mirrorChoiceToCookie(consent);
  const storageKey = getPostHogConsentStorageKey() ?? FALLBACK_STORAGE_KEY;
  try {
    window.localStorage.setItem(storageKey, consent === "granted" ? "1" : "0");
    if (storageKey !== FALLBACK_STORAGE_KEY) {
      window.localStorage.removeItem(FALLBACK_STORAGE_KEY);
    }
  } catch {
    storageUnavailable = true;
    // In a full/read-only store, do not leave an older grant behind if removing
    // it is still possible. With unavailable storage, a reload must ask again.
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // The current document still honors the choice in memory.
    }
  }
}

async function syncPostHogConsent(
  consent: TrackingConsent,
  revision: number,
  force = false
): Promise<void> {
  if (consent === "pending") return;
  const posthog = await loadPostHogClient().catch(() => null);
  if (!posthog || revision !== choiceRevision || readChoice() !== consent)
    return;
  try {
    if (!force && posthog.get_explicit_consent_status() === consent) return;
  } catch {
    // Still apply the choice when the SDK cannot read its current state.
  }
  applyPostHogConsent(posthog, consent);
  await syncPostHogIdentity();
}

function applyPostHogConsent(
  posthog: NonNullable<ReturnType<typeof getInitializedPostHogClient>>,
  consent: Exclude<TrackingConsent, "pending">
): void {
  try {
    if (consent === "granted") posthog.opt_in_capturing();
    else posthog.opt_out_capturing();
  } catch {
    // The shared choice already applies even if the analytics SDK is blocked.
  }
}

export async function loadTrackingConsent(): Promise<TrackingConsent> {
  const revision = choiceRevision;
  const storedChoice = readChoice();
  if (storedChoice !== "pending" || storageUnavailable) {
    // Choices saved before the cookie mirror existed reach the server here.
    mirrorChoiceToCookie(storedChoice);
    updateTikTokConsent(storedChoice);
    void syncPostHogConsent(storedChoice, revision);
    return storedChoice;
  }

  const posthog = await loadPostHogClient().catch(() => null);
  // A click while the SDK loads takes precedence over its older persisted state.
  const currentChoice = readChoice();
  if (
    choiceRevision !== revision ||
    currentChoice !== "pending" ||
    storageUnavailable
  ) {
    updateTikTokConsent(currentChoice);
    return currentChoice;
  }

  let consent: TrackingConsent = "pending";
  try {
    const legacyChoice = posthog?.get_explicit_consent_status();
    if (legacyChoice === "granted" || legacyChoice === "denied") {
      consent = legacyChoice;
      persistChoice(consent);
    }
  } catch {
    // Consent remains pending when the analytics SDK cannot read its storage.
  }
  updateTikTokConsent(consent);
  return consent;
}

export async function setTrackingConsent(
  consent: Exclude<TrackingConsent, "pending">
): Promise<void> {
  const revision = ++choiceRevision;
  const initializedPostHog = getInitializedPostHogClient();
  // The loaded SDK must see its previous consent so its opt-in/out methods can
  // reset identities and recordings when entering/leaving cookieless mode.
  if (initializedPostHog) applyPostHogConsent(initializedPostHog, consent);
  persistChoice(consent);
  updateTikTokConsent(consent);

  if (!initializedPostHog) await syncPostHogConsent(consent, revision, true);
  else await syncPostHogIdentity();
}
