import { supabaseAdmin } from "@/lib/supabase/admin";
import Customer from "@/models/customer";
import type { CustomerPurchaseFacts } from "@icecore/scenario-contracts";

export async function loadCustomerPurchaseFacts(input: {
  workspaceId: string;
  customerId: string;
  after?: Date;
  excludeConversionId?: string;
}): Promise<CustomerPurchaseFacts & { convertedSince: boolean }> {
  const customer = await Customer.findOne({
    _id: input.customerId,
    workspaceId: input.workspaceId,
    status: "active",
  })
    .select("conversationIds")
    .lean<{ conversationIds?: unknown[] }>();
  if (!customer) throw new Error("Customer no longer available");
  const ids = (customer.conversationIds || []).map(String);
  const { data, error } = await supabaseAdmin.rpc(
    "get_customer_purchase_facts",
    {
      p_workspace_id: input.workspaceId,
      p_customer_id: input.customerId,
      p_conversation_ids: ids,
      p_after: input.after?.toISOString() || null,
      p_exclude_conversion_id: input.excludeConversionId || null,
    }
  );
  if (
    error ||
    !data ||
    typeof data.purchaseCount !== "number" ||
    typeof data.convertedSince !== "boolean"
  )
    throw new Error("Purchase facts unavailable");
  return data as CustomerPurchaseFacts & { convertedSince: boolean };
}
