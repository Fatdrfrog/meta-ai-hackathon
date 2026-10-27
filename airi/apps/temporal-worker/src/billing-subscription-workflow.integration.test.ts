import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  BILLING_SUBSCRIPTION_CHARGE_ACTIVITY,
  type BillingSubscriptionChargeActivityResult,
} from "@icecore/temporal";
import { createLocalTemporalWorkflowHarness } from "./testing/local-temporal.js";

test(
  "a challenged renewal stays alive to reconcile and reaches its finite grace deadline",
  { timeout: 90_000 },
  async () => {
    const harness = await createLocalTemporalWorkflowHarness(
      fileURLToPath(
        new URL("./workflows/billing-subscription.ts", import.meta.url),
      ),
    );
    const companyId = "company-1";
    const subscriptionId = "subscription-1";
    let attempts = 0;
    try {
      await harness.run({
        workflowType: "billingSubscriptionWorkflow",
        input: { contractVersion: 1, companyId, subscriptionId },
        activities: {
          [BILLING_SUBSCRIPTION_CHARGE_ACTIVITY]:
            async (): Promise<BillingSubscriptionChargeActivityResult> => {
              attempts += 1;
              return attempts === 1
                ? {
                    status: "requires_action",
                    companyId,
                    subscriptionId,
                    nextChargeAt: new Date(Date.now() + 1000).toISOString(),
                  }
                : {
                    status: "unpaid",
                    companyId,
                    subscriptionId,
                    reason: "grace_expired",
                  };
            },
        },
        assert: async (handle) => {
          const result =
            (await handle.result()) as BillingSubscriptionChargeActivityResult;
          assert.equal(result.status, "unpaid");
          assert.equal(attempts, 2);
        },
      });
    } finally {
      await harness.close();
    }
  },
);
