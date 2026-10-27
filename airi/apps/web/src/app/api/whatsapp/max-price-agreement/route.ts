import { getWhatsAppWorkspaceContext } from "@/lib/whatsapp/get-workspace-context";
import {
  MetaGraphRequestError,
  getWhatsAppGraphClient,
} from "@icecore/shared/lib/meta/api";
import { NextRequest, NextResponse } from "next/server";
import { requiredFieldResponse } from "@/lib/api/json-body";
import { readTrimmedString as cleanString } from "@icecore/shared/lib/value-utils";

const graphClient = getWhatsAppGraphClient();

type MaxPriceAgreement = {
  status?: string;
  signer_name?: string;
  signer_email?: string;
  [key: string]: unknown;
};

type MaxPriceAgreementRequest = {
  workspaceId?: string;
  signerName?: string;
  signerEmail?: string;
  signer_name?: string;
  signer_email?: string;
};

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function graphErrorResponse(error: MetaGraphRequestError) {
  return NextResponse.json(
    {
      error:
        error.formattedError?.message ||
        error.message ||
        `Meta Graph API request failed: HTTP ${error.status}`,
      meta_error: error.metaError || undefined,
      actionable: error.formattedError?.actionable || undefined,
    },
    { status: error.status }
  );
}

async function getBusinessEnrollmentContext(workspaceId: string) {
  const access = await getWhatsAppWorkspaceContext(workspaceId, {
    requireManager: true,
    requireCredentials: false,
    managerErrorMessage:
      "Only managers and admins can enroll WhatsApp max-price agreements",
  });

  if (access.error) {
    return { error: access.error };
  }

  const businessId = cleanString(access.context.credentials.businessId);
  const accessToken = cleanString(access.context.credentials.accessToken);

  if (!businessId) {
    return {
      error: NextResponse.json(
        {
          error: "Meta Business ID is required for max-price enrollment",
        },
        { status: 400 }
      ),
    };
  }

  if (!accessToken) {
    return {
      error: NextResponse.json(
        {
          error: "WhatsApp access token is required for max-price enrollment",
        },
        { status: 400 }
      ),
    };
  }

  return { businessId, accessToken };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const workspaceId = cleanString(searchParams.get("workspaceId"));

  if (!workspaceId) return requiredFieldResponse("workspaceId");

  const context = await getBusinessEnrollmentContext(workspaceId);
  if (context.error) {
    return context.error;
  }

  try {
    const agreement = await graphClient.getJson<MaxPriceAgreement>(
      `${context.businessId}/max_price_agreements`,
      { token: context.accessToken }
    );

    return NextResponse.json({
      success: true,
      data: {
        businessId: context.businessId,
        agreement,
      },
    });
  } catch (error) {
    if (error instanceof MetaGraphRequestError) {
      return graphErrorResponse(error);
    }
    throw error;
  }
}

export async function POST(request: NextRequest) {
  let body: MaxPriceAgreementRequest | null = null;
  try {
    body = (await request.json()) as MaxPriceAgreementRequest;
  } catch {
    body = null;
  }

  const workspaceId = cleanString(body?.workspaceId);
  const signerName = cleanString(body?.signerName || body?.signer_name);
  const signerEmail = cleanString(body?.signerEmail || body?.signer_email);

  if (!workspaceId) return requiredFieldResponse("workspaceId");

  if (!signerName) return requiredFieldResponse("signerName");

  if (!signerEmail || !isValidEmail(signerEmail)) {
    return NextResponse.json(
      { error: "A valid signerEmail is required" },
      { status: 400 }
    );
  }

  const context = await getBusinessEnrollmentContext(workspaceId);
  if (context.error) {
    return context.error;
  }

  try {
    const agreement = await graphClient.postJson<MaxPriceAgreement>(
      `${context.businessId}/max_price_agreements`,
      {
        token: context.accessToken,
        body: {
          signer_name: signerName,
          signer_email: signerEmail,
        },
      }
    );

    return NextResponse.json({
      success: true,
      data: {
        businessId: context.businessId,
        agreement,
      },
    });
  } catch (error) {
    if (error instanceof MetaGraphRequestError) {
      return graphErrorResponse(error);
    }
    throw error;
  }
}
