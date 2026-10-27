import { getWhatsAppWorkspaceContext } from "@/lib/whatsapp/get-workspace-context";
import { listWhatsAppOptInEvents } from "@/lib/whatsapp/signup-service";
import { NextResponse } from "next/server";
import {
  errorMessageResponse,
  requiredFieldResponse,
} from "@/lib/api/json-body";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("workspaceId")?.trim();
  if (!workspaceId) return requiredFieldResponse("workspaceId");

  const access = await getWhatsAppWorkspaceContext(workspaceId, {
    requireManager: true,
  });
  if (access.error) return access.error;

  try {
    const result = await listWhatsAppOptInEvents({
      workspaceId,
      sourceId: access.context.sourceId,
      limit: Number(url.searchParams.get("limit") || 200),
    });
    return NextResponse.json(result);
  } catch (error) {
    return errorMessageResponse(error);
  }
}
