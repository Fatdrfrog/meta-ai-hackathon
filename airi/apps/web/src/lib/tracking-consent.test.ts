/** @jest-environment jsdom */

const mockLoadPostHogClient = jest.fn();
const mockConsentStatus = jest.fn();
const mockOptIn = jest.fn();
const mockOptOut = jest.fn();
const mockSyncIdentity = jest.fn();
let mockSdkStorageKey: string | null = null;
let mockInitializedClient: ReturnType<typeof client> | null = null;
const CONSENT_KEY = "airi_tracking_consent";
const PIXEL_SELECTOR = 'script[src^="https://analytics.tiktok.com/"]';
type PixelWindow = Window & {
  ttq?: unknown[][];
  TiktokAnalyticsObject?: string;
};

jest.mock("@/lib/posthog/client", () => ({
  loadPostHogClient: () => mockLoadPostHogClient(),
  getPostHogConsentStorageKey: () => mockSdkStorageKey,
  getInitializedPostHogClient: () => mockInitializedClient,
  syncPostHogIdentity: () => mockSyncIdentity(),
}));

function pixelQueue() {
  return (window as PixelWindow).ttq;
}

function resetPixel() {
  document.querySelectorAll(PIXEL_SELECTOR).forEach(script => script.remove());
  delete (window as PixelWindow).ttq;
  delete (window as PixelWindow).TiktokAnalyticsObject;
}

function client() {
  return {
    get_explicit_consent_status: mockConsentStatus,
    opt_in_capturing: mockOptIn,
    opt_out_capturing: mockOptOut,
  };
}

describe("shared tracking consent", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    window.localStorage.clear();
    resetPixel();
    mockConsentStatus.mockReturnValue("pending");
    mockSdkStorageKey = null;
    mockInitializedClient = null;
    mockLoadPostHogClient.mockResolvedValue(client());
  });

  afterEach(() => {
    jest.restoreAllMocks();
    resetPixel();
  });

  it("reapplies the current auth identity after the initialized SDK accepts consent", async () => {
    mockInitializedClient = client();
    const consent = await import("./tracking-consent");
    await consent.setTrackingConsent("granted");
    expect(mockSyncIdentity).toHaveBeenCalledTimes(1);
    expect(mockOptIn.mock.invocationCallOrder[0]).toBeLessThan(
      mockSyncIdentity.mock.invocationCallOrder[0]
    );
  });

  it.each(["pending", "denied"])(
    "does not create or load TikTok for %s",
    async status => {
      mockConsentStatus.mockReturnValue(status);
      const { loadTrackingConsent } = await import("./tracking-consent");

      expect(await loadTrackingConsent()).toBe(status);
      expect(pixelQueue()).toBeUndefined();
      expect(document.querySelector(PIXEL_SELECTOR)).toBeNull();
    }
  );

  it("uses the existing SDK refusal even when PostHog cannot load", async () => {
    mockSdkStorageKey = "__ph_opt_in_out_test-project";
    window.localStorage.setItem(mockSdkStorageKey, "0");
    mockLoadPostHogClient.mockResolvedValue(null);
    const consent = await import("./tracking-consent");

    expect(await consent.loadTrackingConsent()).toBe("denied");
    expect(window.localStorage.getItem(CONSENT_KEY)).toBeNull();
    expect(pixelQueue()).toBeUndefined();
  });

  it("writes refusal to the SDK's own key before its scheduled initialization can capture", async () => {
    mockSdkStorageKey = "__ph_opt_in_out_test-project";
    window.localStorage.setItem(mockSdkStorageKey, "1");
    mockLoadPostHogClient.mockImplementation(async () => {
      expect(window.localStorage.getItem(mockSdkStorageKey!)).toBe("0");
      return client();
    });
    const consent = await import("./tracking-consent");

    await consent.setTrackingConsent("denied");
    expect(mockOptOut).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(CONSENT_KEY)).toBeNull();
    expect(pixelQueue()).toBeUndefined();
  });

  it("migrates a choice made without a project key into the existing SDK store", async () => {
    mockLoadPostHogClient.mockResolvedValue(null);
    const consent = await import("./tracking-consent");
    await consent.setTrackingConsent("denied");
    mockSdkStorageKey = "__ph_opt_in_out_test-project";
    window.localStorage.setItem(mockSdkStorageKey, "1");

    expect(await consent.loadTrackingConsent()).toBe("denied");
    expect(window.localStorage.getItem(mockSdkStorageKey)).toBe("0");
    expect(window.localStorage.getItem(CONSENT_KEY)).toBeNull();
    expect(pixelQueue()).toBeUndefined();
  });

  it("lets an initialized SDK see its previous grant when clearing identities on refusal", async () => {
    mockSdkStorageKey = "__ph_opt_in_out_test-project";
    window.localStorage.setItem(mockSdkStorageKey, "1");
    mockInitializedClient = client();
    mockOptOut.mockImplementationOnce(() => {
      expect(window.localStorage.getItem(mockSdkStorageKey!)).toBe("1");
    });
    const consent = await import("./tracking-consent");

    await consent.setTrackingConsent("denied");

    expect(mockOptOut).toHaveBeenCalledTimes(1);
    expect(mockLoadPostHogClient).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(mockSdkStorageKey)).toBe("0");
    expect(pixelQueue()).toBeUndefined();
  });

  it("migrates an existing grant and initializes exactly once across concurrent loads", async () => {
    mockConsentStatus.mockReturnValue("granted");
    const { loadTrackingConsent } = await import("./tracking-consent");

    expect(
      await Promise.all([loadTrackingConsent(), loadTrackingConsent()])
    ).toEqual(["granted", "granted"]);
    expect(window.localStorage.getItem(CONSENT_KEY)).toBe("1");
    expect(document.querySelectorAll(PIXEL_SELECTOR)).toHaveLength(1);
    expect(document.querySelector(PIXEL_SELECTOR)?.getAttribute("src")).toBe(
      "https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=DAJGMK3C77UCRCTVDUJG&lib=ttq"
    );
    expect(pixelQueue()?.filter(([method]) => method === "page")).toHaveLength(
      1
    );
  });

  it("initializes on acceptance without a PostHog key and preserves the choice across a reload", async () => {
    mockLoadPostHogClient.mockResolvedValue(null);
    let consent = await import("./tracking-consent");
    expect(await consent.loadTrackingConsent()).toBe("pending");
    expect(pixelQueue()).toBeUndefined();

    await consent.setTrackingConsent("granted");
    await consent.setTrackingConsent("granted");
    expect(document.querySelectorAll(PIXEL_SELECTOR)).toHaveLength(1);
    expect(pixelQueue()?.filter(([method]) => method === "page")).toHaveLength(
      1
    );

    jest.resetModules();
    resetPixel();
    consent = await import("./tracking-consent");
    expect(await consent.loadTrackingConsent()).toBe("granted");
    expect(document.querySelectorAll(PIXEL_SELECTOR)).toHaveLength(1);
  });

  it("persists refusal across reloads when PostHog is unavailable", async () => {
    mockLoadPostHogClient.mockResolvedValue(null);
    let consent = await import("./tracking-consent");
    await consent.setTrackingConsent("denied");

    jest.resetModules();
    consent = await import("./tracking-consent");
    expect(await consent.loadTrackingConsent()).toBe("denied");
    expect(document.querySelector(PIXEL_SELECTOR)).toBeNull();
    expect(pixelQueue()).toBeUndefined();
  });

  it("does not let an older SDK initialization overwrite a refusal", async () => {
    let resolveClient!: (value: ReturnType<typeof client>) => void;
    mockLoadPostHogClient.mockReturnValue(
      new Promise(resolve => {
        resolveClient = resolve;
      })
    );
    mockConsentStatus.mockReturnValue("granted");
    const consent = await import("./tracking-consent");
    const loading = consent.loadTrackingConsent();
    const declining = consent.setTrackingConsent("denied");

    expect(window.localStorage.getItem(CONSENT_KEY)).toBe("0");
    resolveClient(client());
    await declining;
    expect(await loading).toBe("denied");
    expect(mockOptOut).toHaveBeenCalledTimes(1);
    expect(mockOptIn).not.toHaveBeenCalled();
    expect(pixelQueue()).toBeUndefined();
  });

  it("makes the latest choice win while the SDK loads and revokes an already queued pixel", async () => {
    let resolveClient!: (value: ReturnType<typeof client>) => void;
    mockLoadPostHogClient.mockReturnValue(
      new Promise(resolve => {
        resolveClient = resolve;
      })
    );
    const consent = await import("./tracking-consent");
    const accepting = consent.setTrackingConsent("granted");
    const declining = consent.setTrackingConsent("denied");
    resolveClient(client());
    await Promise.all([accepting, declining]);

    expect(mockOptIn).not.toHaveBeenCalled();
    expect(mockOptOut).toHaveBeenCalledTimes(1);
    expect(pixelQueue()?.at(-1)).toEqual(["revokeConsent"]);
    expect(pixelQueue()?.some(([method]) => method === "page")).toBe(false);
    expect(await consent.loadTrackingConsent()).toBe("denied");
  });

  it("fails closed when storage cannot be read, even if PostHog reports a grant", async () => {
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    mockConsentStatus.mockReturnValue("granted");
    const consent = await import("./tracking-consent");

    expect(await consent.loadTrackingConsent()).toBe("pending");
    await expect(consent.setTrackingConsent("denied")).resolves.toBeUndefined();
    expect(await consent.loadTrackingConsent()).toBe("denied");
    expect(pixelQueue()).toBeUndefined();
  });

  it("keeps refusal in memory and removes a stale grant when storage writes fail", async () => {
    window.localStorage.setItem(CONSENT_KEY, "1");
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    const consent = await import("./tracking-consent");

    await expect(consent.setTrackingConsent("denied")).resolves.toBeUndefined();
    expect(window.localStorage.getItem(CONSENT_KEY)).toBeNull();
    expect(await consent.loadTrackingConsent()).toBe("denied");
    expect(pixelQueue()).toBeUndefined();
  });

  it("does not migrate a grant if storage becomes unavailable during SDK initialization", async () => {
    let resolveClient!: (value: ReturnType<typeof client>) => void;
    mockLoadPostHogClient.mockReturnValue(
      new Promise(resolve => {
        resolveClient = resolve;
      })
    );
    mockConsentStatus.mockReturnValue("granted");
    const consent = await import("./tracking-consent");
    const loading = consent.loadTrackingConsent();

    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    resolveClient(client());

    expect(await loading).toBe("pending");
    expect(pixelQueue()).toBeUndefined();
  });

  it("keeps the prompt usable when the SDK fails to load or read consent", async () => {
    mockLoadPostHogClient.mockRejectedValue(new Error("blocked"));
    const consent = await import("./tracking-consent");
    expect(await consent.loadTrackingConsent()).toBe("pending");

    mockLoadPostHogClient.mockResolvedValue(client());
    mockConsentStatus.mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(await consent.loadTrackingConsent()).toBe("pending");
    await expect(consent.setTrackingConsent("denied")).resolves.toBeUndefined();
    expect(await consent.loadTrackingConsent()).toBe("denied");
    expect(pixelQueue()).toBeUndefined();
  });

  it("applies a choice made without PostHog once the configured SDK is available", async () => {
    mockLoadPostHogClient.mockResolvedValue(null);
    const consent = await import("./tracking-consent");
    await consent.setTrackingConsent("denied");
    mockLoadPostHogClient.mockResolvedValue(client());
    mockConsentStatus.mockReturnValue("granted");

    expect(await consent.loadTrackingConsent()).toBe("denied");
    await Promise.resolve();
    expect(mockOptOut).toHaveBeenCalledTimes(1);
    expect(pixelQueue()).toBeUndefined();
  });

  describe("server cookie mirror", () => {
    function readConsentCookie(): string | null {
      const entry = document.cookie
        .split("; ")
        .find(part => part.startsWith(`${CONSENT_KEY}=`));
      return entry ? entry.slice(CONSENT_KEY.length + 1) : null;
    }

    beforeEach(() => {
      document.cookie = `${CONSENT_KEY}=; Path=/; Max-Age=0`;
    });

    it.each(["granted", "denied"] as const)(
      "mirrors a %s choice into the cookie the server reads",
      async choice => {
        const { setTrackingConsent } = await import("./tracking-consent");
        await setTrackingConsent(choice);
        expect(readConsentCookie()).toBe(choice);
      }
    );

    it("mirrors a choice saved before the cookie existed on the next load", async () => {
      window.localStorage.setItem(CONSENT_KEY, "0");
      const { loadTrackingConsent } = await import("./tracking-consent");

      expect(await loadTrackingConsent()).toBe("denied");
      expect(readConsentCookie()).toBe("denied");
    });

    it("writes no cookie while the visitor has not chosen", async () => {
      const { loadTrackingConsent } = await import("./tracking-consent");

      expect(await loadTrackingConsent()).toBe("pending");
      expect(readConsentCookie()).toBeNull();
    });
  });
});
