import { resolveUserWorkspaceMembership } from "@/lib/supabase/queries";
import { encryptString } from "@/lib/crypto";
import { trackSourceConnected } from "@/lib/analytics";
import { flushServerPostHog } from "@/lib/posthog/server";
import {
  buildCompanyChannelLimitExceededResponse,
  ensureCompanyChannelCapacity,
} from "@/lib/limits/company-limits";
import { getCompanyIdForWorkspace } from "@/lib/supabase/company-users";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });

  const body = await request.json();
  const access = await resolveUserWorkspaceMembership(
    supabase,
    user.id,
    body.workspaceId
  );
  if (!access.ok)
    return NextResponse.json(
      { error: access.error },
      { status: access.status }
    );
  const companyUser = { workspace_id: access.workspaceId };

  const {
    instagram_business_account_id,
    instagram_scoped_id,
    page_access_token,
    page_id,
  } = body;

  const igBusinessId = instagram_business_account_id || instagram_scoped_id;
  if (!igBusinessId || !page_access_token) {
    return new Response(
      JSON.stringify({
        error: "Instagram account ID and access token are required",
      }),
      { status: 400 }
    );
  }

  try {
    const companyId = await getCompanyIdForWorkspace(
      supabase,
      companyUser.workspace_id
    );

    if (!companyId) {
      return new Response(
        JSON.stringify({ error: "Workspace company not found" }),
        { status: 400 }
      );
    }

    const encryptedToken = encryptString(String(page_access_token));
    const credentials = {
      instagram_business_account_id: igBusinessId,
      ...(instagram_scoped_id && { instagram_scoped_id }),
      page_access_token: encryptedToken,
      ...(page_id && { page_id }),
      auth_method: "manual",
      connected_at: new Date().toISOString(),
    };

    const { data: existing } = await supabase
      .from("sources")
      .select("id, credentials")
      .eq("workspace_id", companyUser.workspace_id)
      .eq("type", "instagram")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let error: unknown = null;
    let created = false;
    if (existing?.id) {
      const currentCreds =
        (existing.credentials as Record<string, unknown>) || {};
      const result = await supabase
        .from("sources")
        .update({
          name: `Instagram (${String(igBusinessId).slice(-6)})`,
          credentials: { ...currentCreds, ...credentials },
        })
        .eq("id", existing.id);
      error = result.error;
    } else {
      const channelCapacity = await ensureCompanyChannelCapacity(
        supabaseAdmin,
        companyUser.workspace_id,
        "instagram"
      );
      if (!channelCapacity.allowed) {
        return buildCompanyChannelLimitExceededResponse(channelCapacity.limit);
      }

      const result = await supabase.from("sources").insert({
        company_id: companyId,
        workspace_id: companyUser.workspace_id,
        type: "instagram",
        name: `Instagram (${String(igBusinessId).slice(-6)})`,
        credentials,
      });
      error = result.error;
      created = true;
    }

    if (error) throw error;
    trackSourceConnected(
      companyId,
      companyUser.workspace_id,
      "instagram",
      created ? "connected" : "reconnected"
    );
    await flushServerPostHog();
    return NextResponse.json({ success: true });
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
    });
  }
}
