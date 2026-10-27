import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildCreativeAssetsCors,
  buildCreativeAssetsLifecycle,
  inspectCreativeAssetsBucket,
  mergeCreativeAssetsCors,
} from "./creative-assets-bucket-config.mjs";
import { runTenantCostInfrastructure } from "./tenant-cost-infrastructure.mjs";

const safeBucket = () => ({
  public_access_prevention: "enforced",
  uniform_bucket_level_access: true,
  lifecycle_config: buildCreativeAssetsLifecycle(),
  cors_config: buildCreativeAssetsCors("https://airi.chat"),
});

test("CORS covers exact-size, create-only browser uploads without removing other origins", () => {
  const legacy = [
    {
      origin: ["https://partner.example"],
      method: ["GET"],
      responseHeader: ["Content-Type"],
    },
  ];
  const merged = mergeCreativeAssetsCors(legacy, "https://airi.chat/path");
  assert.deepEqual(merged[0], legacy[0]);
  assert.equal(
    inspectCreativeAssetsBucket({ ...safeBucket(), cors_config: merged })
      .corsReady,
    true,
  );
  assert.deepEqual(mergeCreativeAssetsCors(merged), merged);
  for (const header of [
    "X-Goog-Content-Length-Range",
    "X-Goog-If-Generation-Match",
    "X-Goog-Meta-Assetid",
  ]) {
    assert.ok(merged[1].responseHeader.includes(header));
  }
});

test("CORS readiness rejects a legacy rule that shadows the upload headers", () => {
  const expected = buildCreativeAssetsCors()[0];
  const legacy = {
    ...expected,
    responseHeader: ["content-type", "X-Existing-Header"],
    maxAgeSeconds: 600,
  };
  const current = [legacy, expected];
  assert.equal(
    inspectCreativeAssetsBucket({ ...safeBucket(), cors_config: current })
      .corsReady,
    false,
  );
  const merged = mergeCreativeAssetsCors(current);
  assert.equal(merged.length, current.length);
  assert.deepEqual(merged[0].origin, legacy.origin);
  assert.deepEqual(merged[0].method, legacy.method);
  assert.equal(merged[0].maxAgeSeconds, legacy.maxAgeSeconds);
  assert.ok(merged[0].responseHeader.includes("X-Existing-Header"));
  const headers = merged[0].responseHeader.map((header) => header.toLowerCase());
  for (const header of expected.responseHeader) {
    assert.ok(headers.includes(header.toLowerCase()));
  }
  assert.equal(headers.filter((header) => header === "content-type").length, 1);
  assert.deepEqual(merged[1], expected);
  assert.deepEqual(legacy.responseHeader, ["content-type", "X-Existing-Header"]);
  assert.equal(
    inspectCreativeAssetsBucket({ ...safeBucket(), cors_config: merged })
      .corsReady,
    true,
  );
  assert.deepEqual(mergeCreativeAssetsCors(merged), merged);
});

test("CORS checks the first match for every origin and method, including wildcards", () => {
  const expected = buildCreativeAssetsCors()[0];
  const current = [
    { origin: ["*"], method: ["PUT"], responseHeader: ["Content-Type"] },
    expected,
  ];
  assert.equal(
    inspectCreativeAssetsBucket({ ...safeBucket(), cors_config: current })
      .corsReady,
    false,
  );
  const merged = mergeCreativeAssetsCors(current);
  assert.deepEqual(merged[0].origin, ["*"]);
  assert.deepEqual(merged[0].method, ["PUT"]);
  assert.ok(merged[0].responseHeader.includes("X-Goog-If-Generation-Match"));
  assert.equal(
    inspectCreativeAssetsBucket({ ...safeBucket(), cors_config: merged })
      .corsReady,
    true,
  );
});

test("lifecycle deletes are restricted to existing temporary and campaign prefixes", () => {
  assert.deepEqual(inspectCreativeAssetsBucket(safeBucket()).safetyErrors, []);
  for (const condition of [
    { age: 30 },
    { matchesPrefix: [""] },
    { matchesPrefix: ["tmp/", "workspaces/"] },
    { matchesPrefix: ["creative/"] },
  ]) {
    const bucket = safeBucket();
    bucket.lifecycle_config = {
      rule: [{ action: { type: "Delete" }, condition }],
    };
    assert.ok(
      inspectCreativeAssetsBucket(bucket).safetyErrors.includes(
        "lifecycle_can_remove_tenant_tombstones",
      ),
    );
  }
  assert.deepEqual(
    inspectCreativeAssetsBucket({ ...safeBucket(), lifecycle_config: {} })
      .safetyErrors,
    [],
  );
});

test("preflight collects readiness without mutation", () => {
  const calls = [];
  const result = runTenantCostInfrastructure("preflight", {
    readBucket: () => safeBucket(),
    validateAnalytics: () => {
      calls.push("validate");
      throw new Error("missing payer columns");
    },
    prepareAnalytics: () => calls.push("prepare"),
    finalizeAnalytics: () => calls.push("finalize"),
    updateCors: () => calls.push("cors"),
  });
  assert.equal(result.analyticsReady, false);
  assert.equal(result.bucketReady, true);
  assert.deepEqual(calls, ["validate"]);
});

test("preparation refuses unsafe lifecycle before any infrastructure mutation", () => {
  const calls = [];
  assert.throws(
    () =>
      runTenantCostInfrastructure("prepare", {
        readBucket: () => ({
          ...safeBucket(),
          lifecycle_config: {
            rule: [{ action: { type: "Delete" }, condition: { age: 30 } }],
          },
        }),
        prepareAnalytics: () => calls.push("prepare"),
        finalizeAnalytics: () => calls.push("finalize"),
        validateAnalytics: () => calls.push("validate"),
        updateCors: () => calls.push("cors"),
      }),
    /lifecycle_can_remove_tenant_tombstones/,
  );
  assert.deepEqual(calls, []);
});

test("preparation reuses analytics owner and updates only missing CORS", () => {
  const calls = [];
  let bucket = { ...safeBucket(), cors_config: [] };
  const result = runTenantCostInfrastructure("prepare", {
    readBucket: () => bucket,
    prepareAnalytics: () => calls.push("prepare"),
    finalizeAnalytics: () => calls.push("finalize"),
    validateAnalytics: () => calls.push("validate"),
    updateCors: (cors) => {
      calls.push("cors");
      bucket = { ...bucket, cors_config: cors };
    },
  });
  assert.deepEqual(calls, ["prepare", "finalize", "cors", "validate"]);
  assert.equal(result.bucketReady && result.analyticsReady, true);
});

test("operator dispatch cannot enter the production deploy job", () => {
  const workflow = readFileSync(
    new URL("../workflows/deploy-temporal-worker.yml", import.meta.url),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const operator = workflow
    .split("  tenant_cost_infrastructure:\n")[1]
    ?.split("  redeploy_web:\n")[0];
  assert.match(operator || "", /github\.event_name == 'workflow_dispatch'/);
  assert.match(
    operator,
    /inputs\.requests_rollout_action == 'tenant_cost_preflight'/,
  );
  assert.match(
    operator,
    /inputs\.requests_rollout_action == 'tenant_cost_prepare'/,
  );
  assert.match(
    operator,
    /uses: \.\/.github\/workflows\/tenant-cost-infrastructure.yml/,
  );
  const deployCondition = workflow.match(/^  deploy:\r?\n    if: (.+)$/m)?.[1];
  assert.equal(
    deployCondition,
    "${{ github.event_name == 'push' || github.event_name != 'workflow_dispatch' || inputs.requests_rollout_action == 'deploy_or_bootstrap' }}",
  );
  const operatorWorkflow = readFileSync(
    new URL("../workflows/tenant-cost-infrastructure.yml", import.meta.url),
    "utf8",
  );
  assert.match(operatorWorkflow, /workflow_call:/);
  assert.doesNotMatch(
    operatorWorkflow,
    /gcloud.*(?:deploy|delete)|secrets\.MONGODB_URI|secrets\.SUPABASE_SERVICE_ROLE_KEY/,
  );
});

test("storage-owning runtimes receive admission configuration and backing services", () => {
  const manifest = JSON.parse(
    readFileSync(
      new URL("../cloud-run/runtime-manifest.json", import.meta.url),
      "utf8",
    ),
  );
  for (const runtime of [manifest.worker, manifest.mediaApi]) {
    const names = runtime.vars.map((entry) =>
      typeof entry === "string" ? entry : entry.name,
    );
    assert.ok(names.includes("STORAGE_QUOTA_ROLLOUT_MODE"));
    assert.ok(names.includes("NEXT_PUBLIC_SUPABASE_URL"));
    const secrets = runtime.secrets.map((entry) =>
      typeof entry === "string" ? entry : entry.name,
    );
    assert.ok(secrets.includes("MONGODB_URI"));
    assert.ok(secrets.includes("SUPABASE_SERVICE_ROLE_KEY"));
  }
});
