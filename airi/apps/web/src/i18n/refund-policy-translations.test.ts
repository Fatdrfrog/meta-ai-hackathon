import fs from "node:fs";
import path from "node:path";
import { locales } from "./locales";

type FlatMessages = Record<string, string>;

function flattenMessages(value: unknown, prefix = "", out: FlatMessages = {}) {
  if (typeof value === "string") {
    out[prefix] = value;
    return out;
  }

  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) =>
      flattenMessages(item, prefix ? `${prefix}.${key}` : key, out)
    );
  }

  return out;
}

function readRefundPolicyMessages(locale: string) {
  const filePath = path.join(
    process.cwd(),
    "messages",
    "legal",
    "refunds",
    locale,
    "page.json"
  );
  return flattenMessages(JSON.parse(fs.readFileSync(filePath, "utf8")));
}

function interpolationTokens(value: string) {
  return [...value.matchAll(/<\/?[a-z]+>|\{[a-zA-Z]+\}/g)]
    .map(match => match[0])
    .sort();
}

describe("refund policy translations", () => {
  const en = readRefundPolicyMessages("en");

  it.each(locales.filter(locale => locale !== "en"))(
    "%s has the same keys as en",
    locale => {
      expect(Object.keys(readRefundPolicyMessages(locale)).sort()).toEqual(
        Object.keys(en).sort()
      );
    }
  );

  it.each(locales.filter(locale => locale !== "en"))(
    "%s keeps every placeholder and link tag from en",
    locale => {
      const messages = readRefundPolicyMessages(locale);

      for (const [key, value] of Object.entries(en)) {
        expect([key, interpolationTokens(messages[key] ?? "")]).toEqual([
          key,
          interpolationTokens(value),
        ]);
      }
    }
  );

  it.each(locales.filter(locale => locale !== "en"))(
    "%s is actually translated",
    locale => {
      const messages = readRefundPolicyMessages(locale);
      const untranslated = Object.entries(en)
        .filter(([key, value]) => messages[key] === value)
        .map(([key]) => key);

      expect(untranslated).toEqual([]);
    }
  );
});
