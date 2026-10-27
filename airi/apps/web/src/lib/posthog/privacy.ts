// The provider-specific log redactors do not cover browser events or replay.
// Keep one URL policy for all three SDK hooks. Routes remain useful without
// query strings/fragments, which can contain nested redirects and credentials.
export function redactPostHogUrl(value: string): string {
  const path = value.split(/[?#]/, 1)[0];
  // URL credentials are uncommon, but should never enter analytics either.
  return path.replace(/^(https?:\/\/)[^/@]+@/i, "$1");
}

const URL_PROPERTY = /(?:url|uri|href|referrer|src|action)$/i;

export function redactPostHogUrls<T>(value: T, property = ""): T {
  if (typeof value === "string") {
    return (
      URL_PROPERTY.test(property) || /^(?:https?:)?\/\//i.test(value)
        ? redactPostHogUrl(value)
        : value
    ) as T;
  }
  if (Array.isArray(value)) {
    return value.map(item => redactPostHogUrls(item, property)) as T;
  }
  if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactPostHogUrls(item, key),
      ])
    ) as T;
  }
  return value;
}

export const POSTHOG_URL_ATTRIBUTES = [
  "href",
  "src",
  "action",
  "formaction",
  "xlink:href",
];

export function maskPostHogAttribute(name: string, value: string): string {
  if (name.toLowerCase() === "value") return "[redacted]";
  return POSTHOG_URL_ATTRIBUTES.includes(name.toLowerCase())
    ? redactPostHogUrl(value)
    : value;
}
