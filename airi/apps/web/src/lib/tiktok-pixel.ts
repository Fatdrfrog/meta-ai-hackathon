import type { TrackingConsent } from "@/lib/tracking-consent";

const PIXEL_ID = "DAJGMK3C77UCRCTVDUJG";
const PIXEL_URL = "https://analytics.tiktok.com/i18n/pixel/events.js";
const METHODS = [
  "page",
  "track",
  "identify",
  "instances",
  "debug",
  "on",
  "off",
  "once",
  "ready",
  "alias",
  "group",
  "enableCookie",
  "disableCookie",
  "holdConsent",
  "revokeConsent",
  "grantConsent",
] as const;
type DeferredMethods = Record<
  (typeof METHODS)[number],
  (...args: unknown[]) => void
>;
type PixelQueue = unknown[][] & DeferredMethods;
type PixelInstance = PixelQueue & { _u?: string };
type TikTokPixel = PixelQueue & {
  _i?: Record<string, PixelInstance>;
  _t?: Record<string, number>;
  _o?: Record<string, Record<string, unknown>>;
  methods: typeof METHODS;
  setAndDefer: (queue: PixelQueue, method: (typeof METHODS)[number]) => void;
  instance: (id: string) => PixelInstance;
  load: (id: string, options?: Record<string, unknown>) => void;
};
type TikTokWindow = Window & {
  TiktokAnalyticsObject?: string;
  ttq?: TikTokPixel;
};

let active = false;

export function updateTikTokConsent(consent: TrackingConsent): void {
  if (typeof window === "undefined") return;
  const browser = window as TikTokWindow;
  if (consent !== "granted") {
    if (active && browser.ttq) {
      // A refusal can arrive while the vendor SDK is still downloading. Do not
      // let its eventual initialization replay events from the earlier grant.
      if (Array.isArray(browser.ttq)) browser.ttq.splice(0);
      browser.ttq.revokeConsent();
    }
    active = false;
    return;
  }
  if (active) return;

  // Keep the original vendor queue/bootstrap, but create and load it only after
  // explicit consent. No TikTok network request is made for pending/denied.
  if (!browser.ttq) {
    const queue = [] as unknown as TikTokPixel;
    browser.TiktokAnalyticsObject = "ttq";
    browser.ttq = queue;
    queue.methods = METHODS;
    queue.setAndDefer = (target, method) => {
      target[method] = (...args) => {
        target.push([method, ...args]);
      };
    };
    for (const method of METHODS) queue.setAndDefer(queue, method);
    queue.instance = id => {
      const instance = queue._i?.[id] ?? ([] as unknown as PixelInstance);
      for (const method of METHODS) queue.setAndDefer(instance, method);
      return instance;
    };
    queue.load = (id, options = {}) => {
      const instance = [] as unknown as PixelInstance;
      instance._u = PIXEL_URL;
      (queue._i ??= {})[id] = instance;
      (queue._t ??= {})[id] = Date.now();
      (queue._o ??= {})[id] = options;
      const script = document.createElement("script");
      script.async = true;
      script.src = `${PIXEL_URL}?sdkid=${id}&lib=ttq`;
      document.head.appendChild(script);
    };
  }

  const pixel = browser.ttq;
  const initialized = Boolean(pixel._i?.[PIXEL_ID]);
  if (!initialized) pixel.load(PIXEL_ID);
  pixel.grantConsent();
  if (!initialized) pixel.page();
  active = true;
}
