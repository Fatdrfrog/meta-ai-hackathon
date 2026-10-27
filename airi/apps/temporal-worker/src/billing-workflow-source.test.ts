import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const srcDir = dirname(fileURLToPath(import.meta.url));

test("billing workflow uses bounded history and explicit retry schedule", () => {
  const source = readFileSync(
    join(srcDir, "workflows", "billing-subscription.ts"),
    "utf8",
  );

  assert.match(source, /continueAsNew<typeof billingSubscriptionWorkflow>/);
  assert.match(source, /BILLING_RETRY_DELAYS_MS/);
  assert.match(source, /sleep\(/);
});

test("worker registers billing activity and workflow exports billing workflow", () => {
  const workerSource = readFileSync(join(srcDir, "worker.ts"), "utf8");
  const indexSource = readFileSync(
    join(srcDir, "workflows", "index.ts"),
    "utf8",
  );

  assert.match(workerSource, /BILLING_SUBSCRIPTION_CHARGE_ACTIVITY/);
  assert.match(workerSource, /billingSubscriptionChargeActivity/);
  assert.match(indexSource, /billingSubscriptionWorkflow/);
});
