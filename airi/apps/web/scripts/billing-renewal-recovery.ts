import { parseArgs } from "node:util";
import { basename } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildBillingSubscriptionWorkflowId } from "@icecore/temporal";

type RecoveryInput = {
  companyId: string;
  after?: string;
  limit: number;
  execute: boolean;
};

export async function recoverBillingRenewals(
  input: RecoveryInput,
  dependencies: {
    supabase: SupabaseClient;
    startWorkflow: (input: {
      companyId: string;
      subscriptionId: string;
    }) => Promise<unknown>;
    reconcileCheckouts: (input: {
      companyId: string;
      limit: number;
    }) => Promise<{ reconciled: number }>;
  }
) {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    !uuid.test(input.companyId) ||
    (input.after && !uuid.test(input.after)) ||
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  )
    throw new Error("A company UUID and limit between 1 and 100 are required.");
  const { data: company, error: companyError } = await dependencies.supabase
    .from("companies")
    .select("id, subscription_type, billing_manual_paid_through")
    .eq("id", input.companyId)
    .single();
  if (companyError || !company) throw new Error("Company could not be read.");
  let checkoutsReconciled = 0;
  if (input.execute) {
    const { error } = await dependencies.supabase.rpc(
      "reconcile_company_billing_entitlement",
      { p_company_id: input.companyId }
    );
    if (error) throw new Error("Company entitlement reconciliation failed.");
    checkoutsReconciled = (
      await dependencies.reconcileCheckouts({
        companyId: input.companyId,
        limit: Math.min(input.limit, 25),
      })
    ).reconciled;
  }
  let query = dependencies.supabase
    .from("subscriptions")
    .select(
      "id, company_id, provider, status, current_period_end, grace_ends_at"
    )
    .eq("company_id", input.companyId)
    .order("id")
    .limit(input.limit + 1);
  if (input.after) query = query.gt("id", input.after);
  const { data, error } = await query;
  if (error || !data) throw new Error("Subscriptions could not be read.");
  const rows = data.slice(0, input.limit);
  const results = [];
  for (const row of rows) {
    if (row.company_id !== input.companyId)
      throw new Error("Subscription owner mismatch.");
    const resumable =
      row.provider === "halyk_epay" &&
      ["active", "trialing", "past_due", "requires_action", "unpaid"].includes(
        row.status
      );
    if (input.execute && resumable)
      await dependencies.startWorkflow({
        companyId: input.companyId,
        subscriptionId: row.id,
      });
    results.push({
      ...row,
      workflowId: resumable
        ? buildBillingSubscriptionWorkflowId({ subscriptionId: row.id })
        : null,
      action: resumable
        ? input.execute
          ? "workflow_started_or_reused"
          : "would_start_or_reuse_workflow"
        : "no_change",
    });
  }
  return {
    company,
    execute: input.execute,
    subscriptions: results,
    checkoutsReconciled,
    nextCursor: data.length > input.limit ? rows.at(-1)!.id : null,
    manualEntitlementReviewRequired:
      !input.after && rows.length === 0 && company.subscription_type !== "free",
  };
}

async function main() {
  const { values } = parseArgs({
    strict: true,
    options: {
      "company-id": { type: "string" },
      after: { type: "string" },
      limit: { type: "string", default: "50" },
      execute: { type: "boolean", default: false },
    },
  });
  const [
    { supabaseAdmin },
    { startBillingSubscriptionWorkflow },
    { reconcileHalykCheckoutPayments },
  ] = await Promise.all([
    import("../src/lib/supabase/admin"),
    import("../src/lib/temporal/billing-subscription"),
    import("../src/lib/billing/service"),
  ]);
  const result = await recoverBillingRenewals(
    {
      companyId: values["company-id"] || "",
      after: values.after,
      limit: Number(values.limit),
      execute: values.execute,
    },
    {
      supabase: supabaseAdmin,
      startWorkflow: startBillingSubscriptionWorkflow,
      reconcileCheckouts: reconcileHalykCheckoutPayments,
    }
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (basename(process.argv[1] || "") === "billing-renewal-recovery.ts") {
  main().catch(() => {
    process.stderr.write(
      "Billing recovery failed. Check arguments and service access; completed starts are safe to repeat.\n"
    );
    process.exitCode = 1;
  });
}
