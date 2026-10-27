const mockStart = jest.fn();
jest.mock("server-only", () => ({}));
jest.mock("./client", () => ({
  getTemporalClient: () => ({ workflow: { start: mockStart } }),
  getTemporalWebClientConfig: () => ({ taskQueue: "main-worker" }),
  isTemporalConfigured: () => true,
}));

import { startBillingSubscriptionWorkflow } from "./billing-subscription";

it("can resume a closed renewal while reusing an active subscription workflow", async () => {
  await startBillingSubscriptionWorkflow({
    subscriptionId: "subscription-1",
    companyId: "company-1",
  });
  expect(mockStart).toHaveBeenCalledWith(
    "billingSubscriptionWorkflow",
    expect.objectContaining({
      workflowId: "billing-subscription:subscription-1",
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
      workflowIdConflictPolicy: "USE_EXISTING",
    })
  );
});
