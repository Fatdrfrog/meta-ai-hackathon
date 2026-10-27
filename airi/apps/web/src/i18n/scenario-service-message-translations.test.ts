import fs from "node:fs";
import path from "node:path";
import { WHATSAPP_SERVICE_MESSAGE_CENTRALIZED_LABEL_KEYS } from "@/components/scenarios/builders/whatsapp/service-message/service-message-labels";

const LOCALES = ["en", "ru", "kz"] as const;
const SERVICE_MESSAGE_DIR = path.resolve(
  __dirname,
  "../components/scenarios/builders/whatsapp/service-message"
);
const T_KEY_RE = /\bt\(\s*["']([^"']+)["']\s*\)/g;

function collectServiceMessageTranslationKeys(): string[] {
  const keys = new Set<string>(WHATSAPP_SERVICE_MESSAGE_CENTRALIZED_LABEL_KEYS);

  for (const entry of fs.readdirSync(SERVICE_MESSAGE_DIR)) {
    if (!/\.(ts|tsx)$/.test(entry) || /\.test\.(ts|tsx)$/.test(entry)) {
      continue;
    }

    const source = fs.readFileSync(
      path.join(SERVICE_MESSAGE_DIR, entry),
      "utf8"
    );
    for (const match of source.matchAll(T_KEY_RE)) {
      keys.add(match[1]);
    }
  }

  return [...keys].sort();
}

function loadScenariosMessages(locale: (typeof LOCALES)[number]) {
  const filePath = path.join(
    process.cwd(),
    "messages",
    "scenarios",
    locale,
    "page.json"
  );
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
    Scenarios?: Record<string, unknown>;
  };
  return parsed.Scenarios ?? {};
}

describe("scenario service-message translations", () => {
  it("keeps every service-message t() and centralized label key in en/ru/kz", () => {
    const keys = collectServiceMessageTranslationKeys();
    expect(keys.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const locale of LOCALES) {
      const scenarios = loadScenariosMessages(locale);
      for (const key of keys) {
        if (!(key in scenarios) || typeof scenarios[key] !== "string") {
          missing.push(`${locale}:${key}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
