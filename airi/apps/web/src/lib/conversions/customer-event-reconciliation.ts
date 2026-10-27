import { supabaseAdmin } from "@/lib/supabase/admin";
import { recordCustomerConversionEvent } from "@/lib/customers/service";

/** The SQL intent survives a failed customer-timeline write at intake. */
export async function reconcileConversionCustomerEvents(input: {
  limit: number;
  deadlineAtMs: number;
}) {
  const { data, error } = await supabaseAdmin
    .from("conversions")
    .select(
      "id,workspace_id,conversation_id,conversion_type,conversion_value,currency,metadata,converted_at"
    )
    .eq("customer_event_pending", true)
    .lte("customer_event_next_at", new Date().toISOString())
    .order("customer_event_next_at")
    .order("id")
    .limit(input.limit);
  if (error) throw new Error("Customer conversion reconciliation unavailable");
  let failures = 0;
  for (const row of data || []) {
    if (Date.now() >= input.deadlineAtMs) break;
    try {
      // Rotate a failed or orphaned row away from the head of the queue. Concurrent
      // workers can still project it safely using the timeline's permanent key.
      const deferred = await supabaseAdmin
        .from("conversions")
        .update({
          customer_event_next_at: new Date(Date.now() + 300_000).toISOString(),
        })
        .eq("workspace_id", row.workspace_id)
        .eq("id", row.id)
        .eq("customer_event_pending", true);
      if (deferred.error)
        throw new Error("Customer conversion retry scheduling failed");
      const recorded = await recordCustomerConversionEvent({
        conversationId: row.conversation_id,
        conversionId: row.id,
        expectedWorkspaceId: row.workspace_id,
        conversionType: row.conversion_type,
        conversionValue: row.conversion_value,
        currency: row.currency,
        occurredAt: new Date(row.converted_at),
        metadata: row.metadata,
        actor: { type: "system" },
      });
      if (!recorded) {
        failures++;
        continue;
      }
      const saved = await supabaseAdmin
        .from("conversions")
        .update({ customer_event_pending: false })
        .eq("workspace_id", row.workspace_id)
        .eq("id", row.id)
        .eq("customer_event_pending", true);
      if (saved.error)
        throw new Error("Customer conversion acknowledgement failed");
    } catch {
      failures++;
    }
  }
  if (failures)
    throw new Error(
      `Customer conversion projection will retry ${failures} rows`
    );
}
