import {
  assertContractVersion,
  BILLING_RETRY_DELAYS_MS,
  BILLING_SUBSCRIPTION_CHARGE_ACTIVITY,
  BILLING_SUBSCRIPTION_WORKFLOW_CONTRACT_VERSION,
  type BillingSubscriptionChargeActivityInput,
  type BillingSubscriptionChargeActivityResult,
  type BillingSubscriptionWorkflowInput,
} from "@icecore/temporal";
import {
  continueAsNew,
  patched,
  proxyActivities,
  setWorkflowOptions,
  sleep,
  workflowInfo,
} from "@temporalio/workflow";

const billingActivities = proxyActivities<{
  [BILLING_SUBSCRIPTION_CHARGE_ACTIVITY]: (
    input: BillingSubscriptionChargeActivityInput,
  ) => Promise<BillingSubscriptionChargeActivityResult>;
}>({
  startToCloseTimeout: "120s",
  retry: {
    maximumAttempts: 3,
    initialInterval: "10s",
    backoffCoefficient: 2,
    maximumInterval: "120s",
  },
});

const billingSubscriptionChargeActivity = billingActivities[
  BILLING_SUBSCRIPTION_CHARGE_ACTIVITY
] as (
  input: BillingSubscriptionChargeActivityInput,
) => Promise<BillingSubscriptionChargeActivityResult>;

function validateContractVersion(value: number): void {
  assertContractVersion(
    value,
    { max: BILLING_SUBSCRIPTION_WORKFLOW_CONTRACT_VERSION },
    "billing workflow",
  );
}

function msUntil(iso: string | null | undefined): number {
  if (!iso) return 0;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, timestamp - Date.now());
}

export async function billingSubscriptionWorkflow(
  input: BillingSubscriptionWorkflowInput,
): Promise<BillingSubscriptionChargeActivityResult> {
  validateContractVersion(input.contractVersion);

  let cycleCount = 0;
  let nextChargeAt = input.startedAt || new Date(Date.now()).toISOString();

  while (true) {
    const waitMs = msUntil(nextChargeAt);
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    let latest: BillingSubscriptionChargeActivityResult | null = null;
    for (
      let attempt = 0;
      attempt <= BILLING_RETRY_DELAYS_MS.length;
      attempt++
    ) {
      const finalAttempt = attempt === BILLING_RETRY_DELAYS_MS.length;
      latest = await billingSubscriptionChargeActivity({
        contractVersion: input.contractVersion,
        subscriptionId: input.subscriptionId,
        companyId: input.companyId,
        attempt,
        finalAttempt,
      });

      if (
        latest.status === "canceled" ||
        latest.status === "unpaid"
      ) {
        return latest;
      }

      if (latest.status === "requires_action") {
        if (!patched("billing-renewal-reconciliation-v1")) return latest;
        const retryAt = msUntil(latest.nextChargeAt);
        nextChargeAt = new Date(
          Date.now() + (retryAt > 0 ? Math.min(retryAt, 3_600_000) : 3_600_000),
        ).toISOString();
        break;
      }

      if (latest.status === "paid") {
        nextChargeAt = latest.nextChargeAt || nextChargeAt;
        break;
      }

      if (latest.status === "skipped") {
        nextChargeAt = latest.nextChargeAt || nextChargeAt;
        break;
      }

      const retryDelayMs =
        latest.retryDelayMs ?? BILLING_RETRY_DELAYS_MS[attempt] ?? 0;
      if (retryDelayMs > 0) {
        await sleep(retryDelayMs);
      }
    }

    cycleCount += 1;
    const info = workflowInfo();
    if (
      info.continueAsNewSuggested ||
      info.historyLength > 10000 ||
      cycleCount >= 12
    ) {
      await continueAsNew<typeof billingSubscriptionWorkflow>({
        ...input,
        startedAt: nextChargeAt,
      });
    }

    if (!latest) {
      return {
        status: "skipped",
        subscriptionId: input.subscriptionId,
        companyId: input.companyId,
        reason: "no_charge_attempt",
      };
    }
  }
}

setWorkflowOptions(
  { versioningBehavior: "AUTO_UPGRADE" },
  billingSubscriptionWorkflow,
);
