import { revokeCustomerApiKey } from "@/lib/customer-api/management";

export const runtime = "nodejs";
type Context = { params: Promise<{ workspaceId: string; keyId: string }> };

export async function DELETE(_request: Request, { params }: Context) {
  const { workspaceId, keyId } = await params;
  return revokeCustomerApiKey(workspaceId, keyId);
}
