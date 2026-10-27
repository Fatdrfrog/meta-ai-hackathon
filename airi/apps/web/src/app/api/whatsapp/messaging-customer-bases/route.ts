import {
  InvalidJsonBodyError,
  invalidJsonBodyResponse,
  readJsonObjectBody,
  requiredFieldResponse,
} from "@/lib/api/json-body";
import { readBodyOrQueryWorkspaceId } from "@/lib/api/query-params";
import { getWhatsAppWorkspaceContext } from "@/lib/whatsapp/get-workspace-context";
import {
  createMessagingCustomerBaseBodySchema,
  errorMessageResponse,
  zodErrorResponse,
} from "@/lib/whatsapp/signup-route-validation";
import {
  createMessagingCustomerBase,
  listMessagingCustomerBases,
} from "@/lib/whatsapp/signup-service";
import { NextResponse } from "next/server";

function getRequiredContext(context: {
  accessToken?: string;
  credentials: { businessId?: string };
  sourceId?: string;
  wabaId?: string;
}) {
  if (!context.accessToken || !context.credentials.businessId) {
    return {
      error: NextResponse.json(
        {
          error:
            "Messaging customer bases require WhatsApp access token and Meta business ID",
          requiresWhatsAppConnection: true,
        },
        { status: 409 }
      ),
    };
  }

  return {
    accessToken: context.accessToken,
    businessId: context.credentials.businessId,
    sourceId: context.sourceId,
    wabaId: context.wabaId,
  };
}

export async function GET(request: Request) {
  const workspaceId = readBodyOrQueryWorkspaceId(request);
  if (!workspaceId) return requiredFieldResponse("workspaceId");

  const access = await getWhatsAppWorkspaceContext(workspaceId, {
    requireManager: true,
  });
  if (access.error) return access.error;

  const required = getRequiredContext(access.context);
  if ("error" in required) return required.error;

  try {
    const result = await listMessagingCustomerBases({
      ...required,
      workspaceId,
    });
    return NextResponse.json(result);
  } catch (error) {
    return errorMessageResponse(error);
  }
}

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

  const parsed = createMessagingCustomerBaseBodySchema.safeParse({
    ...body,
    workspaceId: readBodyOrQueryWorkspaceId(request, body),
  });
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const { name, workspaceId } = parsed.data;

  const access = await getWhatsAppWorkspaceContext(workspaceId, {
    requireManager: true,
  });
  if (access.error) return access.error;

  const required = getRequiredContext(access.context);
  if ("error" in required) return required.error;

  try {
    const base = await createMessagingCustomerBase({
      ...required,
      name,
      workspaceId,
    });
    return NextResponse.json({ base });
  } catch (error) {
    return errorMessageResponse(error);
  }
}
