import fs from "node:fs";
import path from "node:path";
import {
  preloadScenarioIdleChunks,
  preloadScenarioOpenChunks,
  preloadScenarioSummaryChunks,
  scenarioEditorChunks,
} from "./scenario-editor-chunks";

type ChunkName = keyof typeof scenarioEditorChunks;

const SRC_ROOT = path.resolve(__dirname, "../..");
const REGISTRY_FILE = path.join(__dirname, "scenario-editor-chunks.ts");

function withoutExtension(file: string) {
  return file.replace(/\.(tsx?|jsx?)$/, "").replace(/[\\/]index$/, "");
}

function resolveSpecifier(fromFile: string, specifier: string) {
  if (specifier.startsWith("@/")) {
    return withoutExtension(path.join(SRC_ROOT, specifier.slice(2)));
  }
  if (specifier.startsWith(".")) {
    return withoutExtension(path.resolve(path.dirname(fromFile), specifier));
  }
  return null;
}

function listSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : listSourceFiles(full);
    }
    return /\.(tsx?)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [full]
      : [];
  });
}

/** Import and re-export declarations that load a module at runtime. */
function listRuntimeImports(source: string): string[] {
  const statements = source.matchAll(
    /^\s*(?:import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/gm
  );
  const imports: string[] = [];
  for (const [, typeOnly, clause, specifier] of statements) {
    const named = clause.match(/^\{([\s\S]*)\}$/);
    const onlyTypes =
      Boolean(typeOnly) ||
      (named !== null &&
        named[1]
          .split(",")
          .map(part => part.trim())
          .filter(Boolean)
          .every(part => part.startsWith("type ")));
    if (!onlyTypes) imports.push(specifier);
  }
  return imports;
}

const lazyModules = new Set(
  [
    ...fs
      .readFileSync(REGISTRY_FILE, "utf8")
      .matchAll(/import\(\s*["']([^"']+)["']\s*\)/g),
  ].map(([, specifier]) => resolveSpecifier(REGISTRY_FILE, specifier)!)
);

describe("scenario editor chunks", () => {
  it("lists every lazily loaded editor", () => {
    expect(lazyModules.size).toBe(Object.keys(scenarioEditorChunks).length);
  });

  it("keeps lazily loaded editors out of every static import", () => {
    // A single static import pulls the module (TipTap, the campaign editor,
    // react-hook-form...) back into the Scenarios page's first load.
    const violations = listSourceFiles(SRC_ROOT).flatMap(file => {
      if (lazyModules.has(withoutExtension(file))) return [];
      return listRuntimeImports(fs.readFileSync(file, "utf8"))
        .map(specifier => resolveSpecifier(file, specifier))
        .filter(target => target !== null && lazyModules.has(target))
        .map(
          target =>
            `${path.relative(SRC_ROOT, file)} -> ${path.relative(SRC_ROOT, target!)}`
        );
    });
    expect(violations).toEqual([]);
  });
});

describe("scenario editor warm-up", () => {
  let preloaded: ChunkName[];

  beforeEach(() => {
    preloaded = [];
    for (const name of Object.keys(scenarioEditorChunks) as ChunkName[]) {
      jest
        .spyOn(scenarioEditorChunks[name], "preload")
        .mockImplementation(() => {
          preloaded.push(name);
        });
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("starts the message and service message editors with the page", () => {
    preloadScenarioOpenChunks();
    expect(preloaded).toEqual([
      "whatsAppInlineEditor",
      "whatsAppServiceMessageSection",
    ]);
  });

  it.each([
    [{ mode: "bulk_campaign" as const }, ["bulkRootNode"]],
    [
      { primaryActionType: "whatsapp_template" as const },
      ["whatsAppTemplateSection"],
    ],
    [{ primaryActionType: "generative_ai" as const }, ["generativeAISection"]],
    [
      { mode: "conversation" as const, primaryActionType: "reply" as const },
      [],
    ],
  ])(
    "starts the editors a scenario's list entry calls for (%o)",
    (summary, expected) => {
      preloadScenarioSummaryChunks(summary);
      expect(preloaded).toEqual(expected);
    }
  );

  it("fetches the remaining editors when idle, and action settings only with the panel", () => {
    preloadScenarioIdleChunks({ nodeSettingsPanel: false });
    expect(preloaded).toEqual(
      expect.arrayContaining([
        "createTypeDialog",
        "nodePaletteMenu",
        "triggerNodeSettings",
        "whatsAppTemplateSection",
        "generativeAISection",
        "telegramReplyBuilder",
        "bulkRootNode",
      ])
    );
    expect(preloaded).not.toContain("actionNodeSettings");

    preloaded = [];
    preloadScenarioIdleChunks({ nodeSettingsPanel: true });
    expect(preloaded).toContain("actionNodeSettings");
  });

  it("also fetches the panels and dialogs a click opens when idle", () => {
    // Downloaded ahead, a later click cannot fail on a dropped connection.
    preloadScenarioIdleChunks({ nodeSettingsPanel: false });
    expect(preloaded).toEqual(
      expect.arrayContaining([
        "previewDrawer",
        "activationImpactDialog",
        "linkedFlowPreviewDialog",
        "triggerLogPanel",
      ])
    );
  });
});
