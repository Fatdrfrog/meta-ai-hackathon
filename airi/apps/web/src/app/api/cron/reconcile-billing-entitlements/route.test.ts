const mockAuth = jest.fn();
const mockRpc = jest.fn();
const mockCheckouts = jest.fn();
const mockHalykConfig = jest.fn();
jest.mock("@/lib/billing/service", () => ({
  reconcileHalykCheckoutPayments: (...args: unknown[]) =>
    mockCheckouts(...args),
}));
jest.mock("@/lib/billing/config", () => ({
  getHalykBillingConfig: () => mockHalykConfig(),
}));
jest.mock("@/lib/cron-auth", () => ({
  verifyCronAuth: (...args: unknown[]) => mockAuth(...args),
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { rpc: (...args: unknown[]) => mockRpc(...args) },
}));
import { GET } from "./route";
beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockReturnValue(null);
  mockRpc.mockResolvedValue({ data: { reconciled: 2 }, error: null });
  mockCheckouts.mockResolvedValue({ reconciled: 1 });
  mockHalykConfig.mockReturnValue({ ok: true });
});
it("authenticates before changing entitlements", async () => {
  mockAuth.mockReturnValue(
    Response.json({ error: "Unauthorized" }, { status: 401 })
  );
  expect(
    (
      await GET(
        new Request("https://airi.chat/api/cron/reconcile-billing-entitlements")
      )
    ).status
  ).toBe(401);
  expect(mockRpc).not.toHaveBeenCalled();
  expect(mockCheckouts).not.toHaveBeenCalled();
});
it("uses the indexed bounded entitlement owner", async () => {
  const response = await GET(
    new Request("https://airi.chat/api/cron/reconcile-billing-entitlements")
  );
  expect(response.status).toBe(200);
  expect(mockRpc).toHaveBeenCalledWith(
    "reconcile_expired_billing_entitlements",
    { p_limit: 100 }
  );
  expect(mockCheckouts).toHaveBeenCalledWith({ limit: 25 });
  expect(await response.json()).toEqual({
    ok: true,
    reconciled: 2,
    checkoutsReconciled: 1,
  });
});
// The checkout reads failed every run (PGRST106: billing_private is not an
// exposed schema) even with no Halyk credentials, so the cron answered 503
// every 5 minutes without a log line.
it("skips checkout reconciliation when Halyk is not configured", async () => {
  mockHalykConfig.mockReturnValue({
    ok: false,
    missing: ["HALYK_EPAY_CLIENT_ID"],
  });
  const response = await GET(
    new Request("https://airi.chat/api/cron/reconcile-billing-entitlements")
  );
  expect(response.status).toBe(200);
  expect(mockCheckouts).not.toHaveBeenCalled();
  expect(await response.json()).toEqual({
    ok: true,
    reconciled: 2,
    checkoutsReconciled: 0,
  });
});
it("reports checkout reconciliation failures for retry and logs them", async () => {
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  mockCheckouts.mockRejectedValueOnce(
    Object.assign(new Error("Invalid schema: billing_private"), {
      code: "PGRST106",
    })
  );
  const response = await GET(
    new Request("https://airi.chat/api/cron/reconcile-billing-entitlements")
  );
  expect(response.status).toBe(503);
  expect(error).toHaveBeenCalledWith(
    "[Cron] Billing entitlement reconciliation failed",
    { error: "Invalid schema: billing_private", code: "PGRST106" }
  );
  error.mockRestore();
});
it("reports RPC failures as failures without exposing database details", async () => {
  mockRpc.mockResolvedValue({
    data: null,
    error: { message: "private database detail" },
  });
  const response = await GET(
    new Request("https://airi.chat/api/cron/reconcile-billing-entitlements")
  );
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain(
    "private database detail"
  );
});
