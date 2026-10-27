import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const contractModule = await import("./verify-dependency-direction.mjs").catch(
  () => ({}),
);

function requireExport(name) {
  assert.equal(
    typeof contractModule[name],
    "function",
    `verify-dependency-direction.mjs must export ${name}`,
  );
  return contractModule[name];
}

function withTemporaryDirectory(callback) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "dependency-direction-"),
  );
  try {
    return callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function writeFile(directory, relativePath, contents = "export {};\n") {
  const filePath = path.join(directory, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function writeVerificationManifests(directory, mutateTurbo = () => {}) {
  writeFile(
    directory,
    "apps/web/package.json",
    JSON.stringify({
      scripts: {
        "check-types": "tsc --noEmit --project tsconfig.build.json",
        "type-check": "pnpm run check-types",
      },
    }),
  );
  writeFile(
    directory,
    "package.json",
    JSON.stringify({
      scripts: {
        "verify:dependency-direction":
          "node .github/scripts/verify-dependency-direction.mjs",
        "check-types":
          "pnpm run verify:dependency-direction && turbo run check-types",
      },
    }),
  );
  const turbo = {
    tasks: Object.fromEntries(
      [
        "@icecore/airi-runtime#check-types",
        "@icecore/airi-runtime#test",
        "@icecore/temporal-worker#check-types",
        "@icecore/temporal-worker#test",
      ].map((taskName) => [
        taskName,
        { inputs: ["$TURBO_DEFAULT$", "$TURBO_ROOT$/apps/web/src/**"] },
      ]),
    ),
  };
  mutateTurbo(turbo);
  writeFile(directory, "turbo.json", JSON.stringify(turbo));
}

function writeManifestScript(directory, manifestPath, scriptName, command) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, manifestPath), "utf8"),
  );
  manifest.scripts[scriptName] = command;
  writeFile(directory, manifestPath, JSON.stringify(manifest));
}

test("scenario boundary rejects editor type imports from transport and bulk routing", async (t) => {
  const verify = requireExport("verifyRepositoryDependencyContract");
  for (const file of [
    "apps/web/src/lib/scenarios/client/http.ts",
    "apps/web/src/lib/scenarios/bulk-column-split-routing.ts",
  ]) {
    await t.test(file, () => {
      withTemporaryDirectory((directory) => {
        writeVerificationManifests(directory);
        writeFile(
          directory,
          file,
          'import type { ScenarioFlowNode } from "@/components/scenarios/types";\n',
        );
        assert.throws(
          () => verify(directory),
          (error) =>
            error instanceof assert.AssertionError &&
            JSON.stringify(error.actual).includes(file),
        );
      });
    });
  }
});

test("scenario persistence and serialization reject transport and database imports", async (t) => {
  const verify = requireExport("verifyRepositoryDependencyContract");
  for (const file of [
    "apps/web/src/lib/scenarios/scenario-graph-persistence.ts",
    "apps/web/src/lib/scenarios/scenario-serialization.ts",
    "apps/web/src/lib/scenarios/scenario-summary-serialization.ts",
  ]) {
    for (const specifier of [
      "next/server",
      "next/headers",
      "@/lib/supabase/workspace-api-access",
      "@/lib/scenarios/scenario-http",
      "@/lib/scenarios/api-shared",
      "@/models/scenario",
      "@/lib/mongoose",
      "mongoose",
      "@icecore/airi-runtime/mongoose",
      "../supabase/server.ts",
    ]) {
      await t.test(`${file}: ${specifier}`, () => {
        withTemporaryDirectory((directory) => {
          writeVerificationManifests(directory);
          writeFile(directory, file, `import "${specifier}";\n`);
          assert.throws(
            () => verify(directory),
            (error) =>
              error instanceof assert.AssertionError &&
              Array.isArray(error.actual) &&
              error.actual.some(
                (reference) =>
                  reference.file === file && reference.specifier === specifier,
              ),
          );
        });
      });
    }
  }
});

test("scenario presentation rejects server effects in every module-reference form", async (t) => {
  const verify = requireExport("assertScenarioPresentationImports");
  const file = "apps/web/src/components/scenarios/view/use-future-provider.tsx";
  const cases = [
    ["next/server", 'import { NextResponse } from "next/server";'],
    ["next/server.js", 'import { NextResponse } from "next/server.js";'],
    ["next/headers", 'import { cookies } from "next/headers";'],
    ["server-only", 'import "server-only";'],
    ["mongoose", 'import type { Document } from "mongoose";'],
    ["mongodb", 'type Client = import("mongodb").MongoClient;'],
    ["mongoose/lib/model", 'export { default } from "mongoose/lib/model";'],
    [
      "@icecore/airi-runtime/mongoose",
      'import db from "@icecore/airi-runtime/mongoose";',
    ],
    [
      "../../../models/scenario.ts",
      'import { Scenario } from "../../../models/scenario.ts";',
    ],
    ["@/models/scenario", 'await import("@/models/scenario");'],
    [
      "../../../app/api/scenarios/route.ts",
      'await import("../../../app/api/scenarios/route.ts");',
    ],
    [
      "@/app/api/scenarios/route",
      'export type { GET } from "@/app/api/scenarios/route";',
    ],
    ["@/lib/mongoose", 'import db = require("@/lib/mongoose");'],
    ["@/lib/mongo", 'require("@/lib/mongo");'],
    [
      "@/lib/supabase/../supabase/admin.ts",
      'import { supabaseAdmin } from "@/lib/supabase/../supabase/admin.ts";',
    ],
    [
      "../../../lib/supabase/server.ts",
      'import * as auth from "../../../lib/supabase/server.ts";',
    ],
    [
      "@/lib/supabase/workspace-api-access",
      'import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";',
    ],
    [
      "@/lib/scenarios/scenario-create",
      'import { createScenario } from "@/lib/scenarios/scenario-create";',
    ],
    [
      "@/lib/scenarios/scenario-save",
      'require("@/lib/scenarios/scenario-save");',
    ],
    [
      "@/lib/scenarios/scenario-delete",
      'await import("@/lib/scenarios/scenario-delete");',
    ],
    [
      "@/lib/scenarios/scenario-detail",
      'export * from "@/lib/scenarios/scenario-detail";',
    ],
    [
      "@/lib/scenarios/linked-condition-repository",
      'import type { Record } from "@/lib/scenarios/linked-condition-repository";',
    ],
    [
      "@/lib/scenarios/scenario-graph-mutation",
      'await import("@/lib/scenarios/scenario-graph-mutation");',
    ],
    [
      "@/features/panel/scenarios/server",
      'import { loadScenariosPage } from "@/features/panel/scenarios/server";',
    ],
    [
      "@/lib/airi/scenario/scenario-runtime",
      'import { resolveActiveScenarioRuntime } from "@/lib/airi/scenario/scenario-runtime";',
    ],
    [
      "../../../lib/airi/scenario/auto-reply-runtime-dependencies.ts",
      'import { scenarioRuntimeDependencies } from "../../../lib/airi/scenario/auto-reply-runtime-dependencies.ts";',
    ],
    [
      "@/lib/airi/scenario/timer-runtime-dependencies",
      'await import("@/lib/airi/scenario/timer-runtime-dependencies");',
    ],
    [
      "<non-literal>",
      'const owner = "@/models/scenario"; await import(owner);',
    ],
  ];

  for (const [specifier, source] of cases) {
    await t.test(specifier, () => {
      withTemporaryDirectory((directory) => {
        writeFile(directory, file, `${source}\n`);
        assert.throws(
          () => verify(directory),
          (error) =>
            error instanceof assert.AssertionError &&
            Array.isArray(error.actual) &&
            error.actual.some(
              (reference) =>
                reference.file === file && reference.specifier === specifier,
            ),
        );
      });
    });
  }
});

test("scenario presentation permits new hook owners, pure helpers and client boundaries", () => {
  const verify = requireExport("assertScenarioPresentationImports");
  withTemporaryDirectory((directory) => {
    writeFile(
      directory,
      "apps/web/src/components/scenarios/future/use-new-capability.ts",
      [
        'import { useState } from "react";',
        'import dynamic from "next/dynamic";',
        'import { useRouter } from "next/navigation";',
        'import { useNodesState } from "@xyflow/react";',
        'import type { ScenarioDocumentDTO } from "@icecore/scenario-contracts";',
        'import type { AiriScenarioRuntimeConfig } from "@icecore/airi-runtime/scenario-runtime-types";',
        'import type { ScenarioRuntimeDependencies } from "@icecore/airi-runtime/scenario-runtime-dependencies";',
        'import { normalizeScenarioPriority } from "@/lib/scenarios/normalization";',
        'import { serializeScenarioSummary } from "@/lib/scenarios/scenario-summary-serialization";',
        'import { fetchScenario } from "@/lib/scenarios/client";',
        'import { createClient } from "@/lib/supabase/client";',
        'import { loadRegisteredBusinessPhonesAudienceAction } from "@/features/panel/scenarios/actions";',
        'const panel = dynamic(() => import("./new-panel"));',
      ].join("\n"),
    );
    writeFile(
      directory,
      "apps/web/src/components/scenarios/future/new-panel.tsx",
      "export const Panel = () => null;\n",
    );
    writeFile(
      directory,
      "apps/web/src/components/scenarios/future/use-new-capability.test.ts",
      'jest.mock("@/models/scenario");\n',
    );

    assert.doesNotThrow(() => verify(directory));
  });
});

test("repository verification enforces the scenario presentation boundary", () => {
  const verify = requireExport("verifyRepositoryDependencyContract");
  withTemporaryDirectory((directory) => {
    writeVerificationManifests(directory);
    const file = "apps/web/src/components/scenarios/view/new-panel.tsx";
    writeFile(
      directory,
      file,
      'import { Scenario } from "@/models/scenario";\n',
    );
    assert.throws(
      () => verify(directory),
      (error) =>
        error instanceof assert.AssertionError &&
        Array.isArray(error.actual) &&
        error.actual.some((reference) => reference.file === file),
    );
  });
});

test("scanner follows namespaced createRequire and immediately invoked factories", () => {
  const collectModuleReferences = requireExport("collectModuleReferences");
  const collectAiriRuntimeWebModules = requireExport(
    "collectAiriRuntimeWebModules",
  );
  const source = [
    'import * as nodeModule from "node:module";',
    'import * as interop from "./internal/module-interop";',
    "const { createRequire: make } = nodeModule;",
    "const copied = nodeModule.createRequire;",
    "const loadNs = nodeModule.createRequire(import.meta.url);",
    'loadNs("../../../apps/web/src/lib/namespaced");',
    'copied(import.meta.url)("../../../apps/web/src/lib/copied");',
    'make(import.meta.url)("../../../apps/web/src/lib/destructured");',
    'interop.createWebRequire(import.meta.url)("../../../apps/web/src/lib/iife");',
    'nodeModule["createRequire"](import.meta.url)("../../../apps/web/src/lib/element");',
    '(0, nodeModule.createRequire)(import.meta.url)("../../../apps/web/src/lib/comma");',
    'loadNs.resolve("../../../apps/web/src/lib/resolved");',
  ].join("\n");

  assert.deepEqual(
    collectModuleReferences(source, "fixture.ts").map(
      ({ specifier, kind }) => `${kind}:${specifier}`,
    ),
    [
      "static:node:module",
      "static:./internal/module-interop",
      "loadNs:../../../apps/web/src/lib/namespaced",
      "factory-require:../../../apps/web/src/lib/copied",
      "factory-require:../../../apps/web/src/lib/destructured",
      "factory-require:../../../apps/web/src/lib/iife",
      "factory-require:../../../apps/web/src/lib/element",
      "factory-require:../../../apps/web/src/lib/comma",
      "require.resolve:../../../apps/web/src/lib/resolved",
    ],
  );

  withTemporaryDirectory((directory) => {
    writeFile(
      directory,
      "packages/airi-runtime/src/runtime.ts",
      [
        'import * as nodeModule from "node:module";',
        "const loadWeb = nodeModule.createRequire(import.meta.url);",
        'loadWeb("../../../apps/web/src/lib/hidden-web");',
      ].join("\n"),
    );
    assert.deepEqual(
      [...collectAiriRuntimeWebModules(directory)],
      [
        [
          "packages/airi-runtime/src/runtime.ts",
          ["apps/web/src/lib/hidden-web"],
        ],
      ],
    );
  });
});

test("scanner follows createRequire aliases and flags non-literal loaders", () => {
  const collectModuleReferences = requireExport("collectModuleReferences");
  const source = [
    'import { createRequire as makeRequire } from "node:module";',
    'import { createWebRequire as makeWeb } from "./internal/module-interop";',
    "function loadHidden() {",
    '  return loadWeb("../../../apps/web/src/lib/hidden");',
    "}",
    "const loadWeb = makeRequire(import.meta.url) as NodeRequire;",
    "const requireWeb = makeWeb(import.meta.url);",
    "const skipped = loadWeb(dynamicId);",
    'const local = loadWeb("./internal/local");',
  ].join("\n");

  assert.deepEqual(
    collectModuleReferences(source, "fixture.ts").map(
      ({ specifier, kind }) => `${kind}:${specifier}`,
    ),
    [
      "static:node:module",
      "static:./internal/module-interop",
      "loadWeb:../../../apps/web/src/lib/hidden",
      "non-literal-require:<non-literal>",
      "loadWeb:./internal/local",
    ],
  );
});

test("scanner detects module syntax and runtime loader calls", () => {
  const collectModuleReferences = requireExport("collectModuleReferences");
  const source = [
    'import "@/side-effect";',
    'import value from "@/default";',
    'import * as values from "@/namespace";',
    'import type { Model } from "@/type-only";',
    'export { exported } from "@/exported";',
    'import legacy = require("@/import-equals");',
    'type DynamicType = typeof import("@/import-type");',
    'const dynamicValue = import("@/dynamic");',
    'const required = require("@/required");',
    'const resolved = require.resolve("@/resolved");',
    'const loaded = requireWeb("../../../apps/web/src/lib/runtime");',
    'jest.mock("@/mocked");',
    '// import ignored from "@/comment";',
    'const plain = "@/plain-string";',
  ].join("\n");

  assert.deepEqual(
    collectModuleReferences(source, "fixture.ts").map(
      ({ specifier }) => specifier,
    ),
    [
      "@/side-effect",
      "@/default",
      "@/namespace",
      "@/type-only",
      "@/exported",
      "@/import-equals",
      "@/import-type",
      "@/dynamic",
      "@/required",
      "@/resolved",
      "../../../apps/web/src/lib/runtime",
      "@/mocked",
    ],
  );
});

test("scanner records computed dynamic imports as unresolved loads", () => {
  const collectModuleReferences = requireExport("collectModuleReferences");
  const source = [
    'const modulePath = "@/models/scenario";',
    "await import(modulePath);",
    'await import("@/models/" + modelName);',
    "await import(`@/models/${modelName}`);",
    "await import(`@/models/scenario`);",
  ].join("\n");

  assert.deepEqual(collectModuleReferences(source, "fixture.ts"), [
    { specifier: "<non-literal>", line: 2, kind: "non-literal-import" },
    { specifier: "<non-literal>", line: 3, kind: "non-literal-import" },
    { specifier: "<non-literal>", line: 4, kind: "non-literal-import" },
    { specifier: "@/models/scenario", line: 5, kind: "dynamic-import" },
  ]);
});

test("computed dynamic imports consume runtime and worker reverse budgets", () => {
  const buildDependencyDebtSnapshot = requireExport(
    "buildDependencyDebtSnapshot",
  );
  const assertPerFileBudget = requireExport("assertPerFileBudget");
  withTemporaryDirectory((directory) => {
    const runtimeFile = "packages/airi-runtime/src/runtime.ts";
    const workerFile = "apps/temporal-worker/src/activity.ts";
    for (const file of [runtimeFile, workerFile]) {
      writeFile(
        directory,
        file,
        'const modulePath = "@/models/scenario"; import(modulePath);\n',
      );
    }
    const snapshot = buildDependencyDebtSnapshot(directory);
    assert.deepEqual([...snapshot.airiRuntimeWeb], [[runtimeFile, 1]]);
    assert.deepEqual([...snapshot.temporalWorkerWeb], [[workerFile, 1]]);
    for (const observed of [
      snapshot.airiRuntimeWeb,
      snapshot.temporalWorkerWeb,
    ]) {
      assert.throws(
        () =>
          assertPerFileBudget({
            label: "computed import debt",
            observed,
            allowed: {},
          }),
        /has 1 reference; allowed 0/,
      );
    }
  });
});

test("scanner records source lines and supports vi mock calls", () => {
  const collectModuleReferences = requireExport("collectModuleReferences");
  assert.deepEqual(
    collectModuleReferences('\nvi.mock("@/mocked");', "fixture.ts"),
    [{ specifier: "@/mocked", line: 2, kind: "test-mock" }],
  );
});

test("test-only path detection excludes fixtures and test directories", () => {
  const isTestOnlySourcePath = requireExport("isTestOnlySourcePath");
  assert.equal(isTestOnlySourcePath("src/runtime.ts"), false);
  assert.equal(isTestOnlySourcePath("src/runtime.test.ts"), true);
  assert.equal(isTestOnlySourcePath("src/runtime.spec.tsx"), true);
  assert.equal(isTestOnlySourcePath("src/runtime.type-test.ts"), true);
  assert.equal(isTestOnlySourcePath("src/__tests__/runtime.ts"), true);
  assert.equal(isTestOnlySourcePath("src/__fixtures__/runtime.ts"), true);
  assert.equal(isTestOnlySourcePath("src/test/runtime.ts"), true);
  assert.equal(isTestOnlySourcePath("src/tests/runtime.ts"), true);
  assert.equal(isTestOnlySourcePath("src\\tests\\runtime.ts"), true);
});

test("production source collection is sorted and excludes tests and build outputs", () => {
  const collectProductionSourceFiles = requireExport(
    "collectProductionSourceFiles",
  );
  withTemporaryDirectory((directory) => {
    writeFile(directory, "src/z.ts");
    writeFile(directory, "src/a.tsx");
    writeFile(directory, "src/a.test.ts");
    writeFile(directory, "src/contract.type-test.ts");
    writeFile(directory, "src/tests/helper.ts");
    writeFile(directory, "node_modules/pkg/index.ts");
    writeFile(directory, ".next/generated.ts");
    const files = collectProductionSourceFiles(directory).map((file) =>
      path.relative(directory, file).replaceAll("\\", "/"),
    );
    assert.deepEqual(files, ["src/a.tsx", "src/z.ts"]);
    assert.equal(
      collectProductionSourceFiles(directory, { includeTests: true }).length,
      5,
    );
  });
});

test("production source collection ignores test-named ancestor directories", () => {
  const collectProductionSourceFiles = requireExport(
    "collectProductionSourceFiles",
  );
  withTemporaryDirectory((directory) => {
    const scanRoot = path.join(directory, "tests", "nested-checkout");
    writeFile(scanRoot, "src/runtime.ts");
    writeFile(scanRoot, "src/tests/helper.ts");

    assert.deepEqual(
      collectProductionSourceFiles(scanRoot).map((file) =>
        path.relative(scanRoot, file).replaceAll("\\", "/"),
      ),
      ["src/runtime.ts"],
    );
  });
});

test("module resolution returns normalized repository-relative source paths", () => {
  const resolveModuleReference = requireExport("resolveModuleReference");
  withTemporaryDirectory((directory) => {
    const sourcePath = path.join(
      directory,
      "packages/runtime/src/feature/file.ts",
    );
    assert.equal(
      resolveModuleReference(directory, sourcePath, "@/lib/value"),
      "apps/web/src/lib/value",
    );
    assert.equal(
      resolveModuleReference(directory, sourcePath, "@/./components/value"),
      "apps/web/src/components/value",
    );
    assert.equal(
      resolveModuleReference(
        directory,
        sourcePath,
        "@/lib/../components/value",
      ),
      "apps/web/src/components/value",
    );
    assert.equal(
      resolveModuleReference(directory, sourcePath, "apps/web/src"),
      "apps/web/src",
    );
    assert.equal(
      resolveModuleReference(directory, sourcePath, "apps/web/src/lib/value"),
      "apps/web/src/lib/value",
    );
    assert.equal(
      resolveModuleReference(
        directory,
        sourcePath,
        "../../../apps/web/src/lib/value",
      ),
      "packages/apps/web/src/lib/value",
    );
    assert.equal(resolveModuleReference(directory, sourcePath, "react"), null);
  });
});

test("forbidden reference collection resolves paths, filters exclusions, and sorts", () => {
  const collectForbiddenModuleReferences = requireExport(
    "collectForbiddenModuleReferences",
  );
  withTemporaryDirectory((directory) => {
    writeFile(directory, "apps/web/src/a.ts", 'import "@/excluded";\n');
    writeFile(
      directory,
      "apps/web/src/a.ts-helper.ts",
      'import "@/similarly-prefixed";\n',
    );
    writeFile(
      directory,
      "apps/web/src/client/allowed.ts",
      'import "@/directory-excluded";\n',
    );
    writeFile(directory, "apps/web/src/z.ts", 'import "@/forbidden";\n');
    writeFile(directory, "apps/web/src/z.test.ts", 'import "@/test-only";\n');
    assert.deepEqual(
      collectForbiddenModuleReferences({
        repoRoot: directory,
        relativeRoots: ["apps/web/src"],
        excludedPrefixes: ["apps/web/src/a.ts", "apps/web/src/client/"],
        isForbidden: ({ specifier }) => specifier.startsWith("@/"),
      }),
      [
        {
          file: "apps/web/src/a.ts-helper.ts",
          line: 1,
          specifier: "@/similarly-prefixed",
          resolvedPath: "apps/web/src/similarly-prefixed",
        },
        {
          file: "apps/web/src/z.ts",
          line: 1,
          specifier: "@/forbidden",
          resolvedPath: "apps/web/src/forbidden",
        },
      ],
    );
  });
});

test("normalized aliases cannot bypass resolved component boundaries", () => {
  const collectForbiddenModuleReferences = requireExport(
    "collectForbiddenModuleReferences",
  );
  withTemporaryDirectory((directory) => {
    writeFile(
      directory,
      "apps/web/src/app/api/route.ts",
      [
        'import "@/./components/direct";',
        'import "@/lib/../components/traversal";',
      ].join("\n"),
    );

    const violations = collectForbiddenModuleReferences({
      repoRoot: directory,
      relativeRoots: ["apps/web/src/app/api"],
      isForbidden: ({ resolvedPath }) =>
        resolvedPath === "apps/web/src/components" ||
        resolvedPath?.startsWith("apps/web/src/components/"),
    });

    assert.deepEqual(
      violations.map(({ specifier, resolvedPath }) => ({
        specifier,
        resolvedPath,
      })),
      [
        {
          specifier: "@/./components/direct",
          resolvedPath: "apps/web/src/components/direct",
        },
        {
          specifier: "@/lib/../components/traversal",
          resolvedPath: "apps/web/src/components/traversal",
        },
      ],
    );
  });
});

test("dependency debt snapshots count reverse and direct cross-workspace references per occurrence", () => {
  const buildDependencyDebtSnapshot = requireExport(
    "buildDependencyDebtSnapshot",
  );
  withTemporaryDirectory((directory) => {
    writeFile(
      directory,
      "packages/airi-runtime/src/runtime.ts",
      'import "@/a";\nimport "../../../apps/web/src/b";\nimport "../../../apps/web/src";\n',
    );
    writeFile(
      directory,
      "apps/temporal-worker/src/worker.ts",
      'requireWeb("../../../apps/web/src/c");\nimport "apps/web/src";\n',
    );
    writeFile(
      directory,
      "apps/widget/src/widget.ts",
      'import "../../../packages/airi-runtime/src/runtime";\nimport "packages/airi-runtime/src";\n',
    );
    writeFile(
      directory,
      "apps/widget/src/widget.test.ts",
      'import "../../../packages/airi-runtime/src/runtime";\n',
    );
    const snapshot = buildDependencyDebtSnapshot(directory);
    assert.deepEqual(
      [...snapshot.airiRuntimeWeb],
      [["packages/airi-runtime/src/runtime.ts", 3]],
    );
    assert.deepEqual(
      [...snapshot.temporalWorkerWeb],
      [["apps/temporal-worker/src/worker.ts", 2]],
    );
    assert.deepEqual(
      [...snapshot.directCrossWorkspaceSource],
      [
        ["apps/temporal-worker/src/worker.ts", 2],
        ["apps/widget/src/widget.ts", 2],
        ["packages/airi-runtime/src/runtime.ts", 2],
      ],
    );
  });
});

test("airi-runtime web modules allow listed imports and reject new @/lib paths", () => {
  const findUnknownModuleViolations = requireExport(
    "findUnknownModuleViolations",
  );
  const collectAiriRuntimeWebModules = requireExport(
    "collectAiriRuntimeWebModules",
  );
  assert.deepEqual(
    findUnknownModuleViolations({
      label: "fixture",
      observed: new Map([
        ["packages/airi-runtime/src/runtime.ts", ["apps/web/src/lib/existing"]],
      ]),
      allowed: Object.freeze({
        "packages/airi-runtime/src/runtime.ts": ["apps/web/src/lib/existing"],
      }),
    }),
    [],
  );
  assert.deepEqual(
    findUnknownModuleViolations({
      label: "fixture",
      observed: new Map([
        [
          "packages/airi-runtime/src/runtime.ts",
          ["apps/web/src/lib/existing", "apps/web/src/lib/new-send"],
        ],
      ]),
      allowed: Object.freeze({
        "packages/airi-runtime/src/runtime.ts": ["apps/web/src/lib/existing"],
      }),
    }),
    [
      "fixture: packages/airi-runtime/src/runtime.ts imports apps/web/src/lib/new-send",
    ],
  );
  withTemporaryDirectory((directory) => {
    writeFile(
      directory,
      "packages/airi-runtime/src/runtime.ts",
      'import "@/lib/existing";\nimport "@/lib/new-send";\n',
    );
    assert.deepEqual(
      [...collectAiriRuntimeWebModules(directory)],
      [
        [
          "packages/airi-runtime/src/runtime.ts",
          ["apps/web/src/lib/existing", "apps/web/src/lib/new-send"],
        ],
      ],
    );
  });
});

test("airi-runtime web modules reject stale catalog entries and missing files", () => {
  const findStaleModuleViolations = requireExport("findStaleModuleViolations");
  const findCatalogFileMismatch = requireExport("findCatalogFileMismatch");
  const findMissingWebModuleFiles = requireExport("findMissingWebModuleFiles");
  const collectAiriRuntimeWebModules = requireExport(
    "collectAiriRuntimeWebModules",
  );
  const assertAllowedWebModules = requireExport("assertAllowedWebModules");

  assert.deepEqual(
    findStaleModuleViolations({
      label: "fixture",
      observed: new Map([
        ["packages/airi-runtime/src/runtime.ts", ["apps/web/src/lib/kept"]],
      ]),
      allowed: Object.freeze({
        "packages/airi-runtime/src/runtime.ts": [
          "apps/web/src/lib/kept",
          "apps/web/src/lib/moved",
        ],
      }),
    }),
    [
      "fixture: packages/airi-runtime/src/runtime.ts no longer imports apps/web/src/lib/moved",
    ],
  );
  assert.deepEqual(
    findCatalogFileMismatch({
      label: "fixture",
      budget: Object.freeze({
        "packages/airi-runtime/src/runtime.ts": 1,
        "packages/airi-runtime/src/extra.ts": 1,
      }),
      modules: Object.freeze({
        "packages/airi-runtime/src/runtime.ts": ["apps/web/src/lib/kept"],
      }),
    }),
    [
      "fixture: packages/airi-runtime/src/extra.ts is in the count budget but not the module catalog",
    ],
  );
  withTemporaryDirectory((directory) => {
    writeFile(
      directory,
      "packages/airi-runtime/src/runtime.ts",
      [
        'import { createRequire as makeRequire } from "node:module";',
        "const loadWeb = makeRequire(import.meta.url);",
        'loadWeb("../../../apps/web/src/lib/aliased");',
      ].join("\n"),
    );
    writeFile(directory, "apps/web/src/lib/kept.ts");
    assert.deepEqual(
      [...collectAiriRuntimeWebModules(directory)],
      [["packages/airi-runtime/src/runtime.ts", ["apps/web/src/lib/aliased"]]],
    );
    assert.deepEqual(
      findMissingWebModuleFiles({
        label: "fixture",
        repoRoot: directory,
        allowed: Object.freeze({
          "packages/airi-runtime/src/runtime.ts": [
            "apps/web/src/lib/kept",
            "apps/web/src/lib/ghost",
          ],
        }),
      }),
      ["fixture: missing on disk apps/web/src/lib/ghost"],
    );
    assert.throws(
      () =>
        assertAllowedWebModules({
          label: "fixture",
          observed: collectAiriRuntimeWebModules(directory),
          allowed: Object.freeze({
            "packages/airi-runtime/src/runtime.ts": ["apps/web/src/lib/kept"],
          }),
        }),
      /packages\/airi-runtime\/src\/runtime.ts imports apps\/web\/src\/lib\/aliased/,
    );
  });
});

test("per-file budgets allow reductions and reject growth", () => {
  const findBudgetViolations = requireExport("findBudgetViolations");
  const assertPerFileBudget = requireExport("assertPerFileBudget");
  assert.deepEqual(
    findBudgetViolations({
      label: "fixture",
      observed: new Map([["src/existing.ts", 1]]),
      allowed: Object.freeze({ "src/existing.ts": 2 }),
    }),
    [],
  );
  assert.deepEqual(
    findBudgetViolations({
      label: "fixture",
      observed: new Map([
        ["src/existing.ts", 3],
        ["src/new.ts", 1],
      ]),
      allowed: Object.freeze({ "src/existing.ts": 2 }),
    }),
    [
      "fixture: src/existing.ts has 3 references; allowed 2",
      "fixture: src/new.ts has 1 reference; allowed 0",
    ],
  );
  assert.throws(
    () =>
      assertPerFileBudget({
        label: "fixture",
        observed: new Map([["src/new.ts", 1]]),
        allowed: {},
      }),
    /fixture: src\/new.ts has 1 reference; allowed 0/,
  );
});

test("verification configuration permits extra task semantics", () => {
  const verify = requireExport("assertVerificationConfiguration");
  withTemporaryDirectory((directory) => {
    writeVerificationManifests(directory, (turbo) => {
      turbo.tasks["@icecore/airi-runtime#check-types"].dependsOn = [
        "^check-types",
      ];
      turbo.tasks["@icecore/airi-runtime#check-types"].inputs.push(
        "$TURBO_ROOT$/packages/shared/src/**",
      );
    });
    assert.doesNotThrow(() => verify(directory));
  });
});

test("verification configuration requires each hidden web input", () => {
  const verify = requireExport("assertVerificationConfiguration");
  withTemporaryDirectory((directory) => {
    writeVerificationManifests(directory, (turbo) => {
      turbo.tasks["@icecore/temporal-worker#test"].inputs = ["$TURBO_DEFAULT$"];
    });
    assert.throws(
      () => verify(directory),
      /@icecore\/temporal-worker#test.*apps\/web\/src/,
    );
  });
});

test("verification configuration accepts bounded harmless command prefixes", () => {
  const verify = requireExport("assertVerificationConfiguration");
  withTemporaryDirectory((directory) => {
    writeVerificationManifests(directory);
    writeManifestScript(
      directory,
      "apps/web/package.json",
      "check-types",
      "CI=1 pnpm exec tsc -p ./tsconfig.build.json --noEmit",
    );
    writeManifestScript(
      directory,
      "apps/web/package.json",
      "type-check",
      "CI=1 pnpm run check-types",
    );
    writeManifestScript(
      directory,
      "package.json",
      "verify:dependency-direction",
      "NODE_OPTIONS=--no-warnings node .github/scripts/verify-dependency-direction.mjs",
    );
    writeManifestScript(
      directory,
      "package.json",
      "check-types",
      "CI=1 pnpm run verify:dependency-direction && TURBO_TELEMETRY_DISABLED=1 turbo run check-types",
    );

    assert.doesNotThrow(() => verify(directory));
  });
});

test("web check-types rejects diagnostic, masked, non-executing, and test-inclusive commands", async (t) => {
  const verify = requireExport("assertVerificationConfiguration");
  const cases = [
    {
      name: "show-config mode",
      command: "tsc --showConfig --noEmit --project tsconfig.build.json",
    },
    {
      name: "help mode",
      command: "tsc --help --noEmit --project tsconfig.build.json",
    },
    {
      name: "version mode",
      command: "tsc --version --noEmit --project tsconfig.build.json",
    },
    {
      name: "init mode",
      command: "tsc --init --noEmit --project tsconfig.build.json",
    },
    {
      name: "watch mode",
      command: "tsc --watch --noEmit --project tsconfig.build.json",
    },
    {
      name: "masked failure",
      command: "tsc --noEmit --project tsconfig.build.json || echo pass",
    },
    {
      name: "spaced semicolon",
      command: "tsc --noEmit --project tsconfig.build.json ; echo pass",
    },
    {
      name: "pipeline",
      command: "tsc --noEmit --project tsconfig.build.json | echo pass",
    },
    {
      name: "newline command",
      command: "tsc --noEmit --project tsconfig.build.json\necho pass",
    },
    {
      name: "echoed compiler tokens",
      command: "echo tsc --noEmit --project tsconfig.build.json",
    },
    {
      name: "test-inclusive editor project",
      command: "tsc --noEmit --project tsconfig.json",
    },
  ];

  for (const invalidCase of cases) {
    await t.test(invalidCase.name, () => {
      withTemporaryDirectory((directory) => {
        writeVerificationManifests(directory);
        writeManifestScript(
          directory,
          "apps/web/package.json",
          "check-types",
          invalidCase.command,
        );
        assert.throws(() => verify(directory), /apps\/web check-types/);
      });
    });
  }
});

test("web type-check alias rejects masking and extra commands", async (t) => {
  const verify = requireExport("assertVerificationConfiguration");
  for (const [name, command] of [
    ["masked failure", "pnpm run check-types || echo pass"],
    ["spaced semicolon", "pnpm run check-types ; echo pass"],
    ["echoed delegate", "echo pnpm run check-types"],
  ]) {
    await t.test(name, () => {
      withTemporaryDirectory((directory) => {
        writeVerificationManifests(directory);
        writeManifestScript(
          directory,
          "apps/web/package.json",
          "type-check",
          command,
        );
        assert.throws(() => verify(directory), /apps\/web type-check/);
      });
    });
  }
});

test("root verifier rejects arguments, masking, and duplicate execution", async (t) => {
  const verify = requireExport("assertVerificationConfiguration");
  const executable = ".github/scripts/verify-dependency-direction.mjs";
  const testFile = ".github/scripts/verify-dependency-direction.test.mjs";
  for (const [name, command] of [
    ["baseline mode", `node ${executable} --print-baseline`],
    ["test mode", `node ${executable} --test`],
    ["test file argument", `node ${executable} ${testFile}`],
    ["masked failure", `node ${executable} || echo pass`],
    ["spaced semicolon", `node ${executable} ; echo pass`],
    ["echoed verifier", `echo node ${executable}`],
    ["duplicate verifier", `node ${executable} && node ${executable}`],
  ]) {
    await t.test(name, () => {
      withTemporaryDirectory((directory) => {
        writeVerificationManifests(directory);
        writeManifestScript(
          directory,
          "package.json",
          "verify:dependency-direction",
          command,
        );
        assert.throws(
          () => verify(directory),
          /verify:dependency-direction.*executable verifier/,
        );
      });
    });
  }
});

test("root check-types rejects masking, dry runs, and extra segments", async (t) => {
  const verify = requireExport("assertVerificationConfiguration");
  const verifier = "pnpm run verify:dependency-direction";
  const turbo = "turbo run check-types";
  for (const [name, command] of [
    ["Turbo dry run", `${verifier} && ${turbo} --dry-run`],
    ["masked verifier", `${verifier} || ${turbo}`],
    ["spaced semicolon", `${verifier} ; ${turbo}`],
    ["pipeline", `${verifier} | ${turbo}`],
    ["newline separator", `${verifier}\n${turbo}`],
    ["echoed verifier", `echo ${verifier} && ${turbo}`],
    ["echoed Turbo", `${verifier} && echo ${turbo}`],
    ["masked tail", `${verifier} && ${turbo} || echo pass`],
    ["extra segment", `${verifier} && ${turbo} && echo pass`],
  ]) {
    await t.test(name, () => {
      withTemporaryDirectory((directory) => {
        writeVerificationManifests(directory);
        writeManifestScript(directory, "package.json", "check-types", command);
        assert.throws(() => verify(directory), /root check-types/);
      });
    });
  }
});

test("verification configuration rejects the obsolete full typecheck alias", () => {
  const verify = requireExport("assertVerificationConfiguration");
  withTemporaryDirectory((directory) => {
    writeVerificationManifests(directory);
    writeManifestScript(
      directory,
      "apps/web/package.json",
      "type-check:full",
      "tsc --noEmit --project tsconfig.json",
    );
    assert.throws(() => verify(directory), /type-check:full.*must be absent/);
  });
});

test("scenario activity composes only the two typed web hosts", () => {
  const verify = requireExport("assertScenarioActivityHostImports");
  withTemporaryDirectory((directory) => {
    writeVerificationManifests(directory);
    const file = "apps/temporal-worker/src/activities/airi-auto-reply.ts";
    writeFile(
      directory,
      file,
      'import "@/lib/airi/scenario/auto-reply-runtime-dependencies";\nimport "@/lib/airi/scenario/timer-runtime-dependencies";\n',
    );
    assert.doesNotThrow(() => verify(directory));
    writeFile(directory, file, 'import "@/models/scenario";\n');
    assert.throws(
      () => verify(directory),
      (error) =>
        error instanceof assert.AssertionError &&
        JSON.stringify(error.actual).includes(file),
    );
  });
});

test("scenario activity rejects computed web-host imports", () => {
  const verify = requireExport("assertScenarioActivityHostImports");
  withTemporaryDirectory((directory) => {
    const file = "apps/temporal-worker/src/activities/airi-auto-reply.ts";
    writeFile(
      directory,
      file,
      'const modulePath = "@/models/scenario"; await import(modulePath);\n',
    );
    assert.throws(
      () => verify(directory),
      (error) =>
        error instanceof assert.AssertionError &&
        error.actual.some(
          (reference) =>
            reference.file === file && reference.specifier === "<non-literal>",
        ),
    );
  });
});

test("shared scenario and timer owners reject web host imports", async (t) => {
  const verify = requireExport("verifyRepositoryDependencyContract");
  for (const file of [
    "packages/airi-runtime/src/scenario-graph.ts",
    "packages/airi-runtime/src/scenario-state.ts",
    "packages/airi-runtime/src/scenario-runtime-types.ts",
    "packages/airi-runtime/src/scenario-runtime-dependencies.ts",
    "packages/airi-runtime/src/temporal-scenario-timers/dependencies.ts",
    "packages/airi-runtime/src/temporal-scenario-timers/external-events/generative-ai-result.ts",
  ]) {
    await t.test(file, () =>
      withTemporaryDirectory((directory) => {
        writeVerificationManifests(directory);
        writeFile(
          directory,
          file,
          'import "@/lib/airi/scenario/timer-runtime-dependencies";\n',
        );
        assert.throws(() => verify(directory), /airi-runtime web debt/);
      }),
    );
  }
});

test("scanner lists named value imports and re-exports, not type or namespace imports", () => {
  const collectNamedValueImports = requireExport("collectNamedValueImports");
  assert.deepEqual(
    collectNamedValueImports(
      [
        'import { getPostHogClient } from "@/lib/posthog/server";',
        'import { type Channel, readChannel as read } from "@/lib/a";',
        'import Default, { named } from "@/lib/b";',
        'import type { ConversationDocument } from "@/types/models";',
        'import { type MessageDocument } from "@/types/messages";',
        'import * as PostHogServerModule from "@/lib/posthog/server";',
        'import Chat from "@/models/chat";',
        'import "@/lib/side-effect";',
        'export { reexported } from "@/lib/c";',
        'export type { ReexportedType } from "@/lib/d";',
        'export * from "@/lib/e";',
      ].join("\n"),
      "packages/airi-runtime/src/example.ts",
    ),
    [
      {
        specifier: "@/lib/posthog/server",
        line: 1,
        names: ["getPostHogClient"],
      },
      { specifier: "@/lib/a", line: 2, names: ["readChannel"] },
      { specifier: "@/lib/b", line: 3, names: ["named"] },
      { specifier: "@/lib/c", line: 9, names: ["reexported"] },
    ],
  );
});

test("runtime code must not link named value imports from web modules", () => {
  const findRuntimeWebNamedValueImports = requireExport(
    "findRuntimeWebNamedValueImports",
  );
  const verify = requireExport("verifyRepositoryDependencyContract");
  withTemporaryDirectory((directory) => {
    writeVerificationManifests(directory);
    writeFile(
      directory,
      "packages/airi-runtime/src/whatsapp-message-processor.ts",
      'import * as PostHogServerModule from "@/lib/posthog/server";\nimport type { MessageDocument } from "@/types/models";\n',
    );
    writeFile(
      directory,
      "packages/airi-runtime/src/local.ts",
      'import { helper } from "./helper";\nimport { normalizeUrlBase } from "@icecore/shared/lib/value-utils";\n',
    );
    writeFile(
      directory,
      "packages/airi-runtime/src/processor.test.ts",
      'import { getPostHogClient } from "@/lib/posthog/server";\n',
    );
    writeFile(
      directory,
      "apps/web/src/lib/posthog/consumer.ts",
      'import { getPostHogClient } from "@/lib/posthog/server";\n',
    );
    assert.deepEqual(findRuntimeWebNamedValueImports(directory), []);

    writeFile(
      directory,
      "packages/airi-runtime/src/whatsapp-message-processor.ts",
      'import * as MongoErrorsModule from "@/lib/mongo-errors";\nimport { getPostHogClient } from "@/lib/posthog/server";\n',
    );
    writeFile(
      directory,
      "apps/temporal-worker/src/relative.ts",
      'export { readWebValue } from "../../web/src/lib/value";\n',
    );
    assert.deepEqual(findRuntimeWebNamedValueImports(directory), [
      {
        file: "apps/temporal-worker/src/relative.ts",
        line: 1,
        specifier: "../../web/src/lib/value",
        names: ["readWebValue"],
      },
      {
        file: "packages/airi-runtime/src/whatsapp-message-processor.ts",
        line: 2,
        specifier: "@/lib/posthog/server",
        names: ["getPostHogClient"],
      },
    ]);
    assert.throws(
      () => verify(directory),
      (error) =>
        error instanceof assert.AssertionError &&
        /readRuntimeExport/.test(error.message) &&
        JSON.stringify(error.actual).includes("getPostHogClient"),
    );
  });
});
