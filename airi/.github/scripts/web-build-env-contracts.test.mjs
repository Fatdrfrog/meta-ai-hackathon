import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("passes production runtime configuration through Turbo's strict build environment", () => {
  const requiredEnvironment = {
    AI_CHAT_PROVIDER_ORDER: "anthropic,vertex",
    ANTHROPIC_AI_ENABLED: "true",
    ANTHROPIC_API_KEY: "contract-anthropic-key",
    ANTHROPIC_HEAVY_MODEL: "claude-sonnet-5-5",
    ANTHROPIC_LIGHT_MODEL: "claude-haiku-4-5",
    ANTHROPIC_REASONING_MODEL: "claude-opus-5-5",
    CONVERSATION_CLASSIFICATION_PUBLISHING_ENABLED: "false",
    CONVERSATION_CLASSIFICATION_PUBSUB_PROJECT_ID: "contract-project",
    CONVERSATION_CLASSIFICATION_PUBSUB_TOPIC: "contract-topic",
    CONVERSATION_CLASSIFICATION_RECONCILIATION_ENABLED: "false",
    TIKTOK_BUSINESS_APP_ID: "contract-app",
    TIKTOK_BUSINESS_APP_SECRET: "contract-secret",
    TIKTOK_BUSINESS_REDIRECT_URI:
      "https://www.airi.chat/api/internal/tiktok/callback",
  };
  const result = spawnSync(
    process.execPath,
    [
      resolve(repoRoot, "node_modules/turbo/bin/turbo"),
      "run",
      "build",
      "--filter",
      "@icecore/web",
      "--dry=json",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, ...requiredEnvironment },
    },
  );

  assert.equal(result.status, 0, result.stderr);

  const dryRun = JSON.parse(result.stdout);
  const webBuild = dryRun.tasks.find(
    (task) => task.taskId === "@icecore/web#build",
  );
  assert.ok(webBuild, "Turbo dry run omitted @icecore/web#build");

  const configuredKeys = webBuild.environmentVariables.configured.map(
    (entry) => entry.split("=", 1)[0],
  );
  for (const key of Object.keys(requiredEnvironment)) {
    assert.ok(
      configuredKeys.includes(key),
      `${key} was filtered out of the web build environment`,
    );
  }
});

test("runs the env contract when Turbo or the contract changes", () => {
  const workflow = readFileSync(
    resolve(repoRoot, ".github/workflows/react-doctor.yml"),
    "utf8",
  );

  assert.match(workflow, /- "turbo\.json"/);
  assert.match(
    workflow,
    /- "\.github\/scripts\/web-build-env-contracts\.test\.mjs"/,
  );
  assert.match(
    workflow,
    /node --test[\s\S]*\.github\/scripts\/web-build-env-contracts\.test\.mjs[\s\S]*\.github\/scripts\/web-typescript-contracts\.test\.mjs/,
  );
});
