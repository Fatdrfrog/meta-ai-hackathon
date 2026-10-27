import fs from "node:fs";
import path from "node:path";

const locales = ["en", "ru", "kz"] as const;

function readMetaAdsMessages(locale: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(
      path.join(
        process.cwd(),
        `messages/settings/integrations/${locale}/page.json`
      ),
      "utf8"
    )
  ).MetaAdsIntegration;
}

function leafKeys(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") return [prefix];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key)
  );
}

describe("Meta Ads integration translations", () => {
  const englishKeys = leafKeys(readMetaAdsMessages("en")).sort();

  it.each(locales)("provides the read-only diagnostic copy in %s", locale => {
    const messages = readMetaAdsMessages(locale);
    expect(messages).toHaveProperty(
      "mcp.states.readOnly.title",
      expect.any(String)
    );
    expect(messages).toHaveProperty(
      "mcp.states.readOnly.description",
      expect.any(String)
    );
  });

  it.each(locales)("keeps every MetaAdsIntegration leaf key in %s", locale => {
    expect(leafKeys(readMetaAdsMessages(locale)).sort()).toEqual(englishKeys);
  });
});
