import { listCustomerWebhookDeliveries } from "@/lib/customer-api/management";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ workspaceId: string; webhookId: string }> };

export async function GET(request: Request, { params }: Context) {
  const { workspaceId, webhookId } = await params;
  return listCustomerWebhookDeliveries(request, workspaceId, webhookId);
}
