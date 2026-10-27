import {
  disableCustomerWebhook,
  updateCustomerWebhook,
} from "@/lib/customer-api/management";

export const runtime = "nodejs";
type Context = { params: Promise<{ workspaceId: string; webhookId: string }> };

export async function PATCH(request: Request, { params }: Context) {
  const { workspaceId, webhookId } = await params;
  return updateCustomerWebhook(request, workspaceId, webhookId);
}

export async function DELETE(_request: Request, { params }: Context) {
  const { workspaceId, webhookId } = await params;
  return disableCustomerWebhook(workspaceId, webhookId);
}
