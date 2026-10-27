/**
 * Check if WhatsApp is already connected for a workspace
 * Helps diagnose if connection exists but UI isn't showing it
 *
 * Usage: GET /api/whatsapp/check-existing?workspaceId=WORKSPACE_ID
 */

import { createClient } from "@/lib/supabase/server";
import { normalizeWhatsAppCredentials } from "@/lib/whatsapp/credentials";
import { NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { requiredFieldResponse } from "@/lib/api/json-body";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const workspaceId = searchParams.get("workspaceId");

  if (!workspaceId) return requiredFieldResponse("workspaceId");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Check if user has access to this workspace
  if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
    return NextResponse.json(
      { error: "Workspace not found or access denied" },
      { status: 403 }
    );
  }

  // Get all WhatsApp sources for this workspace
  const { data: sources, error } = await supabase
    .from("sources")
    .select("id, name, type, credentials, created_at, updated_at")
    .eq("workspace_id", workspaceId)
    .eq("type", "whatsapp");

  if (error) {
    return NextResponse.json(
      { error: "Failed to query sources", details: error.message },
      { status: 500 }
    );
  }

  const results = (sources || []).map(source => {
    const credentials = source.credentials as {
      waba_id?: string;
      phone_number_id?: string;
      access_token?: string;
      token_expires_at?: string;
      embedded_signup?: boolean;
    } | null;
    const normalized = normalizeWhatsAppCredentials(credentials || undefined);

    return {
      sourceId: source.id,
      name: source.name,
      hasCredentials: !!credentials,
      wabaId: normalized.wabaId || "Not set",
      phoneNumberId: normalized.phoneNumberId || "Not set",
      hasAccessToken: !!credentials?.access_token,
      tokenExpiresAt: credentials?.token_expires_at || "Not set",
      embeddedSignup: credentials?.embedded_signup || false,
      createdAt: source.created_at,
      updatedAt: source.updated_at,
    };
  });

  return NextResponse.json({
    workspaceId,
    found: results.length > 0,
    count: results.length,
    sources: results,
    summary: {
      hasWhatsApp: results.length > 0,
      hasValidCredentials: results.some(
        r => r.hasCredentials && r.wabaId !== "Not set"
      ),
      totalSources: results.length,
    },
  });
}
