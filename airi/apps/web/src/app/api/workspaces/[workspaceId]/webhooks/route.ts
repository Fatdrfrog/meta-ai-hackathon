import {
  createCustomerWebhook,
  listCustomerWebhooks,
} from "@/lib/customer-api/management";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ workspaceId: string }> };

export async function GET(_request: Request, { params }: Context) {
  return listCustomerWebhooks((await params).workspaceId);
}

export async function POST(request: Request, { params }: Context) {
  return createCustomerWebhook(request, (await params).workspaceId);
}
