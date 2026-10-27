import { createClient } from "@/lib/supabase/server";
import { normalizeWhatsAppCredentials } from "@/lib/whatsapp/credentials";
import { updateCurrentWhatsAppSourceCredentials } from "@/lib/whatsapp/flows/source-rebind-guard";
import {
  buildMarketingMessagesCredentialPatch,
  resolveMarketingMessagesStatusFromMetaPayload,
} from "@/lib/whatsapp/marketing/messages-onboarding";
import {
  MetaGraphRequestError,
  formatMetaGraphAPIError,
  getWhatsAppGraphClient,
  parseMetaGraphAPIError,
} from "@icecore/shared/lib/meta/api";
import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { requiredFieldResponse } from "@/lib/api/json-body";

const graphClient = getWhatsAppGraphClient();

type EligibilityRequest = {
  workspaceId: string;
  accessTokenOverride?: string;
  businessIdOverride?: string;
  includeEligibleWabas?: boolean;
};

async function buildEligibilityResponse(
  supabase: Awaited<ReturnType<typeof createClient>>,
  workspaceId: string,
  accessTokenOverride?: string,
  businessIdOverride?: string,
  includeEligibleWabas?: boolean
) {
  const { data: source, error: sourceError } = await supabase
    .from("sources")
    .select("id, credentials, name")
    .eq("workspace_id", workspaceId)
    .eq("type", "whatsapp")
    .maybeSingle();

  if (sourceError || !source) {
    return NextResponse.json(
      { error: "whatsapp_not_connected" },
      { status: 404 }
    );
  }

  const existingCredentials =
    source.credentials && typeof source.credentials === "object"
      ? (source.credentials as Record<string, unknown>)
      : {};
  const normalized = normalizeWhatsAppCredentials(existingCredentials);
  const wabaId = normalized.wabaId;
  const accessToken = accessTokenOverride || normalized.accessToken;

  if (!wabaId || !accessToken) {
    return NextResponse.json(
      { error: "WhatsApp credentials incomplete" },
      { status: 400 }
    );
  }

  let wabaData: {
    id: string;
    name?: string;
    account_review_status?: string;
    marketing_messages_onboarding_status?: string;
    owner_business_info?: {
      id?: string;
      name?: string;
      marketing_messages_onboarding_status?: {
        status?: string;
        time?: string;
      };
    };
  };
  try {
    wabaData = await graphClient.getJson<typeof wabaData>(wabaId, {
      token: accessToken,
      query: {
        fields:
          "id,name,account_review_status,marketing_messages_onboarding_status,owner_business_info",
      },
    });
  } catch (error) {
    if (error instanceof MetaGraphRequestError) {
      return NextResponse.json(
        {
          error:
            error.formattedError?.message ||
            `Failed to fetch WABA eligibility: HTTP ${error.status}`,
          meta_error: error.metaError || undefined,
          actionable: error.formattedError?.actionable || undefined,
        },
        { status: error.status }
      );
    }
    throw error;
  }

  const resolvedBusinessId =
    businessIdOverride ||
    normalized.businessId ||
    wabaData.owner_business_info?.id;

  let businessData: {
    id: string;
    name?: string;
    marketing_messages_onboarding_status?: {
      status?: string;
      time?: string;
    };
  } | null = null;
  let businessError: string | null = null;
  let businessActionable: string | null = null;
  let businessMetaError: unknown | null = null;

  if (resolvedBusinessId) {
    try {
      businessData = await graphClient.getJson<{
        id: string;
        name?: string;
        marketing_messages_onboarding_status?: {
          status?: string;
          time?: string;
        };
      }>(resolvedBusinessId, {
        token: accessToken,
        query: { fields: "id,name,marketing_messages_onboarding_status" },
      });
    } catch (error) {
      if (error instanceof MetaGraphRequestError) {
        const metaError =
          error.metaError || parseMetaGraphAPIError(error.details);
        const formatted = metaError ? formatMetaGraphAPIError(metaError) : null;
        businessMetaError = metaError || undefined;
        businessActionable = formatted?.actionable || null;
        businessError =
          formatted?.message ||
          `Failed to fetch business status: HTTP ${error.status}`;
      } else {
        businessError =
          error instanceof Error
            ? error.message
            : "Failed to fetch business info";
      }
    }
  }

  let eligibleWabas: {
    data: Array<{
      id: string;
      name?: string;
      timezone_id?: string;
      message_template_namespace?: string;
    }>;
    paging?: unknown;
  } | null = null;
  let eligibleWabasError: string | null = null;

  if (includeEligibleWabas && resolvedBusinessId) {
    try {
      const filter = encodeURIComponent(
        JSON.stringify([
          {
            field: "marketing_messages_onboarding_status",
            operator: "IN",
            value: ["ELIGIBLE"],
          },
        ])
      );
      eligibleWabas = await graphClient.getJson<{
        data: Array<{
          id: string;
          name?: string;
          timezone_id?: string;
          message_template_namespace?: string;
        }>;
        paging?: unknown;
      }>(`${resolvedBusinessId}/client_whatsapp_business_accounts`, {
        token: accessToken,
        query: { filtering: filter },
      });
    } catch (error) {
      if (error instanceof MetaGraphRequestError) {
        eligibleWabasError = `Failed to fetch eligible WABAs: HTTP ${error.status}`;
      } else {
        eligibleWabasError =
          error instanceof Error
            ? error.message
            : "Failed to fetch eligible WABAs";
      }
    }
  }

  const resolvedStatus = resolveMarketingMessagesStatusFromMetaPayload({
    wabaStatus: wabaData.marketing_messages_onboarding_status,
    businessStatus:
      businessData?.marketing_messages_onboarding_status ||
      wabaData.owner_business_info?.marketing_messages_onboarding_status,
  });
  const marketingMessagesPatch = buildMarketingMessagesCredentialPatch({
    status: resolvedStatus,
  });
  try {
    await updateCurrentWhatsAppSourceCredentials({
      workspaceId,
      sourceId: source.id,
      expectedWabaId: wabaId,
      buildCredentials: current => ({
        ...current,
        ...marketingMessagesPatch,
      }),
    });
  } catch (updateError) {
    return NextResponse.json(
      {
        error:
          updateError instanceof Error
            ? updateError.message
            : "Failed to persist Marketing Messages status",
      },
      { status: 500 }
    );
  }

  revalidatePath(`/panel/w/${workspaceId}/settings/integrations`);

  return NextResponse.json({
    success: true,
    data: {
      waba: wabaData,
      business: businessData,
      business_error: businessError || undefined,
      business_actionable: businessActionable || undefined,
      business_meta_error: businessMetaError || undefined,
      eligible_wabas: eligibleWabas || undefined,
      eligible_wabas_error: eligibleWabasError || undefined,
      marketing_messages: marketingMessagesPatch,
    },
  });
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const workspaceId = searchParams.get("workspaceId");

  if (!workspaceId) return requiredFieldResponse("workspaceId");

  if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return buildEligibilityResponse(supabase, workspaceId);
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: EligibilityRequest | null = null;
  try {
    body = (await request.json()) as EligibilityRequest;
  } catch {
    body = null;
  }

  const workspaceId = body?.workspaceId;
  if (!workspaceId) return requiredFieldResponse("workspaceId");

  if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rawBody = body as
    | (EligibilityRequest & {
        access_token?: string;
        accessToken?: string;
        business_id?: string;
        businessId?: string;
      })
    | null;
  const accessTokenOverride =
    rawBody?.accessTokenOverride ||
    rawBody?.access_token ||
    rawBody?.accessToken;
  const businessIdOverride =
    rawBody?.businessIdOverride || rawBody?.business_id || rawBody?.businessId;
  const includeEligibleWabas = Boolean(body?.includeEligibleWabas);

  return buildEligibilityResponse(
    supabase,
    workspaceId,
    accessTokenOverride,
    businessIdOverride,
    includeEligibleWabas
  );
}
