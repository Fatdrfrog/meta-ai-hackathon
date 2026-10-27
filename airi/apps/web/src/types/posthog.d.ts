type PostHogBrowserClient = (typeof import("posthog-js"))["default"];

declare global {
  interface Window {
    posthog?: PostHogBrowserClient;
  }
}

export {};
