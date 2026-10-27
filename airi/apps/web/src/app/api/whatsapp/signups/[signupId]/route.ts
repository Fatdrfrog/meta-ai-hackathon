import {
  InvalidJsonBodyError,
  invalidJsonBodyResponse,
  readJsonObjectBody,
} from "@/lib/api/json-body";
import { getWhatsAppWorkspaceContext } from "@/lib/whatsapp/get-workspace-context";
import {
  updateWhatsAppSignupBodySchema,
  errorMessageResponse,
  zodErrorResponse,
} from "@/lib/whatsapp/signup-route-validation";
import { updateWhatsAppSignupLink } from "@/lib/whatsapp/signup-service";
import { NextResponse } from "next/server";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ signupId: string }> }
) {
  let body: Record<string, unknown>;
  try {
    body = await readJsonObjectBody(request);
  } catch (error) {
    if (error instanceof InvalidJsonBodyError) {
      return invalidJsonBodyResponse(error);
    }
    throw error;
  }

  const parsed = updateWhatsAppSignupBodySchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const { workspaceId } = parsed.data;

  const access = await getWhatsAppWorkspaceContext(workspaceId, {
    requireManager: true,
  });
  if (access.error) return access.error;
  if (!access.context.accessToken) {
    return NextResponse.json(
      {
        error: "WhatsApp access token is missing",
        requiresWhatsAppConnection: true,
      },
      { status: 409 }
    );
  }

  const { signupId } = await params;
  try {
    const link = await updateWhatsAppSignupLink({
      accessToken: access.context.accessToken,
      signupLinkId: signupId,
      workspaceId,
      input: {
        displayName: parsed.data.displayName,
        signupMessage: parsed.data.signupMessage,
        confirmationMessage: parsed.data.confirmationMessage,
        websiteUrl: parsed.data.websiteUrl,
        promoCode: parsed.data.promoCode,
        productLine: parsed.data.productLine,
        shop: parsed.data.shop,
        campaign: parsed.data.campaign,
        landingPage: parsed.data.landingPage,
        ad: parsed.data.ad,
        checkoutFlow: parsed.data.checkoutFlow,
        messagingCustomerBaseId: parsed.data.messagingCustomerBaseId,
        status: parsed.data.status,
      },
    });
    return NextResponse.json({ link });
  } catch (error) {
    return errorMessageResponse(error);
  }
}
