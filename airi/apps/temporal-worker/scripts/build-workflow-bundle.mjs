import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bundleWorkflowCode } from "@temporalio/worker";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(scriptDir, "..");
const workflowsPath = resolve(workerRoot, "src/workflows/index.ts");
const outputPath = resolve(workerRoot, "dist/workflow-bundle.js");

const bundle = await bundleWorkflowCode({
  workflowsPath,
});

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, bundle.code, "utf8");

console.log("[Temporal Worker] Workflow bundle generated", {
  workflowsPath,
  outputPath,
  codeBytes: Buffer.byteLength(bundle.code, "utf8"),
});
