import {
  InvalidJsonBodyError,
  invalidJsonBodyResponse,
  readJsonObjectBody,
  requiredFieldResponse,
} from "@/lib/api/json-body";
import { readBodyOrQueryWorkspaceId } from "@/lib/api/query-params";
import { getWhatsAppWorkspaceContext } from "@/lib/whatsapp/get-workspace-context";
import {
  createWhatsAppSignupBodySchema,
  errorMessageResponse,
  zodErrorResponse,
} from "@/lib/whatsapp/signup-route-validation";
import {
  createWhatsAppSignupLink,
  listWhatsAppSignupLinks,
} from "@/lib/whatsapp/signup-service";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const workspaceId = readBodyOrQueryWorkspaceId(request);
  if (!workspaceId) return requiredFieldResponse("workspaceId");

  const access = await getWhatsAppWorkspaceContext(workspaceId, {
    requireManager: true,
  });
  if (access.error) return access.error;

  try {
    const result = await listWhatsAppSignupLinks({
      workspaceId,
      sourceId: access.context.sourceId,
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

  const parsed = createWhatsAppSignupBodySchema.safeParse({
    ...body,
    workspaceId: readBodyOrQueryWorkspaceId(request, body),
  });
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const { workspaceId } = parsed.data;
  const access = await getWhatsAppWorkspaceContext(workspaceId, {
    requireManager: true,
  });
  if (access.error) return access.error;

  const { context } = access;
  const businessPhoneNumber =
    context.credentials.displayPhoneNumber || parsed.data.businessPhoneNumber;
  if (!context.accessToken || !context.wabaId || !businessPhoneNumber) {
    return NextResponse.json(
      {
        error:
          "WhatsApp signup links require WABA ID, access token, and display phone number",
        requiresWhatsAppConnection: true,
      },
      { status: 409 }
    );
  }

  try {
    const link = await createWhatsAppSignupLink({
      accessToken: context.accessToken,
      businessPhoneNumber,
      input: {
        displayName: parsed.data.displayName,
        signupMessage: parsed.data.signupMessage,
        confirmationMessage: parsed.data.confirmationMessage,
        privacyPolicyUrl: parsed.data.privacyPolicyUrl,
        websiteUrl: parsed.data.websiteUrl,
        promoCode: parsed.data.promoCode,
        productLine: parsed.data.productLine,
        shop: parsed.data.shop,
        campaign: parsed.data.campaign,
        landingPage: parsed.data.landingPage,
        ad: parsed.data.ad,
        checkoutFlow: parsed.data.checkoutFlow,
        messagingCustomerBaseId: parsed.data.messagingCustomerBaseId,
      },
      phoneNumberId: context.phoneNumberId,
      sourceId: context.sourceId,
      wabaId: context.wabaId,
      workspaceId,
    });
    return NextResponse.json({ link });
  } catch (error) {
    return errorMessageResponse(error);
  }
}
