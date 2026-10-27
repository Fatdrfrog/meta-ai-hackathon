import assert from "node:assert/strict";
import { readRuntimeExport } from "@icecore/airi-runtime/module-interop";

await import("../src/worker.js");
await import("../src/whatsapp-webhook-runtime-dependencies.js");
const analyticsRuntime = await import(
  "@/lib/analytics/analytics-projection-runtime"
);
assert.equal(
  typeof readRuntimeExport(analyticsRuntime, "startAnalyticsProjectionRuntime"),
  "function",
  "the production loader must resolve the canonical analytics owner",
);

process.stdout.write(
  "Temporal worker and auxiliary startup imports loaded successfully.\n",
);
