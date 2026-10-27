import fs from "node:fs";
import path from "node:path";

type FlatMessages = Record<string, string>;

function flattenMessages(value: unknown, prefix = "", out: FlatMessages = {}) {
  if (typeof value === "string") {
    out[prefix] = value;
    return out;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      flattenMessages(item, prefix ? `${prefix}.${index}` : String(index), out)
    );
    return out;
  }

  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) =>
      flattenMessages(item, prefix ? `${prefix}.${key}` : key, out)
    );
  }

  return out;
}

function readJson(relativePath: string) {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), relativePath), "utf8")
  ) as unknown;
}

function pickWabaSelectionMessages(messages: unknown) {
  return Object.entries(flattenMessages(messages)).filter(([key]) =>
    key.startsWith("WABASelection.")
  );
}

describe("WhatsApp settings translations", () => {
  it("ships the same complete shared history status catalog in every locale", () => {
    const catalogs = ["en", "ru", "kz"].map(
      locale =>
        (readJson(`messages/${locale}.json`) as Record<string, unknown>)
          .WhatsAppHistorySync as Record<string, string>
    );
    for (const catalog of catalogs) {
      expect(Object.keys(catalog).sort()).toEqual(
        Object.keys(catalogs[0]).sort()
      );
      expect(
        Object.values(catalog).every(
          value =>
            typeof value === "string" &&
            value.trim().length > 0 &&
            !/[?]{3,}/.test(value)
        )
      ).toBe(true);
      expect(catalog.providerProgress).toContain("{progress}");
      expect(catalog.savedCount).toContain("{count");
    }
  });
  it("does not contain replacement question-mark blocks in WABA selection copy", () => {
    const broken: string[] = [];

    for (const locale of ["ru", "kz"]) {
      for (const relativePath of [
        `messages/${locale}.json`,
        `messages/settings/integrations/${locale}/page.json`,
      ]) {
        for (const [key, value] of pickWabaSelectionMessages(
          readJson(relativePath)
        )) {
          if (/[?]{3,}/.test(value)) {
            broken.push(`${relativePath}:${key}`);
          }
        }
      }
    }

    expect(broken).toEqual([]);
  });
});
