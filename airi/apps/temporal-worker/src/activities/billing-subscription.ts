import {
  assertContractVersion,
  BILLING_RETRY_DELAYS_MS,
  BILLING_SUBSCRIPTION_WORKFLOW_CONTRACT_VERSION,
  type BillingSubscriptionChargeActivityInput,
  type BillingSubscriptionChargeActivityResult,
} from "@icecore/temporal";

function validateContractVersion(value: number): void {
  assertContractVersion(
    value,
    { max: BILLING_SUBSCRIPTION_WORKFLOW_CONTRACT_VERSION },
    "billing activity",
  );
}

export async function billingSubscriptionChargeActivity(
  input: BillingSubscriptionChargeActivityInput,
): Promise<BillingSubscriptionChargeActivityResult> {
  validateContractVersion(input.contractVersion);

  const { chargeHalykSubscriptionRenewal } = await import(
    "@/lib/billing/service"
  );
  const result = await chargeHalykSubscriptionRenewal({
    subscriptionId: input.subscriptionId,
    companyId: input.companyId,
    attempt: input.attempt,
    finalAttempt: input.finalAttempt,
    retryDelayMs: BILLING_RETRY_DELAYS_MS[input.attempt] ?? null,
  });

  return {
    subscriptionId: input.subscriptionId,
    companyId: input.companyId,
    ...result,
  };
}
