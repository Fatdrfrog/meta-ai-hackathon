import {
  InvalidJsonBodyError,
  invalidJsonBodyResponse,
  readJsonObjectBody,
} from "@/lib/api/json-body";
import { getWhatsAppWorkspaceContext } from "@/lib/whatsapp/get-workspace-context";
import {
  setDefaultMessagingCustomerBaseBodySchema,
  errorMessageResponse,
  zodErrorResponse,
} from "@/lib/whatsapp/signup-route-validation";
import { setDefaultMessagingCustomerBase } from "@/lib/whatsapp/signup-service";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await readJsonObjectBody(request);
  } catch (error) {
    if (error instanceof InvalidJsonBodyError) {
      return invalidJsonBodyResponse(error);
    }
    throw error;
  }

  const parsed = setDefaultMessagingCustomerBaseBodySchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const { customerBaseId, workspaceId } = parsed.data;

  const access = await getWhatsAppWorkspaceContext(workspaceId, {
    requireManager: true,
  });
  if (access.error) return access.error;
  if (!access.context.accessToken || !access.context.wabaId) {
    return NextResponse.json(
      {
        error: "Default customer base requires WABA ID and access token",
        requiresWhatsAppConnection: true,
      },
      { status: 409 }
    );
  }

  try {
    const result = await setDefaultMessagingCustomerBase({
      accessToken: access.context.accessToken,
      customerBaseId,
      sourceId: access.context.sourceId,
      wabaId: access.context.wabaId,
      workspaceId,
    });
    return NextResponse.json(result);
  } catch (error) {
    return errorMessageResponse(error);
  }
}
