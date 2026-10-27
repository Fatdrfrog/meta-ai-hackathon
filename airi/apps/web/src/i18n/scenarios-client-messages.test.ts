import fs from "node:fs";
import path from "node:path";
import { locales } from "./locales";
import {
  loadAnalyticsClientMessages,
  loadScenariosClientMessages,
} from "./message-loader";

const SRC = path.resolve(__dirname, "..");
const OMITTED_NAMESPACES = ["CampaignHistory", "InternalLabelsManager"];
// Every page that renders under loadScenariosClientMessages.
const SCENARIOS_CATALOG_PAGES = [
  "features/panel/scenarios/route.tsx",
  "app/panel/w/[workspaceId]/airi/page.tsx",
  "features/panel/messengers/whatsapp-templates-route.tsx",
  "features/panel/messengers/whatsapp-welcome-sequences-route.tsx",
];
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

function resolveSource(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else return null;

  const candidates = [
    base,
    ...EXTENSIONS.map(extension => `${base}${extension}`),
    ...EXTENSIONS.map(extension => path.join(base, `index${extension}`)),
  ];
  return (
    candidates.find(
      candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    ) ?? null
  );
}

function reachableSources(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = entries.map(entry => path.join(SRC, entry));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !/\.[jt]sx?$/.test(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, "utf8");
    for (const [, specifier] of source.matchAll(SPECIFIER)) {
      const resolved = resolveSource(file, specifier);
      if (resolved) queue.push(resolved);
    }
  }
  return seen;
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.[jt]sx?$/.test(entry.name) && !/\.test\./.test(entry.name)
      ? [full]
      : [];
  });
}

function namespaceReaders(namespace: string): string[] {
  const reference = new RegExp(`["'\`]${namespace}["'\`.]`);
  return sourceFiles(SRC).filter(
    file =>
      !file.startsWith(path.join(SRC, "i18n")) &&
      reference.test(fs.readFileSync(file, "utf8"))
  );
}

describe("Scenarios client catalog", () => {
  it("leaves out namespaces that no page on it renders", () => {
    const reachable = reachableSources(SCENARIOS_CATALOG_PAGES);
    expect(reachable.size).toBeGreaterThan(100);

    for (const namespace of OMITTED_NAMESPACES) {
      const readers = namespaceReaders(namespace);
      expect(readers.length).toBeGreaterThan(0);
      expect(
        readers
          .filter(reader => reachable.has(reader))
          .map(reader => path.relative(SRC, reader))
      ).toEqual([]);
    }
  });

  it.each([...locales])(
    "keeps the namespaces the Scenarios tree reads in %s",
    async locale => {
      const [scenarios, analytics] = await Promise.all([
        loadScenariosClientMessages(locale),
        loadAnalyticsClientMessages(locale),
      ]);

      expect(Object.keys(scenarios)).toEqual(
        expect.arrayContaining([
          "Scenarios",
          "CampaignScheduleEditor",
          "CsvUpload",
          "CustomerBehavior",
          "templates",
          "CampaignRecipientPicker",
          "CampaignDispatchPlanCard",
        ])
      );
      for (const namespace of OMITTED_NAMESPACES) {
        expect(scenarios).not.toHaveProperty(namespace);
      }
      expect(analytics).toHaveProperty("CampaignHistory");
    }
  );
});
