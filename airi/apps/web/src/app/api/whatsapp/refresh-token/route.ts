import { createClient } from "@/lib/supabase/server";
import { validateStoredToken } from "@/lib/whatsapp/token-refresh";
import { getWhatsAppConnectionMaintenanceStatus } from "@/lib/whatsapp/token-lifecycle";
import { NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { requiredFieldResponse } from "@/lib/api/json-body";

/**
 * POST /api/whatsapp/refresh-token
 *
 * Validates and checks if a WhatsApp token needs refresh.
 * Scheduled maintenance renews eligible credentials automatically. This legacy
 * endpoint checks status; it does not run a second, uncoordinated renewal.
 *
 * Query params:
 * - workspaceId: Workspace ID to check token for
 *
 * @see https://developers.facebook.com/docs/whatsapp/embedded-signup/implementation
 */
export async function POST(request: Request) {
  try {
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

    // Verify user has access to workspace
    if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
      return NextResponse.json(
        { error: "Workspace not found or access denied" },
        { status: 403 }
      );
    }

    // Get WhatsApp source for workspace
    const { data: source, error: sourceError } = await supabase
      .from("sources")
      .select("id, credentials")
      .eq("workspace_id", workspaceId)
      .eq("type", "whatsapp")
      .maybeSingle();

    if (sourceError || !source) {
      return NextResponse.json(
        { error: "WhatsApp source not found" },
        { status: 404 }
      );
    }

    const credentials = source.credentials as {
      access_token?: unknown;
      token_expires_at?: string;
      embedded_signup?: boolean;
    };

    if (!credentials?.access_token) {
      return NextResponse.json(
        { error: "No access token found" },
        { status: 404 }
      );
    }

    // Validate stored token
    // credentials.access_token is already an EncryptedString object, not a string
    const validation = await validateStoredToken(
      credentials.access_token as unknown as
        | string
        | { iv: string; tag: string; ciphertext: string },
      credentials.token_expires_at || null
    );

    // If token needs refresh, provide guidance
    if (validation.needsRefresh) {
      return NextResponse.json({
        needsRefresh: true,
        actionRequired: validation.actionRequired,
        message: validation.message,
        validation: validation.validation,
        embeddedSignup: credentials.embedded_signup === true,
        guidance:
          validation.actionRequired === "reconnect"
            ? "Confirm your WhatsApp connection to keep messages working."
            : "Your WhatsApp connection is maintained automatically. No action is needed.",
      });
    }

    // Token is valid
    return NextResponse.json({
      needsRefresh: false,
      actionRequired: validation.actionRequired,
      message: validation.message || "Token is valid",
      validation: validation.validation,
      embeddedSignup: credentials.embedded_signup === true,
    });
  } catch (error) {
    console.error("Error checking token refresh:", error);
    return NextResponse.json(
      {
        error: "Failed to check token refresh",
        message:
          error instanceof Error ? error.message : "Unknown error occurred",
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/whatsapp/refresh-token?workspaceId=XXX
 *
 * Quick check if token needs refresh (lighter weight than POST)
 */
export async function GET(request: Request) {
  try {
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

    // Verify user has access to workspace
    if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
      return NextResponse.json(
        { error: "Workspace not found or access denied" },
        { status: 403 }
      );
    }

    // Get WhatsApp source
    const { data: source } = await supabase
      .from("sources")
      .select("credentials")
      .eq("workspace_id", workspaceId)
      .eq("type", "whatsapp")
      .maybeSingle();

    if (!source?.credentials) {
      return NextResponse.json(
        { needsRefresh: false, message: "No WhatsApp connection found" },
        { status: 200 }
      );
    }

    const maintenance = getWhatsAppConnectionMaintenanceStatus(
      source.credentials
    );
    const requiresReconnect =
      maintenance.state === "expired" ||
      maintenance.state === "action_required";
    return NextResponse.json({
      needsRefresh: requiresReconnect || maintenance.state === "maintaining",
      actionRequired: requiresReconnect
        ? "reconnect"
        : maintenance.state === "maintaining"
          ? "validate"
          : "none",
      daysUntilExpiry: maintenance.daysUntilExpiry,
    });
  } catch (error) {
    console.error("Error checking token refresh (GET):", error);
    return NextResponse.json(
      { error: "Failed to check token refresh" },
      { status: 500 }
    );
  }
}
