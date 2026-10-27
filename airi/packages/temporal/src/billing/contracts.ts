export const BILLING_SUBSCRIPTION_WORKFLOW = "billingSubscriptionWorkflow";
export const BILLING_SUBSCRIPTION_WORKFLOW_CONTRACT_VERSION = 1;
export const BILLING_SUBSCRIPTION_CHARGE_ACTIVITY =
  "billingSubscriptionChargeActivity";

export const BILLING_RETRY_DELAYS_MS = [
  60 * 60 * 1000,
  24 * 60 * 60 * 1000,
  72 * 60 * 60 * 1000,
] as const;

export type BillingSubscriptionWorkflowInput = {
  contractVersion: number;
  subscriptionId: string;
  companyId: string;
  startedAt?: string | null;
};

export type BillingSubscriptionChargeActivityInput = {
  contractVersion: number;
  subscriptionId: string;
  companyId: string;
  attempt: number;
  finalAttempt: boolean;
};

export type BillingSubscriptionChargeActivityResult = {
  status:
    | "paid"
    | "retry"
    | "unpaid"
    | "canceled"
    | "skipped"
    | "requires_action";
  subscriptionId: string;
  companyId: string;
  nextChargeAt?: string | null;
  retryDelayMs?: number | null;
  invoiceId?: string | null;
  reason?: string | null;
};

export function sanitizeBillingWorkflowIdPart(value: string): string {
  const sanitized = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return sanitized || "unknown";
}

export function buildBillingSubscriptionWorkflowId(params: {
  subscriptionId: string;
}): string {
  return [
    "billing-subscription",
    sanitizeBillingWorkflowIdPart(params.subscriptionId),
  ].join(":");
}
