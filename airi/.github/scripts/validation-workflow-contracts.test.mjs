import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { posix } from "node:path";
import test from "node:test";
import {
  compileWorkflowPathFilter,
  readWorkflowPushPaths,
} from "./deploy-vercel-production.mjs";

const repoRoot = new URL("../../", import.meta.url);
const validationWorkflows = [
  "replay-temporal-workflows.yml",
  "rag-golden.yml",
  "react-doctor.yml",
  "scenario-prompt-inputs.yml",
  "airi-harness-tests.yml",
];

async function readWorkflow(name) {
  return (
    await readFile(new URL(`.github/workflows/${name}`, repoRoot), "utf8")
  ).replace(/\r\n?/g, "\n");
}

async function readConcurrency(name) {
  const workflow = await readWorkflow(name);
  const block = workflow.match(/^concurrency:\n((?: {2}[^\n]*\n)+)/m)?.[1];
  assert.ok(block, `${name} must group obsolete validation runs`);
  const group = block.match(/^ {2}group: (.+)$/m)?.[1];
  const cancel = block.match(/^ {2}cancel-in-progress: (true|false)$/m)?.[1];
  assert.ok(group, `${name} must define a concurrency group`);
  assert.ok(cancel, `${name} must define its cancellation policy`);
  return { group, cancel: cancel === "true" };
}

// Resolve the context paths and fallback operator used by these workflow keys.
// Unknown syntax fails loudly rather than making the isolation checks pass.
function resolveGroup(template, github) {
  return template
    .replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expression) => {
      const values = expression.split(/\s*\|\|\s*/).map((path) => {
        assert.match(path, /^github(?:\.[a-z_]+)+$/);
        return path
          .split(".")
          .slice(1)
          .reduce((value, key) => value?.[key], github);
      });
      return values.find(Boolean) ?? "";
    })
    .toLowerCase();
}

const pullRequest = {
  event: { pull_request: { number: 42 } },
  ref: "refs/pull/42/merge",
  sha: "a".repeat(40),
  run_id: 100,
};

for (const name of validationWorkflows) {
  test(`${name} supersedes older commits in one PR without canceling another PR`, async () => {
    const policy = await readConcurrency(name);
    const older = resolveGroup(policy.group, pullRequest);
    const newer = resolveGroup(policy.group, {
      ...pullRequest,
      sha: "b".repeat(40),
      run_id: 101,
    });
    const otherPr = resolveGroup(policy.group, {
      ...pullRequest,
      event: { pull_request: { number: 43 } },
      ref: "refs/pull/43/merge",
    });

    assert.equal(
      policy.cancel,
      true,
      "obsolete validation must be cancellable",
    );
    assert.equal(
      newer,
      older,
      "new commits must supersede the same PR's validation",
    );
    assert.notEqual(
      otherPr,
      older,
      "a different PR must retain its own validation",
    );
  });
}

for (const name of [
  "rag-golden.yml",
  "react-doctor.yml",
  "airi-harness-tests.yml",
]) {
  test(`${name} supersedes one ref without canceling validation for other refs`, async () => {
    const { group } = await readConcurrency(name);
    const push = {
      event: {},
      ref: "refs/heads/main",
      sha: "a".repeat(40),
      run_id: 100,
    };
    assert.equal(
      resolveGroup(group, { ...push, sha: "b".repeat(40), run_id: 101 }),
      resolveGroup(group, push),
      "push and manual validation must not create a unique group per run",
    );
    assert.notEqual(
      resolveGroup(group, { ...push, ref: "refs/heads/codex/other-change" }),
      resolveGroup(group, push),
      "validation for another ref must not be canceled",
    );
    assert.notEqual(
      resolveGroup(group, push),
      resolveGroup(group, pullRequest),
    );
  });
}

test("validation workflows cannot cancel another workflow for the same PR", async () => {
  const groups = await Promise.all(
    validationWorkflows.map(async (name) => {
      const { group } = await readConcurrency(name);
      const workflow = (await readWorkflow(name)).match(/^name: (.+)$/m)?.[1];
      return resolveGroup(group, { ...pullRequest, workflow });
    }),
  );
  assert.equal(
    new Set(groups).size,
    validationWorkflows.length,
    "each workflow must have its own cancellation namespace",
  );
});

test("validation policy changes route to the existing React Doctor contract check", async () => {
  const matches = compileWorkflowPathFilter(
    readWorkflowPushPaths(await readWorkflow("react-doctor.yml")),
  );
  for (const path of [
    ".github/scripts/validation-workflow-contracts.test.mjs",
    ".github/scripts/committed-secrets.test.mjs",
    ".cursor/rules/project-overview.mdc",
    "apps/web/.cursor/mcp.json",
    ".github/workflows/replay-temporal-workflows.yml",
    ".github/workflows/rag-golden.yml",
    ".github/workflows/react-doctor.yml",
    ".github/workflows/airi-harness-tests.yml",
  ]) {
    assert.equal(
      matches(path),
      true,
      `${path} must trigger validation of its policy`,
    );
  }
  assert.equal(matches("docs/unrelated.md"), false);
});

// on.<event>.paths for a trigger other than push, read by the same parser.
function readTriggerPaths(workflow, event) {
  return readWorkflowPushPaths(
    workflow
      .replace(/^ {2}push:$/m, "  push_paths_not_read:")
      .replace(new RegExp(`^ {2}${event}:$`, "m"), "  push:"),
  );
}

// The Airi UI suites render src/components/ai with its real neighbours
// (catalogs, ui kit, integrations), and so does the browser smoke, whose
// files share the prefix below. The server-side suites (airi-chats, ai,
// meta-ads/mcp, the routes) mock their non-Airi dependencies and are not
// traced here.
const airiHarnessSourceDirs = ["apps/web/src/components/ai"];
// Those server-side suites do load the shared test doubles under test-support.
const airiHarnessServerSuiteDirs = [
  "apps/web/src/lib/airi-chats",
  "apps/web/src/lib/meta-ads/mcp",
  "apps/web/src/lib/ai",
  "apps/web/src/app/api/workspaces/[workspaceId]/airi-chats",
];
const TEST_SUPPORT_PREFIX = "apps/web/src/test-support/";
const airiSmokePrefix = "apps/web/tests/airi-chat-browser";
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const MODULE_SPECIFIER =
  /(?:\bfrom|\bimport|\brequire|\brequireActual|\bjest\.mock)\s*\(?\s*["']([^"']+)["']/g;
// The smoke server aliases next/* to stand-ins beside it.
const SMOKE_ALIAS_TARGET =
  /\bresolve\(\s*testRoot,\s*["']([^"']+\.[cm]?[jt]sx?)["']/g;

async function workspacePackageDirs() {
  const dirs = new Map();
  for (const entry of await readdir(new URL("packages/", repoRoot), {
    withFileTypes: true,
  })) {
    const manifest = new URL(`packages/${entry.name}/package.json`, repoRoot);
    if (!entry.isDirectory() || !existsSync(manifest)) continue;
    const { name } = JSON.parse(await readFile(manifest, "utf8"));
    dirs.set(name, `packages/${entry.name}`);
  }
  return dirs;
}

// Repo-relative file a module specifier loads, or null for an npm dependency
// (the manifests and lockfile are watched for those).
function resolveSpecifier(specifier, fromPath, packageDirs) {
  let base;
  if (specifier.startsWith("@/")) {
    base = `apps/web/src/${specifier.slice(2)}`;
  } else if (specifier.startsWith(".")) {
    base = posix.join(posix.dirname(fromPath), specifier);
  } else if (specifier.startsWith("@icecore/")) {
    const name = specifier.split("/").slice(0, 2).join("/");
    const dir = packageDirs.get(name);
    assert.ok(dir, `${fromPath} imports unknown workspace package ${name}`);
    return `${dir}/package.json`;
  } else {
    return null;
  }
  for (const suffix of ["", ".ts", ".tsx", ".js", ".mjs", ".json"]) {
    const candidate = `${base}${suffix}`;
    const url = new URL(candidate, repoRoot);
    if (existsSync(url) && statSync(url).isFile()) return candidate;
  }
  for (const index of ["/index.ts", "/index.tsx", "/index.js"]) {
    if (existsSync(new URL(`${base}${index}`, repoRoot))) {
      return `${base}${index}`;
    }
  }
  assert.fail(`${fromPath} imports ${specifier}, which does not resolve`);
}

// Every file the Airi jest suites and the browser smoke load directly: the
// imports, mocks and requireActual targets in the gated folders and the
// smoke's files (and the test stand-ins those pull in), the test-support
// doubles the server-side suites import, plus the modules jest.config.js
// maps in.
async function airiHarnessDirectInputs() {
  const packageDirs = await workspacePackageDirs();
  const sources = [];
  for (const dir of airiHarnessSourceDirs) {
    for (const name of await readdir(new URL(`${dir}/`, repoRoot), {
      recursive: true,
    })) {
      sources.push(`${dir}/${name.replaceAll("\\", "/")}`);
    }
  }
  for (const name of await readdir(new URL("apps/web/tests/", repoRoot))) {
    const path = `apps/web/tests/${name}`;
    if (path.startsWith(airiSmokePrefix)) sources.push(path);
  }

  const queue = sources.filter((path) => SOURCE_FILE.test(path));
  assert.ok(queue.length > 0, "no Airi harness sources found");
  const scanned = new Set(queue);
  const inputs = new Set();
  while (queue.length > 0) {
    const path = queue.shift();
    const text = await readFile(new URL(path, repoRoot), "utf8");
    const found = [...text.matchAll(MODULE_SPECIFIER)].map(([, specifier]) =>
      resolveSpecifier(specifier, path, packageDirs),
    );
    if (path.startsWith(airiSmokePrefix)) {
      for (const [, target] of text.matchAll(SMOKE_ALIAS_TARGET)) {
        found.push(`apps/web/tests/${target}`);
      }
    }
    for (const resolved of found) {
      if (!resolved) continue;
      inputs.add(resolved);
      if (
        resolved.startsWith("apps/web/tests/") &&
        SOURCE_FILE.test(resolved) &&
        !scanned.has(resolved)
      ) {
        scanned.add(resolved);
        queue.push(resolved);
      }
    }
  }
  for (const dir of airiHarnessServerSuiteDirs) {
    for (const name of await readdir(new URL(`${dir}/`, repoRoot), {
      recursive: true,
    })) {
      const path = `${dir}/${name.replaceAll("\\", "/")}`;
      if (!SOURCE_FILE.test(path)) continue;
      const text = await readFile(new URL(path, repoRoot), "utf8");
      for (const [, specifier] of text.matchAll(MODULE_SPECIFIER)) {
        const resolved = resolveSpecifier(specifier, path, packageDirs);
        if (resolved?.startsWith(TEST_SUPPORT_PREFIX)) inputs.add(resolved);
      }
    }
  }
  const jestConfig = await readFile(
    new URL("apps/web/jest.config.js", repoRoot),
    "utf8",
  );
  for (const [, target] of jestConfig.matchAll(/<rootDir>\/([^"'$]+)["']/g)) {
    inputs.add(`apps/web/${target}`);
  }
  return [...inputs].sort();
}

test("airi-harness-tests.yml runs when a file its suites or browser smoke load changes", async () => {
  const workflow = await readWorkflow("airi-harness-tests.yml");
  const pushPaths = readWorkflowPushPaths(workflow);
  assert.deepEqual(
    readTriggerPaths(workflow, "pull_request"),
    pushPaths,
    "pull requests and merges to main must watch the same inputs",
  );

  const watched = compileWorkflowPathFilter(pushPaths);
  const inputs = await airiHarnessDirectInputs();
  for (const expected of [
    "apps/web/messages/en.json",
    "apps/web/jest.mocks/next-intl.js",
    "apps/web/src/app/globals.css",
    "apps/web/src/components/ui/button.tsx",
    "apps/web/tests/whatsapp-templates-browser-navigation.ts",
    "apps/web/src/test-support/supabase-auth-test-utils.ts",
    "packages/shared/package.json",
  ]) {
    assert.ok(inputs.includes(expected), `${expected} should be an input`);
  }
  assert.deepEqual(
    inputs.filter((path) => !watched(path)),
    [],
    "a change to these files would break the Airi harness without running it",
  );
  assert.equal(watched("docs/unrelated.md"), false);
});
