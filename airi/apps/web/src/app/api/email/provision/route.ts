import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";
import { z } from "zod";
import {
  buildCompanyChannelLimitExceededResponse,
  ensureCompanyChannelCapacity,
} from "@/lib/limits/company-limits";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { syncWorkspaceEmailSourceAddresses } from "@/lib/email/email-source";
import { getWorkspaceEmailProviderConfig } from "@/lib/email/provider-config";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";

const BodySchema = z.object({
  workspaceId: z.string(),
  requestedLocalPart: z.string().optional(),
});

function slugifyLocalPart(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || Math.random().toString(36).slice(2, 10)
  );
}

async function generateUniqueLocalPart(base?: string): Promise<string> {
  const tryBase = base ? slugifyLocalPart(base) : undefined;
  const candidate = async (suffix?: string) =>
    suffix
      ? `${tryBase}-${suffix}`
      : tryBase || Math.random().toString(36).slice(2, 8);
  for (let i = 0; i < 10; i++) {
    const suffix = i === 0 ? undefined : Math.random().toString(36).slice(2, 6);
    const lp = await candidate(suffix);
    const { data } = await supabaseAdmin
      .from("workspace_email_addresses")
      .select("id")
      .eq("local_part", lp)
      .maybeSingle();
    if (!data) return lp;
  }
  // fallback random
  return Math.random().toString(36).slice(2, 10);
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });

  // Parse body first to get workspaceId for scoping
  const body = await req.json();
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return new NextResponse(
      JSON.stringify({ error: "Invalid body", details: parsed.error.message }),
      { status: 400 }
    );
  }
  const { workspaceId, requestedLocalPart } = parsed.data;

  // Resolve membership in this workspace
  if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
    return new NextResponse(
      JSON.stringify({ error: "User not associated with this workspace" }),
      { status: 403 }
    );
  }

  const providerConfig = await getWorkspaceEmailProviderConfig(workspaceId);
  if (!providerConfig) {
    return new NextResponse(
      JSON.stringify({
        error:
          "Email integration is disabled for this workspace. Enable provider in Supabase first.",
      }),
      { status: 403 }
    );
  }

  try {
    const channelCapacity = await ensureCompanyChannelCapacity(
      supabaseAdmin,
      workspaceId,
      "email"
    );
    if (!channelCapacity.allowed) {
      return buildCompanyChannelLimitExceededResponse(channelCapacity.limit);
    }

    const newLocalPart = await generateUniqueLocalPart(requestedLocalPart);

    // Insert into workspace_email_addresses table
    const { data, error } = await supabaseAdmin
      .from("workspace_email_addresses")
      .insert({
        local_part: newLocalPart,
        workspace_id: workspaceId,
        postmark_stream_outbound: "outbound",
        kind: "inbound",
        status: "active",
      })
      .select("full_address")
      .single();

    if (error) throw error;

    await syncWorkspaceEmailSourceAddresses(workspaceId);

    return NextResponse.json({ address: data.full_address });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Provision failed";
    return new NextResponse(
      JSON.stringify({ error: "Provision failed", details: message }),
      { status: 500 }
    );
  }
}
