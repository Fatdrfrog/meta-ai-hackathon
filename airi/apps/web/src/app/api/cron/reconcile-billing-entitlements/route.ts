import { verifyCronAuth } from "@/lib/cron-auth";
import { getHalykBillingConfig } from "@/lib/billing/config";
import { reconcileHalykCheckoutPayments } from "@/lib/billing/service";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const denied = verifyCronAuth(request);
  if (denied) return denied;
  try {
    const { data, error } = await supabaseAdmin.rpc(
      "reconcile_expired_billing_entitlements",
      { p_limit: 100 }
    );
    if (error) throw error;
    // Without Halyk credentials no checkout can be pending.
    const checkouts = getHalykBillingConfig().ok
      ? await reconcileHalykCheckoutPayments({ limit: 25 })
      : { reconciled: 0 };
    return NextResponse.json({
      ok: true,
      ...data,
      checkoutsReconciled: checkouts.reconciled,
    });
  } catch (error) {
    console.error("[Cron] Billing entitlement reconciliation failed", {
      error: error instanceof Error ? error.message : String(error),
      code: (error as { code?: unknown } | null)?.code,
    });
    return NextResponse.json(
      { ok: false, error: "Billing entitlement reconciliation failed" },
      { status: 503 }
    );
  }
}
