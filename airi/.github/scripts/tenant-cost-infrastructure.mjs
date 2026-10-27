import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectCreativeAssetsBucket,
  mergeCreativeAssetsCors,
} from "./creative-assets-bucket-config.mjs";
import { syncGcpLlmProductAnalytics } from "./sync-gcp-llm-product-analytics.mjs";

export function runTenantCostInfrastructure(phase, operations, appOrigin) {
  if (!["preflight", "prepare"].includes(phase))
    throw new Error("Expected preflight or prepare");
  let bucket = operations.readBucket();
  let inspection = inspectCreativeAssetsBucket(bucket, appOrigin);
  if (phase === "prepare") {
    if (inspection.safetyErrors.length)
      throw new Error(inspection.safetyErrors.join(", "));
    operations.prepareAnalytics();
    operations.finalizeAnalytics();
    if (!inspection.corsReady) {
      operations.updateCors(
        mergeCreativeAssetsCors(bucket.cors_config, appOrigin),
      );
      bucket = operations.readBucket();
      inspection = inspectCreativeAssetsBucket(bucket, appOrigin);
    }
  }
  let analyticsReady = false;
  let analyticsError;
  try {
    operations.validateAnalytics();
    analyticsReady = true;
  } catch (error) {
    analyticsError =
      error instanceof Error ? error.message : "Analytics validation failed";
  }
  return {
    phase,
    bucketReady: inspection.safetyErrors.length === 0 && inspection.corsReady,
    ...inspection,
    analyticsReady,
    ...(analyticsError ? { analyticsError } : {}),
  };
}

function gcloud(args) {
  const result = spawnSync("gcloud", args, {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0)
    throw new Error(
      `GCP infrastructure command failed (${args.slice(0, 3).join(" ")})`,
    );
  return result.stdout;
}

function main() {
  const phase = process.argv[2];
  const project = process.env.GCP_PROJECT_ID;
  const bucket =
    process.env.GCS_CREATIVE_ASSETS_BUCKET || "icecore-ai-creative-assets-prod";
  if (!project) throw new Error("GCP_PROJECT_ID is required");
  const analytics = (analyticsPhase) =>
    syncGcpLlmProductAnalytics({
      phase: analyticsPhase,
      projectId: project,
      publisherServiceAccounts: [
        process.env.GCP_AI_GATEWAY_SERVICE_ACCOUNT,
        process.env.GCP_WORKER_SERVICE_ACCOUNT,
      ],
      existingInfrastructureOnly: true,
      location: process.env.GCP_LLM_ANALYTICS_LOCATION,
    });
  const result = runTenantCostInfrastructure(
    phase,
    {
      readBucket: () =>
        JSON.parse(
          gcloud([
            "storage",
            "buckets",
            "describe",
            `gs://${bucket}`,
            `--project=${project}`,
            "--format=json",
          ]),
        ),
      prepareAnalytics: () => analytics("prepare"),
      finalizeAnalytics: () => analytics("finalize"),
      validateAnalytics: () => analytics("validate-finalized"),
      updateCors: (cors) => {
        const directory = fs.mkdtempSync(
          path.join(os.tmpdir(), "airi-cost-cors-"),
        );
        const file = path.join(directory, "cors.json");
        try {
          fs.writeFileSync(file, JSON.stringify(cors), { mode: 0o600 });
          gcloud([
            "storage",
            "buckets",
            "update",
            `gs://${bucket}`,
            `--project=${project}`,
            `--cors-file=${file}`,
          ]);
        } finally {
          fs.rmSync(file, { force: true });
          fs.rmdirSync(directory);
        }
      },
    },
    process.env.NEXT_PUBLIC_APP_URL || "https://airi.chat",
  );
  console.info(
    JSON.stringify({ event: "tenant_cost_infrastructure", ...result }),
  );
  if (!result.bucketReady || !result.analyticsReady) process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "tenant_cost_infrastructure",
        error:
          error instanceof Error
            ? error.message
            : "Infrastructure check failed",
      }),
    );
    process.exitCode = 1;
  }
}
