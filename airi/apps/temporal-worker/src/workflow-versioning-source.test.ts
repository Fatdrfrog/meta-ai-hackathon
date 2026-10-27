import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const srcDir = dirname(fileURLToPath(import.meta.url));
const workflowsDir = join(srcDir, "workflows");

function readWorkflowSources(): Array<{ name: string; source: string }> {
  return readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".ts") && name !== "index.ts")
    .map((name) => ({
      name,
      source: readFileSync(join(workflowsDir, name), "utf8"),
    }));
}

test("all workflow definitions use auto-upgrade worker versioning", () => {
  for (const { name, source } of readWorkflowSources()) {
    assert.doesNotMatch(
      source,
      /versioningBehavior:\s*"PINNED"/,
      `${name} should not pin open executions to stale worker builds`,
    );
  }
});

test("worker config defaults to auto-upgrade when the env var is absent", () => {
  const source = readFileSync(join(srcDir, "config.ts"), "utf8");

  assert.match(
    source,
    /process\.env\.TEMPORAL_WORKER_VERSIONING_BEHAVIOR\)[\s\S]*\|\|[\s\S]*"AUTO_UPGRADE"/,
  );
  assert.doesNotMatch(
    source,
    /process\.env\.TEMPORAL_WORKER_VERSIONING_BEHAVIOR\)\s*\|\|\s*"PINNED"/,
  );
});
