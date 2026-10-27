import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertSingleCommand,
  collectModuleReferences,
  parseCommandChain,
  resolveModuleReference,
} from "./verify-dependency-direction.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const webRoot = resolve(repoRoot, "apps/web");
const tscPath = resolve(repoRoot, "node_modules/typescript/bin/tsc");
// The project next.config.ts hands to `next build`; check-types compiles it too.
const NEXT_PRODUCTION_TSCONFIG = "tsconfig.build.json";
// A cold `tsc -p tsconfig.build.json` keeps 2,708 MiB live (tsc "Memory used"
// under --expose-gc, TypeScript 5.9.2, 2026-10-06). The CI budget is that plus
// 25%, rounded up to 512 MiB. Growth fails CI instead of silently raising it.
const WEB_TYPECHECK_HEAP_MB = 3584;

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: webRoot,
    encoding: "utf8",
    ...options,
  });
}

function readResolvedTypeScriptConfig(tsconfigPath) {
  const result = runNode([tscPath, "--showConfig", "--project", tsconfigPath]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function normalizeConfigPath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isTestSource(filePath) {
  const normalized = normalizeConfigPath(filePath);
  return (
    /^(e2e|tests|test-fixtures|jest\.mocks)\//.test(normalized) ||
    /^playwright[^/]*\.config\.ts$/.test(normalized) ||
    /(^|\/)(__tests__|__mocks__)(\/|$)/.test(normalized) ||
    /\.(test|spec|eval)\.(ts|tsx)$/.test(normalized) ||
    /(test-utils\.tsx?|[.-]fixtures\.ts|\.test-mock\.ts)$/.test(normalized)
  );
}

function assertWebCiTypecheck(workflow) {
  const typecheckStep = workflow.match(
    /- name: Check production types[\s\S]*?(?=\n\s{6}- name:|\n\s{2}[a-zA-Z_-]+:|$)/,
  )?.[0];
  assert.ok(typecheckStep, "web CI is missing the production typecheck step");
  const runCommand = /^\s*run:\s*(.+)$/m.exec(typecheckStep)?.[1];
  assertSingleCommand(runCommand, {
    label: "web CI canonical check-types command",
    expectedTokens: ["pnpm", "--filter", "@icecore/web", "run", "check-types"],
  });
  const heapBudget = Number(
    /NODE_OPTIONS:\s*["']?--max-old-space-size=(\d+)/.exec(typecheckStep)?.[1],
  );
  assert.equal(
    heapBudget,
    WEB_TYPECHECK_HEAP_MB,
    "the web typecheck heap budget is pinned to a measurement; raise it only with a new one",
  );
}

test("Jest discovers scenario unit tests without collecting Playwright specs", () => {
  const packageJson = JSON.parse(
    readFileSync(resolve(webRoot, "package.json"), "utf8"),
  );
  const parsed = parseCommandChain(
    packageJson.scripts?.["test:scenarios"],
    "canonical scenario test command",
  );
  assert.deepEqual(parsed.operators, []);
  assert.equal(parsed.commands.length, 1);
  const [runner, ...args] = parsed.commands[0];
  assert.equal(runner, "jest");
  const result = runNode([
    resolve(webRoot, "node_modules/jest/bin/jest.js"),
    ...args,
    "--listTests",
    "--json",
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const discovered = JSON.parse(result.stdout).map(normalizeConfigPath);
  assert.ok(
    discovered.some((file) =>
      file.endsWith("/lib/scenarios/graph-validation.test.ts"),
    ),
    "scenario unit tests must remain discoverable",
  );
  for (const file of [
    "src/models/scenario.test.ts",
    "src/lib/airi/scenario/timer-recovery/ingress.test.ts",
    "src/lib/airi/scenario/timer-recovery/plan.test.ts",
    "src/lib/airi/reply/runtime/scenario.test.ts",
  ]) {
    assert.ok(
      discovered.some((candidate) => candidate.endsWith(`/${file}`)),
      `canonical scenario test command omitted ${file}`,
    );
  }
  assert.equal(
    discovered.some(
      (file) => file.includes("/e2e/") || file.includes("/web/tests/"),
    ),
    false,
    "Playwright specs must run through their own test runner",
  );
});

test("Next production builds typecheck strict production source without test roots", () => {
  const configResult = runNode(
    [
      "-e",
      [
        "const loadConfig = require('next/dist/server/config').default;",
        "const { PHASE_PRODUCTION_BUILD } = require('next/constants');",
        "loadConfig(PHASE_PRODUCTION_BUILD, process.cwd())",
        "  .then((config) => process.stdout.write(JSON.stringify(config.typescript)));",
      ].join(" "),
    ],
    {
      env: { ...process.env, NODE_ENV: "production" },
    },
  );

  assert.equal(configResult.status, 0, configResult.stderr);
  assert.deepEqual(JSON.parse(configResult.stdout), {
    ignoreBuildErrors: false,
    tsconfigPath: NEXT_PRODUCTION_TSCONFIG,
  });

  const buildConfig = readResolvedTypeScriptConfig(NEXT_PRODUCTION_TSCONFIG);
  const buildFiles = buildConfig.files.map(normalizeConfigPath);

  assert.ok(
    buildFiles.includes("src/app/layout.tsx"),
    "production app source was omitted from the build typecheck",
  );
  assert.ok(
    buildFiles.includes("src/app/api/test/conversation/route.ts"),
    "the production test API route was mistaken for test source",
  );
  for (const file of [
    "src/components/scenarios/view/node-enrichment/types.type-test.ts",
    "scripts/ensure-mongo-indexes.ts",
    "next.config.ts",
  ]) {
    assert.ok(
      buildFiles.includes(file),
      `${file} must stay in the production typecheck`,
    );
  }
  assert.equal(
    buildFiles.some(isTestSource),
    false,
    "test source leaked into the production build typecheck",
  );
  assert.equal(buildConfig.compilerOptions.strict, true);
  assert.equal(buildConfig.compilerOptions.noImplicitAny, true);
  assert.equal(buildConfig.compilerOptions.strictNullChecks, true);
  assert.equal(buildConfig.compilerOptions.noEmit, true);
});

function readCanonicalCheckTypesProject() {
  const packageJson = JSON.parse(
    readFileSync(resolve(webRoot, "package.json"), "utf8"),
  );
  const command = packageJson.scripts?.["check-types"];

  assert.equal(typeof command, "string", "missing check-types script");

  const commandParts = parseCommandChain(
    command,
    "canonical web check-types command",
  ).commands[0];
  assert.equal(commandParts[0], "tsc");
  assert.ok(
    commandParts.includes("--noEmit"),
    "check-types must keep the compiler read-only",
  );
  const projectFlagIndex = commandParts.findIndex((part) =>
    ["--project", "-p"].includes(part),
  );
  assert.notEqual(
    projectFlagIndex,
    -1,
    "check-types must name its TypeScript project explicitly",
  );

  return normalizeConfigPath(commandParts[projectFlagIndex + 1]);
}

function readCanonicalCheckTypesConfig() {
  return readResolvedTypeScriptConfig(readCanonicalCheckTypesProject());
}

test("the canonical web check-types command checks the Next production program", () => {
  // Jest transforms with SWC and never typechecks, so test files are typed
  // only by the editor project below.
  assert.equal(
    readCanonicalCheckTypesProject(),
    NEXT_PRODUCTION_TSCONFIG,
    "check-types must compile the program `next build` checks, not the test-inclusive editor project",
  );
});

test("the editor project keeps test sources typed", () => {
  const editorConfig = readResolvedTypeScriptConfig("tsconfig.json");
  const editorFiles = editorConfig.files.map(normalizeConfigPath);

  for (const file of [
    "src/app/layout.tsx",
    "src/instrumentation.test.ts",
    "src/lib/whatsapp/__tests__/whatsapp-webhook-processor.test.ts",
    "e2e/scenarios/whatsapp-qr-entry-point.spec.ts",
    "src/lib/airi/rag/eval/rag-golden.eval.test.ts",
    "playwright.config.ts",
  ]) {
    assert.ok(editorFiles.includes(file), `the editor project omitted ${file}`);
  }
});

// References TypeScript follows into the program; jest.mock and require strings
// do not load declarations.
const TYPE_GRAPH_REFERENCE_KINDS = new Set([
  "static",
  "import-equals",
  "import-type",
  "dynamic-import",
]);

test("the web check-types program does not compile temporal-worker source", () => {
  // Worker source brings the worker's own dependencies (redis clients,
  // @temporalio/activity and the generated Temporal protos behind it) into the
  // web program. Only web Jest suites import worker activities, and test
  // files stay out of the check-types program.
  const offenders = [];
  for (const file of readCanonicalCheckTypesConfig().files) {
    const sourcePath = resolve(webRoot, file);
    const sourceText = readFileSync(sourcePath, "utf8");
    if (!sourceText.includes("temporal-worker")) continue;
    for (const reference of collectModuleReferences(sourceText, sourcePath)) {
      if (!TYPE_GRAPH_REFERENCE_KINDS.has(reference.kind)) continue;
      const target = resolveModuleReference(
        repoRoot,
        sourcePath,
        reference.specifier,
      );
      if (
        target?.startsWith("apps/temporal-worker/") ||
        reference.specifier.startsWith("@icecore/temporal-worker")
      ) {
        offenders.push(
          `${normalizeConfigPath(file)}:${reference.line} ${reference.specifier}`,
        );
      }
    }
  }

  assert.deepEqual(offenders, []);
});

test("web CI runs the canonical production typecheck within its pinned heap", () => {
  const workflow = readFileSync(
    resolve(repoRoot, ".github/workflows/react-doctor.yml"),
    "utf8",
  );

  assertWebCiTypecheck(workflow);
});

test("web CI rejects a masked canonical typecheck", () => {
  const workflow = readFileSync(
    resolve(repoRoot, ".github/workflows/react-doctor.yml"),
    "utf8",
  );
  const maskedWorkflow = workflow.replace(
    "run: pnpm --filter @icecore/web run check-types",
    "run: pnpm --filter @icecore/web run check-types || echo pass",
  );

  assert.throws(
    () => assertWebCiTypecheck(maskedWorkflow),
    /canonical check-types command/,
  );
});

test("web CI rejects an unmeasured typecheck heap budget", () => {
  const workflow = readFileSync(
    resolve(repoRoot, ".github/workflows/react-doctor.yml"),
    "utf8",
  );
  const raisedWorkflow = workflow.replace(
    `--max-old-space-size=${WEB_TYPECHECK_HEAP_MB}`,
    "--max-old-space-size=5120",
  );

  assert.notEqual(raisedWorkflow, workflow);
  assert.throws(
    () => assertWebCiTypecheck(raisedWorkflow),
    /pinned to a measurement/,
  );
});

test("the web deployment uses the monorepo Node runtime", () => {
  const rootPackage = JSON.parse(
    readFileSync(resolve(repoRoot, "package.json"), "utf8"),
  );
  const webPackage = JSON.parse(
    readFileSync(resolve(webRoot, "package.json"), "utf8"),
  );

  assert.equal(
    webPackage.engines?.node,
    rootPackage.engines?.node,
    "apps/web can drift from the monorepo Node runtime when deployed as Vercel's project root",
  );
});
