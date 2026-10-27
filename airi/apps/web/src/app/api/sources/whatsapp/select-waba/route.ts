import { getCompanyIdForWorkspace } from "@/lib/supabase/company-users";
import { createClient } from "@/lib/supabase/server";
import {
  buildWhatsAppPhoneOwnership,
  findWhatsAppPhoneOwner,
  listWhatsAppPhoneOwnersForCompany,
} from "@/lib/whatsapp/account/inventory";
import { recordObservedWhatsAppAccountsForCompany } from "@/lib/whatsapp/account/persistence";
import { resolveCompanyWhatsAppAccessToken } from "@/lib/whatsapp/company-access-token";
import { readWhatsAppSelectionSessionToken } from "@/lib/whatsapp/embedded-signup-selection-session";
import {
  discoverWABAs,
  type WABAWithPhones,
} from "@/lib/whatsapp/waba-service";
import { NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";

/**
 * GET /api/sources/whatsapp/select-waba
 * Fetches all available WABAs for the user to select from
 * Query params: workspace_id, selection_session=1 (an Embedded Signup
 * selection is expected; its token comes from the httpOnly session cookie).
 * The legacy access_token param is still accepted.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const accessToken = searchParams.get("access_token");
  const workspaceId = searchParams.get("workspace_id");
  const selectionSessionExpected =
    searchParams.get("selection_session") === "1";

  if (!accessToken && !workspaceId) {
    return NextResponse.json(
      { error: "Missing access token or workspace" },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    let companyId: string | null = null;
    if (workspaceId) {
      if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }

      companyId = await getCompanyIdForWorkspace(supabase, workspaceId);
    }

    const selectionToken = readWhatsAppSelectionSessionToken(request, {
      workspaceId,
      userId: user.id,
    });
    if (selectionSessionExpected && !accessToken && !selectionToken) {
      return NextResponse.json(
        {
          error: "selection_session_expired",
          message:
            "Start Embedded Signup again to refresh the Meta access token and choose a number.",
        },
        { status: 410 }
      );
    }

    const resolvedAccessToken = await resolveCompanyWhatsAppAccessToken({
      companyId,
      explicitAccessToken: accessToken || selectionToken,
    });

    if (!resolvedAccessToken) {
      return NextResponse.json(
        {
          error: "reauthorization_required",
          message:
            "Reconnect WhatsApp with Meta before choosing another number for this workspace.",
        },
        { status: 409 }
      );
    }

    // Resiliently discover all WABAs (handles tech providers)
    const allWABAs = await discoverWABAs(resolvedAccessToken);
    if (companyId) {
      await recordObservedWhatsAppAccountsForCompany({
        companyId,
        accounts: allWABAs,
      });
    }

    if (allWABAs.length === 0) {
      return NextResponse.json(
        {
          error: "no_business_found",
          message:
            "No WhatsApp Business Account found with provided permissions",
        },
        { status: 404 }
      );
    }

    const phoneIds = allWABAs.flatMap(waba =>
      waba.phoneNumbers.map(phone => phone.id)
    );
    const ownersByPhone = companyId
      ? await listWhatsAppPhoneOwnersForCompany({
          companyId,
          phoneNumberIds: phoneIds,
        })
      : new Map();

    return NextResponse.json({
      wabas: allWABAs.map((w: WABAWithPhones) => ({
        ...w,
        phoneNumbers: w.phoneNumbers.map(phone => ({
          ...phone,
          ownership: buildWhatsAppPhoneOwnership({
            owner: ownersByPhone.get(phone.id)?.[0] || null,
            currentWorkspaceId: workspaceId,
          }),
        })),
        // Ensure legacy fields match what the frontend expects
        businessName: w.businessName || "WhatsApp Account", // Minimal fallback
      })),
      totalWABAs: allWABAs.length,
    });
  } catch (error) {
    console.error("Error fetching WABAs:", error);
    return NextResponse.json(
      {
        error: "fetch_failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

/**
 * POST /api/sources/whatsapp/select-waba
 * User selects a specific WABA and phone number to connect
 * Body: { waba_id, phone_number_id, workspace_id, access_token? (legacy) }
 * The Embedded Signup token comes from the selection session cookie.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { access_token, waba_id, phone_number_id, workspace_id } = body;

    if (!waba_id || !phone_number_id || !workspace_id) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    // Validate user has access to this workspace
    if (!(await checkUserWorkspaceAccess(supabase, user.id, workspace_id))) {
      return NextResponse.json(
        { error: "User not authorized for this workspace" },
        { status: 403 }
      );
    }

    const companyId = await getCompanyIdForWorkspace(supabase, workspace_id);
    if (!companyId) {
      return NextResponse.json(
        { error: "Workspace company not found" },
        { status: 400 }
      );
    }

    const resolvedAccessToken = await resolveCompanyWhatsAppAccessToken({
      companyId,
      explicitAccessToken:
        (typeof access_token === "string" && access_token) ||
        readWhatsAppSelectionSessionToken(request, {
          workspaceId: workspace_id,
          userId: user.id,
        }),
    });

    if (!resolvedAccessToken) {
      return NextResponse.json(
        {
          error: "reauthorization_required",
          message:
            "Reconnect WhatsApp with Meta before choosing another number for this workspace.",
        },
        { status: 409 }
      );
    }

    // Validate WABA access
    const { validateWABAAccess } = await import("@/lib/whatsapp/waba-service");
    const validation = await validateWABAAccess(waba_id, resolvedAccessToken);

    if (!validation.valid) {
      return NextResponse.json(
        { error: "invalid_waba", message: validation.error },
        { status: 400 }
      );
    }

    // Find the selected phone number
    const selectedPhone = validation.phoneNumbers?.find(
      p => p.id === phone_number_id
    );

    if (!selectedPhone) {
      return NextResponse.json(
        { error: "Phone number not found in WABA" },
        { status: 400 }
      );
    }

    const existingOwner = await findWhatsAppPhoneOwner({
      companyId,
      phoneNumberId: phone_number_id,
      currentWorkspaceId: workspace_id,
    });
    if (existingOwner) {
      const workspaceName =
        existingOwner.workspaceName || existingOwner.workspaceId;
      return NextResponse.json(
        {
          error: "phone_already_connected",
          message: `This WhatsApp number is already connected to ${workspaceName}. Choose another number or transfer it explicitly.`,
          conflict: {
            phone_number_id,
            source_id: existingOwner.sourceId,
            workspace_id: existingOwner.workspaceId,
            workspace_name: existingOwner.workspaceName,
          },
        },
        { status: 409 }
      );
    }

    // Return the validated data - the callback handler will save it
    return NextResponse.json({
      success: true,
      data: {
        waba_id,
        phone_number_id,
        display_phone_number: selectedPhone.display_phone_number,
        verified_name: selectedPhone.verified_name,
      },
    });
  } catch (error) {
    console.error("Error selecting WABA:", error);
    return NextResponse.json(
      {
        error: "selection_failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
