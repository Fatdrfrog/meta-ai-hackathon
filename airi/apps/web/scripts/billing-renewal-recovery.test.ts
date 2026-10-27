import { recoverBillingRenewals } from "./billing-renewal-recovery";
const companyId = "11111111-1111-4111-8111-111111111111";
const subscription = {
  id: "22222222-2222-4222-8222-222222222222",
  company_id: companyId,
  provider: "halyk_epay",
  status: "requires_action",
};
function fixture(rows: unknown[]) {
  const query: Record<string, unknown> = { data: rows, error: null };
  for (const name of ["select", "eq", "order", "limit", "gt"])
    query[name] = jest.fn(() => query);
  const startWorkflow = jest.fn();
  const reconcileCheckouts = jest.fn().mockResolvedValue({ reconciled: 1 });
  const supabase = {
    rpc: jest.fn().mockResolvedValue({ error: null }),
    from: jest.fn((table: string) =>
      table === "subscriptions"
        ? query
        : {
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: { id: companyId, subscription_type: "pro" },
                  error: null,
                }),
              }),
            }),
          }
    ),
  };
  return {
    query,
    startWorkflow,
    reconcileCheckouts,
    supabase: supabase as never,
  };
}
it("previews without starting a workflow or changing manual entitlement", async () => {
  const deps = fixture([]);
  const report = await recoverBillingRenewals(
    { companyId, limit: 50, execute: false },
    deps
  );
  expect(report.manualEntitlementReviewRequired).toBe(true);
  expect(deps.startWorkflow).not.toHaveBeenCalled();
  expect(deps.reconcileCheckouts).not.toHaveBeenCalled();
});
it("starts only owned Halyk renewals and returns a bounded cursor", async () => {
  const deps = fixture([
    subscription,
    { ...subscription, id: "33333333-3333-4333-8333-333333333333" },
  ]);
  const report = await recoverBillingRenewals(
    { companyId, limit: 1, execute: true },
    deps
  );
  expect(deps.query.limit).toHaveBeenCalledWith(2);
  expect(deps.startWorkflow).toHaveBeenCalledTimes(1);
  expect(deps.startWorkflow).toHaveBeenCalledWith({
    companyId,
    subscriptionId: subscription.id,
  });
  expect(report.nextCursor).toBe(subscription.id);
  expect(deps.reconcileCheckouts).toHaveBeenCalledWith({ companyId, limit: 1 });
  expect(report.checkoutsReconciled).toBe(1);
});
it.each([
  { ...subscription, provider: "paddle" },
  { ...subscription, status: "canceled" },
])("leaves externally managed or closed renewals unchanged", async row => {
  const deps = fixture([row]);
  await recoverBillingRenewals({ companyId, limit: 10, execute: true }, deps);
  expect(deps.startWorkflow).not.toHaveBeenCalled();
});
it("fails before workflow start when subscription ownership does not match", async () => {
  const deps = fixture([{ ...subscription, company_id: "another-company" }]);
  await expect(
    recoverBillingRenewals({ companyId, limit: 10, execute: true }, deps)
  ).rejects.toThrow("owner mismatch");
  expect(deps.startWorkflow).not.toHaveBeenCalled();
});
