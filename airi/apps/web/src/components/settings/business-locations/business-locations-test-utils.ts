import type { BusinessLocationRecord } from "@/lib/business-locations/types";
import catalog from "../../../../messages/settings/business-locations/en/page.json";

// Test helpers for the Settings → Offices components. next-intl is ESM-only,
// so each test file mocks it with nextIntlTestMock, which reads the real en
// catalog and formats the ICU it uses: {name}, plural with # and select.

type Values = Record<string, unknown>;

let testLocale = "en";

/** The locale useLocale returns, for country labels. */
export function setTestLocale(locale: string): void {
  testLocale = locale;
}

/** The text between the brace at `start` and its matching close, and where that close is. */
function readBlock(text: string, start: number): [string, number] {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return [text.slice(start + 1, index), index];
    }
  }
  throw new Error(`Unclosed brace in "${text}"`);
}

function readOptions(text: string): Map<string, string> {
  const options = new Map<string, string>();
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("{", index);
    if (open < 0) break;
    const selector = text.slice(index, open).trim();
    const [body, close] = readBlock(text, open);
    options.set(selector, body);
    index = close + 1;
  }
  return options;
}

/** A small ICU formatter: enough for the Offices catalog, not a full one. */
export function formatTestMessage(
  message: string,
  values: Values = {}
): string {
  let output = "";
  let index = 0;
  while (index < message.length) {
    if (message[index] !== "{") {
      output += message[index];
      index += 1;
      continue;
    }
    const [body, close] = readBlock(message, index);
    index = close + 1;
    const match = /^\s*(\w+)\s*(?:,\s*(plural|select)\s*,([\s\S]*))?$/.exec(
      body
    );
    if (!match) throw new Error(`Unreadable argument "{${body}}"`);
    const [, name, kind, rest] = match;
    if (!(name in values)) throw new Error(`Missing value "${name}"`);
    const value = values[name];
    if (!kind) {
      output += String(value);
      continue;
    }
    const options = readOptions(rest);
    const count = Number(value);
    const selector =
      kind === "plural"
        ? options.has(`=${count}`)
          ? `=${count}`
          : count === 1 && options.has("one")
            ? "one"
            : "other"
        : options.has(String(value))
          ? String(value)
          : "other";
    const branch = options.get(selector) ?? "";
    output += formatTestMessage(
      kind === "plural" ? branch.replace(/#/g, String(count)) : branch,
      values
    );
  }
  return output;
}

function readCatalogMessage(key: string): string {
  const value = key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      catalog.BusinessLocationsSettings
    );
  if (typeof value !== "string") throw new Error(`Missing message "${key}"`);
  return value;
}

/** The translator useTranslations returns: real en copy for Offices, the key elsewhere. */
export function createTestTranslator(namespace: string) {
  return (key: string, values?: Values) =>
    namespace === "BusinessLocationsSettings"
      ? formatTestMessage(readCatalogMessage(key), values)
      : `${namespace}.${key}`;
}

/** Pass as `jest.mock("next-intl", () => jest.requireActual(...).nextIntlTestMock)`. */
export const nextIntlTestMock = {
  useTranslations: (namespace: string) => createTestTranslator(namespace),
  useLocale: () => testLocale,
};

/** An office as GET returns it; Almaty by default. */
export function createOfficeRecord(
  overrides: Partial<BusinessLocationRecord> = {}
): BusinessLocationRecord {
  return {
    key: "kz_almaty_abay",
    name: "Abay Avenue",
    country: "KZ",
    city: "Almaty",
    cityKey: "almaty",
    address: "Abay Ave 10",
    phone: "+7 727 000 00 00",
    tags: ["mall"],
    latitude: 43.238949,
    longitude: 76.889709,
    sortOrder: 0,
    isActive: true,
    updatedAt: "2026-10-05T00:00:00.000Z",
    ...overrides,
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** jsdom lacks what Radix popovers and cmdk measure and scroll with. */
export function installDomPolyfills(): void {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverMock,
  });
  const noop = (): void => {};
  for (const [name, value] of Object.entries({
    scrollIntoView: noop,
    hasPointerCapture: (): boolean => false,
    setPointerCapture: noop,
    releasePointerCapture: noop,
  })) {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      value,
    });
  }
}
